using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Networking;

/// <summary>Per-server networking state.</summary>
public sealed class ServerNetworkState
{
    public string ProviderId { get; set; } = "direct";
    public string? Address { get; set; }
    public int? Port { get; set; }
    public bool Verified { get; set; }
    public DateTime? VerifiedAt { get; set; }
    public string? Detail { get; set; }
}

/// <summary>
/// Selects and drives the pluggable networking providers, and owns the
/// verification step that decides whether an address may be called reachable.
///
/// Verification policy (deliberate and strict):
///   - A provider reporting success gives us an ADDRESS, not reachability.
///   - Only a genuine RakNet unconnected ping/pong round trip sets Verified.
///   - A failed self-probe from behind NAT is reported as "could not confirm",
///     never as "unreachable" and never as "verified".
/// </summary>
public sealed class NetworkManager
{
    private readonly ILogger<NetworkManager> _logger;
    private readonly DirectProvider _direct;
    private readonly PlayitProvider _playit;
    private readonly ManualProvider _manual;
    private readonly RakNetVerifier _verifier;
    private readonly ConcurrentDictionary<string, ServerNetworkState> _state = new();

    public NetworkManager(
        DirectProvider direct,
        PlayitProvider playit,
        ManualProvider manual,
        RakNetVerifier verifier,
        ILogger<NetworkManager> logger)
    {
        _direct = direct;
        _playit = playit;
        _manual = manual;
        _verifier = verifier;
        _logger = logger;
    }

    public ServerNetworkState? GetState(string serverId) => _state.GetValueOrDefault(serverId);

    private INetworkProvider Resolve(string providerId) => providerId switch
    {
        "playit" => _playit,
        "manual" => _manual,
        _ => _direct,
    };

    /// <summary>
    /// Establish networking for a server and verify it.
    /// Returns the address (if any) plus an explicit verified flag so the panel
    /// can never display an unproven address as working.
    /// </summary>
    public async Task<(bool Success, string? Address, int? Port, bool Verified, string? Detail)> StartAsync(
        string serverId, string providerId, int localPort, string? manualAddress, int? manualPort,
        bool verify, CancellationToken ct)
    {
        if (providerId == "manual" && !string.IsNullOrWhiteSpace(manualAddress))
        {
            _manual.SetEndpoint(manualAddress, manualPort ?? localPort);
        }

        var provider = Resolve(providerId);
        var result = await provider.StartAsync(localPort, ct);

        var state = _state.GetOrAdd(serverId, _ => new ServerNetworkState());
        state.ProviderId = providerId;
        state.Address = result.Address;
        state.Port = result.Port;
        state.Verified = false;
        state.VerifiedAt = null;
        state.Detail = result.Notes ?? result.Error;

        if (!result.Success || result.Address is null)
        {
            _logger.LogWarning("Networking failed for {ServerId} via {Provider}: {Error}",
                serverId, providerId, result.Error);
            return (false, result.Address, result.Port, false, result.Error ?? result.Notes);
        }

        if (!verify)
        {
            return (true, result.Address, result.Port, false,
                "Endpoint established but not verified. Join once from a real Bedrock client to confirm.");
        }

        // The real test: speak Bedrock's own protocol at the public endpoint.
        var verification = await _verifier.VerifyAsync(result.Address, result.Port ?? localPort, 8000, ct);
        state.Verified = verification.Verified;
        state.VerifiedAt = verification.Verified ? DateTime.UtcNow : null;
        state.Detail = verification.Detail;

        if (verification.Verified)
        {
            _logger.LogInformation(
                "VERIFIED: {ServerId} reachable at {Address}:{Port} ({Latency}ms)",
                serverId, verification.Address, verification.Port, verification.LatencyMs);
            return (true, verification.Address, verification.Port, true, verification.Detail);
        }

        _logger.LogWarning("Not verified for {ServerId}: {Detail}", serverId, verification.Detail);
        return (true, result.Address, result.Port, false, verification.Detail);
    }

    public async Task StopAsync(string serverId, CancellationToken ct)
    {
        var state = _state.GetValueOrDefault(serverId);
        var provider = Resolve(state?.ProviderId ?? "direct");
        await provider.StopAsync(ct);
        if (state is not null)
        {
            state.Address = null;
            state.Port = null;
            state.Verified = false;
            state.VerifiedAt = null;
            state.Detail = "Stopped.";
        }
    }

    /// <summary>Re-run verification without touching the tunnel.</summary>
    public async Task<(bool Verified, string? Detail)> ReverifyAsync(string serverId, CancellationToken ct)
    {
        var state = _state.GetValueOrDefault(serverId);
        if (state?.Address is null)
        {
            return (false, "No endpoint is established for this server.");
        }
        var result = await _verifier.VerifyAsync(state.Address, state.Port ?? 19132, 8000, ct);
        state.Verified = result.Verified;
        state.VerifiedAt = result.Verified ? DateTime.UtcNow : null;
        state.Detail = result.Detail;
        return (result.Verified, result.Detail);
    }

    /// <summary>Drop verified flags everywhere; used when a server stops.</summary>
    public void Invalidate(string serverId)
    {
        var state = _state.GetValueOrDefault(serverId);
        if (state is null) return;
        state.Verified = false;
        state.Detail = "Server stopped — endpoint no longer verified.";
    }
}
