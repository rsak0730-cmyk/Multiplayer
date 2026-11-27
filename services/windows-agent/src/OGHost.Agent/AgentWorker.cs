using Microsoft.Extensions.Logging;
using OGHost.Agent.Models;
using OGHost.Agent.Networking;
using OGHost.Agent.Services;

namespace OGHost.Agent;

/// <summary>
/// The agent's main loop: pair once, then heartbeat and poll for commands
/// forever, reconnecting after any network failure or Windows restart.
///
/// Everything is OUTBOUND. The agent never listens on a port, so it works
/// behind NAT and CGNAT with no router or firewall changes — which is what
/// makes hosting from a laptop on a mobile broadband connection possible.
/// </summary>
public sealed class AgentWorker : BackgroundService
{
    private readonly ILogger<AgentWorker> _logger;
    private readonly AgentConfigStore _config;
    private readonly ControlPlaneClient _client;
    private readonly HardwareMonitor _hardware;
    private readonly CommandDispatcher _dispatcher;
    private readonly ServerProcessManager _processes;
    private readonly BdsInstaller _installer;
    private readonly NetworkManager _network;

    private int _consecutiveFailures;

    public AgentWorker(
        AgentConfigStore config,
        ControlPlaneClient client,
        HardwareMonitor hardware,
        CommandDispatcher dispatcher,
        ServerProcessManager processes,
        BdsInstaller installer,
        NetworkManager network,
        ILogger<AgentWorker> logger)
    {
        _config = config;
        _client = client;
        _hardware = hardware;
        _dispatcher = dispatcher;
        _processes = processes;
        _installer = installer;
        _network = network;
        _logger = logger;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("OG HOST Agent {Version} starting", _hardware.AgentVersion);
        _logger.LogInformation("Data directory: {Dir}", _config.Options.DataDirectory);

        await _config.LoadAsync(stoppingToken);

        if (!_config.IsPaired)
        {
            var paired = await PairAsync(stoppingToken);
            if (!paired)
            {
                _logger.LogError(
                    "Not paired. Edit {Path}: set controlPlaneUrl to your OG HOST address and paste your " +
                    "pairing code into pairingCode, then run the agent again.",
                    _config.Options.ConfigPath);
                // Keep running and retry — the user may be typing the code now.
                await RetryPairingLoopAsync(stoppingToken);
            }
        }

        _logger.LogInformation("Paired as node {NodeId}. Connecting to {Url}",
            _config.Options.NodeId, _config.Options.ControlPlaneUrl);

        if (_config.Options.HonorAutoStart)
        {
            await AutoStartServersAsync(stoppingToken);
        }
        else
        {
            _logger.LogInformation(
                "HonorAutoStart is disabled: no Minecraft servers will be started automatically. " +
                "The agent reconnects on its own, but servers stay stopped until you start them from the panel.");
        }

        // Two independent loops: heartbeat and command polling. Separating them
        // means a slow command never delays the heartbeat that keeps the node
        // shown as online.
        using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
        var heartbeat = Task.Run(() => HeartbeatLoopAsync(heartbeatCts.Token), heartbeatCts.Token);
        var logs = Task.Run(() => LogShippingLoopAsync(heartbeatCts.Token), heartbeatCts.Token);

        await PollLoopAsync(stoppingToken);

        heartbeatCts.Cancel();
        await Task.WhenAll(heartbeat, logs);
    }

    // ------------------------------------------------------------------
    // Pairing
    // ------------------------------------------------------------------

    private async Task<bool> PairAsync(CancellationToken ct)
    {
        var code = _config.Options.PairingCode?.Trim().ToUpperInvariant();
        if (string.IsNullOrWhiteSpace(code))
        {
            _logger.LogWarning("No pairing code configured.");
            return false;
        }

        _logger.LogInformation("Claiming pairing code {Code}…", Mask(code));
        var result = await _client.ClaimPairingAsync(
            code, _hardware.HostName, _hardware.OperatingSystem, _hardware.AgentVersion, ct);

        if (result is null) return false;

        _config.Options.NodeId = result.NodeId;
        _config.Options.NodeToken = result.Token;
        // The code is single-use; clear it so a restart cannot replay it.
        _config.Options.PairingCode = null;
        await _config.SaveAsync(ct);

        _logger.LogInformation("Paired successfully as node {NodeId}", result.NodeId);
        if (!string.IsNullOrWhiteSpace(result.Message)) _logger.LogInformation(result.Message);
        return true;
    }

    private async Task RetryPairingLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(20), ct);
            // Reload in case the user just edited config.json.
            await _config.LoadAsync(ct);
            if (_config.IsPaired)
            {
                _logger.LogInformation("Credentials found in config.json; continuing.");
                return;
            }
            if (await PairAsync(ct)) return;
            _logger.LogInformation("Still waiting for a valid pairing code in {Path}…", _config.Options.ConfigPath);
        }
    }

    // ------------------------------------------------------------------
    // Heartbeat
    // ------------------------------------------------------------------

    private async Task HeartbeatLoopAsync(CancellationToken ct)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(5, _config.Options.HeartbeatIntervalSeconds));
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var payload = BuildHeartbeat();
                var ok = await _client.SendHeartbeatAsync(payload, ct);
                if (ok)
                {
                    _consecutiveFailures = 0;
                }
                else
                {
                    _consecutiveFailures++;
                    if (_consecutiveFailures == 5)
                    {
                        _logger.LogWarning(
                            "Five heartbeats failed in a row. Check that controlPlaneUrl is correct and that " +
                            "this device can reach it. Retrying every {Seconds}s.", (int)interval.TotalSeconds);
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _consecutiveFailures++;
                _logger.LogDebug(ex, "Heartbeat failed (attempt {N})", _consecutiveFailures);
            }

            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    private HeartbeatRequest BuildHeartbeat()
    {
        var cpu = _hardware.GetCpuPercent();
        var (ramTotal, ramAvailable) = _hardware.GetMemory();
        var (diskTotal, diskAvailable, diskUsed) = _hardware.GetStorage();

        var servers = _processes.All.Select(s =>
        {
            var network = _network.GetState(s.ServerId);
            return new HeartbeatServer(
                s.ServerId,
                s.Status,
                s.InstalledVersion ?? _installer.GetInstalledVersion(s.ServerId),
                s.OnlinePlayers,
                network?.Address ?? s.PublicAddress,
                network?.Port ?? s.PublicPort,
                network?.Verified ?? s.NetworkingVerified,
                s.LastError);
        }).ToList();

        // Include servers we know about on disk but are not currently managed
        // in memory, so the panel does not show them as vanished after a restart.
        foreach (var serverId in KnownServerIds())
        {
            if (servers.Any(s => s.ServerId == serverId)) continue;
            servers.Add(new HeartbeatServer(
                serverId, "stopped", _installer.GetInstalledVersion(serverId), 0, null, null, false, null));
        }

        return new HeartbeatRequest(
            _hardware.HostName,
            _hardware.OperatingSystem,
            _hardware.AgentVersion,
            OperatingSystem.IsWindows() ? "windows" : "other",
            cpu, ramTotal, ramAvailable, diskTotal, diskAvailable, diskUsed,
            _hardware.GetUptimeSeconds(),
            servers);
    }

    private IEnumerable<string> KnownServerIds()
    {
        var root = _config.Options.ServersRoot;
        if (!Directory.Exists(root)) yield break;
        foreach (var dir in Directory.GetDirectories(root))
        {
            yield return Path.GetFileName(dir);
        }
    }

    // ------------------------------------------------------------------
    // Console log shipping
    // ------------------------------------------------------------------

    private async Task LogShippingLoopAsync(CancellationToken ct)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(1, _config.Options.LogFlushIntervalSeconds));
        while (!ct.IsCancellationRequested)
        {
            try
            {
                foreach (var server in _processes.All)
                {
                    var batch = server.DrainLogs(200);
                    if (batch.Count > 0)
                    {
                        await _client.PushConsoleLogsAsync(server.ServerId, batch, ct);
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Log shipping tick failed");
            }

            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { break; }
        }
    }

    // ------------------------------------------------------------------
    // Command polling
    // ------------------------------------------------------------------

    private async Task PollLoopAsync(CancellationToken ct)
    {
        var interval = TimeSpan.FromSeconds(Math.Max(1, _config.Options.PollIntervalSeconds));
        while (!ct.IsCancellationRequested)
        {
            try
            {
                var commands = await _client.PollCommandsAsync(ct);
                foreach (var command in commands)
                {
                    // Long-running work (install, update, backup) must not block
                    // the poll loop, or the node looks offline while it works.
                    _ = Task.Run(() => _dispatcher.ExecuteAsync(command, ct), ct);
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Command poll failed; retrying");
            }

            try { await Task.Delay(interval, ct); }
            catch (OperationCanceledException) { break; }
        }

        // Agent is shutting down (Windows restart, service stop, Ctrl+C).
        // Stop servers safely rather than leaving orphaned processes.
        _logger.LogInformation("Agent stopping; shutting down managed servers safely…");
        await _processes.StopAllAsync(CancellationToken.None);
    }

    // ------------------------------------------------------------------
    // Auto-start
    // ------------------------------------------------------------------

    private async Task AutoStartServersAsync(CancellationToken ct)
    {
        // The panel records auto_start_on_node_boot per server; the agent only
        // honours it when the operator also enabled HonorAutoStart locally.
        // Both switches must be on — a server never starts by accident.
        foreach (var serverId in KnownServerIds())
        {
            var flagPath = Path.Combine(_installer.ServerDirectory(serverId), ".oghost-autostart");
            if (!File.Exists(flagPath)) continue;
            var state = _installer.ReadState(serverId);
            var worldName = state.WorldName ?? "world";
            _logger.LogInformation("Auto-starting server {ServerId}", serverId);
            var managed = _processes.GetOrAdd(serverId, worldName);
            await _processes.StartAsync(serverId, worldName, managed.Port, managed.MaxPlayers, ct);
        }
    }

    private static string Mask(string code) =>
        code.Length <= 4 ? "****" : $"{code[..2]}****{code[^2..]}";
}
