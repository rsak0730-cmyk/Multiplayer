using OGHost.Agent.Services;
using Xunit;

namespace OGHost.Agent.Tests;

/// <summary>
/// The on-disk layout is what makes updates safe. Worlds live OUTSIDE the
/// engine directory, so replacing or rolling back the Bedrock engine can never
/// delete player progress. These tests pin that separation and the versioned
/// engine directory scheme.
/// </summary>
public sealed class InstallerLayoutTests
{
    [Fact]
    public void Engine_directories_are_versioned_and_separate_per_version()
    {
        var config = TestDoubles.Config();
        var installer = TestDoubles.Installer(config);

        var a = installer.EngineDirectory("1.21.20");
        var b = installer.EngineDirectory("1.21.30");

        Assert.NotEqual(a, b);
        Assert.EndsWith(Path.Combine("engines", "1.21.20"), a);
        Assert.EndsWith(Path.Combine("engines", "1.21.30"), b);
    }

    [Fact]
    public void Worlds_live_outside_the_engine_directory()
    {
        var config = TestDoubles.Config();
        var installer = TestDoubles.Installer(config);

        var world = installer.WorldDirectory("myworld");
        var engine = installer.EngineDirectory("1.21.20");

        Assert.False(world.StartsWith(engine, StringComparison.OrdinalIgnoreCase),
            "A world directory must never be inside an engine directory");
        Assert.EndsWith(Path.Combine("worlds", "myworld"), world);
    }

    [Fact]
    public void Server_directories_are_scoped_by_server_id()
    {
        var config = TestDoubles.Config();
        var installer = TestDoubles.Installer(config);

        var a = installer.ServerDirectory("11111111-1111-1111-1111-111111111111");
        var b = installer.ServerDirectory("22222222-2222-2222-2222-222222222222");

        Assert.NotEqual(a, b);
        Assert.Contains("servers", a);
    }

    [Fact]
    public void No_version_is_reported_when_nothing_is_installed()
    {
        var config = TestDoubles.Config();
        var installer = TestDoubles.Installer(config);

        Assert.Null(installer.GetInstalledVersion("does-not-exist"));
        Assert.Empty(installer.GetInstalledVersions());
    }

    [Fact]
    public void A_version_counts_as_installed_only_when_the_executable_exists()
    {
        var config = TestDoubles.Config();
        var installer = TestDoubles.Installer(config);
        var serverId = Guid.NewGuid().ToString();

        // Directory exists but the engine binary does not: not installed.
        Directory.CreateDirectory(installer.ServerDirectory(serverId));
        Assert.Null(installer.GetInstalledVersion(serverId));

        // Now simulate a real engine install and point state at it.
        var version = "9.9.9";
        var engine = installer.EngineDirectory(version);
        Directory.CreateDirectory(engine);
        File.WriteAllText(Path.Combine(engine, "bedrock_server.exe"), "stub");

        installer.WriteState(serverId, new ServerState(version, "world", engine, DateTime.UtcNow));

        Assert.Equal(version, installer.GetInstalledVersion(serverId));
        Assert.Contains(version, installer.GetInstalledVersions());
    }

    [Fact]
    public void Rollback_refuses_a_version_that_is_not_on_disk()
    {
        var config = TestDoubles.Config();
        var installer = TestDoubles.Installer(config);
        var serverId = Guid.NewGuid().ToString();
        Directory.CreateDirectory(installer.ServerDirectory(serverId));

        var result = installer.Rollback(serverId, "world", "8.8.8");

        Assert.False(result.Success);
        Assert.Contains("not present on this device", result.Error, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Rollback_succeeds_to_a_version_that_is_on_disk()
    {
        var config = TestDoubles.Config();
        var installer = TestDoubles.Installer(config);
        var serverId = Guid.NewGuid().ToString();
        var version = "7.7.7";

        var engine = installer.EngineDirectory(version);
        Directory.CreateDirectory(engine);
        File.WriteAllText(Path.Combine(engine, "bedrock_server.exe"), "stub");

        var result = installer.Rollback(serverId, "world", version);

        Assert.True(result.Success, result.Error);
        Assert.Equal(version, result.Version);
        Assert.Equal(version, installer.GetInstalledVersion(serverId));
    }

    [Fact]
    public async Task Install_fails_honestly_when_version_discovery_is_unavailable()
    {
        // Keep the test hermetic: if the operator override is set in the
        // environment, discovery would succeed from it and prove nothing.
        var previousOverride = Environment.GetEnvironmentVariable("OGHOST_BDS_URL");
        Environment.SetEnvironmentVariable("OGHOST_BDS_URL", null);
        try
        {
            var config = TestDoubles.Config();
            var installer = TestDoubles.Installer(config);

            // NoOpHttpFactory blocks the network, so discovery returns null and the
            // installer must report that rather than guessing a version.
            var result = await installer.InstallAsync(
                Guid.NewGuid().ToString(), "world", null, "stable", CancellationToken.None);

            Assert.False(result.Success);
            Assert.Null(result.Version);
            Assert.Contains("discover", result.Error, StringComparison.OrdinalIgnoreCase);
        }
        finally
        {
            Environment.SetEnvironmentVariable("OGHOST_BDS_URL", previousOverride);
        }
    }

    [Fact]
    public void State_survives_a_round_trip()
    {
        var config = TestDoubles.Config();
        var installer = TestDoubles.Installer(config);
        var serverId = Guid.NewGuid().ToString();
        Directory.CreateDirectory(installer.ServerDirectory(serverId));

        var written = new ServerState("1.21.20", "survival-world", "/tmp/engine", DateTime.UtcNow);
        installer.WriteState(serverId, written);
        var read = installer.ReadState(serverId);

        Assert.Equal(written.Version, read.Version);
        Assert.Equal(written.WorldName, read.WorldName);
    }

    [Fact]
    public void Reading_state_for_an_unknown_server_does_not_throw()
    {
        var config = TestDoubles.Config();
        var installer = TestDoubles.Installer(config);
        var state = installer.ReadState("no-such-server");
        Assert.Null(state.Version);
        Assert.Null(state.WorldName);
    }
}
