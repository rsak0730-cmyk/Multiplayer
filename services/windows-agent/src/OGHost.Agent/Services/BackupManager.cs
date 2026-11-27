using System.IO.Compression;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Services;

public sealed record BackupResult(bool Success, string? FileName, long SizeBytes, string? Error);

/// <summary>
/// World backups. Archives live on this device under {data}/backups/{serverId}.
///
/// Consistency matters more than speed: a Bedrock world is a folder of LevelDB
/// chunks being written continuously, so zipping it mid-write can capture a
/// torn chunk. When the server is running we flush with `save hold` /
/// `save resume` first, and the panel can require a safe stop instead.
/// </summary>
public sealed class BackupManager
{
    private readonly ILogger<BackupManager> _logger;
    private readonly AgentConfigStore _config;
    private readonly BdsInstaller _installer;
    private readonly ServerProcessManager _processes;

    public BackupManager(
        AgentConfigStore config,
        BdsInstaller installer,
        ServerProcessManager processes,
        ILogger<BackupManager> logger)
    {
        _config = config;
        _installer = installer;
        _processes = processes;
        _logger = logger;
    }

    public string BackupDirectory(string serverId) =>
        Path.Combine(_config.Options.BackupsRoot, serverId);

    public string BackupPath(string serverId, string fileName) =>
        Path.Combine(BackupDirectory(serverId), fileName);

    /// <summary>Create a consistent backup of the world plus its configuration.</summary>
    public async Task<BackupResult> CreateAsync(
        string serverId, string worldName, string name, bool safeStopIfRunning, CancellationToken ct)
    {
        try
        {
            var serverDir = _installer.ServerDirectory(serverId);
            var worldDir = _installer.WorldDirectory(worldName);
            if (!Directory.Exists(worldDir) && !Directory.Exists(serverDir))
            {
                return new BackupResult(false, null, 0, "Nothing to back up: no world or server directory exists yet.");
            }

            var managed = _processes.Get(serverId);
            var wasRunning = managed?.Process is { HasExited: false };
            var stoppedForBackup = false;

            if (wasRunning && safeStopIfRunning)
            {
                var (ok, error) = await _processes.StopAsync(serverId, 60, ct);
                if (!ok)
                {
                    return new BackupResult(false, null, 0,
                        $"Could not stop the server safely before backing up: {error}");
                }
                stoppedForBackup = true;
            }
            else if (wasRunning)
            {
                // Flush the world to disk without stopping, so the archive is
                // as consistent as BDS allows while live.
                await FlushAsync(serverId);
            }

            Directory.CreateDirectory(BackupDirectory(serverId));
            var fileName = $"{Sanitize(name)}.zip";
            var destination = BackupPath(serverId, fileName);
            if (File.Exists(destination)) File.Delete(destination);

            using (var archive = ZipFile.Open(destination, ZipArchiveMode.Create))
            {
                if (Directory.Exists(worldDir))
                {
                    await AddDirectoryAsync(archive, worldDir, $"worlds/{worldName}", ct);
                }

                // Configuration travels with the world so a restore is complete.
                foreach (var configName in new[]
                         {
                             "server.properties", "allowlist.json", "permissions.json",
                             "server_admin_allowlist.json", "valid_known_packs.json",
                             "world_resource_packs.json", "world_behavior_packs.json",
                         })
                {
                    var path = Path.Combine(serverDir, configName);
                    if (File.Exists(path))
                    {
                        archive.CreateEntryFromFile(path, $"config/{configName}", CompressionLevel.Optimal);
                    }
                }

                foreach (var packDir in new[] { "behavior_packs", "resource_packs" })
                {
                    var path = Path.Combine(serverDir, packDir);
                    if (Directory.Exists(path))
                    {
                        await AddDirectoryAsync(archive, path, packDir, ct);
                    }
                }

                var meta = archive.CreateEntry("oghost-backup.json", CompressionLevel.Optimal);
                await using (var writer = new StreamWriter(meta.Open()))
                {
                    await writer.WriteAsync($$"""
                    {
                      "server_id": "{{serverId}}",
                      "world_name": "{{worldName}}",
                      "minecraft_version": "{{managed?.InstalledVersion ?? _installer.GetInstalledVersion(serverId) ?? ""}}",
                      "agent_version": "{{typeof(BackupManager).Assembly.GetName().Version?.ToString(3)}}",
                      "created_at": "{{DateTime.UtcNow:O}}",
                      "stopped_for_backup": {{(stoppedForBackup ? "true" : "false")}}
                    }
                    """);
                }
            }

            var size = new FileInfo(destination).Length;

            if (stoppedForBackup)
            {
                // Leave the server stopped: the operator asked for a safe stop
                // and restarting without being asked would be surprising.
                _logger.LogInformation("Backup {File} created ({Bytes} bytes); server left stopped", fileName, size);
            }

            return new BackupResult(true, fileName, size, null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Backup failed for {ServerId}", serverId);
            return new BackupResult(false, null, 0, ex.Message);
        }
    }

    /// <summary>Restore a backup. Refuses to run against a live server.</summary>
    public async Task<BackupResult> RestoreAsync(
        string serverId, string worldName, string fileName, CancellationToken ct)
    {
        try
        {
            var managed = _processes.Get(serverId);
            if (managed?.Process is { HasExited: false })
            {
                return new BackupResult(false, null, 0,
                    "Cannot restore while the server is running. Stop it first — restoring over a live world corrupts it.");
            }

            var archivePath = BackupPath(serverId, fileName);
            if (!File.Exists(archivePath))
            {
                return new BackupResult(false, null, 0, $"Backup file “{fileName}” is not on this device.");
            }

            var serverDir = _installer.ServerDirectory(serverId);
            var worldDir = _installer.WorldDirectory(worldName);

            // Move the current world aside rather than deleting it, so a bad
            // restore is still recoverable.
            if (Directory.Exists(worldDir))
            {
                var aside = worldDir + $".pre-restore-{DateTime.UtcNow:yyyyMMddHHmmss}";
                Directory.Move(worldDir, aside);
                _logger.LogInformation("Existing world moved aside to {Path}", aside);
            }

            Directory.CreateDirectory(worldDir);

            using (var archive = ZipFile.OpenRead(archivePath))
            {
                var worldPrefix = $"worlds/{worldName}/";
                foreach (var entry in archive.Entries)
                {
                    ct.ThrowIfCancellationRequested();
                    var normalised = entry.FullName.Replace('\\', '/');
                    if (normalised.StartsWith(worldPrefix, StringComparison.OrdinalIgnoreCase))
                    {
                        var relative = normalised[worldPrefix.Length..];
                        if (string.IsNullOrEmpty(relative)) continue;
                        var target = ServerFileManager.ResolveInsideRoot(worldDir, relative);
                        if (target is null) continue; // refuse traversal inside the archive
                        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(target);
                        }
                        else
                        {
                            entry.ExtractToFile(target, overwrite: true);
                        }
                    }
                    else if (normalised.StartsWith("config/", StringComparison.OrdinalIgnoreCase))
                    {
                        var name = Path.GetFileName(normalised);
                        if (string.IsNullOrEmpty(name)) continue;
                        var target = ServerFileManager.ResolveInsideRoot(serverDir, name);
                        if (target is null) continue;
                        Directory.CreateDirectory(serverDir);
                        entry.ExtractToFile(target, overwrite: true);
                    }
                    else if (normalised.StartsWith("behavior_packs/", StringComparison.OrdinalIgnoreCase) ||
                             normalised.StartsWith("resource_packs/", StringComparison.OrdinalIgnoreCase))
                    {
                        var target = ServerFileManager.ResolveInsideRoot(serverDir, normalised);
                        if (target is null) continue;
                        if (string.IsNullOrEmpty(entry.Name))
                        {
                            Directory.CreateDirectory(target);
                        }
                        else
                        {
                            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                            entry.ExtractToFile(target, overwrite: true);
                        }
                    }
                }
            }

            var size = new FileInfo(archivePath).Length;
            _logger.LogInformation("Restored {File} for {ServerId}", fileName, serverId);
            return new BackupResult(true, fileName, size, null);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Restore failed for {ServerId}", serverId);
            return new BackupResult(false, null, 0, ex.Message);
        }
    }

    public bool Delete(string serverId, string fileName)
    {
        try
        {
            var path = BackupPath(serverId, fileName);
            if (!File.Exists(path)) return false;
            File.Delete(path);
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not delete backup {File}", fileName);
            return false;
        }
    }

    /// <summary>Enforce a keep-count so scheduled backups cannot fill the disk.</summary>
    public void Prune(string serverId, int keepCount)
    {
        try
        {
            var dir = BackupDirectory(serverId);
            if (!Directory.Exists(dir)) return;
            var files = Directory.GetFiles(dir, "*.zip")
                .Select(f => new FileInfo(f))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Skip(Math.Max(1, keepCount))
                .ToList();
            foreach (var file in files)
            {
                file.Delete();
                _logger.LogInformation("Pruned old backup {File}", file.Name);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Backup pruning failed for {ServerId}", serverId);
        }
    }

    public IReadOnlyList<(string FileName, long SizeBytes, DateTime CreatedAt)> List(string serverId)
    {
        var dir = BackupDirectory(serverId);
        if (!Directory.Exists(dir)) return Array.Empty<(string, long, DateTime)>();
        return Directory.GetFiles(dir, "*.zip")
            .Select(f => new FileInfo(f))
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Select(f => (f.Name, f.Length, f.LastWriteTimeUtc))
            .ToList();
    }

    private async Task FlushAsync(string serverId)
    {
        // `save hold` asks BDS to queue writes; `save resume` releases them.
        await _processes.SendCommandAsync(serverId, "save hold", CancellationToken.None);
        await Task.Delay(2500);
        await _processes.SendCommandAsync(serverId, "save resume", CancellationToken.None);
        await Task.Delay(500);
    }

    private static async Task AddDirectoryAsync(
        ZipArchive archive, string sourceDir, string entryPrefix, CancellationToken ct)
    {
        foreach (var file in Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            ct.ThrowIfCancellationRequested();
            var relative = Path.GetRelativePath(sourceDir, file).Replace('\\', '/');
            var entryName = $"{entryPrefix}/{relative}";
            try
            {
                archive.CreateEntryFromFile(file, entryName, CompressionLevel.Optimal);
            }
            catch (IOException ex)
            {
                // LevelDB files can be locked while the server runs; skipping
                // one is better than failing the whole backup, but we log it so
                // the operator knows the archive may be incomplete.
                archive.CreateEntry($"oghost-warnings/{Path.GetFileName(file)}.txt")
                    .Open()
                    .Write(System.Text.Encoding.UTF8.GetBytes(
                        $"Skipped during backup: {ex.Message}"));
            }
        }
        await Task.CompletedTask;
    }

    /// <summary>
    /// Turn a user-supplied backup name into a safe single file name.
    ///
    /// Two things must be true: no path separator can survive (so the name can
    /// never escape the backup directory), and no ".." run can survive (so the
    /// result is never mistaken for a traversal by anything downstream). A
    /// legitimate name such as "world-2024.01.01" is unaffected — only runs of
    /// two or more dots are collapsed.
    /// </summary>
    private static string Sanitize(string name)
    {
        var invalid = Path.GetInvalidFileNameChars();
        var cleaned = new string(name.Select(c => invalid.Contains(c) ? '_' : c).ToArray());

        // Collapse ".." (and longer runs) down to a single dot.
        while (cleaned.Contains("..", StringComparison.Ordinal))
        {
            cleaned = cleaned.Replace("..", ".", StringComparison.Ordinal);
        }

        cleaned = cleaned.Trim().TrimStart('.');
        return string.IsNullOrWhiteSpace(cleaned) ? "backup" : cleaned;
    }
}
