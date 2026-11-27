using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using OGHost.Agent;
using OGHost.Agent.Networking;
using OGHost.Agent.Services;

// ---------------------------------------------------------------------------
// OG HOST Windows Agent
//
// Runs as a console app or a Windows Service. All communication with the
// control plane is outbound HTTPS, so it works behind NAT and CGNAT with no
// inbound ports, no firewall rules and no router configuration.
//
// First run: creates config.json next to the executable and exits with
// instructions. Edit config.json (controlPlaneUrl + pairingCode), run again,
// and the node appears in the web panel.
// ---------------------------------------------------------------------------

var builder = Host.CreateApplicationBuilder(args);

// Run as a Windows Service when installed as one; harmless otherwise.
builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "OGHostAgent";
});

// config.json next to the executable is the operator-editable source of truth.
var configPath = Path.Combine(AppContext.BaseDirectory, "config.json");
builder.Configuration
    .AddJsonFile("appsettings.json", optional: true, reloadOnChange: false)
    .AddJsonFile(configPath, optional: true, reloadOnChange: true)
    .AddEnvironmentVariables(prefix: "OGHOST_");

builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection(AgentOptions.SectionName));

builder.Services.AddSingleton<AgentConfigStore>();
builder.Services.AddSingleton<HardwareMonitor>();
builder.Services.AddSingleton<BdsInstaller>();
builder.Services.AddSingleton<BdsVersionDiscovery>();
builder.Services.AddSingleton<ServerProcessManager>();
builder.Services.AddSingleton<ServerFileManager>();
builder.Services.AddSingleton<BackupManager>();
builder.Services.AddSingleton<AddonInstaller>();
builder.Services.AddSingleton<RakNetVerifier>();
builder.Services.AddSingleton<DirectProvider>();
builder.Services.AddSingleton<PlayitProvider>();
builder.Services.AddSingleton<ManualProvider>();
builder.Services.AddSingleton<NetworkManager>();
builder.Services.AddSingleton<CommandDispatcher>();

// Named HTTP clients. Every service above is a singleton that owns long-lived
// agent state, so we use named clients (not typed clients, which register their
// service as transient) and let IHttpClientFactory rotate the handlers.
builder.Services.AddHttpClient(HttpClients.ControlPlane, http =>
{
    http.Timeout = TimeSpan.FromSeconds(45);
    http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "OGHOST-Agent/0.1");
})
.ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
{
    // The agent polls every few seconds; recycle pooled connections periodically
    // so a control-plane DNS change (e.g. a Vercel redeploy) is picked up.
    PooledConnectionLifetime = TimeSpan.FromMinutes(10),
});

builder.Services.AddHttpClient(HttpClients.Downloads, http =>
{
    // BDS archives are hundreds of megabytes on a slow connection.
    http.Timeout = TimeSpan.FromMinutes(30);
    http.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "OGHOST-Agent/0.1");
});

builder.Services.AddHttpClient(HttpClients.Transfers, http =>
{
    http.Timeout = TimeSpan.FromMinutes(30);
});

builder.Services.AddHttpClient(HttpClients.Lookups, http =>
{
    http.Timeout = TimeSpan.FromSeconds(15);
});

builder.Services.AddHostedService<AgentWorker>();
builder.Services.AddHostedService<BackupScheduler>();

builder.Services.Configure<HostOptions>(options =>
{
    // Give running servers time to stop cleanly on shutdown/restart.
    options.ShutdownTimeout = TimeSpan.FromSeconds(90);
});

var host = builder.Build();

// First-run convenience: if there is no config and no pairing code, print
// exactly what the operator must do instead of failing silently.
var store = host.Services.GetRequiredService<AgentConfigStore>();
await store.LoadAsync(CancellationToken.None);
if (!store.IsPaired && string.IsNullOrWhiteSpace(store.Options.PairingCode))
{
    var logger = host.Services.GetRequiredService<ILoggerFactory>().CreateLogger("OGHost.Agent");
    logger.LogWarning(
        """

        ============================================================
          OG HOST Agent is not paired yet.

          1. Sign in to your OG HOST website and open Devices.
          2. Tap "Pair a device" to generate a pairing code.
          3. Edit this file:   {ConfigPath}
             Set "ControlPlaneUrl" to your website address, e.g.
                 https://your-app.vercel.app
             Set "PairingCode" to the code from step 2.
          4. Run OGHost.Agent.exe again.

          No inbound ports or firewall rules are needed.
        ============================================================
        """,
        configPath);
}

await host.RunAsync();
