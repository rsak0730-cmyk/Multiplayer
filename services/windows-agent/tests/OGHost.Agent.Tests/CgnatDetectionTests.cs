using OGHost.Agent.Networking;
using Xunit;

namespace OGHost.Agent.Tests;

/// <summary>
/// CGNAT / private-range detection. Getting this wrong in either direction is
/// bad: claiming a CGNAT address is public tells the user their friends can
/// join when they cannot, and rejecting a genuine public IP blocks working
/// setups. These ranges are the ones that matter for Indian mobile broadband
/// (Airtel, Jio, Vi), which is overwhelmingly CGNAT.
/// </summary>
public sealed class CgnatDetectionTests
{
    [Theory]
    // RFC6598 carrier-grade NAT — the range that makes direct mode impossible.
    [InlineData("100.64.0.1", true)]
    [InlineData("100.100.50.25", true)]
    [InlineData("100.127.255.254", true)]
    // RFC1918 private
    [InlineData("10.0.0.5", true)]
    [InlineData("192.168.1.10", true)]
    [InlineData("172.16.0.1", true)]
    [InlineData("172.31.255.255", true)]
    // Loopback / link-local / unspecified
    [InlineData("127.0.0.1", true)]
    [InlineData("169.254.1.1", true)]
    [InlineData("0.0.0.0", true)]
    // Junk
    [InlineData("not-an-ip", true)]
    public void Detects_non_routable_addresses(string address, bool expected)
    {
        Assert.Equal(expected, DirectProvider.IsPrivateOrCgnat(address));
    }

    [Theory]
    [InlineData("100.63.255.255")]  // just below the CGNAT block
    [InlineData("100.128.0.1")]     // just above the CGNAT block
    [InlineData("172.15.0.1")]      // just below 172.16/12
    [InlineData("172.32.0.1")]      // just above 172.16/12
    [InlineData("11.0.0.1")]
    [InlineData("192.169.0.1")]
    [InlineData("8.8.8.8")]
    [InlineData("49.44.0.1")]       // a real Indian ISP range
    [InlineData("203.0.113.45")]    // TEST-NET-3, routable-shaped
    public void Accepts_genuinely_routable_addresses(string address)
    {
        Assert.False(DirectProvider.IsPrivateOrCgnat(address));
    }

    [Fact]
    public void Direct_provider_declares_that_it_cannot_cross_cgnat()
    {
        var provider = new DirectProvider(new NoOpHttpFactory(), TestDoubles.Logger<DirectProvider>());
        Assert.False(provider.SupportsCgnat);
        Assert.Equal("direct", provider.Id);
    }

    [Fact]
    public void Playit_provider_declares_cgnat_support()
    {
        var provider = new PlayitProvider(TestDoubles.Config(), TestDoubles.Logger<PlayitProvider>());
        Assert.True(provider.SupportsCgnat);
        Assert.Equal("playit", provider.Id);
    }

    /// <summary>
    /// The property that actually matters: DirectProvider must never hand back a
    /// LAN address and let the caller believe it is publicly reachable.
    ///
    /// With HTTP blocked, no external "what is my IP" lookup can succeed, so the
    /// provider has no evidence of a public IPv4. It may still learn a LAN
    /// interface address from the OS (that call sends no traffic and works on any
    /// machine with a network interface, including CI runners), but then it MUST
    /// warn that router port forwarding is required. Either outcome is honest;
    /// silently reporting a private address as public would not be.
    /// </summary>
    [Fact]
    public async Task Direct_provider_never_presents_a_lan_address_as_publicly_reachable()
    {
        var provider = new DirectProvider(new NoOpHttpFactory(), TestDoubles.Logger<DirectProvider>());
        var result = await provider.StartAsync(19132, CancellationToken.None);

        if (result.Success)
        {
            Assert.False(string.IsNullOrWhiteSpace(result.Address),
                "A successful provider must report an address");

            // It must never claim an external lookup confirmed this address,
            // because no lookup could have succeeded.
            Assert.DoesNotContain("external lookup", result.Notes ?? string.Empty,
                StringComparison.OrdinalIgnoreCase);

            // And if what it found is a private/CGNAT address, it must say so.
            if (DirectProvider.IsPrivateOrCgnat(result.Address!))
            {
                Assert.Contains("port forwarding", result.Notes ?? string.Empty,
                    StringComparison.OrdinalIgnoreCase);
            }
        }
        else
        {
            Assert.False(string.IsNullOrWhiteSpace(result.Error),
                "A failed provider must say why it failed");
        }
    }

    [Fact]
    public async Task Playit_provider_fails_clearly_without_a_secret()
    {
        var provider = new PlayitProvider(TestDoubles.Config(), TestDoubles.Logger<PlayitProvider>());
        var result = await provider.StartAsync(19132, CancellationToken.None);
        Assert.False(result.Success);
        Assert.Contains("Playit secret", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Playit_provider_fails_clearly_without_the_third_party_binary()
    {
        var config = TestDoubles.Config(o => o.PlayitSecret = "secret-abc");
        var provider = new PlayitProvider(config, TestDoubles.Logger<PlayitProvider>());
        var result = await provider.StartAsync(19132, CancellationToken.None);
        Assert.False(result.Success);
        Assert.Contains("Playit agent binary", result.Error, StringComparison.OrdinalIgnoreCase);
    }
}
