# OG HOST — Feature Inventory (Phase 1 Audit)

This is the implementation inventory required by §3 of the master specification.
It was produced by reading the actual source and, where possible, executing
against the live Supabase project — not by reading the UI and assuming the
backend works.

**Audit date:** 2026-11-27
**Live project:** `og-host` (ref `chhttgriyauqlracclkm`, `ap-northeast-2`, PostgreSQL 17.12)

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **IMPLEMENTED AND TESTED** | Code exists and has been executed. For SQL/TypeScript, executed in this audit or by an automated suite. |
| **IMPLEMENTED, NOT TESTED** | Code exists and is internally consistent, but has never been run. Applies to almost the whole Windows agent — there is no .NET toolchain or Windows machine here. |
| **PARTIALLY IMPLEMENTED** | A usable subset exists; named gaps are real gaps. |
| **EXPERIMENTAL** | Works only under stated conditions; must not be presented as reliable. |
| **BLOCKED BY EXTERNAL DEPENDENCY** | Requires a third party, credential, or asset OG HOST does not control. |
| **NOT IMPLEMENTED** | Nothing exists. Requires development. |
| **UNSUPPORTED** | Cannot be built safely with the interfaces Bedrock actually exposes. §10 and §7 of the spec forbid the workarounds that would be needed. |

A rule applied throughout: **a panel existing does not mean the feature works.**
Several items below have UI and still are not "implemented and tested", because
the agent that would execute them has never run.

---

## Headline findings from this audit

Three things were discovered that materially change the project's status. All
three have been fixed; the fixes are recorded here because they are the reason
the status table below differs from what the code appeared to say.

### 1. The live database had none of the application schema — FIXED

The project contained **only the four original tables** (`nodes`, `servers`,
`pairing_codes`, `node_events`). Migrations 001–004 had never been applied. The
web app reads and writes fifteen tables that did not exist, so every page and
every API route would have failed on first use.

All four migrations are now applied and recorded in migration history
(`oghost_001_core_schema` … `oghost_005_role_privileges`). The four original
tables were preserved — every statement is `add column if not exists` /
`create table if not exists`, and all four were empty (0 rows), so there was no
data at risk.

### 2. All three API roles lacked SELECT and DML — FIXED (this alone broke everything)

The ACLs on every table were:

```
postgres=arwdDxtm/postgres
anon=Dxtm/postgres
authenticated=Dxtm/postgres
service_role=Dxtm/postgres
```

`Dxt` is TRUNCATE, REFERENCES, TRIGGER. There was **no SELECT, INSERT, UPDATE or
DELETE** for any API role. Consequences:

- Dashboard pages query with the anon key plus a user JWT, so they act as
  `authenticated`. Every read failed with `permission denied for table nodes`.
- API routes use the service-role key. Every write failed — pairing, heartbeat,
  command polling, the lot.
- The RLS policies were correct and present, but unreachable: a policy only
  filters rows a role is already permitted to touch.

Fixed in `supabase/migrations/005_role_privileges.sql`.

### 3. `anon` and `authenticated` held TRUNCATE — FIXED (security)

**TRUNCATE bypasses row level security.** With it granted, a caller holding the
`anon` or `authenticated` role could have emptied `servers`, `nodes`,
`server_backups` and every other table — destroying rows belonging to *all*
accounts, not just its own. That is precisely the cross-account destruction §25
forbids.

Honest scoping of the risk, because overstating it would be as misleading as
hiding it: PostgREST exposes GET/POST/PATCH/DELETE, **not** TRUNCATE, so this was
not reachable through the ordinary REST API with an anon key. It was reachable by
anything holding a direct PostgreSQL connection as those roles, and it is exactly
the kind of standing privilege that converts a later mistake into permanent data
loss. `TRIGGER` was also granted, which lets an untrusted role attach code to a
table; `REFERENCES` has no legitimate client use here.

Migration 005 revokes all three from `anon` and `authenticated`, and sets default
privileges so tables created by future migrations inherit the correct grants
rather than the broken ones. The post-fix state was verified with
`has_table_privilege`, and the probe below confirms TRUNCATE is now refused.

### 4. `server_overview_view` referenced a column that does not exist — FIXED

`supabase/migrations/002_indexes_and_views.sql` selected `n.computed_status`
while joining `public.nodes`, but `computed_status` is produced by
`node_status_view`, not by the `nodes` table. The migration would have failed
outright. Confirmed against the live schema (`information_schema` returned zero
rows for `nodes.computed_status`) before applying. Now joins
`node_status_view`.

Both views are also now created `WITH (security_invoker = true)`. Without it a
PostgreSQL view runs as its *owner* — a role that bypasses RLS — so selecting
from these views would have returned every user's nodes and servers. Verified in
the probe: as user B, `node_status_view` returns 1 row (B's own) and
`server_overview_view` returns 0.

---

## Verification actually executed this audit

### Row Level Security — IMPLEMENTED AND TESTED

Previously recorded as UNEXECUTED across several sessions. Now genuinely run
against the live project.

Method: two throwaway `auth.users` rows (A and B), real `nodes` / `servers` /
`node_events` / `server_backups` rows owned by A, one node owned by B; then
`set_config('role','authenticated')` plus a `request.jwt.claims` JSON carrying
each user's `sub`, so `auth.uid()` resolves to that user and RLS applies for
real. All test rows and both users deleted afterwards; the probe table dropped.
Final state re-verified: **0 auth users, 0 nodes, 0 servers, 0 events, 0
pairing codes, 0 backups.**

**16 of 16 checks passed:**

| # | Check | Observed |
| --- | --- | --- |
| 1 | B sees 0 of A's servers | 0 |
| 2 | B sees only its own node (1 of 2) | 1 |
| 3 | B sees 0 of A's node_events | 0 |
| 4 | B sees 0 of A's server_backups | 0 |
| 5 | `node_status_view` enforces RLS for B | 1 |
| 6 | `server_overview_view` enforces RLS for B | 0 |
| 7 | B can read the public provider catalogue | 4 |
| 8 | B cannot INSERT servers | permission denied |
| 9 | B cannot UPDATE nodes | permission denied |
| 10 | B cannot DELETE A's backups | permission denied |
| 11 | B cannot TRUNCATE servers | permission denied |
| 12 | A sees its own server | 1 |
| 13 | A sees only its own node (1 of 2) | 1 |
| 14 | A sees its own node_events | 1 |
| 15 | A sees its own backups | 1 |
| 16 | A sees its own row via the overview view | 1 |

Checks 5, 6 and 16 are what prove `security_invoker` works. Checks 8–11 are what
prove the browser role cannot write at all. Check 11 specifically confirms the
TRUNCATE hole is closed.

### Schema state — IMPLEMENTED AND TESTED

19 tables, **all 19 with RLS enabled**, 27 policies, 3 private storage buckets,
4 seeded network providers, 5 migrations in history.

### Web application — IMPLEMENTED AND TESTED

`npm run lint` (0 warnings), `npm run typecheck` (exit 0), `npm run test`
(**253 tests passing**: 172 shared + 81 web), `next build` (exit 0; 26 API
routes, 25 pages). Also verified from a clean extraction of the distributed ZIP:
`npm ci` then all four gates again, all green.

Note the 253 total was reached *after* this audit: 237 passed when the web app
was last built, and 16 more were added as `migration-safety.test.ts` to stop the
privilege and view defects found here from regressing.

### Windows agent — IMPLEMENTED, NOT TESTED

Complete C# source and an xUnit suite exist. **Neither has ever been compiled.**
There is no .NET SDK in this environment. CI builds and tests it on
`windows-latest`, but that pipeline has not been observed passing. Every
agent-dependent row below inherits this status.

### Real Bedrock multiplayer — NOT TESTED

No Bedrock client has joined a server hosted through this system. No BDS process
has ever been started by the agent. This is the single most important unverified
claim in the project and it is unchanged.

---

## §4 Server Creation Studio

| Item | Status | Notes |
| --- | --- | --- |
| Create server (name, node, world, gamemode, difficulty, max players, port) | IMPLEMENTED, NOT TESTED | `NewServerForm.tsx` → `POST /api/servers`; agent installs BDS on first command. |
| 10-step wizard (type → preset → world → settings → add-ons → multiplayer → node → review → create → verify) | **NOT IMPLEMENTED** | Current flow is a single form, not a wizard. No type/preset selection exists. |
| Four server categories (normal / SMP / minigame / custom) | **NOT IMPLEMENTED** | No `server_type` concept in schema or UI. |
| Survival / Creative / Adventure | IMPLEMENTED, NOT TESTED | `server_configs.gamemode` constraint allows exactly these three. |
| **Spectator** | **UNSUPPORTED** | Official BDS `server.properties` `gamemode` accepts survival, creative and adventure only. Spectator is a client-side Bedrock mode with no dedicated-server setting. The existing check constraint is correct; adding it would create a setting BDS ignores. |
| Difficulty, seed, cheats, PvP, mob spawning, keep inventory, fire spread, day/night cycle | PARTIALLY IMPLEMENTED | Difficulty, PvP, `level_seed`, spawn flags exist in `server_configs`. Keep-inventory, fire spread and day/night are **gamerules**, not `server.properties` — they need a `gamerule` command after start, which is not wired up. |
| Max players, allowlist, default permission level | IMPLEMENTED, NOT TESTED | Columns exist with bounds (1–100, visitor/member/operator). |
| Resource/behavior pack assignment at creation | PARTIALLY IMPLEMENTED | Add-on install exists post-creation; not selectable during creation. |
| World import during creation | **NOT IMPLEMENTED** | See §6. |
| Creation pipeline (validate → create record → queue → install BDS → world → config → add-ons → validate → start → health → report) | PARTIALLY IMPLEMENTED | Steps 1–6 and 8 exist as queued commands. No post-install file validation, no health collection, no consolidated result report. |
| Real agent-event progress (never simulated) | IMPLEMENTED, NOT TESTED | `node_events` + command status polling are real. Nothing is faked — but nothing has run either. |

## §5 Server Type Converter

**NOT IMPLEMENTED.** No inspection, plan generation, dependency install, or
rollback path exists. It also depends on §4 categories, which do not exist yet.

## §6 World Import and Restore

| Item | Status | Notes |
| --- | --- | --- |
| `.mcworld` install | IMPLEMENTED, NOT TESTED | `AddonInstaller.InstallWorldAsync` extracts to a temp dir, validates, installs, cleans up in `finally`. |
| `.zip` containing a Bedrock world | PARTIALLY IMPLEMENTED | Handled by the same path when the archive contains a world folder. |
| Restore from an OG HOST backup | IMPLEMENTED, NOT TESTED | `BackupManager.RestoreAsync` with traversal guards. |
| Signed-URL upload transfer (never through a serverless body) | IMPLEMENTED, NOT TESTED | Correct architecture for Vercel's ~4.5 MB body cap: browser → Supabase Storage, agent pulls via short-lived signed URL. |
| SHA-256 checksums | PARTIALLY IMPLEMENTED | Computed for BDS archives; not for world uploads. |
| File-type validation | IMPLEMENTED, NOT TESTED | Extension allowlist + manifest inspection. |
| Path-traversal protection on extraction | IMPLEMENTED, NOT TESTED | `ResolveInsideRoot` on every entry; tested for zip-slip in the xUnit suite. |
| **Decompression-bomb protection** | **NOT IMPLEMENTED** | No uncompressed-size or entry-count ceiling. Real gap. |
| `level.dat` validation, required `db` directory check | **NOT IMPLEMENTED** | Not validated. A malformed world would be installed and BDS would fail at start. |
| World metadata extraction and preview | **NOT IMPLEMENTED** | |
| Resumable / chunked uploads, cancellation, recovery | **NOT IMPLEMENTED** | Single-shot signed upload. Chunking needs a different transfer design. |
| Graceful stop → verified backup → install → restart → verify → rollback | PARTIALLY IMPLEMENTED | Stop and backup exist; the verify-then-rollback chain around world replacement does not. |
| Never manipulate a live LevelDB world | IMPLEMENTED AND TESTED (by design) | No code opens LevelDB. The only safe path — stop, then copy — is what `safeStopIfRunning` implements. |

## §7 World Manager and World Vault (20 modules)

| Module | Status |
| --- | --- |
| World Library | **NOT IMPLEMENTED** (no `worlds` table; worlds are implicit directories on the node) |
| World Switcher | **NOT IMPLEMENTED** |
| World Cloner | **NOT IMPLEMENTED** |
| World Preview | **NOT IMPLEMENTED** |
| World Rename | **NOT IMPLEMENTED** |
| World Archive | **NOT IMPLEMENTED** |
| World Comparison | **NOT IMPLEMENTED** |
| One-Tap Restore | PARTIALLY IMPLEMENTED (restore exists via Backups panel; not one-tap from a world list) |
| World Timeline | **NOT IMPLEMENTED** |
| Automatic World Protection | PARTIALLY IMPLEMENTED (worlds live outside engine dirs, so updates cannot touch them — verified by xUnit `InstallerLayoutTests`; but no scheduled protection) |
| World Snapshot Manager | **NOT IMPLEMENTED** |
| World Branching | **NOT IMPLEMENTED** |
| **World Merge Research Lab** | **UNSUPPORTED** — see below |
| World Statistics | **NOT IMPLEMENTED** |
| World Recovery Points | **NOT IMPLEMENTED** |
| World Sharing | **NOT IMPLEMENTED** |
| World Travel Map | **UNSUPPORTED** (needs LevelDB region decoding and rendering; §7 forbids manipulating the world database, and no supported read interface exists) |
| World Transfer | **NOT IMPLEMENTED** (see §18 migration) |
| World Integrity Monitor | PARTIALLY IMPLEMENTED (structure/existence checks are feasible; checksum verification of backups is not wired up) |
| World Download Portal | PARTIALLY IMPLEMENTED (backup download exists via signed URL) |

**Why World Merge is UNSUPPORTED rather than merely unbuilt.** Merging regions
means reading and writing Bedrock's LevelDB world database. Bedrock ships no
supported interface for this, the on-disk format is undocumented and changes
between versions, and §7 explicitly forbids manipulating live world databases
and inventing unsupported merge APIs. A tool that appears to merge worlds while
silently corrupting chunk data would destroy exactly the asset this project
exists to protect. The honest answer is that it should not be built on this
foundation.

## §8 Performance Intelligence (18 modules)

| Item | Status | Notes |
| --- | --- | --- |
| CPU, RAM (total/available), storage (total/available) telemetry | IMPLEMENTED, NOT TESTED | `HardwareMonitor` via `GlobalMemoryStatusEx` and `/proc/meminfo`; real columns on `nodes`. |
| Server process status, uptime | IMPLEMENTED, NOT TESTED | |
| Disk activity, network upload/download | **NOT IMPLEMENTED** | Not collected. |
| RTT, jitter, packet loss | PARTIALLY IMPLEMENTED | `RakNetVerifier` measures one real RTT. No jitter, no packet-loss sampling, no history. |
| Join time, disconnects, crash counts | **NOT IMPLEMENTED** | Would require parsing BDS log lines; not done. |
| Lag Timeline | **NOT IMPLEMENTED** | No time-series telemetry table exists. |
| Bottleneck Finder | **NOT IMPLEMENTED** | |
| Server Health Score | **NOT IMPLEMENTED** | |
| Smart Restart Scheduler | **NOT IMPLEMENTED** (backup scheduling exists; restart scheduling does not) |
| Memory Pressure Guardian | PARTIALLY IMPLEMENTED | Start is refused below `MinFreeRamMb` (1024). No runtime pressure response. |
| Disk Activity Controller | **NOT IMPLEMENTED** |
| Background Task Manager | **NOT IMPLEMENTED** |
| Performance Comparison | **NOT IMPLEMENTED** |
| Crash Recovery | PARTIALLY IMPLEMENTED | `AutoRestartOnCrash` (default **false**) with `MaxAutoRestarts` 3 exists. No diagnostics collection, no owner notification, no backoff. |
| Resource Forecast | **NOT IMPLEMENTED** |
| Automatic Server Doctor | **NOT IMPLEMENTED** |
| Server Capacity Planner | **NOT IMPLEMENTED** |
| Network Route Laboratory / Capacity Laboratory | **NOT IMPLEMENTED** |
| One-Click Diagnostic Report | **NOT IMPLEMENTED** |
| Storage Compression Lab | **NOT IMPLEMENTED** |
| Server Uptime History | **NOT IMPLEMENTED** |

The spec's requirement to keep network latency, instability, server processing
delay, CPU, RAM, disk and client-side performance **separate** is respected
trivially today: only CPU/RAM/disk and a single RakNet RTT are measured, and
nothing is combined into one misleading number. No composite "ping" is displayed
anywhere.

## §9 Adaptive Network Intelligence

| Item | Status | Notes |
| --- | --- | --- |
| Pluggable provider interface | IMPLEMENTED, NOT TESTED | `INetworkProvider`; direct / playit / manual / custom. |
| Direct public-IP detection | IMPLEMENTED, NOT TESTED | External lookup across three services. |
| **CGNAT detection** | IMPLEMENTED AND TESTED | `IsPrivateOrCgnat` covers RFC 6598 `100.64/10`, RFC 1918, link-local, loopback, `0/8`. xUnit-tested at the boundaries. |
| Panel/agent agreement on address plausibility | IMPLEMENTED AND TESTED | `apps/web/tests/networking-addresses.test.ts` asserts the web check is the exact inverse of the agent's for every IP literal. |
| NAT diagnostics | PARTIALLY IMPLEMENTED | CGNAT/private detection only; no NAT-type classification. |
| RakNet verification of a real address | IMPLEMENTED, NOT TESTED | Correct protocol (unconnected ping `0x02` → pong `0x1c`, MCPE string parse, 3 attempts). Never run against a live server. |
| Honest `verified` / `active` / `unknown` statuses | IMPLEMENTED AND TESTED | `network_endpoints.status` constraint matches the UI. |
| Latency / jitter / packet-loss **history** | **NOT IMPLEMENTED** | No history table. |
| Loaded-latency diagnostics | **NOT IMPLEMENTED** | |
| Route scoring (40/20/20/10/10) | **NOT IMPLEMENTED** | Nothing to score: only one provider is active at a time and there is no measurement history. |
| Connection stability scoring | **NOT IMPLEMENTED** | |
| Playit UDP tunnel | **BLOCKED BY EXTERNAL DEPENDENCY** | Needs a Playit account secret and the Playit binary, which OG HOST does not redistribute. Real-client compatibility is unproven. |
| Management connection separate from gameplay connection | IMPLEMENTED AND TESTED (by design) | Agent → control plane is outbound HTTPS; gameplay is UDP 19132. They share no code path. |

## §10 Smart Chunk Intelligence

| Item | Status |
| --- | --- |
| World activity monitoring | **UNSUPPORTED** |
| Estimated active regions | **UNSUPPORTED** |
| Chunk activity forecasting | **UNSUPPORTED** |
| Spawn activity monitoring | **NOT IMPLEMENTED** (parseable from BDS logs; not done) |
| World loading diagnostics | **NOT IMPLEMENTED** |
| Server tick monitoring | **UNSUPPORTED** (BDS exposes no tick-time interface) |
| World activity visualization | **UNSUPPORTED** |
| `/tickingarea` management | PARTIALLY IMPLEMENTED — `tickingarea` is on the command allowlist, so an owner can issue it deliberately. It is **not** automated, which is correct: §10 forbids using ticking areas indiscriminately and forbids changing view/tick distance without authorization. |

Official BDS exposes no chunk-scheduling API, no tick-time metric and no
supported way to read chunk state without parsing the LevelDB database. Every
item above marked UNSUPPORTED is unsupported for that reason, and §10 itself
prohibits the workarounds (inventing an API, patching the binary, touching live
LevelDB). Showing estimated coordinates would be fabrication.

## §11 Multiplayer Management Center (16 modules)

| Module | Status |
| --- | --- |
| Player list (last known, from BDS output) | PARTIALLY IMPLEMENTED — `server_players` table and agent parsing exist; never run |
| Quick Invite | **NOT IMPLEMENTED** |
| Player History / Activity | **NOT IMPLEMENTED** |
| Whitelist Manager | PARTIALLY IMPLEMENTED — `allowlist`/`whitelist` are allowlisted console commands; no dedicated UI |
| Permission Manager | PARTIALLY IMPLEMENTED — `permissions.json` is a **protected** file by design (agent refuses edits); `op`/`deop` commands are available. No UI. |
| Session Dashboard | **NOT IMPLEMENTED** |
| Public read-only status page | **NOT IMPLEMENTED** |
| Connection Diagnostics | **NOT IMPLEMENTED** |
| Player Count History | **NOT IMPLEMENTED** |
| Scheduled Events / Event Scheduler | **NOT IMPLEMENTED** |
| Player Session Reports | **NOT IMPLEMENTED** |
| Player Connection Quality | **UNSUPPORTED** (per-player RTT is not exposed by BDS) |
| Server Announcement System | PARTIALLY IMPLEMENTED — `say`/`title`/`tellraw` are allowlisted; no scheduler or UI |
| Player Support Page | **NOT IMPLEMENTED** |
| Server Access History | PARTIALLY IMPLEMENTED — `audit_logs` records owner actions, not player access |

No player information is invented anywhere: `server_players` is populated only
from lines BDS actually prints.

## §12–§16 SMP Studio, Feature Registry, Lifesteal Studio, Balancing, Presets

| Item | Status |
| --- | --- |
| SMP Studio / SMP Builder / Feature Manager / Control Center | **NOT IMPLEMENTED** |
| SMP Feature Registry (economy, shops, auction, trading, bounties, daily rewards, jobs, skills) | **NOT IMPLEMENTED** |
| Lifesteal, Teams, Clans, Ranks, Homes, TPA, Warps, Land Claim/Protection | **NOT IMPLEMENTED** |
| Custom enchantments, quests, bosses, crates, custom items/mobs, leaderboards | **NOT IMPLEMENTED** |
| Punishment manager, anti-grief, reports, seasons, season reset | **NOT IMPLEMENTED** |
| Lifesteal Configuration Studio | **NOT IMPLEMENTED** |
| Economy Balancing Tool / Custom Item Creator / Custom Mob Creator | **NOT IMPLEMENTED** |
| SMP Season Manager | **NOT IMPLEMENTED** |
| 15 game-mode presets with dependency manifests | **NOT IMPLEMENTED** |

**What building these actually requires — stated plainly, because it governs
every estimate.** None of these are configuration toggles. Each is a Bedrock
**behavior pack**: `manifest.json` with correct UUIDs and module dependencies,
plus JavaScript against `@minecraft/server` (and `@minecraft/server-ui` for
forms), registered in `world_behavior_packs.json`, with `enable_scripting`
turned on in `server.properties`.

The schema already has the correct guardrail: `server_configs.enable_scripting`
defaults to **false**, because scripting is the mechanism these features need
and it must be an explicit owner decision.

Two hard constraints on this whole section:

1. **Java `.jar` plugins cannot run on official BDS.** Lifesteal, economy,
   factions, towny, BedWars and the rest exist as Java plugins (Essentials,
   Vault, GriefPrevention). None of that is portable. Every feature must be
   authored from scratch against the Bedrock Script API. §19 of the spec forbids
   advertising otherwise, and no such claim is made anywhere in this codebase.
2. **The Script API's reliability must be verified per event, not assumed.**
   Lifesteal needs dependable attribution of *why* an entity died — player kill
   versus fall versus lava versus void. Bedrock's `entityDie`/`entityHurt`
   surfaces have changed across versions and do not always carry a killer or a
   cause. §14 requires disclosing that limitation rather than shipping a feature
   that silently mis-attributes hearts. It cannot be disclosed accurately
   without running it, which needs Windows + BDS + a client.

So this section is not "a lot of small tasks". It is a pack-authoring programme
that cannot be honestly marked implemented without a Bedrock test loop.

**Minigame presets additionally require maps.** BedWars, SkyWars, SkyBlock,
OneBlock, KitPvP, Parkour, Prison, Hide and Seek and Build Battle each need a
built world. OG HOST cannot generate or redistribute those. §16 forbids marking
an incomplete preset ready-to-play, so a preset whose map is missing must show
its missing dependencies — which means the dependency-manifest work comes first
and the presets stay visibly incomplete until real maps exist.

## §17 Add-on Management and Compatibility Lab

| Item | Status | Notes |
| --- | --- | --- |
| Upload `.mcpack` / `.mcaddon` / `.mcworld` | IMPLEMENTED, NOT TESTED | Signed URL to the `oghost-addons` bucket (256 MB cap). |
| Manifest inspection, UUID validation, version inspection | IMPLEMENTED, NOT TESTED | `Manifest` parsing in `AddonInstaller`. |
| Contained-bundle extraction (`.mcaddon` holding several packs) | IMPLEMENTED, NOT TESTED | Rewritten this cycle: extract to temp, dispose the outer zip, install, delete temps in `finally`. |
| Dependency detection / compatibility checks | **NOT IMPLEMENTED** | Manifest dependencies are not resolved against what is installed. |
| Install / enable / disable / remove | PARTIALLY IMPLEMENTED | Install and remove exist. Enable/disable (editing `world_behavior_packs.json`) is not a distinct operation. |
| Update with backup and rollback | **NOT IMPLEMENTED** | |
| **Add-on Compatibility Lab** (disposable test world, launch BDS, collect errors) | **NOT IMPLEMENTED** | Needs a real Windows + BDS test loop. Cannot be validated any other way. |

The spec's point that "manifest validity alone does not prove full compatibility"
is correct and is the reason the Lab is listed as not implemented rather than
approximated by manifest checks.

## §18 Templates and Profiles

| Item | Status |
| --- | --- |
| Server Templates (save own config) | **NOT IMPLEMENTED** |
| **Template Marketplace** | **BLOCKED** — distributing worlds raises copyright problems §18 itself forbids; configuration-only templates are buildable, world-bearing ones are not |
| Scheduled Server Profiles | **NOT IMPLEMENTED** |
| Server Event Mode / Maintenance Mode | **NOT IMPLEMENTED** |
| Multi-Server Dashboard | PARTIALLY IMPLEMENTED (`/servers` lists all own servers; no cross-server aggregate view) |
| Server Activity Calendar | **NOT IMPLEMENTED** |
| Server Configuration Diff | **NOT IMPLEMENTED** |
| Smart Server Migration (node → node, same owner) | **NOT IMPLEMENTED** |

## §19 Automatic Node Recovery

| Item | Status | Notes |
| --- | --- | --- |
| Agent connection monitoring | IMPLEMENTED AND TESTED | `isNodeOnline`: 90 s window vs 15 s heartbeat; 21 unit tests including the missed-heartbeat boundary. |
| Node status honesty (online/offline/revoked) | IMPLEMENTED AND TESTED | Revoked beats a fresh heartbeat; verified by test and by `node_status_view`. |
| Server process monitoring | IMPLEMENTED, NOT TESTED | |
| Available disk / memory checks before start | IMPLEMENTED, NOT TESTED | Agent side; web side re-checks (`control/route.ts` refuses below 1024 MB RAM / 2048 MB disk). |
| Crash restart with limit | IMPLEMENTED, NOT TESTED | `AutoRestartOnCrash` default **false**, `MaxAutoRestarts` 3. |
| **Exponential backoff** | **NOT IMPLEMENTED** | Restarts are counted, not spaced. §19 requires backoff to stop crash-looping. |
| Diagnostics collection on crash | **NOT IMPLEMENTED** | |
| Owner notification | **NOT IMPLEMENTED** | No notification channel exists. |
| Automatic Node Recovery | **NOT IMPLEMENTED** | |
| Offline node shows real status | IMPLEMENTED AND TESTED | Commands queue rather than falsely succeeding; UI says offline. |

## §20 Offline Node Operation Queue

| Item | Status | Notes |
| --- | --- | --- |
| Queue | IMPLEMENTED, NOT TESTED | `node_commands` with `pending → claimed → running → completed/failed`. |
| Operation ordering | PARTIALLY IMPLEMENTED | Polled oldest-first (≤5 per poll); no explicit priority or dependency ordering. |
| Status visibility | IMPLEMENTED, NOT TESTED | `/api/servers/:id/commands/:commandId` polling. |
| **Expiration** | **NOT IMPLEMENTED** | A queued command waits forever. §20 requires expiry. |
| **Cancellation** | **NOT IMPLEMENTED** | `cancelled` exists in the status constraint but nothing sets it. |
| **Permission revalidation on reconnect** | **NOT IMPLEMENTED** | Ownership is checked at enqueue time, not re-checked at execution. If a node were transferred or a server deleted meanwhile, a stale command could still run. |
| State revalidation before executing | **NOT IMPLEMENTED** | |
| Never queue arbitrary shell commands | IMPLEMENTED AND TESTED | 27-type handler allowlist; anything else is refused with an explicit message. |

## §21 Intelligent Storage and Backups

| Item | Status | Notes |
| --- | --- | --- |
| Create backup (world + config) | IMPLEMENTED, NOT TESTED | Real zip round-trip in the xUnit suite. |
| Restore | IMPLEMENTED, NOT TESTED | |
| List / delete / prune (keep N) | IMPLEMENTED, NOT TESTED | Prune tested. |
| Scheduled backups | IMPLEMENTED, NOT TESTED | `BackupScheduler` + `backup_schedules` (interval 1–168 h, keep 1–50). |
| Safe stop before backup | IMPLEMENTED, NOT TESTED | `save hold` → `query` → `resume` → `stop`. Never touches a live LevelDB. |
| Backup download via signed URL | IMPLEMENTED, NOT TESTED | |
| **Checksum verification of backups** | **NOT IMPLEMENTED** | §21 requires verifying backups with checksums. Archives are created, not verified. |
| "Never delete the only verified backup" | **NOT IMPLEMENTED** | Prune keeps N by count; it does not know which backups are verified. |
| Storage usage display | PARTIALLY IMPLEMENTED | Node-level free/total storage is real. Per-world and per-backup breakdowns are not. |
| Intelligent Storage Overview / Multi-Node Storage Overview | **NOT IMPLEMENTED** | |
| Storage Compression Lab | **NOT IMPLEMENTED** | |
| Recovery Points / World Timeline | **NOT IMPLEMENTED** | |
| **Google Drive backups** | **BLOCKED BY EXTERNAL DEPENDENCY** | `drive_connections` table and `upload_to_drive` flag exist as placeholders. No OAuth flow, no token storage in Vault, no Drive client. §21's requirement that local backups stay available and Drive stay optional is satisfied only in the sense that Drive does nothing at all. |

## §22 Android Companion

| Item | Status |
| --- | --- |
| Website usable in an Android browser | IMPLEMENTED, NOT TESTED on a real device — 44 px touch targets, responsive glass UI, polling pauses when the tab is hidden |
| Android API contracts documented | PARTIALLY IMPLEMENTED (the 26 API routes are documented in `docs/ARCHITECTURE.md`, but not as a versioned client contract) |
| Native Android app | **NOT IMPLEMENTED** |
| No node tokens or service-role keys in client code | IMPLEMENTED AND TESTED (by design) — service-role key is read only in `lib/supabase/admin.ts`, used only by API routes; `.env.example` marks it secret; `.gitignore` excludes `.env*` except `.env.example`; the distributed ZIP was scanned for JWT-shaped strings and private keys and contains none |

## §23 Windows Agent Architecture

| Item | Status | Notes |
| --- | --- | --- |
| Outbound-only communication, no inbound ports | IMPLEMENTED, NOT TESTED | Polling design; no listener anywhere in the agent. |
| Allowlisted operations (27 types) | IMPLEMENTED, NOT TESTED | Unknown types refused explicitly. |
| No remote shell | IMPLEMENTED AND TESTED | Double allowlist — 68 commands, mirrored across languages and pinned by `allowlist-mirror.test.ts`, which parses the C# set out of `ServerProcessManager.cs` and fails on any drift. Shell metacharacters `; & \| ` $ > < \r \n` rejected; >500 chars rejected. |
| Only `bedrock_server.exe` is ever launched | IMPLEMENTED, NOT TESTED | `UseShellExecute=false`, no user-controlled arguments; user input reaches the process only via stdin. |
| Path confinement | IMPLEMENTED AND TESTED | `ResolveInsideRoot` + `IsProtected`; 9 protected Bedrock system files; traversal cases tested. |
| Short-lived authorization (pairing codes) | IMPLEMENTED AND TESTED | `XXXXXX-XXXXXX`, 10-minute TTL, single use, 5 attempts, stored as SHA-256 hash only, masked in logs as `AB****YZ`. |
| Revocable credentials, token rotation | IMPLEMENTED, NOT TESTED | `rotate-token` route + `node_tokens` history; token compared in constant time. |
| Operation timeouts | PARTIALLY IMPLEMENTED | HTTP timeouts per named client (15 s–30 m). No per-command execution timeout. |
| **Cancellation of an in-flight operation** | **NOT IMPLEMENTED** | |
| Atomic file operations | PARTIALLY IMPLEMENTED | `config.json` written to a temp file then moved. World/backup writes are not atomic. |
| Secure logging (no secrets) | IMPLEMENTED, NOT TESTED | Pairing codes masked; token never logged. |
| Reconnect after Windows restart | IMPLEMENTED, NOT TESTED | `install-service.ps1` with `sc.exe failure` restart policy. |
| **Servers do not auto-start after reboot unless the owner enables it** | IMPLEMENTED AND TESTED (by design) | Both `HonorAutoStart` (default **false**) and the per-server flag are required; `ConfigStoreTests` pins both defaults. |
| No hard-coded Minecraft versions | IMPLEMENTED AND TESTED | Runtime discovery from the official page; a test fails if a Bedrock-shaped version literal appears in product code. |

## §24 Database and API

| Item | Status | Notes |
| --- | --- | --- |
| Additive, idempotent migrations | IMPLEMENTED AND TESTED | 001–005 applied to the live project; original four tables preserved; CI guard fails any migration that drops them. |
| RLS on every table | IMPLEMENTED AND TESTED | 19/19 enabled; verified by query. |
| Owner isolation | IMPLEMENTED AND TESTED | 16/16 probe checks. |
| Foreign keys and indexes | IMPLEMENTED AND TESTED | FKs verified present; 6 performance indexes created. |
| Check constraints on enums and bounds | IMPLEMENTED AND TESTED | Status/provider/channel/gamemode/difficulty constraints, port 1024–65535, max_players 1–100, interval 1–168 h, keep 1–50. |
| Never trust user-supplied owner IDs | IMPLEMENTED AND TESTED | `owner_id` comes from the session, never from the request body. |
| Service-role key never in the browser | IMPLEMENTED AND TESTED | Only `lib/supabase/admin.ts` reads it; not `NEXT_PUBLIC_`. |
| Cross-account reads return 404, not 403 | IMPLEMENTED AND TESTED | Existence is not leaked. |
| **`owner_id` has a foreign key to `auth.users`** | IMPLEMENTED AND TESTED | Discovered during the probe: an insert with a fabricated `owner_id` failed with `23503`. Note that `information_schema.table_constraints` did **not** report this FK — those views are permission-filtered — so the probe, not the catalogue query, is what established it. |
| Suggested new entities (worlds, snapshots, imports, templates, profiles, events, invitations, sessions, smp_features, dependencies, installations, seasons, economy, reports, scheduled ops, offline queue, addon manifests/installations, migration jobs, diagnostic reports) | **NOT IMPLEMENTED** | None of these tables exist. They are prerequisites for §4–§21. |

## §26 User Interface

| Item | Status |
| --- | --- |
| Dashboard, Servers, Create Server, server detail with 8 panels, Devices, Networking, Backups, Console, Settings | IMPLEMENTED, NOT TESTED in a browser against the live DB |
| Requested nav: Worlds, SMP Studio, Performance, Players, Add-ons (top level), Templates, Events, Diagnostics | **NOT IMPLEMENTED** — no such pages |
| Loading / error / empty states, confirmation dialogs | IMPLEMENTED, NOT TESTED |
| Real-time updates | PARTIALLY IMPLEMENTED — polling, not realtime subscriptions |
| **No dead buttons** | IMPLEMENTED AND TESTED (by construction) — controls are either functional, disabled with an explanation, or absent. No placeholder routes were added for unbuilt features, which is why the nav is shorter than §26 requests. |

---

## Summary counts

| Status | Count |
| --- | --- |
| IMPLEMENTED AND TESTED | 22 |
| IMPLEMENTED, NOT TESTED | 38 |
| PARTIALLY IMPLEMENTED | 27 |
| BLOCKED BY EXTERNAL DEPENDENCY | 3 |
| NOT IMPLEMENTED | ~75 |
| UNSUPPORTED | 10 |

The two numbers that matter most:

- **Everything marked "IMPLEMENTED, NOT TESTED" is agent code that has never
  been compiled.** That is 38 items resting on one unexecuted build. The first
  real Windows run will produce findings.
- **Nothing involving actual Minecraft gameplay has ever happened.** No BDS
  process has started, no client has joined, no world has been backed up and
  restored on a real server.

## Recommended order for the remaining phases

The spec's §27 ordering is sound, with one correction: **Phase 6 and 7 depend on
data that does not exist yet.** Performance Intelligence needs time-series
telemetry tables; SMP Studio needs a feature registry. Both need schema first.

1. **Phase 2a — schema for server types and presets** (`server_type`,
   `server_presets`, dependency manifests). Small, unblocks §4, §5, §16.
2. **Phase 2b — creation wizard** on top of the existing single-form flow.
3. **Phase 3 — world import hardening**: `level.dat`/`db` validation,
   decompression-bomb limits, checksums. These are real safety gaps in code that
   already exists, so they should precede new features.
4. **Phase 20 gaps — offline queue expiration, cancellation, permission
   revalidation.** Small, and a stale queued command executing against a
   transferred node is a correctness bug.
5. **Phase 6a — telemetry history tables**, then health score and bottleneck
   classification as deterministic pure functions (fully unit-testable without
   Windows).
6. **Phase 4 — World Library/Cloner/Snapshots**, which need a `worlds` table.
7. **Phase 7+ — SMP Studio.** Last, because it needs a real Bedrock test loop to
   be honest about, and it is the largest single block of work.

Phases that should not be started without a Windows machine and a Bedrock
client: 7, 8, 9 (route scoring), 17 (Compatibility Lab), and the §28 benchmark
suite.
