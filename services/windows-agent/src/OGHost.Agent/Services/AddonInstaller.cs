using System.IO.Compression;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Services;

public sealed record AddonResult(bool Success, string? InstalledPath, string? Error, string? PackId);

/// <summary>
/// Installs legitimate Minecraft Bedrock add-ons.
///
/// Bedrock add-ons are ZIP archives with a different extension:
///   .mcpack  → a single behaviour OR resource pack (has manifest.json)
///   .mcaddon → a bundle of .mcpack files inside one zip
///   .mcworld → a complete world save
///
/// The official Bedrock Dedicated Server has NO Java plugin API, so .jar files
/// are rejected outright rather than silently ignored. Installing an add-on
/// means: unpack into behavior_packs/ or resource_packs/, read its manifest to
/// learn the pack id and type, then register it in the world's
/// world_behavior_packs.json / world_resource_packs.json so BDS actually loads
/// it on next start.
/// </summary>
public sealed class AddonInstaller
{
    private static readonly string[] AllowedExtensions = { ".mcpack", ".mcaddon", ".mcworld" };

    private readonly ILogger<AddonInstaller> _logger;
    private readonly BdsInstaller _installer;
    private readonly IHttpClientFactory _httpFactory;

    private HttpClient Http => _httpFactory.CreateClient(HttpClients.Transfers);

    public AddonInstaller(IHttpClientFactory httpFactory, BdsInstaller installer, ILogger<AddonInstaller> logger)
    {
        _httpFactory = httpFactory;
        _installer = installer;
        _logger = logger;
    }

    public static bool IsSupported(string fileName) =>
        AllowedExtensions.Any(ext => fileName.EndsWith(ext, StringComparison.OrdinalIgnoreCase));

    /// <summary>Download an add-on from a signed URL and install it.</summary>
    public async Task<AddonResult> InstallFromUrlAsync(
        string serverId, string worldName, string fileName, string addonType,
        string downloadUrl, CancellationToken ct)
    {
        if (!IsSupported(fileName))
        {
            if (fileName.EndsWith(".jar", StringComparison.OrdinalIgnoreCase))
            {
                return new AddonResult(false, null,
                    "That is a Java Edition plugin. The official Bedrock Dedicated Server cannot load .jar plugins — it uses Bedrock add-ons (.mcpack, .mcaddon) and behaviour/resource packs.",
                    null);
            }
            return new AddonResult(false, null,
                "Unsupported file type. Bedrock add-ons must be .mcpack, .mcaddon or .mcworld.", null);
        }

        try
        {
            var serverDir = _installer.ServerDirectory(serverId);
            if (!Directory.Exists(serverDir))
            {
                return new AddonResult(false, null,
                    "This server is not installed on this device yet. Install Bedrock Dedicated Server first.", null);
            }

            var tempPath = Path.Combine(Path.GetTempPath(), $"oghost-{Guid.NewGuid():N}.zip");
            using (var response = await Http.GetAsync(downloadUrl, HttpCompletionOption.ResponseHeadersRead, ct))
            {
                response.EnsureSuccessStatusCode();
                await using var source = await response.Content.ReadAsStreamAsync(ct);
                await using var target = File.Create(tempPath);
                await source.CopyToAsync(target, ct);
            }

            // Verify the archive really is a zip before touching the server dir.
            if (!IsZip(tempPath))
            {
                File.Delete(tempPath);
                return new AddonResult(false, null,
                    "The uploaded file is not a valid ZIP archive. Bedrock add-ons are ZIP files with a .mcpack/.mcaddon/.mcworld extension.",
                    null);
            }

            var result = addonType.ToLowerInvariant() switch
            {
                "mcworld" => await InstallWorldAsync(serverId, worldName, tempPath, ct),
                "mcaddon" => await InstallBundleAsync(serverId, tempPath, ct),
                _ => await InstallSinglePackAsync(serverId, tempPath, ct),
            };

            try { File.Delete(tempPath); } catch { /* best effort */ }
            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Add-on install failed for {ServerId}", serverId);
            return new AddonResult(false, null, ex.Message, null);
        }
    }

    /// <summary>A single .mcpack: read its manifest, unpack, register.</summary>
    private async Task<AddonResult> InstallSinglePackAsync(string serverId, string archivePath, CancellationToken ct)
    {
        using var archive = ZipFile.OpenRead(archivePath);
        var manifestEntry = archive.Entries.FirstOrDefault(e =>
            e.FullName.Replace('\\', '/').EndsWith("manifest.json", StringComparison.OrdinalIgnoreCase));
        if (manifestEntry is null)
        {
            return new AddonResult(false, null,
                "No manifest.json found in this pack, so it is not a valid Bedrock add-on.", null);
        }

        var manifest = await ReadManifestAsync(manifestEntry, ct);
        if (manifest is null)
        {
            return new AddonResult(false, null, "manifest.json could not be parsed.", null);
        }

        var packKind = ClassifyManifest(manifest);
        if (packKind is null)
        {
            return new AddonResult(false, null,
                "manifest.json declares no recognised module type (expected behavior, resources or skin_pack).", null);
        }

        var folderName = SafeFolderName(manifest);
        var serverDir = _installer.ServerDirectory(serverId);
        var packRoot = Path.Combine(serverDir, packKind.Directory, folderName);

        if (Directory.Exists(packRoot)) Directory.Delete(packRoot, recursive: true);
        Directory.CreateDirectory(packRoot);

        // Entries may be nested one level deep inside the archive.
        var prefix = CommonPrefix(archive.Entries);
        foreach (var entry in archive.Entries)
        {
            ct.ThrowIfCancellationRequested();
            var normalised = entry.FullName.Replace('\\', '/');
            if (string.IsNullOrEmpty(entry.Name)) continue;
            var relative = prefix is not null && normalised.StartsWith(prefix, StringComparison.Ordinal)
                ? normalised[prefix.Length..]
                : normalised;
            if (string.IsNullOrEmpty(relative)) continue;
            var target = ServerFileManager.ResolveInsideRoot(packRoot, relative);
            if (target is null) continue; // refuse zip-slip
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            entry.ExtractToFile(target, overwrite: true);
        }

        RegisterPack(serverId, packKind, manifest, folderName);

        _logger.LogInformation("Installed {Kind} pack {Folder} for {ServerId}", packKind.Directory, folderName, serverId);
        return new AddonResult(true, packRoot, null, manifest.Header.Uuid);
    }

    /// <summary>An .mcaddon: a zip of zips. Install each contained pack.</summary>
    private async Task<AddonResult> InstallBundleAsync(string serverId, string archivePath, CancellationToken ct)
    {
        // Extract the contained packs first, then dispose the outer archive
        // before installing them — installing re-opens archives and we do not
        // want two handles on the same file.
        var extracted = new List<(string Name, string Path)>();
        try
        {
            using (var archive = ZipFile.OpenRead(archivePath))
            {
                var packs = archive.Entries
                    .Where(e => AllowedExtensions.Any(ext =>
                        e.FullName.EndsWith(ext, StringComparison.OrdinalIgnoreCase)))
                    .ToList();

                if (packs.Count == 0)
                {
                    // Some .mcaddon files are a single flat pack, not a bundle.
                    return await InstallSinglePackAsync(serverId, archivePath, ct);
                }

                foreach (var pack in packs)
                {
                    ct.ThrowIfCancellationRequested();
                    var tempPack = Path.Combine(Path.GetTempPath(), $"oghost-pack-{Guid.NewGuid():N}.mcpack");
                    pack.ExtractToFile(tempPack, overwrite: true);
                    extracted.Add((pack.Name, tempPack));
                }
            }

            var installed = new List<string>();
            string? lastError = null;

            foreach (var (name, tempPack) in extracted)
            {
                ct.ThrowIfCancellationRequested();
                var result = await InstallSinglePackAsync(serverId, tempPack, ct);
                if (result.Success) installed.Add(name);
                else lastError = result.Error;
            }

            if (installed.Count == 0)
            {
                return new AddonResult(false, null,
                    lastError ?? "No packs could be installed from this .mcaddon.", null);
            }
            return new AddonResult(true, _installer.ServerDirectory(serverId),
                lastError is null ? null : $"Installed {installed.Count} pack(s); some failed: {lastError}", null);
        }
        finally
        {
            foreach (var (_, path) in extracted)
            {
                try { File.Delete(path); } catch { /* best effort */ }
            }
        }
    }

    /// <summary>A .mcworld replaces the world. Requires the server to be stopped.</summary>
    private async Task<AddonResult> InstallWorldAsync(
        string serverId, string worldName, string archivePath, CancellationToken ct)
    {
        var worldDir = _installer.WorldDirectory(worldName);
        var serverDir = _installer.ServerDirectory(serverId);
        var linkTarget = Path.Combine(serverDir, "worlds", worldName);

        // Move the existing world aside instead of deleting it.
        if (Directory.Exists(worldDir))
        {
            var aside = worldDir + $".pre-mcworld-{DateTime.UtcNow:yyyyMMddHHmmss}";
            Directory.Move(worldDir, aside);
        }
        Directory.CreateDirectory(worldDir);

        using (var archive = ZipFile.OpenRead(archivePath))
        {
            var prefix = CommonPrefix(archive.Entries);
            foreach (var entry in archive.Entries)
            {
                ct.ThrowIfCancellationRequested();
                if (string.IsNullOrEmpty(entry.Name)) continue;
                var normalised = entry.FullName.Replace('\\', '/');
                var relative = prefix is not null && normalised.StartsWith(prefix, StringComparison.Ordinal)
                    ? normalised[prefix.Length..]
                    : normalised;
                if (string.IsNullOrEmpty(relative)) continue;
                var target = ServerFileManager.ResolveInsideRoot(worldDir, relative);
                if (target is null) continue; // refuse zip-slip
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                entry.ExtractToFile(target, overwrite: true);
            }
        }

        if (!Directory.Exists(linkTarget))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(linkTarget)!);
            try { Directory.CreateSymbolicLink(linkTarget, worldDir); }
            catch { /* LinkServer will recreate it on the next install/start */ }
        }

        return new AddonResult(true, worldDir, null, null);
    }

    private sealed record PackKind(string Directory, string RegistryFile);

    private static PackKind? ClassifyManifest(Manifest manifest)
    {
        foreach (var module in manifest.Modules ?? Array.Empty<ManifestModule>())
        {
            var type = (module.Type ?? string.Empty).ToLowerInvariant();
            if (type.Contains("data") || type.Contains("script") || type.Contains("behavior") || type.Contains("behaviour"))
            {
                return new PackKind("behavior_packs", "world_behavior_packs.json");
            }
            if (type.Contains("resources") || type.Contains("resource"))
            {
                return new PackKind("resource_packs", "world_resource_packs.json");
            }
            if (type.Contains("skin"))
            {
                return new PackKind("skin_packs", "skin_packs.json");
            }
        }
        return null;
    }

    /// <summary>
    /// Register the pack in the world's pack list so BDS actually loads it.
    /// Without this step the files sit on disk and nothing happens — the most
    /// common reason add-ons "don't work".
    /// </summary>
    private void RegisterPack(string serverId, PackKind kind, Manifest manifest, string folderName)
    {
        if (kind.Directory == "skin_packs") return; // skin packs are not world-scoped on BDS

        var serverDir = _installer.ServerDirectory(serverId);
        var registryPath = Path.Combine(serverDir, kind.RegistryFile);

        var entries = new List<RegistryEntry>();
        if (File.Exists(registryPath))
        {
            try
            {
                var existing = JsonSerializer.Deserialize<List<RegistryEntry>>(File.ReadAllText(registryPath));
                if (existing is not null) entries = existing;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Could not parse {File}; recreating it", registryPath);
            }
        }

        var uuid = manifest.Header.Uuid;
        var version = manifest.Header.Version ?? new[] { 1, 0, 0 };
        entries.RemoveAll(e => string.Equals(e.PackId, uuid, StringComparison.OrdinalIgnoreCase));
        entries.Add(new RegistryEntry { PackId = uuid, Version = version });

        var json = JsonSerializer.Serialize(entries, new JsonSerializerOptions { WriteIndented = true });
        Directory.CreateDirectory(serverDir);
        File.WriteAllText(registryPath, json);
    }

    private static async Task<Manifest?> ReadManifestAsync(ZipArchiveEntry entry, CancellationToken ct)
    {
        try
        {
            await using var stream = entry.Open();
            return await JsonSerializer.DeserializeAsync<Manifest>(stream, cancellationToken: ct);
        }
        catch
        {
            return null;
        }
    }

    private static string SafeFolderName(Manifest manifest)
    {
        var name = manifest.Header.Name ?? manifest.Header.Uuid ?? "pack";
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray()).Trim();
        return string.IsNullOrWhiteSpace(cleaned) ? "pack" : cleaned;
    }

    /// <summary>Detect a single common top-level folder inside the archive.</summary>
    private static string? CommonPrefix(IReadOnlyList<ZipArchiveEntry> entries)
    {
        var first = entries.FirstOrDefault(e => !string.IsNullOrEmpty(e.Name))?.FullName.Replace('\\', '/');
        if (first is null) return null;
        var slash = first.IndexOf('/');
        if (slash <= 0) return null;
        var prefix = first[..(slash + 1)];
        var allShare = entries
            .Where(e => !string.IsNullOrEmpty(e.Name))
            .All(e => e.FullName.Replace('\\', '/').StartsWith(prefix, StringComparison.Ordinal));
        return allShare ? prefix : null;
    }

    private static bool IsZip(string path)
    {
        try
        {
            using var archive = ZipFile.OpenRead(path);
            return archive.Entries.Count > 0;
        }
        catch
        {
            return false;
        }
    }

    private sealed class Manifest
    {
        public ManifestHeader Header { get; set; } = new();
        public ManifestModule[]? Modules { get; set; }
    }

    private sealed class ManifestHeader
    {
        public string? Uuid { get; set; }
        public string? Name { get; set; }
        public int[]? Version { get; set; }
    }

    private sealed class ManifestModule
    {
        public string? Type { get; set; }
        public string? Uuid { get; set; }
        public int[]? Version { get; set; }
    }

    private sealed class RegistryEntry
    {
        public string? PackId { get; set; }
        public int[]? Version { get; set; }
    }
}
