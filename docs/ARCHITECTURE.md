# OG HOST — Architecture

## The one idea everything else follows from

**The website is the remote control. Your Windows computer is the game host.**

OG HOST is a public, multi-user platform with strictly private resources.
Anyone may register an account and pair their own machines, but no account can
ever see, control, or consume another account's hardware. There is no shared
hosting and no resource pooling — that is a design constraint, not a missing
feature.

```
┌──────────────────────┐         ┌───────────────────────────┐
│  Your phone / any    │  HTTPS  │  Vercel                   │
│  browser             │────────▶│  Next.js app + API routes │
│  (Android-first UI)  │         │  (serverless, short-lived)│
└──────────────────────┘         └─────────────┬─────────────┘
                                               │
                                    Supabase JS (anon key, RLS)
                                    service role (server-side only)
                                               │
                                 ┌─────────────▼─────────────┐
                                 │  Supabase                 │
                                 │  PostgreSQL + Auth        │
                                 │  Row Level Security       │
                                 │  Storage (add-ons, files, │
                                 │  backup transfers)        │
                                 └─────────────▲─────────────┘
                                               │
                        outbound HTTPS polling │ (agent initiates
                        every ~4s for commands │  every connection)
                        every ~15s heartbeat   │
                                               │
                                 ┌─────────────┴─────────────┐
                                 │  Your Windows 10/11 PC    │
                                 │  OGHost.Agent.exe         │
                                 │   └─ bedrock_server.exe   │──▶ UDP 19132
                                 │      (official BDS)       │    to your friends
                                 └───────────────────────────┘
```

### Why polling instead of websockets or inbound connections

Vercel functions are short-lived and cannot hold a permanent connection to a
device, and a home PC behind NAT/CGNAT cannot receive inbound connections
without router configuration. So the **agent initiates everything**:

- `POST /api/agent/heartbeat` every ~15 s — hardware stats and per-server status.
- `GET /api/agent/commands/poll` every ~4 s — the agent's work queue.
- `POST /api/agent/commands/result` — completion or failure of a command.
- `POST /api/agent/console-logs` — batched real BDS stdout/stderr.
- `POST /api/agent/events` — lifecycle events for the activity feed.

The consequence: a node is "online" only if a heartbeat arrived in the last
90 seconds. Nothing infers liveness; it is measured.

### Why commands are queued in the database

A command row (`node_commands`) is the contract between the two sides. This
gives three properties that matter for a free self-hosted product:

1. **Offline tolerance.** Create a server while the laptop is asleep; the
   install command waits and runs when it wakes.
2. **Auditability.** Every privileged action is a row with a timestamp, a
   status, a result payload and an error message.
3. **No long-lived connection state.** Nothing has to survive a Vercel cold
   start or a Windows restart.

---

## Components

### `apps/web` — Next.js 14 (App Router) control plane

| Layer | Path | Notes |
| --- | --- | --- |
| Pages | `src/app/(dashboard)/**` | Mobile-first, dark glass UI. |
| Auth pages | `src/app/(auth)/**` | Login / signup via Supabase Auth. |
| User API | `src/app/api/{nodes,servers,dashboard,profile}/**` | Ownership-checked, RLS-scoped. |
| Agent API | `src/app/api/agent/**` | Token-authenticated, rate limited. |
| Domain logic | `src/lib/**` | Auth, commands, rate limiting, audit, BDS, networking. |
| UI primitives | `src/components/ui/**` | Card, Badge, Meter, StatusDot. |

Server components read through the **anon** Supabase client, so Row Level
Security applies and a user can only ever see their own rows. Writes that need
to bypass RLS go through server-side API routes using the **service role**
key — and each of those routes re-verifies ownership explicitly first. RLS is
the safety net, not the only defence.

### `packages/shared` — contracts

Types, the command vocabulary, validation helpers and constants shared by the
web app and mirrored by the agent. Framework-free on purpose.

Notably `isAllowedBdsCommand()` — the same allowlist the agent enforces again
independently. Two implementations of one boundary: if either is wrong, the
other still holds.

### `services/windows-agent` — .NET 8 Worker Service

| Concern | File |
| --- | --- |
| Main loop (pair → heartbeat → poll) | `AgentWorker.cs` |
| Command allowlist dispatcher | `Services/CommandDispatcher.cs` |
| Real hardware measurement | `Services/HardwareMonitor.cs` |
| Version discovery (never hard-coded) | `Services/BdsVersionDiscovery.cs` |
| Install / update / rollback | `Services/BdsInstaller.cs` |
| BDS process lifecycle | `Services/ServerProcessManager.cs` |
| Confined file access | `Services/ServerFileManager.cs` |
| Backups + scheduled backups | `Services/BackupManager.cs`, `Services/BackupScheduler.cs` |
| Bedrock add-ons | `Services/AddonInstaller.cs` |
| Pluggable networking | `Networking/INetworkProvider.cs` and friends |

### `supabase/migrations`

Four migrations. `001` extends the four tables that already exist in the
`og-host` project (`nodes`, `servers`, `pairing_codes`, `node_events`) with
`ADD COLUMN IF NOT EXISTS` and creates the additional tables. It never drops or
recreates anything. `002` adds indexes and read-only views, `003` seeds the
networking provider catalogue, `004` creates storage buckets and per-node
network settings.

---

## Data flow: clicking "Start"

This is the sequence the platform is actually judged on.

```
1.  Browser      POST /api/servers/:id/control {action:"start"}
2.  API          requireUser() → Supabase session
3.  API          loadServerContext() → reads server + node through the anon
                 client, so RLS proves ownership. A wrong id is a 404, not a
                 403 — it never confirms someone else's server exists.
4.  API          is node.last_seen_at within 90 s?  → no: 409 NODE_OFFLINE
5.  API          enough free RAM / disk?            → no: 409 INSUFFICIENT_*
6.  API          is BDS installed?                  → no: queue install_bds
                                                        with then_start:true
7.  API          INSERT node_commands (start_server) with service role
8.  API          UPDATE servers.status = 'starting'
9.  API          INSERT audit_logs
10. Agent        GET /api/agent/commands/poll → claims the command
11. Agent        re-checks free RAM/disk locally (never trusts the panel)
12. Agent        spawns bedrock_server.exe, redirects stdin/stdout/stderr
13. Agent        waits for the "Server started" line, up to 90 s
14. Agent        establishes networking via the selected provider
15. Agent        sends a REAL RakNet unconnected ping to the public endpoint
16. Agent        POST /api/agent/commands/result {status, result}
17. API          UPDATE servers.status, installed_version, public_address,
                 networking_verified
18. Agent        heartbeats keep the status and player count current
19. Browser      polls /api/servers/:id and renders the real state
```

Step 15 is the whole point of the exercise. Without it, "your server is
online" is an opinion. With it, it is a measurement.

---

## Design decisions worth knowing

**Worlds live outside engine directories.** `%LocalAppData%\OGHOST\worlds\`
holds the data; `engines\<version>\` holds disposable Bedrock binaries. An
update extracts into a *new* versioned folder and re-links the world, so a
failed update cannot eat a save. Rollback is just re-pointing the link.

**Uploads never transit a serverless function.** Vercel caps request bodies at
~4.5 MB while `.mcaddon` files and world archives are far larger. The API
issues a signed Supabase Storage upload URL, the browser PUTs the bytes
directly, then the agent pulls them down through a 15-minute signed download
URL. Storage paths are prefixed with the owner's user id so storage RLS
applies.

**Console polling, not websockets.** Tailing `server_console_logs` every 2.5 s
works on Vercel, survives cold starts, and is battery-friendly on a phone
(it pauses when the tab is hidden).

**Nothing is faked.** No seeded demo servers, no invented statistics, no
guessed IP addresses. Absent data renders as "unknown" or "offline". Where a
value is stale (device went offline) the UI says so explicitly.

---

## Extending

**Add a networking provider.** Implement `INetworkProvider` in the agent
(`StartAsync`, `StopAsync`, `CurrentAddress`, `CurrentPort`, `SupportsCgnat`),
register it in `NetworkManager.Resolve`, add a row to `network_providers`, and
add it to the `provider` enum in `network_endpoints`. Nothing else changes —
verification is provider-agnostic because it always speaks RakNet at whatever
address comes back.

**Add a command.** Add the string to `NODE_COMMANDS` in `packages/shared`,
add a Zod-validated branch in the relevant API route, and add a handler to
`CommandDispatcher._handlers`. A command type missing from that dictionary is
refused by the agent even if it somehow reaches the queue.

**Add a BDS setting.** Add the column in a migration, the field in
`server_configs`, the entry in `renderServerProperties()`, and a control in
`ConfigPanel.tsx`. The agent writes whatever `server.properties` text the panel
sends, so no agent change is needed.
