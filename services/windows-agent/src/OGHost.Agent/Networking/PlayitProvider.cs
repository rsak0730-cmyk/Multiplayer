using System.Diagnostics;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Networking;

/// <summary>
/// Playit.gg UDP tunnel provider — the realistic free option for CGNAT
/// connections such as Airtel, Jio and Vi mobile broadband.
///
/// How it works: Playit's agent makes an OUTBOUND connection to Playit's
/// servers and they hand back a public host:port that forwards UDP to a local
/// port. Because the connection is outbound, no port forwarding and no public
/// IPv4 are needed.
///
/// WHAT THIS IMPLEMENTATION REQUIRES FROM THE OPERATOR (documented honestly):
///   1. A free playit.gg account with a UDP tunnel created for the BDS port.
///   2. The tunnel secret stored in the agent config (or supplied per-server
///      by the panel).
///   3. The official playit-agent binary present on the device. We do NOT
///      bundle or redistribute Playit's binary — set Agent:PlayitAgentPath or
///      put playit.exe next to the agent.
///
/// WHAT IS NOT YET VERIFIED: that a current Bedrock client successfully joins
/// through this tunnel. Playit supports UDP and Bedrock is UDP, but protocol
/// compatibility and free-tier limits change over time and must be confirmed
/// with a real client on real hardware. Until that test passes, the panel
/// shows the address as UNVERIFIED. See docs/NETWORKING.md.
/// </summary>
public sealed class PlayitProvider : INetworkProvider
{
    // playit prints lines like:
    //   udp tunnel ready: <host>.playit.gg:12345 -> 127.0.0.1:19132
    private static readonly Regex TunnelReady = new(
        @"(?<host>[a-z0-9\.\-]+)\s*:\s*(?<port>\d{1,5})",
        RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private readonly ILogger<PlayitProvider> _logger;
    private readonly AgentConfigStore _config;
    private Process? _process;
    private string? _secret;

    public string Id => "playit";
    public string Name => "Playit.gg UDP tunnel";
    public bool SupportsCgnat => true;
    public string? CurrentAddress { get; private set; }
    public int? CurrentPort { get; private set; }

    public PlayitProvider(AgentConfigStore config, ILogger<PlayitProvider> logger)
    {
        _config = config;
        _logger = logger;
    }

    public async Task<NetworkResult> StartAsync(int localPort, CancellationToken ct)
    {
        var secret = _config.Options.PlayitSecret;
        if (string.IsNullOrWhiteSpace(secret))
        {
            return new NetworkResult(false, null, localPort,
                "No Playit secret is configured for this device. Create a free UDP tunnel at playit.gg, " +
                "copy the secret, and save it on the Networking page.", null);
        }
        _secret = secret;

        var agentPath = ResolvePlayitAgent();
        if (agentPath is null)
        {
            return new NetworkResult(false, null, localPort,
                "The Playit agent binary was not found. Download it from playit.gg and either put playit.exe " +
                "next to OGHost.Agent.exe or set Agent:PlayitAgentPath in config.json. " +
                "OG HOST does not bundle or redistribute third-party binaries.", null);
        }

        if (_process is { HasExited: false })
        {
            return CurrentAddress is null
                ? new NetworkResult(false, null, localPort, "A tunnel is already starting but has not reported an address yet.", null)
                : new NetworkResult(true, CurrentAddress, CurrentPort, null, "Tunnel already running.");
        }

        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = agentPath,
                // The secret is passed via the environment rather than the
                // command line so it does not appear in process listings.
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(agentPath) ?? AppContext.BaseDirectory,
            };
            psi.EnvironmentVariables["PLAYIT_SECRET"] = _secret;

            var process = new Process { StartInfo = psi, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, e) => HandleOutput(e.Data);
            process.ErrorDataReceived += (_, e) => HandleOutput(e.Data);
            process.Exited += (_, _) =>
            {
                _logger.LogWarning("Playit agent exited unexpectedly");
                CurrentAddress = null;
                CurrentPort = null;
            };

            if (!process.Start())
            {
                return new NetworkResult(false, null, localPort, "Could not start the Playit agent.", null);
            }
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            _process = process;

            // Wait for the tunnel to report a public address.
            var deadline = DateTime.UtcNow.AddSeconds(60);
            while (DateTime.UtcNow < deadline)
            {
                ct.ThrowIfCancellationRequested();
                if (CurrentAddress is not null) break;
                if (process.HasExited)
                {
                    return new NetworkResult(false, null, localPort,
                        $"The Playit agent exited with code {process.ExitCode}. Check the secret and tunnel type (it must be UDP).",
                        null);
                }
                await Task.Delay(500, ct);
            }

            if (CurrentAddress is null)
            {
                return new NetworkResult(false, null, localPort,
                    "The Playit agent started but did not report a public address within 60 seconds. " +
                    "Confirm the tunnel is UDP and points at port " + localPort + ".", null);
            }

            _logger.LogInformation("Playit tunnel ready: {Address}:{Port} -> local {Local}",
                CurrentAddress, CurrentPort, localPort);

            return new NetworkResult(true, CurrentAddress, CurrentPort, null,
                "Tunnel established. This address is UNVERIFIED until a real Bedrock protocol round trip succeeds.");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to start the Playit tunnel");
            return new NetworkResult(false, null, localPort, ex.Message, null);
        }
    }

    public Task StopAsync(CancellationToken ct)
    {
        try
        {
            if (_process is { HasExited: false })
            {
                _process.Kill(entireProcessTree: true);
                _process.WaitForExit(10_000);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Error stopping the Playit agent");
        }
        finally
        {
            _process?.Dispose();
            _process = null;
            CurrentAddress = null;
            CurrentPort = null;
        }
        return Task.CompletedTask;
    }

    private void HandleOutput(string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        _logger.LogDebug("[playit] {Line}", line);

        if (CurrentAddress is not null) return;

        // Only accept lines that look like a tunnel announcement.
        if (!line.Contains("tunnel", StringComparison.OrdinalIgnoreCase) &&
            !line.Contains("ready", StringComparison.OrdinalIgnoreCase) &&
            !line.Contains("playit.gg", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        var match = TunnelReady.Match(line);
        if (!match.Success) return;

        var host = match.Groups["host"].Value;
        if (!int.TryParse(match.Groups["port"].Value, out var port)) return;
        if (port is < 1 or > 65535) return;

        CurrentAddress = host;
        CurrentPort = port;
    }

    private string? ResolvePlayitAgent()
    {
        var configured = _config.Options.PlayitAgentPath;
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;

        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "playit.exe"),
            Path.Combine(AppContext.BaseDirectory, "playit"),
            Path.Combine(_config.Options.DataDirectory, "playit.exe"),
        };
        return candidates.FirstOrDefault(File.Exists);
    }
}
