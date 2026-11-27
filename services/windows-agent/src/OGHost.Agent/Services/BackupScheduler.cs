using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Services;

/// <summary>Schedule settings persisted per server by the panel.</summary>
public sealed record BackupSchedule(
    bool Enabled,
    int IntervalHours,
    int KeepCount,
    bool SafeStopServer,
    bool UploadToDrive);

/// <summary>
/// Runs scheduled backups locally on the node.
///
/// This lives on the device rather than in the cloud on purpose: backups keep
/// happening even when nobody has the website open, when the phone is off, or
/// when the control plane is unreachable. The panel only stores the settings.
/// </summary>
public sealed class BackupScheduler : BackgroundService
{
    private readonly ILogger<BackupScheduler> _logger;
    private readonly AgentConfigStore _config;
    private readonly BdsInstaller _installer;
    private readonly BackupManager _backups;
    private readonly ServerProcessManager _processes;
    private readonly Dictionary<string, DateTime> _nextRun = new();

    public BackupScheduler(
        AgentConfigStore config,
        BdsInstaller installer,
        BackupManager backups,
        ServerProcessManager processes,
        ILogger<BackupScheduler> logger)
    {
        _config = config;
        _installer = installer;
        _backups = backups;
        _processes = processes;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Wait a moment so startup pairing/heartbeat happens first.
        await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken).ConfigureAwait(false);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Backup scheduler tick failed");
            }

            await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken).ConfigureAwait(false);
        }
    }

    private async Task TickAsync(CancellationToken ct)
    {
        if (!Directory.Exists(_config.Options.ServersRoot)) return;

        foreach (var serverDir in Directory.GetDirectories(_config.Options.ServersRoot))
        {
            ct.ThrowIfCancellationRequested();
            var serverId = Path.GetFileName(serverDir);
            var schedule = ReadSchedule(serverDir);
            if (schedule is null || !schedule.Enabled) continue;

            var due = _nextRun.TryGetValue(serverId, out var when) ? when : DateTime.UtcNow;
            if (DateTime.UtcNow < due) continue;

            var state = _installer.ReadState(serverId);
            var worldName = state.WorldName ?? "world";
            var name = $"scheduled-{DateTime.UtcNow:yyyyMMdd-HHmmss}";

            // Never stop a live server unless the operator asked for it.
            var managed = _processes.Get(serverId);
            var running = managed?.Process is { HasExited: false };
            if (running && !schedule.SafeStopServer)
            {
                _logger.LogInformation(
                    "Skipping scheduled backup for {ServerId}: server is running and safe-stop is disabled", serverId);
                _nextRun[serverId] = DateTime.UtcNow.AddHours(schedule.IntervalHours);
                continue;
            }

            _logger.LogInformation("Running scheduled backup for {ServerId}", serverId);
            var result = await _backups.CreateAsync(serverId, worldName, name, schedule.SafeStopServer, ct);
            if (result.Success)
            {
                _backups.Prune(serverId, schedule.KeepCount);
                _logger.LogInformation(
                    "Scheduled backup {File} created ({Bytes} bytes)", result.FileName, result.SizeBytes);
            }
            else
            {
                _logger.LogWarning("Scheduled backup failed for {ServerId}: {Error}", serverId, result.Error);
            }

            _nextRun[serverId] = DateTime.UtcNow.AddHours(schedule.IntervalHours);
        }
    }

    private static BackupSchedule? ReadSchedule(string serverDir)
    {
        try
        {
            var path = Path.Combine(serverDir, ".oghost-schedule.json");
            if (!File.Exists(path)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(path));
            var root = doc.RootElement;

            bool Bool(string name, bool fallback) =>
                root.TryGetProperty(name, out var p) && (p.ValueKind == JsonValueKind.True || p.ValueKind == JsonValueKind.False)
                    ? p.GetBoolean()
                    : fallback;
            int Int(string name, int fallback) =>
                root.TryGetProperty(name, out var p) && p.ValueKind == JsonValueKind.Number && p.TryGetInt32(out var v)
                    ? v
                    : fallback;

            return new BackupSchedule(
                Bool("enabled", false),
                Math.Clamp(Int("interval_hours", 24), 1, 168),
                Math.Clamp(Int("keep_count", 7), 1, 50),
                Bool("safe_stop_server", false),
                Bool("upload_to_drive", false));
        }
        catch
        {
            return null;
        }
    }
}
