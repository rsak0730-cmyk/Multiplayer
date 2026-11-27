# OG HOST — Security

This document describes the security model as implemented, including the parts
that are deliberately *not* there. Where a control is enforced in two places,
both are named — defence in depth is only real if you can point at both layers.

---

## Threat model

The platform lets strangers register accounts and attach machines they control.
The interesting threats are therefore:

1. **Cross-account access** — user A reading or controlling user B's node,
   server, files, backups or console.
2. **Remote code execution** — turning the website into a shell on someone's
   Windows PC. This is the highest-impact failure mode: the victim is a
   home user, and the machine holds their worlds.
3. **Credential theft** — stealing a node token or the service-role key.
4. **Path traversal** — reading or overwriting files outside a server's own
   directory.
5. **Abuse / enumeration** — pairing-code brute force, id guessing, DoS via
   unbounded polling or uploads.
6. **False confidence** — the platform claiming a server is publicly reachable
   when it is not, causing a user to share an address that cannot work.

Threat 6 is included because it causes real harm: a user tells ten friends to
join at 8pm and nobody can.

---

## 1. Authentication and session handling

- **Supabase Auth** issues sessions; OG HOST never stores or sees a password.
- The browser holds only the **anon** key, which is public by design and
  useless without Row Level Security.
- The **service-role** key exists only in `SUPABASE_SERVICE_ROLE_KEY`, read
  exclusively inside `src/lib/supabase/admin.ts`, which is imported only by
  API routes. It is never passed to a client component and never appears in a
  response body.
- `src/middleware.ts` refreshes the session cookie and redirects unauthenticated
  requests away from `/dashboard`, `/servers`, `/devices`, `/networking`,
  `/backups`, `/console` and `/settings`.
- Every API route calls `requireUser()` before touching data. Middleware is
  convenience; the routes are the enforcement point, because middleware can be
  bypassed by hitting an API path directly.

## 2. Ownership enforcement (three layers)

**Layer 1 — Row Level Security.** Every table has RLS enabled and every policy
is scoped to `auth.uid() = owner_id`, or for child tables, to an `EXISTS`
subquery proving the parent row belongs to the caller. Browser reads therefore
cannot return another account's rows even if the client is modified.

The original four tables (`nodes`, `servers`, `pairing_codes`, `node_events`)
had read-only policies when the project started; migration `001` re-asserts
them idempotently and deliberately adds **no** browser-side write policies for
them. Writes to those tables only ever happen server-side.

**Layer 2 — API ownership re-check.** Routes that write use the service-role
client, which bypasses RLS. So each one re-verifies ownership in the same
query. Example from `POST /api/servers`:

```ts
const { data: node } = await admin
  .from('nodes')
  .select('*')
  .eq('id', input.node_id)
  .eq('owner_id', user!.id)      // ← the actual control
  .is('revoked_at', null)
  .maybeSingle();
if (!node) return 403;
```

`loadServerContext()` does the same for every per-server route, reading the
server and its node through the **anon** client so RLS proves ownership before
any service-role write happens.

**Layer 3 — the agent.** A node token maps to exactly one node row, which maps
to exactly one `owner_id`. Command execution is filtered by
`node_id = token's node`, and per-server commands additionally verify
`servers.node_id = node.id`. Even a stolen token cannot reach another
account's machine, because the token is bound to one node.

**Enumeration resistance.** A request for a server id you do not own returns
`404 Not found`, not `403 Forbidden` — the API never confirms that someone
else's resource exists.

## 3. Device pairing

```
website  → generate code, store SHA-256(code), return plaintext once
agent    → POST /api/agent/pairing/claim { code }
api      → look up by hash, check expiry, check attempts < 5
api      → create node row bound to pairing.owner_id
api      → issue node token, store SHA-256(token), return plaintext once
api      → mark the code claimed (single use)
```

Properties that matter:

- The **plaintext code is never stored**. Only `code_hash`.
- Codes are **single use** (`claimed_at`), expire after **10 minutes**, and are
  invalidated after **5 failed attempts** — brute force is not viable, and the
  code space (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, 12 chars, ambiguous glyphs
  removed) is ~10^18 anyway.
- Codes are **bound to the authenticated owner** at creation, so a code cannot
  be used to attach a node to someone else's account.
- Pairing is **rate limited by IP**.
- The node token is a 32-byte random value (`ogt_` + base64url), stored only as
  a hash, shown once, rotatable, and revocable.

## 4. No remote shell — the central guarantee

The single most important design decision: **there is no command that executes
an arbitrary string on the node.**

`CommandDispatcher._handlers` is a closed dictionary. A command type not in it
is refused with an error before anything else happens:

```csharp
if (!_handlers.TryGetValue(command.CommandType, out var handler))
    return Fail($"Command '{command.CommandType}' is not in this agent's allowlist.");
```

The only process the agent ever starts is `bedrock_server.exe`, resolved from
an official BDS install directory, with **no user-controlled arguments**.
`ProcessStartInfo` sets `UseShellExecute = false` and passes no argument list,
so there is nothing to inject into.

User text reaches BDS only through **stdin**, and only after allowlist
validation performed **twice**:

1. `packages/shared/src/commands.ts` → `isAllowedBdsCommand()` in
   `POST /api/servers/:id/control`.
2. `ServerProcessManager.IsAllowedCommand()` in the agent, independently.

Both reject anything whose first token is not a known Bedrock console command,
and both reject `; & | \` $ > < \r \n` outright, plus anything over 500 chars.
stdin is not a shell, so metacharacters are inert — rejecting them anyway costs
nothing and protects against a future transport that might not be.

Consequences worth stating plainly: you cannot run PowerShell, `cmd`, `curl` or
any Windows command through this panel. If you need that, use Remote Desktop
into your own machine. That is not an OG HOST feature and never will be.

## 5. File access confinement

`ServerFileManager.ResolveInsideRoot()` resolves a user-supplied relative path
against the server's root with `Path.GetFullPath`, then asserts the result
still begins with the root. `../`, rooted paths (`/etc/passwd`,
`C:\Windows\...`), and NUL bytes are rejected. The web API applies the same
check before queueing (`isSafeRelativePath`).

Protected from edit and delete, in **both** layers:
`bedrock_server.exe`, `bedrock_server.pdb`, `allowlist.json`,
`server_admin_allowlist.json`, `permissions.json`, `valid_known_packs.json`,
and anything under `.oghost*` (the agent's own state).

World directories additionally cannot be deleted through the file manager at
all — an accidental tap on a phone must not erase months of building. Use
backups and restore for that.

Zip extraction (add-ons, restores) uses the same resolver per entry, so a
zip-slip entry like `worlds/x/../../../../escape.txt` is skipped rather than
written.

## 6. Upload validation

- Add-ons: only `.mcpack`, `.mcaddon`, `.mcworld`. A `.jar` is rejected with an
  explanation that Bedrock cannot load Java plugins — better than a silent
  failure. The archive must then parse as a ZIP and contain a `manifest.json`
  with a recognised module type, or the install fails with a reason.
- Size limits: 256 MB per add-on, 2 MB for in-browser text editing, 512 MB for
  agent-written files.
- Storage paths are prefixed `{userId}/{serverId}/...` and storage RLS policies
  require that prefix to equal `auth.uid()`. A signed URL for another user's
  path cannot be generated or used.
- `upload_commit` re-checks that the supplied `storage_path` starts with the
  caller's own `{userId}/{serverId}/` prefix before signing a download URL, so
  a user cannot ask their node to pull someone else's object.

## 7. Rate limiting and abuse control

`src/lib/rate-limit.ts` is a sliding-window counter applied to pairing, node
deletion, token rotation, server creation, config writes, file operations,
backups, add-ons, networking, version operations and every agent endpoint.
Defaults: 120 requests / 60 s per key.

**Known limitation, stated honestly:** this is in-memory, so on Vercel each
serverless instance has its own counter and the effective limit is
`instances × configured`. It still stops a single client hammering one warm
instance, but it is not a distributed limiter. For production multi-instance
hardening, swap the implementation for Upstash Redis behind the same
`checkRateLimit(key)` signature — no call sites change.

Additional controls: console-log batches are capped at 200 lines and each line
at 4000 chars; command polling returns at most 5 commands; console log rows are
pruned after 7 days (`prune_console_logs()`).

## 8. Audit logging

`audit_logs` records actor type, action, target, details JSON and IP for:
pairing code creation, node pairing/revocation/token rotation, server
creation/deletion, every control action, config changes, file operations,
add-on uploads and installs, backup creation/restore/deletion, and networking
changes.

Rows are inserted **server-side only**. RLS grants `SELECT` on your own rows and
no `INSERT`/`UPDATE`/`DELETE`, so a compromised browser session cannot rewrite
history. The page is read-only in the UI for the same reason.

Audit writes are wrapped in try/catch and never fail a request — losing an audit
row is bad, but breaking the user's action because logging failed is worse. The
failure is logged.

## 9. Resource isolation

There is no shared infrastructure to isolate: each server runs as a separate
`bedrock_server.exe` process on a machine owned by exactly one account. Within
a node, the agent enforces `MinFreeRamMb` (1024) and `MinFreeDiskMb` (2048)
before starting, and the API enforces the same thresholds from the last
heartbeat before queueing. Both checks exist because the panel's view of a
machine can be up to 15 seconds stale.

## 10. Secrets management

| Secret | Where it lives | Never |
| --- | --- | --- |
| Supabase service-role key | Vercel env var, server-side only | in a bundle, a response, or a repo |
| Node token | hashed in `nodes.token_hash`; plaintext in the device's `config.json` | logged, transmitted except to the control plane, or shown twice |
| Pairing code | hashed in `pairing_codes.code_hash` | stored in plaintext |
| Playit secret | `node_network_settings`, returned only to the owner's session and their agent | echoed in list endpoints |
| Google Drive OAuth tokens | Supabase Vault, referenced by id | in a table column or a migration |

`.env.example` documents every variable with placeholders. `.gitignore` excludes
`.env*`. The agent masks pairing codes in its own logs (`AB****YZ`).

---

## Known dependency advisories

`npm audit` reports vulnerabilities in this repository. They are listed here
explicitly rather than quietly left in `package-lock.json`, because a security
document that omits them would be misleading.

Versions verified with `npm audit` and `npm ls`. "Fix" is the version npm offers
via `npm audit fix --force`.

### Shipped to production (deployed on Vercel)

| Package | Installed | Advisory range | Fix | Severity | Notes |
| --- | --- | --- | --- | --- | --- |
| `next` | 14.2.35 | `<=16.3.0-preview.10` | 16.4.6 | **critical** | DoS via Image Optimizer `remotePatterns`; DoS via HTTP request deserialization with insecure React Server Components. **There is no patched 14.x release** — fixing this means Next 16, which also brings React 19. |
| `zod` | 3.25.76 | `<4.6.6` | 4.6.7 | high | Memory exhaustion while validating oversized constrained collections. |

### Development and build tooling only — never deployed

| Package | Fix | Severity | Why it is lower risk here |
| --- | --- | --- | --- |
| `vitest` | 5.1.2 | **critical** | The file-read/RCE advisory requires the **Vitest UI server** to be listening. It is never started in CI or locally here. |
| `tinypool` (via vitest) | — | **critical** | Prototype-pollution gadget in worker options; reachable only through the Vitest runner. |
| `eslint-config-next` → `@next/eslint-plugin-next` → `glob` | — | high | Lint-time only. |
| `postcss`, `vite` | — | high | Build-time only; output is the compiled bundle, not these packages. |

### Why these were not upgraded

Every available fix is a **major version bump**. `npm audit fix` (without
`--force`) changes nothing, which is npm telling you the same thing.

- **`next` 14 → 16** spans two majors and pulls in **React 18 → 19**. That is a
  real migration (async request APIs, ref-as-prop, `useFormState` →
  `useActionState`, caching-default changes), not a dependency bump. Doing it
  blind would trade a *verified working build* for an unverified one, which is a
  worse security posture than a known, documented advisory.
- **`zod` 3 → 4** deprecates `z.string().uuid()` and `z.string().url()`, both of
  which this codebase uses, and changes error shapes. The specific advisory is
  about *oversized constrained collections*; every schema here is a flat object
  of strings, numbers and booleans with explicit `.min()`/`.max()` bounds, so the
  vulnerable pattern is not present. That is a mitigation, **not** a fix.
- **`vitest` / `tinypool`** are dev-only and the advisory path is not exercised.

This is a decision with a cost, and the cost is stated plainly: **the deployed
app currently runs a `next` version with published critical DoS advisories.**

### The path forward

1. `.github/dependabot.yml` opens weekly PRs for npm, NuGet and GitHub Actions.
   CI runs the full gate (lint, typecheck, 371 unit tests, production build, SQL
   migration validation, and the Windows agent xUnit suite) on each one.
2. Do **not** merge a major bump on a green build alone. For `next`, read the
   15 and 16 codemods and run `npx @next/codemod upgrade latest`.
3. Recommended order: `zod` 3→4 first (small, 11 files, typecheck catches most
   of it), then `vitest`, then `next`+React last as a dedicated migration.
4. Mitigations available without upgrading, in rough order of value:
   - Put a WAF/CDN with request-body size limits in front of the deployment
     (Vercel already caps body size, which blunts the zod DoS).
   - Do not enable `images.remotePatterns` with a wildcard — the Next image
     advisory needs a permissive configuration to be exploitable, and this app
     does not use the Image Optimizer for remote hosts.
   - Add CSP headers (see below) and keep `SUPABASE_SERVICE_ROLE_KEY`
     server-side only.

---

## What is NOT implemented (and the honest consequence)

- **Distributed rate limiting.** See §7. In-memory per instance.
- **Content Security Policy headers.** Not set. Worth adding in
  `next.config.mjs` before a public launch; the app has no third-party script
  dependencies, so a strict policy is feasible.
- **CSRF tokens.** Not needed as designed: auth is a `SameSite=Lax` cookie and
  every mutating route is `POST`/`PUT`/`PATCH`/`DELETE` with a JSON body, which
  a cross-origin form cannot produce. Do not add cookie-auth `GET` mutations or
  this reasoning breaks.
- **Two-factor authentication.** Delegated to Supabase Auth; enable MFA there.
- **Upload virus scanning.** Not performed. A malicious `.mcaddon` could contain
  a pack that misbehaves in-game. Only install add-ons you trust — the same rule
  as any modpack.
- **Per-server resource quotas (CPU/RAM caps).** Not enforced. BDS does not
  expose a reliable memory ceiling, and Windows job objects were judged too
  fragile for a first release. The pre-flight checks are a guardrail, not a
  sandbox.
- **Agent binary signing.** The published agent is unsigned, so SmartScreen will
  warn. Code-signing requires a paid certificate; the workflow publishes a
  SHA-256 checksum so a user can at least verify they downloaded what CI built.

---

## Verification status

Read the "Verified how" column carefully. **Written is not the same as run.**
The xUnit rows below describe tests that exist and were audited line by line
against the real C# signatures, but they have **never been executed** — there is
no .NET toolchain in the environment where this code was written. They run in CI
on `windows-latest`; that pipeline has not yet been observed passing.

| Control | Verified how | Actually executed? |
| --- | --- | --- |
| Row Level Security owner isolation | Live SQL probe against project `og-host` — two throwaway users, real rows, `set role authenticated` + `request.jwt.claims`, 16 checks | **YES — 16/16 passed** |
| Cross-account read attempts | Same probe: B sees 0 of A's servers, node_events and backups | **YES** |
| Cross-account write attempts | Same probe: INSERT/UPDATE/DELETE refused with `permission denied` | **YES** |
| TRUNCATE (an RLS-bypassing operation) refused to untrusted roles | Same probe, check 11 | **YES** |
| Views enforce RLS rather than bypassing it | Same probe: `node_status_view` → 1 row for B, `server_overview_view` → 0 | **YES** |
| Role privileges are minimal (`authenticated` read-only, `anon` catalogue only) | `has_table_privilege` across all 29 public tables | **YES** |
| No table grants TRUNCATE/REFERENCES/TRIGGER to `anon` or `authenticated` | `has_table_privilege` sweep after migration 007 — **0 of 29 exposed** | **YES** |
| Default ACL cannot re-grant them to tables created later | `pg_default_acl` → `anon=m, authenticated=rm` | **YES** |
| Schema state: 29 tables, all RLS-enabled, 31 policies | `pg_class` / `pg_policies` query | **YES** |
| Voice schema matches the repository migration exactly | 10 tables, 43 constraints, 10 table comments, 8 column comments, 4 triggers, 4 policies, 22 indexes | **YES** |
| Voice credential tables unreachable from a browser session | 6 tables: `anon`/`authenticated` hold no privilege at all, and have no RLS policy | **YES** |
| Additive, idempotent migrations preserve the original four tables | Applied 001–007 to the live project; all four preserved and still empty | **YES** |
| Voice proximity, dimension separation, permission and quality logic | vitest — 97 tests | **YES — all pass** |
| Web/shared validation, allowlist mirror, CGNAT mirror, version discovery | vitest — 371 tests | **YES — all pass** |
| Lint, typecheck, production build | `next lint` (0 warnings), `tsc --noEmit`, `next build` | **YES** |
| Command allowlist rejects shell and accepts Bedrock commands | xUnit `CommandAllowlistTests` | **NO — written, never run** |
| Path confinement and traversal rejection | xUnit `PathConfinementTests` | **NO — written, never run** |
| Protected Bedrock system files | xUnit, same file | **NO — written, never run** |
| CGNAT / private-range detection (agent side) | xUnit `CgnatDetectionTests` | **NO — written, never run** |
| Zip-slip resistance in backup restore | xUnit `BackupManagerTests` | **NO — written, never run** |
| Version comparison and download-page parsing | xUnit | **NO — written, never run** |
| Real BDS process behaviour | Needs Windows + official BDS | **NO** |
| Real Bedrock client joining a hosted server | Needs Windows + BDS + a client on mobile data | **NO** |
| Backup → restore round trip on a live server | Needs Windows + BDS | **NO** |
| Update → rollback round trip on a live server | Needs Windows + BDS | **NO** |
| Playit UDP tunnel with a current Bedrock client | Needs a Playit account + binary + Windows | **NO** |

### What the RLS probe changed

Before this audit, RLS and cross-account access were recorded as unexecuted. They
are now genuinely verified — and verifying them surfaced two defects that
inspection alone had missed:

1. **`anon`, `authenticated` and `service_role` had no SELECT or DML privileges
   at all**, only TRUNCATE/REFERENCES/TRIGGER. The policies were correct but
   unreachable, and the application could not have functioned: every dashboard
   read and every API write would have failed with `permission denied`. Fixed in
   migration 005.
2. **TRUNCATE was granted to `anon` and `authenticated`.** TRUNCATE bypasses RLS,
   so either role could have emptied every table including other accounts' rows.
   Not reachable through PostgREST's HTTP verbs, but a standing privilege that
   must not exist. Revoked in migration 005, and probe check 11 confirms it is
   now refused.

Both are documented in `docs/FEATURE-INVENTORY.md` with the evidence.

### What applying the voice schema revealed

Migration 005's fix was real but **narrower than it looked**, and the gap was
invisible to both code review and the repository's own static migration tests.

3. **Revoking from tables does not change the default ACL.** Supabase ships
   default privileges of `{anon=Dxtm, authenticated=rDxtm}` for tables created by
   `postgres` in `public`. Migration 005 revoked TRUNCATE, REFERENCES and TRIGGER
   from every table *that existed at the time*, so the probe correctly reported
   them refused — but the four owner-facing voice tables created afterwards
   (`voice_server_configs`, `voice_rooms`, `voice_groups`, `voice_service_health`)
   silently re-inherited all three. `anon=Dxtm` means an anonymous role with a
   direct Postgres connection could TRUNCATE them, and TRUNCATE bypasses RLS, so
   that would have cleared voice configuration for every account.

   The six credential-bearing voice tables were unaffected only because
   migration 006 revoked from them explicitly.

   Same scoping caveat as defect 2: PostgREST exposes GET/POST/PATCH/DELETE and
   not TRUNCATE, so this was not reachable with the anon key over HTTP. It
   required a direct database connection as `anon` or `authenticated`.

   Fixed in migration 007, which does both halves: it alters the default ACL so
   future tables inherit only `anon=m, authenticated=rm`, and it sweeps every
   existing public table in a loop rather than from a list that would go stale.
   Re-running the same audit query afterwards reports **0 of 29 tables exposed**,
   with `authenticated` retaining SELECT on all 29 (RLS does the scoping) and
   `anon` retaining SELECT on exactly one (`network_providers`).

   The lesson is recorded as executable tests in
   `packages/shared/tests/migration-safety.test.ts`: one asserts the default ACL
   is revoked and not merely the tables, one asserts the sweep is generic, and
   one asserts the voice credential tables have RLS enabled with no browser
   policy. A static test still cannot see an inherited ACL — that requires
   querying `pg_default_acl` on the live project, which is why the audit query is
   documented here rather than only in code.

### Voice features that remain unverified

Everything above concerns the schema and the pure routing logic. The parts of
OG VOICE that need hardware, a network or a real Minecraft client have **not**
been executed, and are labelled as such wherever they appear:

| Not yet verified | Why |
| --- | --- |
| Real microphone capture and two-way audio | Needs a physical device and a running voice server |
| Measured end-to-end voice latency | Needs a real SFU and two clients |
| Android 12–16 permission, foreground-service and Bluetooth behaviour | No Android SDK or device in this environment |
| Windows companion build and hotkey capture | No Windows host; `dotnet` is not installed here |
| Bedrock add-on position sync against a live BDS | No Bedrock Dedicated Server available |
| NAT traversal on Jio/Airtel/Vi mobile networks | Needs those carriers; `relay_mode` stays `unknown` until measured |
| Any of the 30 real-multiplayer steps in §20 | Needs 1 Windows BDS + Android and Windows players |

The remaining untested rows are the ones that matter most before opening
registration to strangers, and they all need the same two things: a Windows
machine and a real Bedrock client. They are listed as a pre-launch checklist in
`docs/INSTALLATION.md` rather than assumed to pass.

