# OG HOST — Windows Agent

The Windows agent is the part of OG HOST that actually hosts Minecraft. The
website is a remote control; this program is the machine doing the work.

It runs on Windows 10/11 as a console app or a Windows Service, built on
**.NET 8 Worker Service**.

---

## What it does

| Responsibility | Where |
| --- | --- |
| Pairs with your account using a short-lived code | `AgentWorker.PairAsync` |
| Reports CPU / RAM / storage every 15 s | `Services/HardwareMonitor.cs` |
| Polls for commands (outbound HTTPS only) | `AgentWorker.PollLoopAsync` |
| Discovers the latest official BDS build | `Services/BdsVersionDiscovery.cs` |
| Downloads, checksums and installs BDS | `Services/BdsInstaller.cs` |
| Starts / stops / restarts `bedrock_server.exe` | `Services/ServerProcessManager.cs` |
| Streams real console output to the panel | `AgentWorker.LogShippingLoopAsync` |
| Forwards allowlisted console commands | `ServerProcessManager.SendCommandAsync` |
| Confined file browsing / edit / upload / delete | `Services/ServerFileManager.cs` |
| Consistent world backups and restores | `Services/BackupManager.cs` |
| Scheduled backups that run while you are asleep | `Services/BackupScheduler.cs` |
| `.mcpack` / `.mcaddon` / `.mcworld` installation | `Services/AddonInstaller.cs` |
| Pluggable multiplayer networking + real verification | `Networking/` |
| Version updates with automatic rollback | `CommandDispatcher.UpdateBds` |

## What it deliberately does not do

- **No listening ports.** Every connection is outbound, so it works behind NAT
  and CGNAT with no router or firewall changes.
- **No remote shell.** There is no command that runs arbitrary Windows
  programs. The only executable ever launched is `bedrock_server.exe` from an
  official install directory, with no user-controlled arguments. Console input
  reaches the process through stdin only, after allowlist validation.
- **No auto-starting Minecraft.** After a Windows restart the agent reconnects
  on its own, but servers stay stopped unless the operator enabled auto-start
  in the panel *and* set `HonorAutoStart` in `config.json`. Both switches are
  required.
- **No resource sharing.** This node belongs to exactly one account.
- **No bundled third-party binaries.** Playit's agent is not redistributed; you
  download it yourself if you use that provider.

---

## Install

### Option A — prebuilt release (easiest)

1. Download `og-host-windows-agent-win-x64.zip` from the repository's
   **Releases** page (produced by the `windows-agent` GitHub Actions workflow).
2. Unzip to a permanent folder, e.g. `C:\OGHOST`. Keep this folder: it holds
   the Bedrock engine files, worlds and backups.
3. Run `OGHost.Agent.exe` once. It creates `config.json` and prints
   instructions.
4. Get a pairing code from the website → **Devices** → **Pair a device**.
5. Edit `config.json`:

   ```json
   {
     "ControlPlaneUrl": "https://your-app.vercel.app",
     "PairingCode": "ABC123-DEF456"
   }
   ```

6. Run `OGHost.Agent.exe` again. Within a few seconds the device appears in the
   panel as **online**.

### Option B — build from source

```powershell
cd services/windows-agent
dotnet publish src/OGHost.Agent -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

The executable lands in
`src/OGHost.Agent/bin/Release/net8.0/win-x64/publish/OGHost.Agent.exe`.

### Run as a Windows Service (survives restarts)

From an **elevated** PowerShell prompt:

```powershell
cd services/windows-agent/scripts
.\install-service.ps1 -ExePath "C:\OGHOST\OGHost.Agent.exe"
```

Remove it with `.\install-service.ps1 -Uninstall`.

---

## config.json reference

| Key | Default | Meaning |
| --- | --- | --- |
| `ControlPlaneUrl` | `http://localhost:3000` | Your deployed OG HOST website. |
| `PairingCode` | `null` | Single-use code from the Devices page. Cleared after pairing. |
| `NodeToken` | `null` | Long-lived credential issued at pairing. **Keep secret.** |
| `NodeId` | `null` | Assigned by the control plane. |
| `DataDirectory` | `%LocalAppData%\OGHOST` | Engines, worlds, backups, downloads. |
| `HeartbeatIntervalSeconds` | `15` | How often hardware stats are reported. |
| `PollIntervalSeconds` | `4` | How often commands are fetched. |
| `LogFlushIntervalSeconds` | `3` | Console output batch interval. |
| `MinFreeRamMb` | `1024` | Refuses to start a server below this. |
| `MinFreeDiskMb` | `2048` | Refuses to start a server below this. |
| `AutoRestartOnCrash` | `false` | Restart a server that dies unexpectedly. |
| `MaxAutoRestarts` | `3` | Crash-loop guard. |
| `HonorAutoStart` | `false` | Allow panel-configured auto-start at boot. |
| `UsePreviewChannel` | `false` | Prefer Bedrock preview builds. |
| `PlayitSecret` | `null` | Secret for a Playit UDP tunnel. |
| `PlayitAgentPath` | `null` | Path to `playit.exe` if not next to the agent. |

Any value can also be set with an environment variable prefixed `OGHOST_`,
e.g. `OGHOST_ControlPlaneUrl`.

---

## On-disk layout

```
%LocalAppData%\OGHOST\
├── engines\               Bedrock Dedicated Server builds, one folder per version
│   └── 1.21.20\           disposable engine files
├── worlds\                the precious data — never inside an engine folder
│   └── myworld\
├── servers\               one folder per server (config + linked world + packs)
│   └── <server-id>\
│       ├── bedrock_server.exe
│       ├── server.properties
│       ├── worlds\myworld   → link to ..\..\worlds\myworld
│       ├── behavior_packs\
│       └── .oghost-state.json
├── backups\
│   └── <server-id>\*.zip
└── downloads\             archived BDS installers
```

Worlds living outside the engine directory is what makes updates and rollbacks
safe: swapping the Bedrock version can never delete player progress.

---

## Development

```bash
cd services/windows-agent
dotnet build
dotnet test
```

Tests cover the security boundaries (command allowlist, path confinement,
protected system files), version comparison, download-page parsing, CGNAT
detection, installer layout and the full backup/restore round trip.

The agent can be built and tested on Linux/macOS for development, but
`bedrock_server.exe` only runs on Windows — process-level behaviour must be
verified on a real Windows machine. See `docs/INSTALLATION.md`.
