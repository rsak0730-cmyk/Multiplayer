using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace OGHost.Agent;

/// <summary>
/// Persisted agent state, stored as <c>config.json</c> next to the executable
/// so it survives restarts and can be edited by the user without a database.
/// The node token lives only here — it is never logged or sent anywhere except
/// the control plane over HTTPS.
/// </summary>
public sealed class AgentConfigStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly ILogger<AgentConfigStore> _logger;
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public AgentOptions Options { get; private set; }

    public AgentConfigStore(IOptions<AgentOptions> options, ILogger<AgentConfigStore> logger)
    {
        _logger = logger;
        Options = options.Value;
        _path = Options.ConfigPath;
    }

    /// <summary>Load config.json over the defaults, creating directories.</summary>
    public async Task LoadAsync(CancellationToken ct)
    {
        EnsureDirectories();
        if (!File.Exists(_path))
        {
            await SaveAsync(ct);
            _logger.LogInformation("Created {Path} — edit it to add your pairing code.", _path);
            return;
        }

        try
        {
            await using var stream = File.OpenRead(_path);
            var loaded = await JsonSerializer.DeserializeAsync<AgentOptions>(stream, JsonOptions, ct);
            if (loaded is null) return;

            // Environment/appsettings win for the control plane URL only if the
            // file left it at the default; otherwise the file is authoritative.
            var merged = Options;
            merged.PairingCode = FirstNonEmpty(loaded.PairingCode, merged.PairingCode);
            merged.NodeToken = FirstNonEmpty(loaded.NodeToken, merged.NodeToken);
            merged.NodeId = FirstNonEmpty(loaded.NodeId, merged.NodeId);
            merged.ControlPlaneUrl = FirstNonEmpty(loaded.ControlPlaneUrl, merged.ControlPlaneUrl)
                ?.TrimEnd('/') ?? merged.ControlPlaneUrl;
            if (!string.IsNullOrWhiteSpace(loaded.DataDirectory))
                merged.DataDirectory = loaded.DataDirectory;
            if (!string.IsNullOrWhiteSpace(loaded.PlayitSecret))
                merged.PlayitSecret = loaded.PlayitSecret;
            if (!string.IsNullOrWhiteSpace(loaded.PlayitAgentPath))
                merged.PlayitAgentPath = loaded.PlayitAgentPath;
            merged.AutoRestartOnCrash = loaded.AutoRestartOnCrash;
            merged.MaxAutoRestarts = loaded.MaxAutoRestarts > 0 ? loaded.MaxAutoRestarts : merged.MaxAutoRestarts;
            merged.HonorAutoStart = loaded.HonorAutoStart;
            merged.MinFreeRamMb = loaded.MinFreeRamMb > 0 ? loaded.MinFreeRamMb : merged.MinFreeRamMb;
            merged.MinFreeDiskMb = loaded.MinFreeDiskMb > 0 ? loaded.MinFreeDiskMb : merged.MinFreeDiskMb;
            merged.UsePreviewChannel = loaded.UsePreviewChannel;
            if (loaded.HeartbeatIntervalSeconds > 0) merged.HeartbeatIntervalSeconds = loaded.HeartbeatIntervalSeconds;
            if (loaded.PollIntervalSeconds > 0) merged.PollIntervalSeconds = loaded.PollIntervalSeconds;
            if (loaded.LogFlushIntervalSeconds > 0) merged.LogFlushIntervalSeconds = loaded.LogFlushIntervalSeconds;

            Options = merged;
            EnsureDirectories();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Could not parse {Path}; using defaults.", _path);
        }
    }

    /// <summary>Persist current options atomically.</summary>
    public async Task SaveAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            EnsureDirectories();
            var temp = _path + ".tmp";
            await using (var stream = File.Create(temp))
            {
                await JsonSerializer.SerializeAsync(stream, Options, JsonOptions, ct);
            }
            File.Move(temp, _path, overwrite: true);
        }
        finally
        {
            _gate.Release();
        }
    }

    public bool IsPaired => !string.IsNullOrWhiteSpace(Options.NodeToken);

    private void EnsureDirectories()
    {
        foreach (var dir in new[]
                 {
                     Options.DataDirectory, Options.ServersRoot, Options.EnginesRoot,
                     Options.WorldsRoot, Options.BackupsRoot, Options.DownloadsRoot,
                 })
        {
            try
            {
                Directory.CreateDirectory(dir);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Could not create directory {Dir}", dir);
            }
        }
    }

    private static string? FirstNonEmpty(string? a, string? b) =>
        !string.IsNullOrWhiteSpace(a) ? a : b;
}
