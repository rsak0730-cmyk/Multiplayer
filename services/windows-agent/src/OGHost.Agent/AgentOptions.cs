using System.Text.Json.Serialization;

namespace OGHost.Agent;

/// <summary>
/// Agent configuration. Values come from <c>config.json</c> next to the
/// executable (or environment variables / appsettings.json). The pairing code
/// is single-use: after a successful claim the agent writes the issued token
/// back to config.json and clears the code.
/// </summary>
public sealed class AgentOptions
{
    public const string SectionName = "Agent";

    /// <summary>Base URL of the OG HOST web control plane, e.g. https://og-host.vercel.app</summary>
    public string ControlPlaneUrl { get; set; } = "http://localhost:3000";

    /// <summary>Short-lived pairing code shown in the web UI (XXXXXX-XXXXXX).</summary>
    public string? PairingCode { get; set; }

    /// <summary>Long-lived node token issued at pairing time. Keep secret.</summary>
    public string? NodeToken { get; set; }

    /// <summary>Node id assigned by the control plane after pairing.</summary>
    public string? NodeId { get; set; }

    /// <summary>Root directory for all BDS installs, worlds and backups.</summary>
    public string DataDirectory { get; set; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "OGHOST");

    /// <summary>Heartbeat interval in seconds.</summary>
    public int HeartbeatIntervalSeconds { get; set; } = 15;

    /// <summary>Command poll interval in seconds when idle.</summary>
    public int PollIntervalSeconds { get; set; } = 4;

    /// <summary>Console log flush interval in seconds.</summary>
    public int LogFlushIntervalSeconds { get; set; } = 3;

    /// <summary>
    /// Automatically restart a Minecraft server that exits unexpectedly.
    /// Off by default: an automatic restart loop on a broken world is worse
    /// than a clean stop.
    /// </summary>
    public bool AutoRestartOnCrash { get; set; }

    /// <summary>Maximum automatic restarts before giving up.</summary>
    public int MaxAutoRestarts { get; set; } = 3;

    /// <summary>
    /// Start servers marked auto_start_on_node_boot when the agent starts.
    /// Off by default — the agent must never start Minecraft on its own unless
    /// the user explicitly enabled it.
    /// </summary>
    public bool HonorAutoStart { get; set; }

    /// <summary>Minimum free RAM (MB) required before a server may start.</summary>
    public int MinFreeRamMb { get; set; } = 1024;

    /// <summary>Minimum free disk (MB) required before a server may start.</summary>
    public int MinFreeDiskMb { get; set; } = 2048;

    /// <summary>Prefer the preview BDS channel when discovering versions.</summary>
    public bool UsePreviewChannel { get; set; }

    /// <summary>Optional Playit secret for UDP tunnelling behind CGNAT.</summary>
    public string? PlayitSecret { get; set; }

    /// <summary>Path to a playit-agent executable, if the user installed one.</summary>
    public string? PlayitAgentPath { get; set; }

    public string ServersRoot => Path.Combine(DataDirectory, "servers");
    public string EnginesRoot => Path.Combine(DataDirectory, "engines");
    public string WorldsRoot => Path.Combine(DataDirectory, "worlds");
    public string BackupsRoot => Path.Combine(DataDirectory, "backups");
    public string DownloadsRoot => Path.Combine(DataDirectory, "downloads");

    /// <summary>
    /// Optional relocation of config.json. Settable from an environment variable
    /// (<c>OGHOST_ConfigPathOverride</c>) or appsettings.json, but deliberately
    /// NOT from config.json itself — a file must not be able to redirect the
    /// agent to a different file. Ignored by the JSON serialiser for that reason.
    /// </summary>
    [JsonIgnore]
    public string? ConfigPathOverride { get; set; }

    /// <summary>Where config.json is read from and written to.</summary>
    public string ConfigPath =>
        string.IsNullOrWhiteSpace(ConfigPathOverride)
            ? Path.Combine(AppContext.BaseDirectory, "config.json")
            : ConfigPathOverride;
}
