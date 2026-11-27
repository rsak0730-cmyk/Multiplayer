import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Migration safety guards.
 *
 * These exist because an audit of the live project found two defects that
 * reading application code could never have revealed:
 *
 *   1. `anon` and `authenticated` held TRUNCATE on every table. TRUNCATE
 *      bypasses row level security, so either role could have emptied tables
 *      containing other accounts' rows.
 *   2. The read-model views did not use `security_invoker`, so they ran as their
 *      owner — a role that bypasses RLS — and would have returned every user's
 *      nodes and servers.
 *
 * Both were fixed in migration 005. These tests make sure a later migration
 * cannot quietly reintroduce either one.
 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));

const migrations = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => ({
    file,
    // Strip line comments so a commented-out example cannot satisfy or trip a check.
    sql: readFileSync(join(MIGRATIONS_DIR, file), 'utf8').replace(/^\s*--.*$/gm, ''),
  }));

const allSql = migrations.map((m) => m.sql).join('\n');

/**
 * Parse a GRANT statement into its privilege list and target roles.
 *
 * Splitting on `on` and `to` matters: `GRANT SELECT ON ALL TABLES ...` contains
 * the word "all", but it is part of the relation specifier, not `GRANT ALL
 * PRIVILEGES`. A naive substring check for "all" produces a false positive here,
 * which is exactly the mistake this helper avoids.
 */
function parseGrants(sql: string): { statement: string; privileges: string; roles: string }[] {
  const out: { statement: string; privileges: string; roles: string }[] = [];
  const re = /grant\s+(.*?)\s+on\s+(.*?)\s+to\s+([^;]+);/gis;
  for (const match of sql.matchAll(re)) {
    out.push({
      statement: match[0].replace(/\s+/g, ' ').trim(),
      privileges: match[1].toLowerCase(),
      roles: match[3].toLowerCase(),
    });
  }
  return out;
}

/** True when a privilege list includes `name`, or is `ALL [PRIVILEGES]`. */
function grantsPrivilege(privileges: string, name: string): boolean {
  const isAll = /^\s*all(\s+privileges)?\s*$/.test(privileges);
  if (isAll) return true;
  return new RegExp(`\\b${name}\\b`, 'i').test(privileges);
}

const UNTRUSTED = /\b(anon|authenticated)\b/;

describe('migrations never grant dangerous privileges to untrusted roles', () => {
  it('never grants TRUNCATE to anon or authenticated', () => {
    // TRUNCATE bypasses RLS entirely. Handing it to a role that any signed-in
    // user (or any anonymous visitor, for `anon`) can assume is how one account
    // destroys every other account's data.
    const offenders: string[] = [];
    for (const { file, sql } of migrations) {
      for (const grant of parseGrants(sql)) {
        if (!UNTRUSTED.test(grant.roles)) continue;
        if (grantsPrivilege(grant.privileges, 'truncate')) {
          offenders.push(`${file}: ${grant.statement.slice(0, 120)}`);
        }
      }
    }
    expect(offenders, 'TRUNCATE (or ALL, which includes it) granted to anon/authenticated').toEqual([]);
  });

  it('never grants TRIGGER or REFERENCES to anon or authenticated', () => {
    // TRIGGER lets a role attach code to a table; REFERENCES has no client use
    // here. Neither belongs to a role an end user can assume.
    const offenders: string[] = [];
    for (const { file, sql } of migrations) {
      for (const grant of parseGrants(sql)) {
        if (!UNTRUSTED.test(grant.roles)) continue;
        if (grantsPrivilege(grant.privileges, 'trigger') || grantsPrivilege(grant.privileges, 'references')) {
          offenders.push(`${file}: ${grant.statement.slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never grants INSERT, UPDATE or DELETE to authenticated', () => {
    // The browser is read-only: every mutation goes through an API route that
    // re-checks ownership with the service-role key. Granting DML to
    // authenticated would widen the surface for no benefit.
    const offenders: string[] = [];
    for (const { file, sql } of migrations) {
      for (const grant of parseGrants(sql)) {
        if (!/\bauthenticated\b/.test(grant.roles)) continue;
        for (const privilege of ['insert', 'update', 'delete']) {
          if (grantsPrivilege(grant.privileges, privilege)) {
            offenders.push(`${file}: ${grant.statement.slice(0, 120)}`);
          }
        }
      }
    }
    expect(offenders, 'write privileges granted to the browser role').toEqual([]);
  });

  it('explicitly revokes those privileges from anon and authenticated', () => {
    // Positive check: the fix must actually be present, not merely unbroken.
    expect(allSql).toMatch(/revoke\s+all\s+on\s+table[\s\S]{0,200}?from\s+anon\s*,\s*authenticated/i);
  });

  it('does grant authenticated SELECT on everything (RLS does the scoping)', () => {
    // Positive counterpart to the checks above: read-only, but able to read.
    // Without this grant the RLS policies are unreachable and the app cannot
    // function at all — which is the defect this migration exists to fix.
    expect(allSql).toMatch(/grant\s+select\s+on\s+all\s+tables\s+in\s+schema\s+public\s+to\s+authenticated/i);
  });

  it('gives anon no more than the public provider catalogue', () => {
    for (const grant of parseGrants(allSql)) {
      if (!/\banon\b/.test(grant.roles)) continue;
      const onTables = /\b(all\s+tables|public\.[a-z_]+)\b/i.test(grant.statement);
      // `grant usage on schema public to anon` is fine and touches no table.
      if (!onTables) continue;
      // The `TABLE` keyword is optional in GRANT, and migration 007 spells it
      // out. The intent of this guard is which relation anon may read, not the
      // syntax used to say so, so both spellings are accepted.
      expect(grant.statement, 'anon may only SELECT the public network_providers catalogue').toMatch(
        /select\s+on\s+(?:table\s+)?public\.network_providers/i,
      );
    }
  });

  it('sets default privileges so future tables inherit safe grants', () => {
    expect(allSql).toMatch(/alter\s+default\s+privileges[\s\S]{0,300}?to\s+authenticated/i);

    const defaults = allSql.match(/alter\s+default\s+privileges[^;]+;/gis) ?? [];
    expect(defaults.length, 'expected default-privilege statements to exist').toBeGreaterThan(0);

    // Only GRANT statements can widen access. This check used to test every
    // `alter default privileges` statement for the word "truncate", which made
    // migration 007's `revoke truncate, references, trigger` fail the suite for
    // being the fix. Distinguishing the verbs keeps the guard honest.
    const grants = defaults.filter((statement) => /^\s*alter\s+default\s+privileges[\s\S]*?\bgrant\b/i.test(statement));
    expect(grants.length, 'expected default-privilege GRANTs to exist').toBeGreaterThan(0);
    for (const statement of grants) {
      if (/\bto\s+[^;]*\b(anon|authenticated)\b/i.test(statement)) {
        expect(statement, 'default privileges must not grant TRUNCATE to untrusted roles').not.toMatch(
          /\btruncate\b/i,
        );
      }
    }
  });

  it('revokes the dangerous privileges from the default ACL, not just from existing tables', () => {
    // THE LESSON FROM MIGRATION 007, and the reason this test exists.
    //
    // Supabase ships default privileges of {anon=Dxtm, authenticated=rDxtm} for
    // tables created by `postgres` in `public`. Migration 005 revoked TRUNCATE,
    // REFERENCES and TRIGGER from every table that existed, and this suite
    // passed — but `voice_rooms`, `voice_server_configs`, `voice_groups` and
    // `voice_service_health` were created afterwards and silently re-inherited
    // all three. TRUNCATE bypasses RLS, so an anon session with a direct
    // Postgres connection could have emptied voice configuration for every
    // account.
    //
    // Revoking from tables is therefore not enough; the default ACL has to
    // change too, or each new migration reopens the hole.
    for (const role of ['anon', 'authenticated']) {
      expect(
        allSql,
        `default privileges must revoke TRUNCATE/REFERENCES/TRIGGER from ${role}`,
      ).toMatch(new RegExp(`alter\\s+default\\s+privileges[\\s\\S]{0,200}?revoke\\s+truncate,\\s*references,\\s*trigger\\s+on\\s+tables\\s+from\\s+${role}\\s*;`, 'i'));
    }
  });

  it('sweeps every existing public table rather than a hardcoded list', () => {
    // A hand-written list of tables goes stale the moment a migration adds one.
    // 007 loops over pg_class so re-running it covers tables that did not exist
    // when it was written.
    expect(allSql).toMatch(/for\s+t\s+in[\s\S]{0,400}?pg_class[\s\S]{0,400}?nspname\s*=\s*'public'/i);
    expect(allSql).toMatch(/execute\s+format\(\s*'revoke\s+all\s+on\s+table\s+public\.%I\s+from\s+anon'/i);
  });

  it('leaves anon exactly one readable table after the sweep', () => {
    // The blanket `revoke all ... from anon` must be followed by re-granting the
    // public provider catalogue, or the landing page loses its data. Scoped to
    // the migration that performs the sweep: 005 also grants network_providers
    // to anon, and matching that first would make the ordering check meaningless.
    const sweepMigration = migrations.find((m) =>
      /revoke\s+all\s+on\s+table\s+public\.%I\s+from\s+anon/i.test(m.sql),
    );
    expect(sweepMigration, 'no migration sweeps anon privileges across public tables').toBeDefined();

    const sql = sweepMigration!.sql;
    const sweepAt = sql.search(/revoke\s+all\s+on\s+table\s+public\.%I\s+from\s+anon/i);
    const regrantAt = sql.search(/grant\s+select\s+on\s+table\s+public\.network_providers\s+to\s+anon/i);
    expect(regrantAt, 'network_providers must be re-granted after the anon sweep').toBeGreaterThan(sweepAt);
    expect(regrantAt).toBeGreaterThanOrEqual(0);
  });
});

describe('voice tables keep credentials out of browser reach', () => {
  const voiceMigration = migrations.find((m) => m.file.startsWith('006'))?.sql ?? '';

  // These six hold session tokens, verification codes, guest identity or the
  // audit trail. They are reachable only through API routes using the
  // service-role key; the browser must never read them, even scoped by RLS.
  const CREDENTIAL_TABLES = [
    'voice_player_links',
    'voice_verification_codes',
    'voice_device_sessions',
    'voice_player_preferences',
    'voice_group_members',
    'voice_connection_events',
  ];

  // Owner-facing tables, where RLS scopes rows to the owner instead.
  const OWNER_TABLES = ['voice_server_configs', 'voice_rooms', 'voice_groups', 'voice_service_health'];

  it('creates all ten voice tables', () => {
    for (const table of [...CREDENTIAL_TABLES, ...OWNER_TABLES]) {
      expect(voiceMigration, `006 must create ${table}`).toMatch(
        new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${table}\\b`, 'i'),
      );
    }
  });

  it.each(CREDENTIAL_TABLES)('enables RLS on %s and gives it no browser policy', (table) => {
    // A policy here would be a second way in: even an owner-scoped policy on
    // voice_device_sessions would expose session token hashes to a browser.
    expect(voiceMigration, `${table} must have RLS enabled`).toMatch(
      new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, 'i'),
    );
    expect(voiceMigration, `${table} must not have a create policy`).not.toMatch(
      new RegExp(`create\\s+policy[^;]*\\bon\\s+public\\.${table}\\b`, 'i'),
    );
    expect(voiceMigration, `${table} must be revoked from anon and authenticated`).toMatch(
      new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated`, 'i'),
    );
  });

  it.each(OWNER_TABLES)('scopes %s to its owner with a policy', (table) => {
    expect(voiceMigration).toMatch(
      new RegExp(`create\\s+policy[^;]*\\bon\\s+public\\.${table}[\\s\\S]{0,200}?auth\\.uid\\(\\)\\s*=\\s*owner_id`, 'i'),
    );
  });

  it('stores only hashes for codes and session tokens', () => {
    expect(voiceMigration).toMatch(/code_hash\s+text\s+not\s+null/i);
    expect(voiceMigration).toMatch(/session_token_hash\s+text\s+not\s+null/i);
    // No plaintext counterpart column may be added later by accident.
    expect(voiceMigration).not.toMatch(/^\s*(code|session_token)\s+text/im);
  });

  it('gives guest links no path into an owner account', () => {
    // voice_player_links must not reference auth.users: Minecraft friends have
    // no OG HOST account and must never reach account or server-management data.
    const links = voiceMigration.match(
      /create\s+table\s+if\s+not\s+exists\s+public\.voice_player_links\s*\(([\s\S]*?)\n\);/i,
    );
    expect(links, 'voice_player_links definition not found').not.toBeNull();
    expect(links![1]).not.toMatch(/auth\.users/i);
    expect(links![1]).not.toMatch(/owner_id/i);
  });

  it('defaults recording and audio storage to off', () => {
    expect(voiceMigration).toMatch(/recording_enabled\s+boolean\s+not\s+null\s+default\s+false/i);
    expect(voiceMigration).toMatch(/audio_storage_enabled\s+boolean\s+not\s+null\s+default\s+false/i);
    // And nothing in the voice schema stores audio itself.
    expect(voiceMigration).not.toMatch(/\baudio_data\b|\brecording_url\b|\bbytea\b/i);
  });

  it('constrains the mic permission state to the ten documented states', () => {
    const states = ['not_requested', 'permission_required', 'permission_granted', 'permission_denied',
      'permission_permanently_denied', 'permission_revoked', 'mic_active', 'mic_muted',
      'device_unavailable', 'disconnected'];
    for (const state of states) {
      expect(voiceMigration, `mic_permission_state check must allow ${state}`).toContain(`'${state}'`);
    }
    expect(voiceMigration).toMatch(/mic_permission_state\s+text\s+not\s+null\s+default\s+'not_requested'/i);
  });

  it('keeps the microphone off until the player activates it', () => {
    // 'not_requested' must be the default, and a session must not start out
    // connected or transmitting.
    expect(voiceMigration).toMatch(/connected\s+boolean\s+not\s+null\s+default\s+false/i);
    expect(voiceMigration).toMatch(/transmitting\s+boolean\s+not\s+null\s+default\s+false/i);
  });

  it('stores no plaintext credential in any voice column', () => {
    // The LiveKit API key and secret belong in environment variables only.
    //
    // This checks column definitions rather than the whole file on purpose: the
    // SQL prose deliberately mentions secrets in order to say none are stored,
    // and `comment on table '...'` strings are not stripped the way `--` line
    // comments are, so a naive whole-file scan fails on its own explanation.
    const bodies = [
      ...voiceMigration.matchAll(
        /create\s+table\s+if\s+not\s+exists\s+public\.(voice_\w+)\s*\(([\s\S]*?)\n\);/gi,
      ),
    ];
    expect(bodies.length, 'expected the ten voice CREATE TABLE statements').toBe(10);

    const TYPES = 'text|uuid|bytea|jsonb|numeric|integer|bigint|boolean|timestamptz';
    for (const [, table, body] of bodies) {
      const parsed = [...body.matchAll(new RegExp(`^\\s+(\\w+)\\s+(${TYPES})`, 'gim'))].map((m) => ({
        name: m[1],
        type: m[2].toLowerCase(),
      }));
      expect(parsed.length, `${table}: no columns parsed`).toBeGreaterThan(0);
      const columns = parsed.map((c) => c.name);

      // Nothing may be able to hold audio bytes at all.
      expect(parsed.some((c) => c.type === 'bytea'), `${table} must not have a bytea column`).toBe(false);

      // No SFU credential at all, hashed or otherwise.
      expect(
        columns.some((c) => /api_key|api_secret|sfu_secret|private_key/i.test(c)),
        `${table} must not store voice server credentials`,
      ).toBe(false);

      // Anything that does look like a credential must be stored hashed.
      for (const column of columns.filter((c) => /(secret|token|password|code)/i.test(c))) {
        expect(column, `${table}.${column} looks like a credential and must be stored hashed`).toMatch(/_hash$/);
      }

      // Audio-related names may only be boolean settings. `recording_enabled`
      // and `audio_storage_enabled` are switches that default to false; a text
      // or jsonb column with such a name would mean the schema can hold audio.
      for (const { name, type } of parsed.filter((c) => /audio|recording|pcm|opus/i.test(c.name))) {
        expect(type, `${table}.${name} must be a boolean setting, never audio storage`).toBe('boolean');
      }
    }

    expect(voiceMigration).toMatch(/sfu_url\s+text\s+not\s+null/i);
    expect(voiceMigration).toMatch(/code_hash\s+text\s+not\s+null/i);
    expect(voiceMigration).toMatch(/session_token_hash\s+text\s+not\s+null/i);
  });

  it('records relay mode as unknown until measured', () => {
    // §10: never assume direct inbound connectivity on mobile carriers.
    expect(voiceMigration).toMatch(/relay_mode\s+text\s+not\s+null\s+default\s+'unknown'/i);
    expect(voiceMigration).toMatch(/turn_servers_configured\s+boolean\s+not\s+null\s+default\s+false/i);
  });

  it('keeps player positions out of browser reach too', () => {
    // Added in 008, after the credential tables, so it is not covered by the
    // loop above. Positions describe where guests are standing, which is why an
    // owner reads the derived player list rather than raw coordinates.
    const positions = migrations.find((m) => m.file.startsWith('008'))?.sql ?? '';
    expect(positions).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.voice_positions\b/i);
    expect(positions).toMatch(/alter\s+table\s+public\.voice_positions\s+enable\s+row\s+level\s+security/i);
    expect(positions).not.toMatch(/create\s+policy[^;]*\bon\s+public\.voice_positions\b/i);
    expect(positions).toMatch(/revoke\s+all\s+on\s+table\s+public\.voice_positions\s+from\s+anon,\s*authenticated/i);
  });

  it('restricts who may claim to have reported a position', () => {
    // The whole authority of proximity voice rests on coordinates coming from
    // inside the server process. A 'client' value here would mean a companion app
    // could place itself next to any player.
    const positions = migrations.find((m) => m.file.startsWith('008'))?.sql ?? '';
    expect(positions).toMatch(/reported_by\s+text\s+not\s+null\s+default\s+'add_on'\s+check\s*\(reported_by\s+in\s*\('add_on',\s*'agent'\)\)/i);
    expect(positions).not.toMatch(/'client'|'companion'|'player'/i);
  });
});

describe('views cannot be used to bypass row level security', () => {
  const viewCreations = allSql.match(/create\s+(?:or\s+replace\s+)?view[^;]+;/gis) ?? [];

  it('defines at least the two read-model views', () => {
    expect(viewCreations.length).toBeGreaterThanOrEqual(2);
    expect(allSql).toMatch(/node_status_view/);
    expect(allSql).toMatch(/server_overview_view/);
  });

  it('creates every view with security_invoker = true', () => {
    // A view without security_invoker runs as its owner. In Supabase that owner
    // bypasses RLS, so the view leaks every user's rows regardless of the
    // owner_id policies on the tables underneath.
    const offenders = viewCreations
      .filter((statement) => !/security_invoker\s*=\s*true/i.test(statement))
      .map((statement) => statement.replace(/\s+/g, ' ').trim().slice(0, 100));

    expect(offenders, 'view created without security_invoker — it would bypass RLS').toEqual([]);
  });

  it('does not select computed_status from the base nodes table', () => {
    // Regression guard for a real bug: server_overview_view selected
    // n.computed_status while joining public.nodes, but that column only exists
    // on node_status_view. The migration failed outright.
    const overview = viewCreations.find((s) => /server_overview_view/i.test(s)) ?? '';
    expect(overview).toMatch(/join\s+public\.node_status_view/i);
    expect(overview).not.toMatch(/join\s+public\.nodes\b/i);
  });
});

describe('migrations preserve the pre-existing tables', () => {
  const protectedTables = ['nodes', 'servers', 'pairing_codes', 'node_events'];

  it.each(protectedTables)('never drops or recreates %s', (table) => {
    const drop = new RegExp(`drop\\s+table[^;]*\\b${table}\\b`, 'i');
    const create = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${table}\\b`, 'i');
    expect(allSql, `a migration drops ${table}`).not.toMatch(drop);
    expect(allSql, `a migration recreates ${table} instead of altering it`).not.toMatch(create);
  });

  /**
   * The ONLY constraint changes ever permitted on a pre-existing table, and why.
   *
   * The rule below exists to stop a migration silently destroying data in the four
   * tables that predate OG HOST. Migration 009 needs exactly one exception:
   * `servers.game_type` was created with CHECK ((game_type = 'bedrock')), which
   * makes a Java engine unrepresentable — the insert is rejected outright, so
   * Paper and Purpur could never be added even by correct application code.
   *
   * Widening that CHECK loses nothing: 'bedrock' stays legal, no row is rewritten,
   * and no column changes type or name. So the exception is granted narrowly — by
   * name, with a test asserting the replacement still accepts every value the old
   * constraint accepted. Dropping a primary key, a foreign key, a NOT NULL or a
   * column on these tables still fails, and so does any constraint change that is
   * not listed here.
   */
  const ALLOWED_CONSTRAINT_CHANGES: ReadonlyArray<{
    table: string;
    constraint: string;
    /** Quoted values the replacement must still accept, so it can only widen. */
    mustStillAllow?: string[];
  }> = [
    { table: 'servers', constraint: 'servers_game_type_check', mustStillAllow: ["'bedrock'"] },
    // New in 009. Dropped only so re-running the migration does not fail on a
    // duplicate constraint name; it protects no pre-existing data.
    { table: 'servers', constraint: 'servers_engine_matches_game_type' },
  ];

  /** A statement that changes one constraint and touches no column. */
  function parseConstraintChange(statement: string) {
    const match =
      /^\s*alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_0-9]+)\s+(drop|add)\s+constraint\s+(?:if\s+(?:not\s+)?exists\s+)?([a-z_0-9]+)/i.exec(
        statement,
      );
    if (!match) return null;
    return { table: match[1], action: match[2].toLowerCase(), constraint: match[3] };
  }

  it('only ever adds columns to the pre-existing tables', () => {
    for (const { file, sql } of migrations) {
      for (const statement of sql.match(/alter\s+table[^;]+;/gis) ?? []) {
        const targetsProtected = protectedTables.some((t) =>
          new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${t}\\b`, 'i').test(statement),
        );
        if (!targetsProtected) continue;

        const change = parseConstraintChange(statement);
        if (change) {
          expect(
            ALLOWED_CONSTRAINT_CHANGES.some((a) => a.table === change.table && a.constraint === change.constraint),
            `${file} changes constraint ${change.constraint} on pre-existing table ${change.table}; it is not allowlisted`,
          ).toBe(true);
          // A constraint statement must do nothing else, so the exception cannot be
          // used as cover for a column change.
          expect(statement, `${file} mixes a constraint change with column DDL`).not.toMatch(
            /add\s+column|drop\s+column|rename|alter\s+column/i,
          );
          continue;
        }

        expect(statement, `${file} alters a protected table without "add column if not exists"`).toMatch(
          /add\s+column\s+if\s+not\s+exists/i,
        );
        expect(statement, `${file} drops or renames a column on a protected table`).not.toMatch(
          /\b(drop|rename|alter)\s+column\b/i,
        );
      }
    }
  });

  it('re-adds, in the same migration, every constraint it drops from a pre-existing table', () => {
    for (const { file, sql } of migrations) {
      const statements = sql.match(/alter\s+table[^;]+;/gis) ?? [];
      for (const statement of statements) {
        const change = parseConstraintChange(statement);
        if (!change || change.action !== 'drop' || !protectedTables.includes(change.table)) continue;
        expect(
          statements.some((s) => new RegExp(`add\\s+constraint\\s+${change.constraint}\\b`, 'i').test(s)),
          `${file} drops ${change.table}.${change.constraint} without re-adding it, leaving the column unconstrained`,
        ).toBe(true);
      }
    }
  });

  it('never narrows a widened CHECK, so existing rows stay valid', () => {
    for (const allowed of ALLOWED_CONSTRAINT_CHANGES) {
      if (!allowed.mustStillAllow?.length) continue;
      const additions = migrations
        .flatMap((m) => m.sql.match(/alter\s+table[^;]+;/gis) ?? [])
        .filter((s) => new RegExp(`add\\s+constraint\\s+${allowed.constraint}\\b`, 'i').test(s));

      expect(additions.length, `${allowed.constraint} is dropped but never re-added`).toBeGreaterThan(0);
      for (const statement of additions) {
        for (const value of allowed.mustStillAllow) {
          expect(
            statement,
            `${allowed.constraint} no longer accepts ${value}; rows already stored would violate it`,
          ).toContain(value);
        }
      }
    }
  });

  it('enables row level security on every table it creates', () => {
    const created = [
      ...allSql.matchAll(/create\s+table\s+if\s+not\s+exists\s+(?:public\.)?([a-z_]+)/gi),
    ].map((m) => m[1]);

    expect(created.length, 'no CREATE TABLE statements found').toBeGreaterThan(0);

    const missingRls = created.filter(
      (table) =>
        // network_providers is intentionally world-readable but still has RLS on.
        !new RegExp(`alter\\s+table\\s+(?:public\\.)?${table}\\s+enable\\s+row\\s+level\\s+security`, 'i').test(
          allSql,
        ),
    );

    expect(missingRls, 'tables created without enabling RLS').toEqual([]);
  });
});
