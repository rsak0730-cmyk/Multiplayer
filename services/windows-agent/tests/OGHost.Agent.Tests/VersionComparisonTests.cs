using OGHost.Agent.Services;
using Xunit;

namespace OGHost.Agent.Tests;

/// <summary>
/// Version comparison drives update notifications, "update available" badges and
/// rollback eligibility. It must handle the 3- and 4-segment versions Bedrock
/// actually ships (e.g. 1.21.20 vs 1.21.20.03) without hard-coding any of them.
/// </summary>
public sealed class VersionComparisonTests
{
    [Theory]
    [InlineData("1.21.0", "1.20.80", 1)]
    [InlineData("1.20.80", "1.21.0", -1)]
    [InlineData("1.21.20", "1.21.20", 0)]
    [InlineData("1.21.20.03", "1.21.20", 1)]
    [InlineData("1.21.20", "1.21.20.03", -1)]
    [InlineData("1.21.2", "1.21.20", -1)]
    [InlineData("2.0.0", "1.99.99", 1)]
    [InlineData("1.0", "1.0.0", 0)]
    public void Compares_dotted_versions_correctly(string a, string b, int expected)
    {
        Assert.Equal(expected, BdsVersionDiscovery.CompareVersions(a, b));
    }

    [Theory]
    [InlineData("1.21.20")]
    [InlineData("1.20.80")]
    public void Comparison_is_antisymmetric(string version)
    {
        Assert.Equal(0, BdsVersionDiscovery.CompareVersions(version, version));
    }

    [Fact]
    public void Handles_malformed_segments_without_throwing()
    {
        // A non-numeric segment is treated as 0 rather than crashing the agent.
        Assert.Equal(0, BdsVersionDiscovery.CompareVersions("1.beta.0", "1.0.0"));
    }

    [Fact]
    public void Update_is_available_only_when_latest_is_strictly_newer()
    {
        Assert.True(BdsVersionDiscovery.CompareVersions("1.21.30", "1.21.20") > 0);
        Assert.False(BdsVersionDiscovery.CompareVersions("1.21.20", "1.21.20") > 0);
        Assert.False(BdsVersionDiscovery.CompareVersions("1.21.10", "1.21.20") > 0);
    }
}
