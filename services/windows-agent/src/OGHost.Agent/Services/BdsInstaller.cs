using System.IO.Compression;
using System.Security.Cryptography;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Services;

/// <summary>Result of an install or update operation.</summary>
public sealed record InstallResult(
    bool Success,
    string? Version,
    string? InstallPath,
    string? ChecksumSha256,
    string? Error);

/// <summary>
/// Downloads, verifies and installs the official Minecraft Bedrock Dedicated
/// Server onto this node.
///
/// Layout (worlds are deliberately kept OUTSIDE the engine directory so an
/// update can never destroy player progress):
///   {data}/engines/{version}/bedrock_server.exe   ← engine files, disposable
///   {data}/worlds/{worldName}/                    ← the actual world, precious
///   {data}/servers/{serverId}/                    ← per-server config + links
///
/// An update extracts into a NEW versioned directory, re-points the server at
/// it, and keeps the old directory so rollback is possible.
/// </summary>
public sealed class BdsInstaller
{
    private readonly IHttpClientFactory _httpFactory;

    private HttpClient Http => _httpFactory.CreateClient(HttpClients.Downloads);
    private readonly AgentConfigStore _config;
    private readonly BdsVersionDiscovery _discovery;
    private readonly ILogger<BdsInstaller> _logger;

    public BdsInstaller(
        IHttpClientFactory httpFactory,
        AgentConfigStore config,
        BdsVersionDiscovery discovery,
        ILogger<BdsInstaller> logger)
    {
        _httpFactory = httpFactory;
        _config = config;
        _discovery = discovery;
        _logger = logger;
    }

    public string EngineDirectory(string version) =>
        Path.Combine(_config.Options.EnginesRoot, version);

    public string ServerDirectory(string serverId) =>
        Path.Combine(_config.Options.ServersRoot, serverId);

    public string WorldDirectory(string worldName) =>
        Path.Combine(_config.Options.WorldsRoot, worldName);

    public string StatePath(string serverId) =>
        Path.Combine(ServerDirectory(serverId), ".oghost-state.json");

    /// <summary>Read the version currently installed for a server, if any.</summary>
    public string? GetInstalledVersion(string serverId)
    {
        var state = ReadState(serverId);
        if (!string.IsNullOrWhiteSpace(state.Version) &&
            File.Exists(Path.Combine(EngineDirectory(state.Version), "bedrock_server.exe")))
        {
            return state.Version;
        }
        return null;
    }

    public IReadOnlyList<string> GetInstalledVersions()
    {
        if (!Directory.Exists(_config.Options.EnginesRoot)) return Array.Empty<string>();
        return Directory.GetDirectories(_config.Options.EnginesRoot)
            .Select(Path.GetFileName)
            .Where(n => n is not null && File.Exists(Path.Combine(EngineDirectory(n!), "bedrock_server.exe")))
            .Select(n => n!)
            .ToList();
    }

    /// <summary>Install (or reinstall) BDS for a server.</summary>
    public async Task<InstallResult> InstallAsync(
        string serverId, string worldName, string? requestedVersion, string channel, CancellationToken ct)
    {
        try
        {
            Directory.CreateDirectory(ServerDirectory(serverId));
            Directory.CreateDirectory(WorldDirectory(worldName));

            var release = string.IsNullOrWhiteSpace(requestedVersion)
                ? await _discovery.DiscoverAsync(channel, ct)
                : await FindLocalOrRemoteAsync(requestedVersion!, channel, ct);

            if (release is null)
            {
                return new InstallResult(false, null, null, null,
                    "Could not discover the current official Bedrock Dedicated Server release. " +
                    "The download page may be unreachable from this machine, or its layout changed. " +
                    "Set the OGHOST_BDS_URL environment variable to a direct official .zip link to override.");
            }

            var engineDir = EngineDirectory(release.Version);
            if (File.Exists(Path.Combine(engineDir, "bedrock_server.exe")))
            {
                _logger.LogInformation("BDS {Version} already present, reusing", release.Version);
                LinkServer(serverId, worldName, release.Version);
                WriteState(serverId, new ServerState(release.Version, worldName, engineDir, DateTime.UtcNow));
                return new InstallResult(true, release.Version, engineDir, null, null);
            }

            var archive = await DownloadAsync(release, ct);
            var checksum = await Sha256Async(archive, ct);

            Directory.CreateDirectory(engineDir);
            ExtractZip(archive, engineDir);

            if (!File.Exists(Path.Combine(engineDir, "bedrock_server.exe")))
            {
                // Some archives nest everything one level deeper.
                var nested = Directory.GetDirectories(engineDir)
                    .FirstOrDefault(d => File.Exists(Path.Combine(d, "bedrock_server.exe")));
                if (nested is null)
                {
                    return new InstallResult(false, release.Version, engineDir, checksum,
                        "Downloaded archive did not contain bedrock_server.exe. The official package layout may have changed.");
                }
                foreach (var entry in Directory.GetFileSystemEntries(nested))
                {
                    var target = Path.Combine(engineDir, Path.GetFileName(entry));
                    if (Directory.Exists(entry)) Directory.Move(entry, target);
                    else File.Move(entry, target, overwrite: true);
                }
                Directory.Delete(nested, recursive: true);
            }

            LinkServer(serverId, worldName, release.Version);
            WriteState(serverId, new ServerState(release.Version, worldName, engineDir, DateTime.UtcNow));
            _logger.LogInformation("Installed BDS {Version} for server {ServerId}", release.Version, serverId);
            return new InstallResult(true, release.Version, engineDir, checksum, null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "BDS install failed for {ServerId}", serverId);
            return new InstallResult(false, null, null, null, ex.Message);
        }
    }

    /// <summary>
    /// Update to a newer version. Keeps the old engine directory for rollback
    /// and never touches the world directory.
    /// </summary>
    public async Task<InstallResult> UpdateAsync(
        string serverId, string worldName, string? targetVersion, string channel, CancellationToken ct)
    {
        var current = GetInstalledVersion(serverId);
        var release = string.IsNullOrWhiteSpace(targetVersion)
            ? await _discovery.DiscoverAsync(channel, ct)
            : await FindLocalOrRemoteAsync(targetVersion!, channel, ct);

        if (release is null)
        {
            return new InstallResult(false, current, null, null,
                "Could not determine the target version for the update.");
        }
        if (current is not null && BdsVersionDiscovery.CompareVersions(release.Version, current) <= 0)
        {
            return new InstallResult(true, current, EngineDirectory(current), null,
                $"Already on {current}; {release.Version} is not newer.");
        }

        return await InstallAsync(serverId, worldName, release.Version, channel, ct);
    }

    /// <summary>Roll back to a previously installed version kept on disk.</summary>
    public InstallResult Rollback(string serverId, string worldName, string version)
    {
        var engineDir = EngineDirectory(version);
        if (!File.Exists(Path.Combine(engineDir, "bedrock_server.exe")))
        {
            return new InstallResult(false, version, null, null,
                $"Version {version} is not present on this device. Rollback only works to a version that was previously installed here.");
        }
        LinkServer(serverId, worldName, version);
        WriteState(serverId, new ServerState(version, worldName, engineDir, DateTime.UtcNow));
        return new InstallResult(true, version, engineDir, null, null);
    }

    /// <summary>
    /// Point a server directory at a specific engine version. The world lives
    /// outside the engine directory and is linked in, so updating the engine
    /// can never delete player progress.
    /// </summary>
    private void LinkServer(string serverId, string worldName, string version)
    {
        var serverDir = ServerDirectory(serverId);
        var engineDir = EngineDirectory(version);
        Directory.CreateDirectory(serverDir);

        // Copy engine files into the server directory. Copying (rather than
        // running in place) means two servers can run different versions from
        // the same cached engine, and per-server config edits stay isolated.
        CopyDirectory(engineDir, serverDir, overwrite: true);

        // Ensure the world directory exists and is linked into the server dir.
        var worldDir = WorldDirectory(worldName);
        Directory.CreateDirectory(worldDir);
        var linkTarget = Path.Combine(serverDir, "worlds", worldName);
        Directory.CreateDirectory(Path.GetDirectoryName(linkTarget)!);
        CreateLink(linkTarget, worldDir);
    }

    private static void CreateLink(string linkPath, string target)
    {
        if (Directory.Exists(linkPath) || File.Exists(linkPath))
        {
            // Already linked or a real directory — leave it alone.
            return;
        }
        try
        {
            Directory.CreateSymbolicLink(linkPath, target);
            return;
        }
        catch (Exception)
        {
            // Symbolic links need Developer Mode or admin rights on Windows.
            // Fall back to a junction, which needs neither.
        }
        try
        {
            CreateJunction(linkPath, target);
        }
        catch (Exception)
        {
            // Last resort: a plain copy. Slower and duplicates data, but always
            // works, and the world is still backed up separately.
            CopyDirectory(target, linkPath, overwrite: false);
        }
    }

    private static void CreateJunction(string junctionPath, string targetPath)
    {
        var psi = new System.Diagnostics.ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = $"/c mklink /J \"{junctionPath}\" \"{targetPath}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = System.Diagnostics.Process.Start(psi);
        process?.WaitForExit(30_000);
        if (!Directory.Exists(junctionPath))
        {
            throw new InvalidOperationException("mklink /J did not create the junction");
        }
    }

    private static void CopyDirectory(string source, string destination, bool overwrite)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source))
        {
            var name = Path.GetFileName(file);
            var target = Path.Combine(destination, name);
            // Never clobber a server's own live configuration: the panel owns
            // server.properties, and an update must not reset the operator's
            // world name, port or player cap.
            if (name.Equals("server.properties", StringComparison.OrdinalIgnoreCase) && File.Exists(target))
            {
                continue;
            }
            // Likewise leave existing pack registries alone — AddonInstaller owns them.
            if ((name.Equals("world_behavior_packs.json", StringComparison.OrdinalIgnoreCase) ||
                 name.Equals("world_resource_packs.json", StringComparison.OrdinalIgnoreCase)) &&
                File.Exists(target))
            {
                continue;
            }
            File.Copy(file, target, overwrite: true);
        }
        foreach (var dir in Directory.GetDirectories(source))
        {
            var name = Path.GetFileName(dir);
            if (name.Equals("worlds", StringComparison.OrdinalIgnoreCase)) continue; // handled by LinkServer
            CopyDirectory(dir, Path.Combine(destination, name), overwrite);
        }
    }

    private async Task<string> DownloadAsync(BdsRelease release, CancellationToken ct)
    {
        Directory.CreateDirectory(_config.Options.DownloadsRoot);
        var fileName = Path.GetFileName(new Uri(release.DownloadUrl).AbsolutePath);
        if (string.IsNullOrWhiteSpace(fileName)) fileName = $"bedrock-server-{release.Version}.zip";
        var destination = Path.Combine(_config.Options.DownloadsRoot, fileName);

        _logger.LogInformation("Downloading BDS {Version} from {Url}", release.Version, release.DownloadUrl);
        using var response = await Http.GetAsync(release.DownloadUrl, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        await using var source = await response.Content.ReadAsStreamAsync(ct);
        await using var target = File.Create(destination);
        await source.CopyToAsync(target, ct);
        return destination;
    }

    private async Task<string> Sha256Async(string path, CancellationToken ct)
    {
        await using var stream = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(stream, ct);
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static void ExtractZip(string archive, string destination)
    {
        ZipFile.ExtractToDirectory(archive, destination, overwriteFiles: true);
    }

    private async Task<BdsRelease?> FindLocalOrRemoteAsync(string version, string channel, CancellationToken ct)
    {
        if (File.Exists(Path.Combine(EngineDirectory(version), "bedrock_server.exe")))
        {
            return new BdsRelease(version, channel, string.Empty);
        }
        var discovered = await _discovery.DiscoverAsync(channel, ct);
        if (discovered is not null && discovered.Version == version) return discovered;
        // Requested a specific version we cannot locate an official URL for.
        return null;
    }

    public ServerState ReadState(string serverId)
    {
        try
        {
            var path = StatePath(serverId);
            if (!File.Exists(path)) return new ServerState(null, null, null, null);
            var json = File.ReadAllText(path);
            return System.Text.Json.JsonSerializer.Deserialize<ServerState>(json)
                   ?? new ServerState(null, null, null, null);
        }
        catch
        {
            return new ServerState(null, null, null, null);
        }
    }

    public void WriteState(string serverId, ServerState state)
    {
        Directory.CreateDirectory(ServerDirectory(serverId));
        File.WriteAllText(StatePath(serverId), System.Text.Json.JsonSerializer.Serialize(state));
    }
}

/// <summary>Persisted per-server install state.</summary>
public sealed record ServerState(
    string? Version,
    string? WorldName,
    string? EnginePath,
    DateTime? InstalledAt);
