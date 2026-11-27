using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using OGHost.Agent.Models;

namespace OGHost.Agent.Services;

/// <summary>Live state of one Bedrock server process on this node.</summary>
public sealed class ManagedServer
{
    public required string ServerId { get; init; }
    // set, not init: an owner can rename a world between starts, and StartAsync
    // refreshes this on the already-tracked instance.
    public required string WorldName { get; set; }
    public required string Directory { get; init; }
    public Process? Process { get; set; }
    public string Status { get; set; } = "stopped";
    public string? InstalledVersion { get; set; }
    public string? LastError { get; set; }
    public int OnlinePlayers { get; set; }
    public int MaxPlayers { get; set; } = 10;
    public int Port { get; set; } = 19132;
    public string? PublicAddress { get; set; }
    public int? PublicPort { get; set; }
    public bool NetworkingVerified { get; set; }
    public int AutoRestartCount { get; set; }
    public DateTime? StartedAt { get; set; }
    public bool StopRequested { get; set; }

    private readonly ConcurrentQueue<ConsoleLogLine> _pending = new();
    private readonly ConcurrentDictionary<string, DateTime> _players = new();

    public IReadOnlyList<string> CurrentPlayers => _players.Keys.ToList();

    public void EnqueueLog(string line, string stream)
    {
        if (string.IsNullOrEmpty(line)) return;
        _pending.Enqueue(new ConsoleLogLine(Truncate(line, 3900), stream));
        while (_pending.Count > 5000 && _pending.TryDequeue(out _)) { }
    }

    public List<ConsoleLogLine> DrainLogs(int max = 200)
    {
        var batch = new List<ConsoleLogLine>(Math.Min(max, _pending.Count));
        while (batch.Count < max && _pending.TryDequeue(out var line)) batch.Add(line);
        return batch;
    }

    public void SetPlayers(IEnumerable<string> names)
    {
        _players.Clear();
        foreach (var name in names) _players[name] = DateTime.UtcNow;
        OnlinePlayers = _players.Count;
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];
}

/// <summary>
/// Owns the real bedrock_server.exe processes on this node: starting them,
/// capturing their output, forwarding allowlisted console commands to stdin,
/// stopping them gracefully, and detecting crashes.
///
/// There is no shell here. The only executable ever launched is
/// bedrock_server.exe from an official BDS install directory, with no
/// user-controlled arguments — user input reaches the process exclusively
/// through stdin, and only after allowlist validation.
/// </summary>
public sealed class ServerProcessManager
{
    private const string ExecutableName = "bedrock_server.exe";

    // BDS console output patterns. Kept permissive because Mojang changes the
    // wording between versions; a miss only costs us a player-count update,
    // never correctness of the process lifecycle.
    private static readonly Regex PlayerConnected = new(
        @"Player connected:\s*(?<name>[^,\r\n]+)", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex PlayerDisconnected = new(
        @"Player disconnected:\s*(?<name>[^,\r\n]+)", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex ListOutput = new(
        @"There are (?<count>\d+)(?:/\d+)? players online", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex ServerStarted = new(
        @"Server started", RegexOptions.Compiled | RegexOptions.IgnoreCase);
    private static readonly Regex VersionLine = new(
        @"Version\s+(?<version>\d+\.\d+\.\d+(?:\.\d+)?)", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly HashSet<string> AllowedCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "say","tell","tellraw","list","whitelist","allowlist","op","deop","kick","ban","pardon",
        "gamemode","difficulty","time","weather","tp","teleport","give","xp","effect","enchant",
        "kill","fill","setblock","clone","structure","save","stop","help","version","locate",
        "summon","execute","scoreboard","gamerule","setworldspawn","spawnpoint","clear",
        "fog","function","reload","script","testfor","testforblock","testforblocks","title",
        "titleraw","tickingarea","transfer","event","inputpermission","permission","replaceitem",
        "ride","rotate","sculk","setmaxplayers","simulationdistance","stopsound","tag",
        "worldborder","worldbuilder","fillbiome","kickall","playsound","me","w","msg",
    };

    private readonly ConcurrentDictionary<string, ManagedServer> _servers = new();
    private readonly ILogger<ServerProcessManager> _logger;
    private readonly AgentConfigStore _config;
    private readonly BdsInstaller _installer;

    public ServerProcessManager(
        AgentConfigStore config, BdsInstaller installer, ILogger<ServerProcessManager> logger)
    {
        _config = config;
        _installer = installer;
        _logger = logger;
    }

    public IReadOnlyCollection<ManagedServer> All => _servers.Values.ToList();

    public ManagedServer? Get(string serverId) => _servers.GetValueOrDefault(serverId);

    public ManagedServer GetOrAdd(string serverId, string worldName)
    {
        return _servers.GetOrAdd(serverId, id => new ManagedServer
        {
            ServerId = id,
            WorldName = worldName,
            Directory = _installer.ServerDirectory(id),
            InstalledVersion = _installer.GetInstalledVersion(id),
        });
    }

    /// <summary>
    /// Start the BDS process. Fails with a clear reason rather than pretending
    /// success: missing engine, not enough RAM, or an executable that exits
    /// immediately are all reported back to the panel.
    /// </summary>
    public async Task<(bool Success, string? Error, string? Version)> StartAsync(
        string serverId, string worldName, int port, int maxPlayers, CancellationToken ct)
    {
        var server = GetOrAdd(serverId, worldName);
        server.Port = port;
        server.MaxPlayers = maxPlayers;
        server.WorldName = worldName;
        // Directory is not refreshed here: it is a pure function of the server id
        // and GetOrAdd already set it, so reassigning it could only ever write the
        // same value back. It stays init-only.

        if (server.Process is { HasExited: false })
        {
            return (true, null, server.InstalledVersion);
        }

        var exePath = Path.Combine(server.Directory, ExecutableName);
        if (!File.Exists(exePath))
        {
            server.Status = "error";
            server.LastError = "bedrock_server.exe is not installed for this server.";
            return (false, server.LastError, null);
        }

        // Resource pre-flight. A 6 GB machine running a browser can easily have
        // less than 1 GB free; starting BDS then just crashes and confuses users.
        var (_, availableRam) = ReadMemory();
        if (availableRam > 0 && availableRam < _config.Options.MinFreeRamMb)
        {
            server.Status = "error";
            server.LastError =
                $"Only {availableRam} MB of RAM is free; at least {_config.Options.MinFreeRamMb} MB is required.";
            return (false, server.LastError, null);
        }

        var (_, availableDisk, _) = ReadStorage();
        if (availableDisk > 0 && availableDisk < _config.Options.MinFreeDiskMb)
        {
            server.Status = "error";
            server.LastError =
                $"Only {availableDisk} MB of storage is free; at least {_config.Options.MinFreeDiskMb} MB is required.";
            return (false, server.LastError, null);
        }

        // Make sure server.properties exists and reflects the panel's settings.
        EnsureProperties(server);

        server.Status = "starting";
        server.LastError = null;
        server.StopRequested = false;
        server.EnqueueLog($"[OG HOST] Starting Bedrock Dedicated Server (port {port})…", "system");

        var psi = new ProcessStartInfo
        {
            FileName = exePath,
            WorkingDirectory = server.Directory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        // BDS takes no arguments that a user should control. Deliberately none.

        try
        {
            var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, e) => HandleOutput(server, e.Data, "stdout");
            process.ErrorDataReceived += (_, e) => HandleOutput(server, e.Data, "stderr");
            process.Exited += (_, _) => HandleExit(server);

            if (!process.Start())
            {
                server.Status = "error";
                server.LastError = "The operating system refused to start bedrock_server.exe.";
                return (false, server.LastError, null);
            }

            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            server.Process = process;
            server.StartedAt = DateTime.UtcNow;
            server.AutoRestartCount = 0;

            // Wait for the "Server started" line, or for an early exit.
            var healthy = await WaitForHealthyAsync(server, TimeSpan.FromSeconds(90), ct);
            if (!healthy)
            {
                var reason = server.LastError ??
                             "The server did not report a successful start within 90 seconds.";
                server.Status = "error";
                TryKill(process);
                return (false, reason, server.InstalledVersion);
            }

            server.Status = "running";
            server.EnqueueLog("[OG HOST] Server is up and accepting connections.", "system");
            _logger.LogInformation("Server {ServerId} started (BDS {Version})", serverId, server.InstalledVersion);
            return (true, null, server.InstalledVersion);
        }
        catch (Exception ex)
        {
            server.Status = "error";
            server.LastError = ex.Message;
            _logger.LogError(ex, "Failed to start server {ServerId}", serverId);
            return (false, ex.Message, null);
        }
    }

    private async Task<bool> WaitForHealthyAsync(ManagedServer server, TimeSpan timeout, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            ct.ThrowIfCancellationRequested();
            if (server.Status == "running") return true;
            if (server.Process is { HasExited: true }) return false;
            await Task.Delay(500, ct);
        }
        return server.Status == "running";
    }

    private void HandleOutput(ManagedServer server, string? data, string stream)
    {
        if (data is null) return;
        server.EnqueueLog(data, stream);

        var connected = PlayerConnected.Match(data);
        if (connected.Success)
        {
            var players = server.CurrentPlayers.ToList();
            var name = connected.Groups["name"].Value.Trim();
            if (!players.Contains(name)) players.Add(name);
            server.SetPlayers(players);
            server.EnqueueLog($"[OG HOST] {name} joined ({server.OnlinePlayers}/{server.MaxPlayers}).", "system");
        }

        var disconnected = PlayerDisconnected.Match(data);
        if (disconnected.Success)
        {
            var players = server.CurrentPlayers
                .Where(p => !p.Equals(disconnected.Groups["name"].Value.Trim(), StringComparison.Ordinal))
                .ToList();
            server.SetPlayers(players);
        }

        var listed = ListOutput.Match(data);
        if (listed.Success && int.TryParse(listed.Groups["count"].Value, out var count))
        {
            server.OnlinePlayers = count;
        }

        var version = VersionLine.Match(data);
        if (version.Success)
        {
            server.InstalledVersion = version.Groups["version"].Value;
        }

        if (ServerStarted.IsMatch(data))
        {
            server.Status = "running";
        }
    }

    private void HandleExit(ManagedServer server)
    {
        var exitCode = 0;
        try { exitCode = server.Process?.ExitCode ?? 0; } catch { /* already disposed */ }

        var wasRunning = server.Status == "running" || server.Status == "starting";
        server.OnlinePlayers = 0;
        server.Process = null;

        if (server.StopRequested)
        {
            server.Status = "stopped";
            server.EnqueueLog($"[OG HOST] Server stopped (exit code {exitCode}).", "system");
            _logger.LogInformation("Server {ServerId} stopped cleanly", server.ServerId);
            return;
        }

        if (!wasRunning) return;

        // Unexpected exit. Only auto-restart when the operator enabled it, and
        // never more than the configured number of times — a crash loop on a
        // corrupted world would otherwise spin forever.
        server.Status = "error";
        server.LastError = $"Server process exited unexpectedly with code {exitCode}.";
        server.EnqueueLog($"[OG HOST] {server.LastError}", "system");
        _logger.LogWarning("Server {ServerId} exited unexpectedly ({Code})", server.ServerId, exitCode);

        if (!_config.Options.AutoRestartOnCrash) return;
        if (server.AutoRestartCount >= _config.Options.MaxAutoRestarts)
        {
            server.EnqueueLog(
                $"[OG HOST] Auto-restart limit ({_config.Options.MaxAutoRestarts}) reached. Not restarting.",
                "system");
            return;
        }

        server.AutoRestartCount++;
        server.EnqueueLog(
            $"[OG HOST] Auto-restart {server.AutoRestartCount}/{_config.Options.MaxAutoRestarts} in 10 seconds…",
            "system");
        _ = Task.Run(async () =>
        {
            await Task.Delay(TimeSpan.FromSeconds(10));
            await StartAsync(server.ServerId, server.WorldName, server.Port, server.MaxPlayers, CancellationToken.None);
        });
    }

    /// <summary>Graceful stop: flush + save, then the BDS <c>stop</c> command.</summary>
    public async Task<(bool Success, string? Error)> StopAsync(string serverId, int timeoutSeconds, CancellationToken ct)
    {
        var server = _servers.GetValueOrDefault(serverId);
        if (server is null || server.Process is null || server.Process.HasExited)
        {
            if (server is not null)
            {
                server.Status = "stopped";
                server.OnlinePlayers = 0;
            }
            return (true, null);
        }

        server.StopRequested = true;
        server.Status = "stopping";
        server.EnqueueLog("[OG HOST] Stopping server safely…", "system");

        try
        {
            await SendRawAsync(server, "save hold");
            await Task.Delay(1000, ct);
            await SendRawAsync(server, "save query");
            await Task.Delay(1500, ct);
            await SendRawAsync(server, "save resume");
            await Task.Delay(500, ct);
            await SendRawAsync(server, "stop");
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Error while sending stop sequence to {ServerId}", serverId);
        }

        var deadline = DateTime.UtcNow.AddSeconds(Math.Clamp(timeoutSeconds, 5, 120));
        while (DateTime.UtcNow < deadline)
        {
            if (server.Process is null || server.Process.HasExited)
            {
                server.Status = "stopped";
                server.OnlinePlayers = 0;
                return (true, null);
            }
            await Task.Delay(500, ct);
        }

        server.LastError = "The server did not exit within the timeout. Use force stop.";
        return (false, server.LastError);
    }

    /// <summary>Immediate kill. Destructive — the panel requires confirmation.</summary>
    public (bool Success, string? Error) ForceStop(string serverId)
    {
        var server = _servers.GetValueOrDefault(serverId);
        if (server?.Process is null)
        {
            if (server is not null)
            {
                server.Status = "stopped";
                server.OnlinePlayers = 0;
            }
            return (true, null);
        }

        server.StopRequested = true;
        server.EnqueueLog("[OG HOST] Force stopping (world may lose recent progress).", "system");
        TryKill(server.Process);
        server.Process = null;
        server.Status = "stopped";
        server.OnlinePlayers = 0;
        return (true, null);
    }

    /// <summary>
    /// Send a console command to BDS stdin. Allowlisted twice: once by the web
    /// control plane and again here, so a compromised or buggy caller cannot
    /// reach the process with arbitrary input.
    /// </summary>
    public async Task<(bool Success, string? Error)> SendCommandAsync(string serverId, string command, CancellationToken ct)
    {
        var server = _servers.GetValueOrDefault(serverId);
        if (server?.Process is null || server.Process.HasExited)
        {
            return (false, "The server is not running.");
        }
        if (!IsAllowedCommand(command, out var reason))
        {
            return (false, reason);
        }
        await SendRawAsync(server, command.Trim());
        return (true, null);
    }

    /// <summary>
    /// Allowlist check. Rejects anything that is not a known BDS console
    /// command, and anything containing shell metacharacters or newlines.
    /// stdin is not a shell, but defence in depth costs nothing.
    /// </summary>
    public static bool IsAllowedCommand(string command, out string reason)
    {
        reason = string.Empty;
        var trimmed = command?.Trim() ?? string.Empty;
        if (trimmed.Length == 0)
        {
            reason = "Empty command.";
            return false;
        }
        if (trimmed.Any(c => c is ';' or '&' or '|' or '`' or '$' or '>' or '<' or '\r' or '\n'))
        {
            reason = "Command contains characters that are not permitted.";
            return false;
        }
        if (trimmed.Length > 500)
        {
            reason = "Command is too long.";
            return false;
        }
        var head = trimmed.Split(' ', StringSplitOptions.RemoveEmptyEntries)[0].ToLowerInvariant();
        if (!AllowedCommands.Contains(head))
        {
            reason = $"'{head}' is not an allowed Bedrock console command. Remote shell access is never available.";
            return false;
        }
        return true;
    }

    private static async Task SendRawAsync(ManagedServer server, string text)
    {
        var stdin = server.Process?.StandardInput;
        if (stdin is null) return;
        await stdin.WriteLineAsync(text);
        await stdin.FlushAsync();
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(10_000);
            }
        }
        catch
        {
            /* best effort */
        }
    }

    /// <summary>
    /// Write server.properties if missing, and always make sure the port and
    /// world name match what the panel expects. The panel owns the rest of the
    /// file — we only guarantee the fields that must agree with our process
    /// bookkeeping.
    /// </summary>
    private void EnsureProperties(ManagedServer server)
    {
        var path = Path.Combine(server.Directory, "server.properties");
        if (!File.Exists(path))
        {
            var defaults = new StringBuilder();
            defaults.AppendLine("server-name=OG HOST Server");
            defaults.AppendLine("gamemode=survival");
            defaults.AppendLine("difficulty=easy");
            defaults.AppendLine($"max-players={server.MaxPlayers}");
            defaults.AppendLine("online-mode=true");
            defaults.AppendLine($"server-port={server.Port}");
            defaults.AppendLine($"server-portv6={server.Port + 1}");
            defaults.AppendLine($"level-name={server.WorldName}");
            defaults.AppendLine("level-seed=");
            defaults.AppendLine("default-player-permission-level=member");
            defaults.AppendLine("compression-threshold=1");
            defaults.AppendLine("compression-algorithm=deflate");
            File.WriteAllText(path, defaults.ToString());
            return;
        }

        var lines = File.ReadAllLines(path).ToList();
        void Set(string key, string value)
        {
            var index = lines.FindIndex(l =>
                l.StartsWith(key + "=", StringComparison.OrdinalIgnoreCase));
            var replacement = $"{key}={value}";
            if (index >= 0) lines[index] = replacement;
            else lines.Add(replacement);
        }

        Set("level-name", server.WorldName);
        Set("server-port", server.Port.ToString());
        Set("max-players", server.MaxPlayers.ToString());
        File.WriteAllLines(path, lines);
    }

    private static (long Total, long Available) ReadMemory()
    {
        if (OperatingSystem.IsWindows())
        {
            var status = new MemoryStatus();
            if (MemoryStatus.TryRead(out status))
            {
                return ((long)(status.TotalPhys / 1024 / 1024), (long)(status.AvailPhys / 1024 / 1024));
            }
        }
        return (0, 0);
    }

    private static (long Total, long Available, long Used) ReadStorage()
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(AppContext.BaseDirectory)) ?? "C:\\";
            var drive = new DriveInfo(root);
            if (!drive.IsReady) return (0, 0, 0);
            var total = drive.TotalSize / 1024 / 1024;
            var free = drive.AvailableFreeSpace / 1024 / 1024;
            return (total, free, total - free);
        }
        catch
        {
            return (0, 0, 0);
        }
    }

    /// <summary>Stop every running server. Used on agent shutdown.</summary>
    public async Task StopAllAsync(CancellationToken ct)
    {
        foreach (var server in _servers.Values.Where(s => s.Process is { HasExited: false }))
        {
            await StopAsync(server.ServerId, 30, ct);
        }
    }

    private sealed class MemoryStatus
    {
        public ulong TotalPhys;
        public ulong AvailPhys;

        public static bool TryRead(out MemoryStatus result)
        {
            result = new MemoryStatus();
            var status = new NativeMemoryStatus();
            status.dwLength = (uint)System.Runtime.InteropServices.Marshal.SizeOf<NativeMemoryStatus>();
            if (!GlobalMemoryStatusEx(ref status)) return false;
            result.TotalPhys = status.ullTotalPhys;
            result.AvailPhys = status.ullAvailPhys;
            return true;
        }

        [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
        private struct NativeMemoryStatus
        {
            public uint dwLength;
            public uint dwMemoryLoad;
            public ulong ullTotalPhys;
            public ulong ullAvailPhys;
            public ulong ullTotalPageFile;
            public ulong ullAvailPageFile;
            public ulong ullTotalVirtual;
            public ulong ullAvailVirtual;
            public ulong ullAvailExtendedVirtual;
        }

        [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
        [return: System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.Bool)]
        private static extern bool GlobalMemoryStatusEx(ref NativeMemoryStatus lpBuffer);
    }
}
