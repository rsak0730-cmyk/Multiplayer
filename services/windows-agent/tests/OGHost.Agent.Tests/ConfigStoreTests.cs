using System.Text.Json;
using Xunit;

namespace OGHost.Agent.Tests;

/// <summary>
/// config.json is the operator's only interface to the agent, and it holds the
/// node token. These tests cover persistence, the single-use pairing code, and
/// that a malformed file degrades to defaults instead of crashing the agent.
/// </summary>
public sealed class ConfigStoreTests
{
    [Fact]
    public async Task Creates_a_config_file_on_first_load()
    {
        var store = TestDoubles.Config();
        await store.LoadAsync(CancellationToken.None);

        Assert.True(File.Exists(store.Options.ConfigPath));
        Assert.False(store.IsPaired);
    }

    [Fact]
    public async Task Persists_the_node_token_across_a_reload()
    {
        var store = TestDoubles.Config();
        await store.LoadAsync(CancellationToken.None);

        store.Options.NodeId = "node-123";
        store.Options.NodeToken = "ogt_test_token";
        await store.SaveAsync(CancellationToken.None);

        var json = await File.ReadAllTextAsync(store.Options.ConfigPath);
        using var doc = JsonDocument.Parse(json);
        Assert.Equal("node-123", doc.RootElement.GetProperty("NodeId").GetString());
        Assert.Equal("ogt_test_token", doc.RootElement.GetProperty("NodeToken").GetString());

        // A brand-new store reading the same file must come back paired. This is
        // what makes the agent survive a reboot without re-pairing.
        var reloaded = TestDoubles.Config(o =>
        {
            o.DataDirectory = store.Options.DataDirectory;
            o.ConfigPathOverride = store.Options.ConfigPath;
        });
        await reloaded.LoadAsync(CancellationToken.None);

        Assert.True(reloaded.IsPaired);
        Assert.Equal("ogt_test_token", reloaded.Options.NodeToken);
        Assert.Equal("node-123", reloaded.Options.NodeId);
    }

    [Fact]
    public async Task Clearing_the_pairing_code_is_persisted()
    {
        var store = TestDoubles.Config(o => o.PairingCode = "ABC123-DEF456");
        await store.LoadAsync(CancellationToken.None);

        // Simulate a successful claim: the agent clears the single-use code.
        store.Options.PairingCode = null;
        store.Options.NodeToken = "ogt_issued";
        await store.SaveAsync(CancellationToken.None);

        var json = await File.ReadAllTextAsync(store.Options.ConfigPath);
        Assert.DoesNotContain("ABC123-DEF456", json);
        Assert.Contains("ogt_issued", json);
        Assert.True(store.IsPaired);
    }

    [Fact]
    public async Task A_malformed_config_file_falls_back_to_defaults()
    {
        var store = TestDoubles.Config();
        await store.LoadAsync(CancellationToken.None);
        await File.WriteAllTextAsync(store.Options.ConfigPath, "{ this is not json");

        // Must not throw; the agent has to keep running and tell the user.
        await store.LoadAsync(CancellationToken.None);
        Assert.False(store.IsPaired);
    }

    [Fact]
    public async Task Creates_every_data_subdirectory()
    {
        var store = TestDoubles.Config();
        await store.LoadAsync(CancellationToken.None);

        Assert.True(Directory.Exists(store.Options.ServersRoot));
        Assert.True(Directory.Exists(store.Options.EnginesRoot));
        Assert.True(Directory.Exists(store.Options.WorldsRoot));
        Assert.True(Directory.Exists(store.Options.BackupsRoot));
        Assert.True(Directory.Exists(store.Options.DownloadsRoot));
    }

    [Fact]
    public async Task Defaults_are_conservative_for_low_end_hardware()
    {
        var store = TestDoubles.Config();
        await store.LoadAsync(CancellationToken.None);

        // A 6 GB Windows laptop needs these guardrails: ~1 GB free RAM and
        // 2 GB free disk before BDS is allowed to start.
        Assert.Equal(1024, store.Options.MinFreeRamMb);
        Assert.Equal(2048, store.Options.MinFreeDiskMb);
        Assert.False(store.Options.AutoRestartOnCrash);
        Assert.False(store.Options.HonorAutoStart);
    }

    [Fact]
    public async Task Zero_or_negative_values_from_config_do_not_disable_guardrails()
    {
        var store = TestDoubles.Config();
        await store.LoadAsync(CancellationToken.None);

        var path = store.Options.ConfigPath;
        await File.WriteAllTextAsync(path, """
        {
          "ControlPlaneUrl": "https://og.example.com/",
          "MinFreeRamMb": 0,
          "MinFreeDiskMb": -5,
          "MaxAutoRestarts": 0,
          "HeartbeatIntervalSeconds": 0
        }
        """);
        await store.LoadAsync(CancellationToken.None);

        Assert.Equal(1024, store.Options.MinFreeRamMb);
        Assert.Equal(2048, store.Options.MinFreeDiskMb);
        Assert.Equal(3, store.Options.MaxAutoRestarts);
        Assert.Equal(15, store.Options.HeartbeatIntervalSeconds);
        Assert.Equal("https://og.example.com", store.Options.ControlPlaneUrl);
    }
}
