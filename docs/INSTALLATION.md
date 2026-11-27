# OG HOST — Installation

Everything you need to go from an empty Supabase project to friends joining your
world. Work through it in order; each step ends with something you can verify.

**Time:** about 45 minutes, most of it waiting on the Windows agent download.
**Cost:** zero. No hosting subscription, no paid service required.
**You need:** a GitHub account, a Supabase project, a Vercel account, a Windows
10/11 computer, and any device with a browser.

---

## Step 0 — What already exists

The Supabase project `og-host` already has these four tables, created and
verified:

| Table | Purpose |
| --- | --- |
| `nodes` | One row per paired Windows device |
| `servers` | One row per Minecraft Bedrock server |
| `pairing_codes` | Short-lived device pairing codes (hashed) |
| `node_events` | Activity feed entries |

Row Level Security is enabled with owner-scoped read policies, and there are
intentionally no browser-side write policies.

**The migrations in this repository preserve all four.** Migration `001` uses
`ADD COLUMN IF NOT EXISTS` and `CREATE TABLE IF NOT EXISTS` throughout — it
never drops or recreates them. A CI job (`web.yml` → *Guard against destructive
statements*) fails the build if anyone later adds a `DROP TABLE` against them.

---

## Step 1 — Database migrations

### Status: ALREADY APPLIED to the live project

Migrations 001–005 were applied to the live `og-host` project
(ref `chhttgriyauqlracclkm`) on **2026-11-27** and are recorded in its migration
history:

```
20261127033553  oghost_001_core_schema
20261127033649  oghost_002_indexes_and_views
20261127033658  oghost_003_seed
20261127033719  oghost_004_storage_and_network_settings
20261127034127  oghost_005_role_privileges
```

Post-apply state, verified by query: **19 tables, all 19 RLS-enabled, 27
policies, 3 private storage buckets, 4 seeded network providers.** The four
original tables (`nodes`, `servers`, `pairing_codes`, `node_events`) were
preserved — they were empty (0 rows) and every statement against them was
`add column if not exists`.

**If you are deploying to this project, skip to Step 2.** Re-running is harmless
(all five are idempotent) but unnecessary. If you are deploying to a *different*
Supabase project, run them in order.

### Running them yourself

Apply in order in the Supabase SQL Editor, or with the CLI.

| File | What it does |
| --- | --- |
| `001_core_schema.sql` | Extends the existing four tables; creates `profiles`, `server_configs`, `node_commands`, `node_tokens`, `server_backups`, `server_versions`, `server_addons`, `network_endpoints`, `server_players`, `server_console_logs`, `audit_logs`; enables RLS and owner-scoped policies on all of them. |
| `002_indexes_and_views.sql` | Performance indexes plus the `node_status_view` and `server_overview_view` read models. Both views are created `WITH (security_invoker = true)` — see the warning below. |
| `003_seed.sql` | Seeds the `network_providers` catalogue (direct / playit / manual / custom). |
| `004_storage_and_network_settings.sql` | Creates the three private storage buckets and their RLS policies, plus `node_network_settings`, `backup_schedules` and `drive_connections`. |
| `005_role_privileges.sql` | **Do not skip this one.** Grants the minimum privileges the app needs and revokes dangerous ones. Without it the application cannot read or write anything. |

All five are idempotent — re-running is safe.

> **Why 005 is mandatory.** An audit of the live project found that `anon`,
> `authenticated` and `service_role` each held only `Dxt` — TRUNCATE, REFERENCES,
> TRIGGER — with **no SELECT, INSERT, UPDATE or DELETE**. Two consequences:
>
> - The app could not function. Dashboard pages act as `authenticated` and every
>   read failed with `permission denied for table nodes`; API routes use
>   `service_role` and every write failed, including agent pairing and heartbeat.
>   RLS policies were correct but unreachable, because a policy only filters rows
>   a role is already allowed to touch.
> - **TRUNCATE was granted to `anon` and `authenticated`, and TRUNCATE bypasses
>   RLS.** Either role could have emptied every table, including rows belonging
>   to other accounts. It is not reachable through PostgREST's HTTP verbs, but it
>   is exactly the standing privilege that turns a later mistake into permanent
>   data loss.
>
> Migration 005 revokes TRUNCATE/REFERENCES/TRIGGER from both untrusted roles,
> grants `authenticated` SELECT only (RLS does the owner scoping), grants `anon`
> SELECT on the public `network_providers` catalogue alone, gives `service_role`
> the DML the API routes need, and sets default privileges so future tables
> inherit the correct grants.

> **Why the views need `security_invoker`.** A normal PostgreSQL view executes
> with the privileges of its *owner*, which in Supabase is a role that bypasses
> RLS. Selecting from `server_overview_view` would then return every user's nodes
> and servers. `WITH (security_invoker = true)` makes the view run as the calling
> role so the underlying policies still apply. Requires PostgreSQL 15+; this
> project runs 17.

**Verify:**

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

You should see the original four plus: `audit_logs`, `backup_schedules`,
`drive_connections`, `network_endpoints`, `network_providers`,
`node_commands`, `node_tokens`, `profiles`, `server_addons`,
`server_backups`, `server_configs`, `server_console_logs`, `server_players`,
`server_versions`.

```sql
-- every table must have RLS on, and no untrusted role may hold TRUNCATE
select c.relname,
       c.relrowsecurity as rls,
       has_table_privilege('authenticated', c.oid, 'TRUNCATE') as auth_can_truncate,
       has_table_privilege('anon',          c.oid, 'TRUNCATE') as anon_can_truncate,
       has_table_privilege('authenticated', c.oid, 'SELECT')   as auth_can_select,
       has_table_privilege('service_role',  c.oid, 'INSERT')   as svc_can_insert
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;
```

Expected: `rls = true` everywhere, both `*_can_truncate = false`,
`auth_can_select = true`, `svc_can_insert = true`.

---

## Step 2 — Supabase auth settings

1. **Authentication → Providers → Email**: enable it.
2. **Email confirmation**: your choice.
   - *Enabled* — safer; the signup page shows "check your email" and waits.
   - *Disabled* — instant sign-in, better while you are testing alone.
3. **Authentication → URL Configuration**:
   - Site URL: your Vercel domain, e.g. `https://og-host.vercel.app`
     (use `http://localhost:3000` while developing locally).
   - Redirect URLs: add both the production domain and `http://localhost:3000/auth/callback`.
4. **Authentication → Policies** (optional but recommended): the default
   `auth.users` policies are fine. OG HOST creates `profiles` rows on demand.

---

## Step 3 — Deploy the website to Vercel

### 3a. Push to GitHub

```bash
git clone <your-repo-url> og-host
cd og-host
# ... this repository's contents ...
git add .
git commit -m "OG HOST: web panel, Windows agent, migrations, docs"
git push origin main
```

### 3b. Import into Vercel

1. Vercel → **Add New… → Project** → import your GitHub repository.
2. Framework preset: **Next.js** (auto-detected).
3. **Root Directory: `apps/web`** ← this is the setting people miss. The repo is
   an npm-workspaces monorepo; Vercel must build the `@oghost/web` workspace and
   it resolves `@oghost/shared` from `packages/shared` automatically.
4. Build command `next build`, output `.next` — leave the defaults.
5. Add environment variables (Project → Settings → Environment Variables):

| Variable | Value | Where to find it |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the `anon` `public` key | same page |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key | same page — **secret** |
| `NEXT_PUBLIC_APP_URL` | your Vercel domain | after the first deploy |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` (optional) | — |
| `RATE_LIMIT_MAX_REQUESTS` | `120` (optional) | — |

Set `SUPABASE_SERVICE_ROLE_KEY` for **Production, Preview and Development**, and
never expose it as `NEXT_PUBLIC_*`.

6. Deploy.

**Verify:** open the deployed URL. You should see the OG HOST landing page. Click
**Get started**, create an account, and land on the Overview dashboard with
zero devices and zero servers. No errors in the Vercel function logs.

### 3c. Local development (optional)

```bash
npm install
cp apps/web/.env.example apps/web/.env.local   # then fill in real values
npm run dev                                    # http://localhost:3000
```

---

## Step 4 — Build the Windows agent

Two options. **A is easier**; B is useful if you want to change agent code.

### Option A — download the CI build

1. Push to `main` (or open a PR). The **Windows Agent CI** workflow runs
   automatically.
2. Open the workflow run → **Artifacts** → download
   `og-host-windows-agent-win-x64`.
3. Verify the checksum if you want to be careful:

   ```powershell
   Get-FileHash og-host-windows-agent-win-x64.zip -Algorithm SHA256
   # compare with the .sha256 file inside the artifact
   ```

4. Unzip to a **permanent** folder, e.g. `C:\OGHOST`. This folder will hold the
   Bedrock engine, your worlds and your backups — do not put it in `Downloads`
   or a temp directory.

### Option B — build locally

Requires the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0).

```powershell
cd services\windows-agent
dotnet publish src\OGHost.Agent -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true
```

Output: `src\OGHost.Agent\bin\Release\net8.0\win-x64\publish\OGHost.Agent.exe`.

### To publish a proper GitHub Release

Create a release in GitHub (Releases → Draft a new release). The
`windows-agent` workflow has a `release: published` trigger and will attach
`og-host-windows-agent-win-x64.zip`, `...-win-arm64.zip` and their `.sha256`
files to it automatically.

---

## Step 5 — Pair your Windows computer

1. In the website, go to **Devices** and press **Generate a pairing code**. A
   code like `K7M2QP-9RT4XN` appears. It expires in **10 minutes**, works
   **once**, and allows **5 attempts**.
2. On the Windows machine, run `OGHost.Agent.exe` once. It creates
   `config.json` next to itself and prints instructions.
3. Edit `config.json`:

   ```json
   {
     "ControlPlaneUrl": "https://og-host.vercel.app",
     "PairingCode": "K7M2QP-9RT4XN"
   }
   ```

   Use your **real** Vercel domain. No trailing slash needed.
4. Run `OGHost.Agent.exe` again. Watch for:

   ```
   Claiming pairing code K7****XN…
   Paired successfully as node <uuid>
   Paired as node <uuid>. Connecting to https://og-host.vercel.app
   ```

5. Refresh **Devices** in the browser. Your computer should appear as
   **online** with real CPU, RAM and storage numbers within ~15 seconds.

**If it does not appear:**

| Symptom | Cause / fix |
| --- | --- |
| `Pairing failed (404)` | Code already used, or mistyped. Generate a new one. |
| `Pairing failed (410)` | Code expired. Generate a new one. |
| `Control plane rejected the node token` | Token was rotated or the node revoked. Re-pair, or paste the new token from Devices → New token. |
| Five heartbeats failed | `ControlPlaneUrl` is wrong, or the machine cannot reach it. Test with `curl https://your-app.vercel.app`. |
| Device shows offline after working | The agent stopped. Install it as a service (next step). |

### Run it as a service (survives restarts)

From an **elevated** PowerShell prompt:

```powershell
cd C:\OGHOST\scripts
.\install-service.ps1 -ExePath "C:\OGHOST\OGHost.Agent.exe"
```

The agent now reconnects automatically after a Windows restart. **Minecraft
servers still do not auto-start** — that requires enabling auto-start per server
in the panel *and* setting `"HonorAutoStart": true` in `config.json`. Both
switches are required by design.

Remove it later with `.\install-service.ps1 -Uninstall`.

---

## Step 6 — Create your first server

1. **My Servers → Create server**.
2. Fill in a name, pick your device, and set the world name.
3. Choose game mode, difficulty, max players (10 is the design target for a
   6 GB machine) and port (leave 19132 unless it is taken).
4. Pick a networking provider — see `docs/NETWORKING.md`. On Airtel/Jio/Vi
   mobile broadband, choose **Playit**; direct mode will fail on CGNAT.
5. Create. The panel queues an `install_bds` command immediately.

The agent then: discovers the current official BDS build → downloads it →
verifies the archive → extracts into a versioned engine folder → links your
world → reports the real installed version back. Watch it on the server's
**Versions** tab. First install takes a few minutes depending on your download
speed.

---

## Step 7 — Start it and confirm real multiplayer

This is the step that decides whether the project actually works.

1. Press **Start**. The panel checks the node is online and has ≥1 GB free RAM
   and ≥2 GB free disk before queueing anything.
2. Open the **Console** tab. Within about a minute you should see genuine BDS
   output ending in `Server started`.
3. Go to **Networking → Start networking**.
4. Read the status carefully:
   - **verified reachable** — a real RakNet ping/pong succeeded. Share it.
   - **unverified** — a tunnel is up and gave an address, but nothing has proven
     a Bedrock client can join. Test it yourself before telling friends.
   - **no address** — nothing established; the reason is displayed.
5. **The authoritative test.** On your phone, using **mobile data (not the same
   Wi-Fi as the laptop)**:
   - Minecraft Bedrock → Servers → Add Server
   - Enter the address and port exactly as shown
   - Save and join

   If you spawn into the world, multiplayer genuinely works.

> Using the same Wi-Fi as the host is not a valid test — it can succeed over
> LAN while the public address is completely unreachable. Use mobile data.

6. Back in the panel, the player count should read 1/10 and your name should
   appear under Players.

**If joining fails,** work through `docs/NETWORKING.md` → *The hairpinning
caveat* and the *Open verification items* list. The most common causes, in
order: Windows Firewall blocked inbound UDP for `bedrock_server.exe`; CGNAT with
direct mode selected; the tunnel provider's free tier limits; a wrong port.

---

## Step 8 — Pre-launch checklist

Before inviting anyone beyond yourself:

**Already done (2026-11-27, against the live project)**

- [x] RLS enabled on every table — 19/19, verified by query.
- [x] Cross-account isolation — verified by a live SQL probe with two throwaway
      users: **16/16 checks passed**. User B saw 0 of A's servers, node_events
      and backups; B's INSERT/UPDATE/DELETE were refused; the
      `security_invoker` views enforced RLS instead of bypassing it. All probe
      data deleted afterwards and the clean state re-verified (0 users, 0 rows).
      Evidence: `docs/FEATURE-INVENTORY.md` → *Row Level Security*.
- [x] Role privileges minimised — `authenticated` is read-only, `anon` sees only
      the public provider catalogue, and TRUNCATE is revoked from both.
- [x] Migrations are additive and preserve the original four tables.

**Still must do — these need a deployed site and two real browsers**

The database layer is verified. The **application layer is not**: the probe above
tested PostgreSQL directly, not the Next.js API routes. Those still need running.

- [ ] Create a **second** account in a private browser window and confirm it
      cannot see the first account's devices, servers, backups or console.
      The RLS underneath this is now proven; the route-level behaviour is not.
- [ ] Try `GET /api/servers/<someone-else's-id>` while signed in as the second
      account. Expect `404`, not `403` and not data.
- [ ] Confirm `SUPABASE_SERVICE_ROLE_KEY` never appears in browser DevTools →
      Network responses, or in the built JS bundle.
- [ ] Join successfully from a real Bedrock client over mobile data (Step 7).
- [ ] Verify a backup → delete the world → restore round trip on a real server.
- [ ] Verify an update → rollback round trip.
- [ ] Set Vercel environment variables for Production **and** Preview.
- [ ] Add your production domain to Supabase's Redirect URLs.

**Should do**

- [ ] Add Content Security Policy headers in `next.config.mjs` (see
      `docs/SECURITY.md` → *What is NOT implemented*).
- [ ] Swap in-memory rate limiting for Upstash Redis if you expect real traffic.
- [ ] Enable Supabase MFA for your own account.
- [ ] Set up a scheduled backup and confirm it runs while the website is closed.
- [ ] Confirm the agent reconnects after a full Windows restart (service mode).
- [ ] Check Windows power settings: a laptop that sleeps stops hosting. Set
      "never sleep" on mains power, and disable hibernate-on-lid-close if you
      want it to run closed.

---

## Operational notes

**Console log retention.** `prune_console_logs()` deletes rows older than 7
days. Schedule it with `pg_cron` if enabled:

```sql
select cron.schedule('oghost-prune-console', '0 4 * * *',
                     $$select public.prune_console_logs()$$);
```

Without `pg_cron` the table grows; it is not harmful, just untidy.

**Stale nodes.** A node is `online` only if a heartbeat arrived in the last
90 seconds. If your device is asleep or powered off it shows offline, and
commands queue rather than failing — they run when it returns.

**Where the data lives.** Bedrock engines, worlds, backups and downloads are all
under `%LocalAppData%\OGHOST` on the Windows machine (configurable via
`DataDirectory`). The website stores metadata, configuration and console logs in
Supabase. **Your worlds are only on your PC** — that is the whole point of
self-hosting, and the reason backups matter.

**Removing a device.** Devices → Disconnect revokes its credentials
immediately. The agent can no longer reach the control plane. Pair it again with
a fresh code if you want it back.

**Uninstalling.** Stop and remove the service
(`.\install-service.ps1 -Uninstall`), delete the agent folder, and delete
`%LocalAppData%\OGHOST` — after copying out any worlds you want to keep.

---

## Troubleshooting index

| Problem | Look at |
| --- | --- |
| Server won't start, RAM warning | Close apps on the laptop; the agent needs ≥1 GB free |
| `bedrock_server.exe` not found | Versions tab → Install; check the agent log for a discovery failure |
| Version discovery failed | Set `OGHOST_BDS_URL` to a direct official `.zip` link on the node |
| Console shows nothing | Node offline, or server not started; check Devices for heartbeat |
| Command rejected | It was not on the Bedrock allowlist — there is no shell access |
| File edit refused | It is a protected Bedrock system file; use Permissions/Allowlist UIs |
| Add-on "doesn't work" | Installed ≠ loaded: restart the server, and enable scripting if the pack needs the script API |
| Address shows unverified | Expected until a real client joins. See `docs/NETWORKING.md` |
| Friends can't join | Firewall UDP, CGNAT + direct mode, or tunnel limits — in that order |
| Agent stops after restart | Install it as a Windows service (Step 5) |
| Laptop sleeps and server dies | Windows power settings → never sleep on mains |
