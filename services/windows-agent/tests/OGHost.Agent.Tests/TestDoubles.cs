using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using OGHost.Agent;
using OGHost.Agent.Services;

namespace OGHost.Agent.Tests;

/// <summary>Shared helpers for building the agent's services without a host.</summary>
internal static class TestDoubles
{
    public static ILogger<T> Logger<T>() => NullLogger<T>.Instance;

    public static AgentConfigStore Config(Action<AgentOptions>? configure = null)
    {
        // Every store gets its OWN config.json and data directory. Without this,
        // AgentConfigStore would read and write the single config.json in the test
        // runner's output directory, and tests that mutate it would interfere with
        // each other in whatever order xUnit happens to run them.
        var isolated = Path.Combine(Path.GetTempPath(), $"oghost-test-{Guid.NewGuid():N}");
        var options = new AgentOptions
        {
            DataDirectory = isolated,
            ConfigPathOverride = Path.Combine(isolated, "config.json"),
            ControlPlaneUrl = "https://example.invalid",
        };
        configure?.Invoke(options);
        Directory.CreateDirectory(options.DataDirectory);
        return new AgentConfigStore(Options.Create(options), Logger<AgentConfigStore>());
    }

    public static BdsInstaller Installer(AgentConfigStore config, BdsVersionDiscovery? discovery = null)
    {
        var factory = new NoOpHttpFactory();
        discovery ??= new BdsVersionDiscovery(factory, config, Logger<BdsVersionDiscovery>());
        return new BdsInstaller(factory, config, discovery, Logger<BdsInstaller>());
    }
}

/// <summary>
/// A minimal IHttpClientFactory that returns a client which cannot reach the
/// network, so tests never depend on connectivity and never hit a real host.
/// </summary>
internal sealed class NoOpHttpFactory : IHttpClientFactory
{
    public HttpClient CreateClient(string name) =>
        new(new BlockingHandler()) { BaseAddress = null };

    private sealed class BlockingHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.ServiceUnavailable)
            {
                Content = new StringContent("network disabled in tests"),
            });
    }
}
