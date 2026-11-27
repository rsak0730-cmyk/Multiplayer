using System.Net;
using System.Net.Sockets;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Networking;

/// <summary>Result of a real Bedrock protocol probe.</summary>
public sealed record VerificationResult(bool Verified, string? Address, int? Port, int? LatencyMs, string? Detail);

/// <summary>
/// Verifies that a Bedrock server is genuinely reachable by speaking the real
/// RakNet handshake: send an Unconnected Ping, wait for an Unconnected Pong.
///
/// This is the only way OG HOST will mark an address "verified". A tunnel
/// claiming to be up is not evidence — a protocol round trip is. Until this
/// succeeds the panel shows the address as UNVERIFIED and never tells the user
/// their friends can join.
///
/// Limitation, stated honestly: when the node itself sits behind NAT, pinging
/// its own public address depends on NAT hairpinning, which many home routers
/// and all CGNAT deployments do not support. A failed self-ping therefore does
/// NOT prove the server is unreachable from outside — it proves we could not
/// confirm it from here. The agent reports that distinction, and the final
/// confirmation is always a real Bedrock client joining.
/// </summary>
public sealed class RakNetVerifier
{
    // RakNet offline message magic: 00 ff ff 00 fe fe fe fe fd fd fd fd 12 34 56 78
    private static readonly byte[] OfflineMessageDataId =
    {
        0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe,
        0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
    };

    private const byte IdUnconnectedPing = 0x01;
    private const byte IdUnconnectedPingOpenConnections = 0x02;
    private const byte IdUnconnectedPong = 0x1c;

    private readonly ILogger<RakNetVerifier> _logger;

    public RakNetVerifier(ILogger<RakNetVerifier> logger) => _logger = logger;

    /// <summary>
    /// Send an unconnected ping and wait for a pong.
    /// </summary>
    public async Task<VerificationResult> VerifyAsync(string address, int port, int timeoutMs = 6000, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(address))
        {
            return new VerificationResult(false, address, port, null, "No address to verify.");
        }

        IPAddress ip;
        try
        {
            if (!IPAddress.TryParse(address, out ip!))
            {
                var resolved = await Dns.GetHostAddressesAsync(address, AddressFamily.InterNetwork, ct);
                ip = resolved.FirstOrDefault() ?? throw new InvalidOperationException(
                    $"Could not resolve hostname “{address}”.");
            }
        }
        catch (Exception ex)
        {
            return new VerificationResult(false, address, port, null, $"Address resolution failed: {ex.Message}");
        }

        var endpoint = new IPEndPoint(ip, port);
        using var udp = new UdpClient(endpoint.AddressFamily);
        try
        {
            udp.Client.ReceiveTimeout = timeoutMs;
            udp.Client.SendTimeout = timeoutMs;

            var started = DateTime.UtcNow;
            var ping = BuildPing();

            // Send a few times: UDP is lossy and the first packet often warms
            // up a NAT mapping or a tunnel that has not seen traffic yet.
            for (var attempt = 0; attempt < 3; attempt++)
            {
                ct.ThrowIfCancellationRequested();
                await udp.SendAsync(ping, ping.Length, endpoint, ct);

                using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeoutCts.CancelAfter(timeoutMs);
                try
                {
                    var received = await udp.ReceiveAsync(timeoutCts.Token);
                    if (received.Buffer.Length > 0 && received.Buffer[0] == IdUnconnectedPong)
                    {
                        var latency = (int)(DateTime.UtcNow - started).TotalMilliseconds;
                        var serverName = ExtractServerName(received.Buffer);
                        _logger.LogInformation(
                            "RakNet pong from {Endpoint} in {Latency}ms ({Server})", endpoint, latency, serverName);
                        return new VerificationResult(true, address, port, latency,
                            $"Received a genuine Bedrock/RakNet pong in {latency} ms." +
                            (serverName is null ? null : $" Server reported: {serverName}"));
                    }
                }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    // this attempt timed out — try again
                }
                catch (SocketException)
                {
                    // no reply on this attempt
                }
            }

            return new VerificationResult(false, address, port, null,
                "No RakNet pong received. The server may be stopped, the port may not be forwarded, " +
                "or (when probing your own public address from behind NAT) hairpinning may be unsupported. " +
                "Confirm by joining once from a real Bedrock client.");
        }
        catch (Exception ex)
        {
            return new VerificationResult(false, address, port, null, $"Verification error: {ex.Message}");
        }
    }

    /// <summary>
    /// Build a RakNet Unconnected Ping packet.
    /// Layout: packet ID (1 byte) | time (8 bytes, big endian) | magic (16 bytes)
    ///         | client GUID (8 bytes).
    /// </summary>
    private static byte[] BuildPing()
    {
        var buffer = new byte[1 + 8 + OfflineMessageDataId.Length + 8];
        var offset = 0;

        buffer[offset++] = IdUnconnectedPingOpenConnections;

        var time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        for (var i = 7; i >= 0; i--)
        {
            buffer[offset++] = (byte)((time >> (i * 8)) & 0xFF);
        }

        Array.Copy(OfflineMessageDataId, 0, buffer, offset, OfflineMessageDataId.Length);
        offset += OfflineMessageDataId.Length;

        var guid = Random.Shared.NextInt64();
        for (var i = 7; i >= 0; i--)
        {
            buffer[offset++] = (byte)((guid >> (i * 8)) & 0xFF);
        }

        return buffer;
    }

    /// <summary>
    /// The pong payload contains a semicolon-delimited server description,
    /// e.g. "MCPE;World Name;version;...;players;max;...". Pull the name out
    /// so the panel can show proof the right server answered.
    /// </summary>
    private static string? ExtractServerName(byte[] pong)
    {
        try
        {
            // Skip: ID(1) + time(8) + magic(16) + GUID(8) + string length(2)
            const int header = 1 + 8 + 16 + 8 + 2;
            if (pong.Length <= header) return null;
            var text = System.Text.Encoding.UTF8.GetString(pong, header, pong.Length - header);
            var parts = text.Split(';');
            if (parts.Length >= 2 && parts[0].Equals("MCPE", StringComparison.OrdinalIgnoreCase))
            {
                return parts[1];
            }
            return text.Length > 80 ? text[..80] : text;
        }
        catch
        {
            return null;
        }
    }
}
