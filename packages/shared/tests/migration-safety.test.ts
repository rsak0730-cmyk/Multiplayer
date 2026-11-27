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
      expect(grant.statement, 'anon may only SELECT the public network_providers catalogue').toMatch(
        /select\s+on\s+public\.network_providers/i,
      );
    }
  });

  it('sets default privileges so future tables inherit safe grants', () => {
    expect(allSql).toMatch(/alter\s+default\s+privileges[\s\S]{0,300}?to\s+authenticated/i);
    // And the defaults must not include TRUNCATE for untrusted roles.
    const defaults = allSql.match(/alter\s+default\s+privileges[^;]+;/gis) ?? [];
    expect(defaults.length, 'expected default-privilege statements to exist').toBeGreaterThan(0);
    for (const statement of defaults) {
      if (/\bto\s+[^;]*\b(anon|authenticated)\b/i.test(statement)) {
        expect(statement, 'default privileges must not grant TRUNCATE to untrusted roles').not.toMatch(
          /\btruncate\b/i,
        );
      }
    }
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

  it('only ever adds columns to the pre-existing tables', () => {
    for (const { file, sql } of migrations) {
      for (const statement of sql.match(/alter\s+table[^;]+;/gis) ?? []) {
        const targetsProtected = protectedTables.some((t) =>
          new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${t}\\b`, 'i').test(statement),
        );
        if (!targetsProtected) continue;
        expect(statement, `${file} alters a protected table without "add column if not exists"`).toMatch(
          /add\s+column\s+if\s+not\s+exists/i,
        );
        expect(statement, `${file} drops or renames a column on a protected table`).not.toMatch(
          /\b(drop|rename|alter)\s+column\b/i,
        );
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
