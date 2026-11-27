using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Networking;

/// <summary>
/// Direct provider: report the node's own public address and the local port.
///
/// No tunnel is created — this only works when the machine genuinely has a
/// routable address (a real public IPv4, or port forwarding set up on the
/// router). We discover the candidate address two ways and say which one we
/// used, because the difference matters:
///   1. The LAN interface address (works if the router forwards the port).
///   2. An external "what is my IP" lookup (works only with a real public IPv4).
///
/// On CGNAT (common with Airtel/Jio/Vi mobile broadband) the external lookup
/// returns the carrier's shared address, which is NOT connectable. We detect
/// that mismatch and report it honestly instead of handing back an address
/// that will never work.
/// </summary>
public sealed class DirectProvider : INetworkProvider
{
    private readonly ILogger<DirectProvider> _logger;
    private readonly IHttpClientFactory _httpFactory;

    private HttpClient Http => _httpFactory.CreateClient(HttpClients.Lookups);

    public string Id => "direct";
    public string Name => "Direct connection";
    public bool SupportsCgnat => false;
    public string? CurrentAddress { get; private set; }
    public int? CurrentPort { get; private set; }

    public DirectProvider(IHttpClientFactory httpFactory, ILogger<DirectProvider> logger)
    {
        _httpFactory = httpFactory;
        _logger = logger;
    }

    public async Task<NetworkResult> StartAsync(int localPort, CancellationToken ct)
    {
        var lan = GetLanAddress();
        var external = await GetExternalAddressAsync(ct);

        if (external is null && lan is null)
        {
            return new NetworkResult(false, null, localPort,
                "Could not determine any network address on this device.", null);
        }

        // If the external address is a private/CGNAT range, direct mode cannot work.
        if (external is not null && IsPrivateOrCgnat(external))
        {
            return new NetworkResult(false, external, localPort,
                $"This device's public address ({external}) is in a carrier-grade NAT or private range, " +
                "so other players cannot connect to it directly. Switch the networking provider to Playit " +
                "or Manual, or set up port forwarding if you have a real public IPv4.",
                "CGNAT detected");
        }

        var address = external ?? lan!;
        CurrentAddress = address;
        CurrentPort = localPort;

        var notes = external is not null
            ? "Using the public IPv4 reported by an external lookup."
            : "No public IPv4 found; using the LAN address. Port forwarding on the router is required.";

        _logger.LogInformation("Direct networking: {Address}:{Port} ({Notes})", address, localPort, notes);
        return new NetworkResult(true, address, localPort, null, notes);
    }

    public Task StopAsync(CancellationToken ct)
    {
        CurrentAddress = null;
        CurrentPort = null;
        return Task.CompletedTask;
    }

    private static string? GetLanAddress()
    {
        try
        {
            // Opening a UDP socket towards a public address does not send any
            // traffic; it just makes the OS pick the interface it would use.
            using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Dgram, ProtocolType.Udp);
            socket.Connect("8.8.8.8", 53);
            var local = socket.LocalEndPoint as IPEndPoint;
            var address = local?.Address.ToString();
            return address is not null && !IPAddress.IsLoopback(local!.Address) ? address : null;
        }
        catch
        {
            return null;
        }
    }

    private async Task<string?> GetExternalAddressAsync(CancellationToken ct)
    {
        // Tried in order; all return a bare IPv4 as text. Any single
        // failure is fine — we only need one answer.
        var services = new[]
        {
            "https://api.ipify.org",
            "https://ifconfig.me/ip",
            "https://icanhazip.com",
        };
        foreach (var service in services)
        {
            try
            {
                using var response = await Http.GetAsync(service, ct);
                if (!response.IsSuccessStatusCode) continue;
                var text = (await response.Content.ReadAsStringAsync(ct)).Trim();
                if (IPAddress.TryParse(text, out var ip) && ip.AddressFamily == AddressFamily.InterNetwork)
                {
                    return text;
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "External IP lookup failed for {Service}", service);
            }
        }
        return null;
    }

    /// <summary>
    /// True for RFC1918 private ranges and the RFC6598 CGNAT range (100.64/10).
    /// An address in these ranges is never reachable from the internet.
    /// </summary>
    public static bool IsPrivateOrCgnat(string address)
    {
        if (!IPAddress.TryParse(address, out var ip)) return true;
        if (IPAddress.IsLoopback(ip)) return true;
        if (ip.AddressFamily != AddressFamily.InterNetwork) return false;

        var bytes = ip.GetAddressBytes();
        if (bytes.Length != 4) return true;

        // 10.0.0.0/8
        if (bytes[0] == 10) return true;
        // 192.168.0.0/16
        if (bytes[0] == 192 && bytes[1] == 168) return true;
        // 172.16.0.0/12
        if (bytes[0] == 172 && bytes[1] >= 16 && bytes[1] <= 31) return true;
        // 100.64.0.0/10 — carrier-grade NAT
        if (bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127) return true;
        // 169.254.0.0/16 — link local
        if (bytes[0] == 169 && bytes[1] == 254) return true;
        // 0.0.0.0 and 127/8
        if (bytes[0] == 0 || bytes[0] == 127) return true;

        return false;
    }
}
