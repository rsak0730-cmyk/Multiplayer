namespace OGHost.Agent.Networking;

/// <summary>Outcome of establishing (or tearing down) a public endpoint.</summary>
public sealed record NetworkResult(
    bool Success,
    string? Address,
    int? Port,
    string? Error,
    string? Notes);

/// <summary>
/// Pluggable networking provider.
///
/// Bedrock gameplay is UDP carrying the RakNet protocol. An HTTPS/HTTP tunnel
/// (ngrok http, cloudflared http, localtunnel) CANNOT carry it, so providers
/// here must be UDP-capable. Implementations are intentionally small and
/// replaceable: to support a new tunnel service, add a class implementing this
/// interface and register it in <see cref="NetworkManager"/>.
/// </summary>
public interface INetworkProvider
{
    /// <summary>Stable id matching the network_providers table.</summary>
    string Id { get; }

    /// <summary>Human-readable name for logs.</summary>
    string Name { get; }

    /// <summary>Whether this provider can work behind CGNAT.</summary>
    bool SupportsCgnat { get; }

    /// <summary>Establish a publicly reachable endpoint for a local UDP port.</summary>
    Task<NetworkResult> StartAsync(int localPort, CancellationToken ct);

    /// <summary>Tear the endpoint down and release any child processes.</summary>
    Task StopAsync(CancellationToken ct);

    /// <summary>Current known address, if any.</summary>
    string? CurrentAddress { get; }

    /// <summary>Current known port, if any.</summary>
    int? CurrentPort { get; }
}
