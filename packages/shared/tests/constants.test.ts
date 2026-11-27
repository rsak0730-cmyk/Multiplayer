import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGENT_VERSION,
  CONSOLE_LOG_RETENTION_DAYS,
  CONTROL_PLANE_API_VERSION,
  DEFAULT_BDS_PORT,
  DEFAULT_BDS_PORT_V6,
  DEFAULT_MAX_PLAYERS,
  HEARTBEAT_INTERVAL_SECONDS,
  MAX_UPLOAD_BYTES,
  NODE_ONLINE_WINDOW_SECONDS,
  PAIRING_CODE_TTL_MINUTES,
  PAIRING_MAX_ATTEMPTS,
} from '../src/constants';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

describe('control-plane constants', () => {
  it('uses a heartbeat and online window that agree', () => {
    expect(HEARTBEAT_INTERVAL_SECONDS).toBe(15);
    expect(NODE_ONLINE_WINDOW_SECONDS).toBe(90);
    // A node must survive several missed heartbeats before being called offline,
    // otherwise a brief network blip flips the UI and blocks commands.
    expect(NODE_ONLINE_WINDOW_SECONDS).toBeGreaterThanOrEqual(HEARTBEAT_INTERVAL_SECONDS * 4);
  });

  it('keeps pairing codes short-lived, single-use and attempt-limited', () => {
    expect(PAIRING_CODE_TTL_MINUTES).toBe(10);
    expect(PAIRING_MAX_ATTEMPTS).toBe(5);
    expect(PAIRING_CODE_TTL_MINUTES).toBeGreaterThan(0);
    expect(PAIRING_MAX_ATTEMPTS).toBeGreaterThan(0);
    // A brute-forceable code would need a far larger attempt budget than this.
    expect(PAIRING_MAX_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  it('targets the documented Bedrock defaults', () => {
    expect(DEFAULT_BDS_PORT).toBe(19132);
    expect(DEFAULT_BDS_PORT_V6).toBe(19133);
    expect(DEFAULT_MAX_PLAYERS).toBe(10);
  });

  it('caps uploads and log retention', () => {
    expect(MAX_UPLOAD_BYTES).toBe(256 * 1024 * 1024);
    expect(CONSOLE_LOG_RETENTION_DAYS).toBe(7);
    expect(CONSOLE_LOG_RETENTION_DAYS).toBeGreaterThan(0);
  });

  it('versions its own contracts', () => {
    expect(AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(CONTROL_PLANE_API_VERSION).toBe('v1');
  });
});

/**
 * "No hard-coded Minecraft version numbers" is a hard project requirement.
 *
 * Bedrock ships new builds constantly, so any pinned version rots within weeks
 * and silently installs the wrong server. Versions must be discovered at
 * runtime from the official download page. This test scans the TypeScript
 * sources for a Bedrock-shaped version literal and fails if one appears.
 *
 * Bedrock versions have always begun with `1.`, which keeps the scan precise:
 * it does not trip over the agent's own `0.1.0`, IP addresses, CIDR ranges or
 * dependency versions.
 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (['node_modules', '.next', 'dist', 'build', 'out', '.git'].includes(entry)) continue;
      collectSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('no Minecraft version is hard-coded anywhere', () => {
  const bedrockVersionLiteral = /\b1\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/;

  it.each([
    ['packages/shared/src', join(REPO_ROOT, 'packages/shared/src')],
    ['apps/web/src', join(REPO_ROOT, 'apps/web/src')],
  ] as const)('finds none in %s', (_label, dir) => {
    const offenders: string[] = [];

    for (const file of collectSourceFiles(dir)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (!bedrockVersionLiteral.test(line)) return;
        const match = line.match(bedrockVersionLiteral)?.[0];
        // Allow it inside a test file's fixture data and inside comments that
        // are explicitly explaining the rule — but never in product code.
        const isTest = /\.test\.tsx?$/.test(file);
        const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
        if (!isTest && !isComment) {
          offenders.push(`${file.replace(REPO_ROOT, '')}:${index + 1} → ${match}`);
        }
      });
    }

    expect(
      offenders,
      'A Minecraft version literal was found in product code. Discover it at runtime instead.',
    ).toEqual([]);
  });
});
