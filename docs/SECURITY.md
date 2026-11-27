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
   CI runs the full gate (lint, typecheck, 237 unit tests, production build, SQL
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

| Control | Verified how |
| --- | --- |
| Command allowlist (reject shell, accept Bedrock commands) | xUnit tests, `CommandAllowlistTests` — 30+ cases |
| Path confinement and traversal rejection | xUnit tests, `PathConfinementTests` |
| Protected system files | xUnit tests, same file |
| CGNAT / private-range detection | xUnit tests, `CgnatDetectionTests` |
| Zip-slip resistance in restore | xUnit tests, `BackupManagerTests` |
| Version comparison and page parsing | xUnit tests |
| Shared validation helpers | vitest, `packages/shared` |
| RLS policies | **Requires a live Supabase project — not yet executed.** See `docs/INSTALLATION.md` §Verify RLS. |
| Cross-account access attempts | **Requires two live accounts — not yet executed.** |
| Real BDS process behaviour | **Requires Windows hardware — not yet executed.** |

The untested rows are the ones that matter most before opening registration to
strangers. They are listed in `docs/INSTALLATION.md` as a pre-launch checklist
rather than assumed to pass.
