using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Networking;

/// <summary>
/// Manual provider: the operator supplies the public address and port
/// themselves (their own VPS relay, router port forwarding, or another tunnel
/// they already run).
///
/// This provider creates nothing — it records what the panel was told and lets
/// the RakNet verifier decide whether it is actually true. That distinction is
/// the whole point: an address typed into a form is a claim, not a fact.
/// </summary>
public sealed class ManualProvider : INetworkProvider
{
    private readonly ILogger<ManualProvider> _logger;

    public string Id => "manual";
    public string Name => "Manual endpoint";
    public bool SupportsCgnat => true; // depends entirely on what the operator points at
    public string? CurrentAddress { get; private set; }
    public int? CurrentPort { get; private set; }

    public ManualProvider(ILogger<ManualProvider> logger) => _logger = logger;

    public Task<NetworkResult> StartAsync(int localPort, CancellationToken ct)
    {
        if (CurrentAddress is null)
        {
            return Task.FromResult(new NetworkResult(false, null, localPort,
                "No manual address has been configured. Enter the public address and port on the Networking page first.",
                null));
        }

        _logger.LogInformation(
            "Manual endpoint in use: {Address}:{Port} (local UDP {Local}). Reachability is decided by the verifier, not by this provider.",
            CurrentAddress, CurrentPort, localPort);

        return Task.FromResult(new NetworkResult(true, CurrentAddress, CurrentPort, null,
            "Manual endpoint recorded. It stays UNVERIFIED until a real RakNet round trip succeeds."));
    }

    public Task StopAsync(CancellationToken ct) => Task.CompletedTask;

    /// <summary>Called by the panel when the operator saves a manual endpoint.</summary>
    public void SetEndpoint(string address, int port)
    {
        CurrentAddress = address;
        CurrentPort = port;
    }

    public void Clear()
    {
        CurrentAddress = null;
        CurrentPort = null;
    }
}
