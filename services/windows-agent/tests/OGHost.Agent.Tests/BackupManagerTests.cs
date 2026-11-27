using System.IO.Compression;
using OGHost.Agent.Services;
using Xunit;

namespace OGHost.Agent.Tests;

/// <summary>
/// Backup and restore correctness. A backup that cannot be restored, or a
/// restore that silently destroys the current world, is worse than no backup
/// feature at all — so these tests exercise the real archive round trip.
/// </summary>
public sealed class BackupManagerTests : IDisposable
{
    private readonly AgentConfigStore _config = TestDoubles.Config();
    private readonly BdsInstaller _installer;
    private readonly ServerProcessManager _processes;
    private readonly BackupManager _backups;
    private readonly string _serverId = Guid.NewGuid().ToString();
    private const string World = "testworld";

    public BackupManagerTests()
    {
        _installer = TestDoubles.Installer(_config);
        _processes = new ServerProcessManager(_config, _installer, TestDoubles.Logger<ServerProcessManager>());
        _backups = new BackupManager(_config, _installer, _processes, TestDoubles.Logger<BackupManager>());

        // Build a realistic server directory: engine files, config, world.
        var serverDir = _installer.ServerDirectory(_serverId);
        Directory.CreateDirectory(serverDir);
        File.WriteAllText(Path.Combine(serverDir, "server.properties"), "level-name=testworld\nmax-players=10\n");
        File.WriteAllText(Path.Combine(serverDir, "permissions.json"), "[]\n");
        Directory.CreateDirectory(Path.Combine(serverDir, "behavior_packs", "mypack"));
        File.WriteAllText(Path.Combine(serverDir, "behavior_packs", "mypack", "manifest.json"), "{}");

        var worldDir = _installer.WorldDirectory(World);
        Directory.CreateDirectory(Path.Combine(worldDir, "db"));
        File.WriteAllText(Path.Combine(worldDir, "level.dat"), "world-data-v1");
        File.WriteAllText(Path.Combine(worldDir, "db", "000001.ldb"), "chunk-data");
    }

    public void Dispose()
    {
        try { Directory.Delete(_config.Options.DataDirectory, recursive: true); } catch { /* best effort */ }
    }

    [Fact]
    public async Task Backup_creates_an_archive_containing_the_world_and_config()
    {
        var result = await _backups.CreateAsync(_serverId, World, "manual-1", safeStopIfRunning: false, CancellationToken.None);

        Assert.True(result.Success, result.Error);
        Assert.Equal("manual-1.zip", result.FileName);
        Assert.True(result.SizeBytes > 0);

        using var archive = ZipFile.OpenRead(_backups.BackupPath(_serverId, result.FileName!));
        var names = archive.Entries.Select(e => e.FullName.Replace('\\', '/')).ToList();

        Assert.Contains(names, n => n == $"worlds/{World}/level.dat");
        Assert.Contains(names, n => n == $"worlds/{World}/db/000001.ldb");
        Assert.Contains(names, n => n == "config/server.properties");
        Assert.Contains(names, n => n == "config/permissions.json");
        Assert.Contains(names, n => n == "oghost-backup.json");
    }

    [Fact]
    public async Task Backup_metadata_records_the_bedrock_version_and_timestamp()
    {
        _installer.WriteState(_serverId, new ServerState("1.21.20", World, null, DateTime.UtcNow));

        var result = await _backups.CreateAsync(_serverId, World, "meta", safeStopIfRunning: false, CancellationToken.None);
        Assert.True(result.Success, result.Error);

        using var archive = ZipFile.OpenRead(_backups.BackupPath(_serverId, result.FileName!));
        var entry = archive.GetEntry("oghost-backup.json");
        Assert.NotNull(entry);
        using var reader = new StreamReader(entry!.Open());
        var json = await reader.ReadToEndAsync();

        Assert.Contains("1.21.20", json);
        Assert.Contains(World, json);
        Assert.Contains("created_at", json);
    }

    [Fact]
    public async Task Restore_brings_back_a_deleted_world()
    {
        var backup = await _backups.CreateAsync(_serverId, World, "before-loss", safeStopIfRunning: false, CancellationToken.None);
        Assert.True(backup.Success, backup.Error);

        // Simulate the disaster: wipe the world.
        Directory.Delete(_installer.WorldDirectory(World), recursive: true);
        Assert.False(File.Exists(Path.Combine(_installer.WorldDirectory(World), "level.dat")));

        var restore = await _backups.RestoreAsync(_serverId, World, backup.FileName!, CancellationToken.None);
        Assert.True(restore.Success, restore.Error);

        Assert.Equal("world-data-v1",
            await File.ReadAllTextAsync(Path.Combine(_installer.WorldDirectory(World), "level.dat")));
        Assert.True(File.Exists(Path.Combine(_installer.WorldDirectory(World), "db", "000001.ldb")));
    }

    [Fact]
    public async Task Restore_moves_the_current_world_aside_instead_of_deleting_it()
    {
        var backup = await _backups.CreateAsync(_serverId, World, "safe", safeStopIfRunning: false, CancellationToken.None);
        Assert.True(backup.Success, backup.Error);

        // Change the live world after the backup was taken.
        await File.WriteAllTextAsync(Path.Combine(_installer.WorldDirectory(World), "level.dat"), "world-data-v2");

        var restore = await _backups.RestoreAsync(_serverId, World, backup.FileName!, CancellationToken.None);
        Assert.True(restore.Success, restore.Error);

        // The restored world is v1…
        Assert.Equal("world-data-v1",
            await File.ReadAllTextAsync(Path.Combine(_installer.WorldDirectory(World), "level.dat")));

        // …and v2 is still recoverable from the aside directory.
        var aside = Directory.GetDirectories(_config.Options.WorldsRoot)
            .FirstOrDefault(d => d.Contains("pre-restore"));
        Assert.NotNull(aside);
        Assert.Equal("world-data-v2", await File.ReadAllTextAsync(Path.Combine(aside!, "level.dat")));
    }

    [Fact]
    public async Task Restore_of_a_missing_file_fails_with_a_clear_reason()
    {
        var result = await _backups.RestoreAsync(_serverId, World, "never-existed.zip", CancellationToken.None);
        Assert.False(result.Success);
        Assert.Contains("not on this device", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Backup_fails_when_there_is_nothing_to_archive()
    {
        var emptyServer = Guid.NewGuid().ToString();
        var result = await _backups.CreateAsync(emptyServer, "no-world", "empty", safeStopIfRunning: false, CancellationToken.None);
        Assert.False(result.Success);
        Assert.Contains("Nothing to back up", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Prune_keeps_only_the_requested_number_of_backups()
    {
        for (var i = 0; i < 5; i++)
        {
            var r = await _backups.CreateAsync(_serverId, World, $"b{i}", safeStopIfRunning: false, CancellationToken.None);
            Assert.True(r.Success, r.Error);
            await Task.Delay(20); // ensure distinct timestamps
        }
        Assert.Equal(5, _backups.List(_serverId).Count);

        _backups.Prune(_serverId, keepCount: 2);

        var remaining = _backups.List(_serverId);
        Assert.Equal(2, remaining.Count);
        // The newest survive.
        Assert.Contains(remaining, r => r.FileName.Contains("b4"));
        Assert.Contains(remaining, r => r.FileName.Contains("b3"));
    }

    [Fact]
    public async Task Delete_removes_the_archive()
    {
        var backup = await _backups.CreateAsync(_serverId, World, "to-delete", safeStopIfRunning: false, CancellationToken.None);
        Assert.True(backup.Success, backup.Error);

        Assert.True(_backups.Delete(_serverId, backup.FileName!));
        Assert.False(_backups.Delete(_serverId, backup.FileName!));
    }

    [Fact]
    public async Task Backup_names_are_sanitised_against_path_injection()
    {
        var hostile = "../../evil";
        var result = await _backups.CreateAsync(_serverId, World, hostile, safeStopIfRunning: false, CancellationToken.None);
        Assert.True(result.Success, result.Error);

        var path = _backups.BackupPath(_serverId, result.FileName!);
        Assert.StartsWith(_backups.BackupDirectory(_serverId), path, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("..", result.FileName);
    }

    [Fact]
    public async Task Restore_ignores_traversal_entries_inside_a_hostile_archive()
    {
        // Craft an archive whose world entries try to escape the world directory.
        var hostile = Path.Combine(_backups.BackupDirectory(_serverId), "hostile.zip");
        Directory.CreateDirectory(Path.GetDirectoryName(hostile)!);
        using (var archive = ZipFile.Open(hostile, ZipArchiveMode.Create))
        {
            var entry = archive.CreateEntry($"worlds/{World}/../../../../escape.txt");
            using var writer = new StreamWriter(entry.Open());
            await writer.WriteAsync("pwned");
            var good = archive.CreateEntry($"worlds/{World}/level.dat");
            using var gw = new StreamWriter(good.Open());
            await gw.WriteAsync("safe-world");
        }

        var result = await _backups.RestoreAsync(_serverId, World, "hostile.zip", CancellationToken.None);
        Assert.True(result.Success, result.Error);

        // Nothing escaped. The hostile entry resolves four levels above the world
        // directory, so check that exact target and every level on the way out —
        // checking only one arbitrary parent would pass even with no guard at all.
        var worldDir = _installer.WorldDirectory(World);
        for (var up = 1; up <= 5; up++)
        {
            var ancestor = Path.GetFullPath(worldDir, string.Join('/', Enumerable.Repeat("..", up)));
            Assert.False(File.Exists(Path.Combine(ancestor, "escape.txt")),
                $"Traversal entry escaped {up} level(s) up to {ancestor}");
        }

        // And nothing called escape.txt exists anywhere under the data directory.
        // Assert.Empty, not DoesNotContain: the claim is that the filtered
        // enumeration yields no files at all. DoesNotContain is a membership test
        // and needs the element to look for, which is not what this expresses.
        Assert.Empty(
            Directory.EnumerateFiles(_config.Options.DataDirectory, "escape.txt", SearchOption.AllDirectories));

        // The legitimate entry in the same archive was still restored.
        Assert.Equal("safe-world",
            await File.ReadAllTextAsync(Path.Combine(worldDir, "level.dat")));
    }
}
