# OG HOST

**Free, self-hosted Minecraft Bedrock hosting you control from your phone.**

OG HOST turns a Windows PC you already own into a private Minecraft **Bedrock**
host, managed through a public website. You register your own machine as a node,
then create, start, update, back up and moderate official Bedrock Dedicated
Server (BDS) instances from anywhere — no hosting subscription, no shared
hardware, no third party holding your worlds.

The website is multi-user: anyone can sign up and pair their own device. Each
account sees **only its own** nodes and servers. Your worlds never leave your
computer.

---

## Why this exists

Commercial Bedrock hosting costs money every month and your world lives on
someone else's machine. A Raspberry Pi or a Linux VPS cannot run official BDS —
Bedrock Dedicated Server is **Windows-only**. So the obvious free option is the
Windows laptop sitting in your room, which is exactly what OG HOST drives.

Designed around a modest target machine: **Windows 10, Intel i3, 6 GB RAM,
500 GB disk, up to 10 players.** The guardrails default to refusing a start
unless ~1 GB of RAM and ~2 GB of disk are free, because on hardware that small
the alternative is a machine that stops responding.

---

## What it does

| | |
| --- | --- |
| **Server lifecycle** | Start, stop, restart, force-stop — queued as commands and executed by the node |
| **Live console** | Real BDS output streamed to the browser, plus an allowlisted command line |
| **File manager** | Browse, read, edit, upload and download server files, confined to one server's directory |
| **Add-ons** | Upload `.mcpack` / `.mcaddon` / `.mcworld`, installed into the right folder and registered |
| **Version manager** | Discovers the current official BDS build at runtime; update and rollback with backup and verification |
| **World backups** | Create, list, restore, delete, download; optional schedule that runs while the site is closed |
| **Monitoring** | CPU, RAM, storage, player count, uptime — real numbers from the node |
| **Networking** | Pluggable providers (direct / Playit / manual / custom) with RakNet-verified addresses |
| **Secure pairing** | Short-lived single-use codes; the node token is stored only as a SHA-256 hash |

### What it deliberately does not do

- **No remote shell.** The console accepts only allowlisted Bedrock commands —
  checked twice, once in the web layer and again in the agent. There is no
  `cmd`, no PowerShell, no arbitrary execution, by design.
- **No resource pooling.** Your node is never shared with another account, and
  no account can see another's servers, files, backups or console.
- **No invented addresses.** If a multiplayer address has not been verified by a
  real RakNet round trip, the UI says **UNVERIFIED** rather than implying it
  works. If nothing is established, no address is shown at all.
- **No hard-coded Minecraft versions.** Bedrock ships builds constantly; a pinned
  version would rot in weeks. Versions are discovered from the official download
  page at runtime, and a test fails the build if a version literal appears in
  product code.

---

## Architecture

```
  Your phone / any browser
            │  HTTPS
            ▼
  ┌──────────────────────┐        ┌─────────────────────────┐
  │  Next.js web panel   │◄──────►│  Supabase               │
  │  (Vercel)            │        │  Postgres + Auth + RLS  │
  │  API routes hold the │        │  Storage (add-ons,      │
  │  service-role key    │        │  backups, file transfer)│
  └──────────────────────┘        └─────────────────────────┘
            ▲   command queue (rows in Postgres)
            │   outbound HTTPS polling only
  ┌─────────┴────────────┐
  │  OG HOST Agent (C#)  │   your Windows PC
  │  Windows service     │
  │   ├─ BDS process mgr │──► bedrock_server.exe (official, Windows-only)
  │   ├─ version mgr     │──► minecraft.net download page
  │   ├─ file mgr        │──► {data}/servers/{id}
  │   ├─ backups         │──► {data}/backups
  │   ├─ add-ons         │
  │   └─ network providers ─► direct / Playit / manual
  └──────────────────────┘
```

**The agent never listens on a port.** It polls the control plane over outbound
HTTPS, which is why it works behind NAT, CGNAT and a carrier firewall with no
router configuration and no inbound firewall rule for the agent itself. It also
means the agent reconnects on its own after a reboot — Minecraft servers do
**not** auto-start unless you explicitly enable that per server *and* set
`HonorAutoStart` on the node. Both switches are required.

Bedrock gameplay traffic is a separate matter: that is UDP/RakNet on port 19132
and it does need a path in. See [docs/NETWORKING.md](docs/NETWORKING.md) — it is
the most important document in this repo if you want friends to actually join.

Full detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Repository layout

```
apps/web/                     Next.js 14 panel + 26 API routes (the control plane)
packages/shared/              TS contracts shared by web and agent tooling
services/windows-agent/       C# .NET 8 agent that runs on your Windows PC
  src/OGHost.Agent/           the agent itself
  tests/OGHost.Agent.Tests/   xUnit suite (allowlist, paths, versions, backups…)
  scripts/install-service.ps1 run as a Windows service, survives restarts
supabase/migrations/          001–007, additive and idempotent
docs/                         ARCHITECTURE, SECURITY, NETWORKING,
                              INSTALLATION, FEATURE-INVENTORY
.github/workflows/            web CI (ubuntu) and agent CI (windows)
```

---

## Getting started

Full walkthrough with verification steps:
**[docs/INSTALLATION.md](docs/INSTALLATION.md)**

The short version:

```bash
npm install
cp apps/web/.env.example apps/web/.env.local   # fill in your Supabase keys
npm run dev                                    # http://localhost:3000
```

1. Apply `supabase/migrations/001`–`007` in order (they extend the existing
   `nodes`, `servers`, `pairing_codes`, `node_events` tables and never drop them).
   **Already applied to the live `og-host` project** — see
   [docs/INSTALLATION.md](docs/INSTALLATION.md#step-1--database-migrations).
   Do not skip `005` or `007`: `005` grants the privileges the app needs and
   revokes TRUNCATE from the untrusted roles, and `007` fixes the default ACL so
   tables created later do not quietly re-inherit it.
2. Deploy `apps/web` to Vercel — **set Root Directory to `apps/web`**.
3. Download the agent from the GitHub Actions artifact (no Windows toolchain
   needed) or `dotnet publish` it yourself.
4. Generate a pairing code in the panel, put it in the agent's `config.json`,
   run the agent.
5. Create a server, start it, and **verify multiplayer from your phone on mobile
   data** — not on the same Wi-Fi as the host.

The agent builds in CI on `windows-latest` for `win-x64` and `win-arm64`, so you
never need a Windows machine to produce the binary.

---

## Development

```bash
npm run typecheck     # shared + web
npm run test          # vitest: shared + web
npm run lint
npm run build         # production build of apps/web

cd services/windows-agent
dotnet build OGHost.Agent.sln -c Release
dotnet test  OGHost.Agent.sln -c Release
```

CI runs all of the above on every push and pull request. The web job also
validates the SQL migrations and **fails if any migration drops one of the four
original tables**.

### Test coverage worth knowing about

Some tests exist purely to stop two things from drifting apart, because no single
runtime ever exercises both sides:

- `packages/shared/tests/allowlist-mirror.test.ts` reads the C#
  `AllowedCommands` set out of `ServerProcessManager.cs` and fails if the web
  allowlist differs by even one command.
- `apps/web/tests/networking-addresses.test.ts` asserts the panel's address
  plausibility check is the exact inverse of the agent's CGNAT detection,
  including the RFC 6598 boundaries that matter for Airtel / Jio / Vi.
- `packages/shared/tests/constants.test.ts` fails if a Minecraft version literal
  appears anywhere in product code.
- `packages/shared/tests/migration-safety.test.ts` fails if any migration grants
  TRUNCATE, TRIGGER or REFERENCES to `anon`/`authenticated`, grants the browser
  role write access, creates a view without `security_invoker`, drops or
  recreates one of the four original tables, or creates a table without enabling
  RLS. This guard was verified by injecting a bad `GRANT TRUNCATE` and confirming
  it fails — a test that cannot fail is not a test.

---

## Verification status — read this

This project is honest about the difference between *built* and *proven*.

| | |
| --- | --- |
| **Verified against the live database** | Migrations 001–007 applied to project `og-host`; 29 tables, all RLS-enabled, 31 policies; **cross-account isolation proven by a 16/16 SQL probe** with two throwaway users (B sees none of A's servers, events or backups; writes refused; TRUNCATE refused; `security_invoker` views enforce RLS). Test data removed and the clean state re-verified. |
| **Found by applying, not by reading** | Supabase's default ACL re-grants TRUNCATE (which bypasses RLS) to every table created after migration 005. Four voice tables inherited it before 007 closed it; a re-audit now reports **0 of 29 exposed**. Static tests passed throughout — only querying the live `pg_default_acl` revealed it. |
| **Verified by build/test** | `next lint` 0 warnings; `tsc --noEmit` clean; **371 TypeScript tests pass**; `next build` succeeds — also re-verified from a clean extraction of the distributed ZIP. |
| **OG VOICE — verified** | Schema live and matching the repo file exactly (10 tables, 43 constraints, 22 indexes); the six credential tables hold no privilege for `anon`/`authenticated`; proximity gain, **dimension separation**, the ten permission states, quality classification and verification-code format covered by 97 unit tests. |
| **OG VOICE — not verified** | No real microphone capture, no two-way audio, no measured latency, no companion app build, no live Bedrock position sync, no NAT traversal on Indian mobile carriers. Needs hardware this environment does not have. See `docs/SECURITY.md`. |
| **Written, not yet executed** | The C# agent has never been compiled or run — there is no .NET toolchain or Windows machine here. Its xUnit suite was audited line by line against the real signatures, and CI builds it on `windows-latest`, but **CI has not been observed passing**. |
| **Not verified** | Joining a real Bedrock client through the Playit free tier over CGNAT. This is the single most important untested claim in the project. |
| **Not executed** | The Next.js **route-level** cross-account test (the database layer beneath it is proven; two real browsers are not); a real backup → restore and update → rollback round trip on a live server. |

Full per-feature status for the whole platform — including what is
**UNSUPPORTED** and why — is in
**[docs/FEATURE-INVENTORY.md](docs/FEATURE-INVENTORY.md)**.

Nothing here is presented as working multiplayer until a real client has joined.
The pre-launch checklist in
[docs/INSTALLATION.md](docs/INSTALLATION.md#step-8--pre-launch-checklist) lists
what to run before inviting anyone else.

See [docs/SECURITY.md](docs/SECURITY.md) for the threat model, including an
explicit list of what is **not** implemented (in-memory-only rate limiting, no
CSP headers, unsigned agent binary, no virus scanning, no per-server quotas).

---

## Requirements

| | |
| --- | --- |
| **Node machine** | Windows 10/11, x64 or arm64. 6 GB RAM and 500 GB disk are enough for 10 players |
| **Website** | Node 20+, a Supabase project, a Vercel account |
| **Minecraft** | Bedrock Edition client to actually play. Java Edition is **not** supported — this is Bedrock-only, using official BDS |
| **Cost** | Zero. No paid service is required; Playit's free tier is the default suggestion for CGNAT connections |

---

## Note on the rest of this repository

This Git history also contains an unrelated earlier project (**SyncBeat**, an
Android media-sync app). Its Gradle sources are not present — only an archive —
so its build cannot succeed. That workflow has been moved to
`.github/workflows/legacy-syncbeat-android.yml` and restricted to
`workflow_dispatch` so it no longer fails on every push. It is kept for history
and is not part of OG HOST.

---

## Licence and third-party software

OG HOST does not bundle, redistribute or modify Minecraft software. The agent
downloads the **official** Bedrock Dedicated Server from Microsoft's published
download page at install time, and you are responsible for complying with
Minecraft's terms of use and EULA.

The Playit provider likewise does **not** ship Playit's binary — third-party
redistribution is not OG HOST's to grant. You supply the agent path yourself and
Playit's own terms apply.
