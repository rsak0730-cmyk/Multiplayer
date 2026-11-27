import { describe, expect, it } from 'vitest';
import {
  addonTypeFromFileName,
  formatBytes,
  isValidMaxPlayers,
  isValidPairingCode,
  isValidPort,
  isValidServerName,
  isValidWorldName,
  resolveInsideRoot,
} from '../src/validation';

describe('server and world names', () => {
  it.each(['My Server', 'survival-1', 'world_2', 'A', 'a'.repeat(64)])(
    'accepts %j',
    (name) => {
      expect(isValidServerName(name)).toBe(true);
      expect(isValidWorldName(name)).toBe(true);
    },
  );

  it('trims surrounding whitespace before validating', () => {
    expect(isValidServerName('  My Server  ')).toBe(true);
    expect(isValidWorldName('\tworld\t')).toBe(true);
  });

  it.each([
    '',
    '   ',
    'a'.repeat(65),
    'bad/name',
    'bad\\name',
    'bad;name',
    'bad|name',
    'bad`name',
    'bad$name',
    '../escape',
    'server.properties',
    'naïve',
    'server🎮',
    'name\nwith\nnewlines',
  ])('rejects %j', (name) => {
    expect(isValidServerName(name)).toBe(false);
    expect(isValidWorldName(name)).toBe(false);
  });

  it('rejects names that could be used to escape a directory', () => {
    // A world name becomes a directory name on the node. These must never pass.
    for (const hostile of ['..', '.', '../..', 'a/../../b', 'C:evil', '\\evil']) {
      expect(isValidWorldName(hostile)).toBe(false);
    }
  });
});

describe('pairing codes', () => {
  it.each(['ABC123-DEF456', 'K7M2QP-9RT4XN', 'AAAAAA-AAAAAA', '000000-000000'])(
    'accepts the shape %j',
    (code) => {
      expect(isValidPairingCode(code)).toBe(true);
    },
  );

  it('accepts lowercase input by normalising it', () => {
    expect(isValidPairingCode('abc123-def456')).toBe(true);
    expect(isValidPairingCode('  AbC123-DeF456  ')).toBe(true);
  });

  it.each([
    '',
    'ABC123DEF456',
    'ABC12-DEF456',
    'ABC123-DEF45',
    'ABC1234-DEF456',
    'ABC123_DEF456',
    'ABC123-DEF4567',
    '------ ------',
    'ABC 123-DEF456',
  ])('rejects %j', (code) => {
    expect(isValidPairingCode(code)).toBe(false);
  });
});

describe('add-on file types', () => {
  it.each([
    ['pack.mcpack', 'mcpack'],
    ['bundle.mcaddon', 'mcaddon'],
    ['world.mcworld', 'mcworld'],
    ['PACK.MCPACK', 'mcpack'],
    ['My Addon.McAddon', 'mcaddon'],
    ['deep/nested/path/world.mcworld', 'mcworld'],
  ] as const)('maps %j to %j', (fileName, expected) => {
    expect(addonTypeFromFileName(fileName)).toBe(expected);
  });

  it.each([
    'thing.zip',
    'pack.exe',
    'mcpack',
    'a.mcpack.zip',
    '',
    'mcaddon',
    'pack.mcpack.txt',
    'manifest.json',
  ])('returns null for the unsupported name %j', (fileName) => {
    expect(addonTypeFromFileName(fileName)).toBe(null);
  });
});

describe('resolveInsideRoot (web-side mirror of the agent guard)', () => {
  const root = '/srv/oghost/servers/server-1';

  it.each([
    ['worlds/level', '/srv/oghost/servers/server-1/worlds/level'],
    ['server.properties', '/srv/oghost/servers/server-1/server.properties'],
    ['behavior_packs/mypack/manifest.json', '/srv/oghost/servers/server-1/behavior_packs/mypack/manifest.json'],
    ['./worlds', '/srv/oghost/servers/server-1/worlds'],
    ['worlds//level', '/srv/oghost/servers/server-1/worlds/level'],
  ] as const)('resolves %j to %j', (relative, expected) => {
    expect(resolveInsideRoot(root, relative)).toBe(expected);
  });

  it('normalises Windows separators to the same result', () => {
    expect(resolveInsideRoot(root, 'behavior_packs\\my pack\\manifest.json')).toBe(
      resolveInsideRoot(root, 'behavior_packs/my pack/manifest.json'),
    );
  });

  it('ignores a trailing separator on the root', () => {
    expect(resolveInsideRoot(`${root}/`, 'worlds')).toBe(
      resolveInsideRoot(root, 'worlds'),
    );
  });

  it.each([
    '../secret.txt',
    '../../etc/passwd',
    'worlds/../../outside.txt',
    '..\\..\\other-server\\worlds',
    'a/b/../../../../etc/passwd',
    '..',
    'worlds/..',
    '',
  ])('refuses the escaping or empty path %j', (relative) => {
    expect(resolveInsideRoot(root, relative)).toBe(null);
  });

  it('never returns a path outside the root, whatever the input', () => {
    // Property check over a spread of hostile inputs: the only acceptable
    // outcomes are null, or a path still under the root.
    const hostile = [
      '../x', '../../x', '../../../x', 'a/../..', '/etc/passwd', 'C:\\Windows',
      '....//....//x', '%2e%2e%2f', 'a/./../../b', '..%2f', 'worlds/../../../x',
    ];
    for (const input of hostile) {
      const resolved = resolveInsideRoot(root, input);
      if (resolved !== null) {
        expect(resolved.startsWith(`${root}/`), `${input} escaped to ${resolved}`).toBe(true);
      }
    }
  });
});

describe('port validation', () => {
  it.each([1024, 19132, 19133, 25565, 65535])('accepts %d', (port) => {
    expect(isValidPort(port)).toBe(true);
  });

  it.each([0, -1, 1, 80, 443, 1023, 65536, 99999, 19132.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s',
    (port) => {
      expect(isValidPort(port)).toBe(false);
    },
  );

  it('rejects privileged ports, which a non-admin agent could not bind anyway', () => {
    expect(isValidPort(19132)).toBe(true);
    expect(isValidPort(80)).toBe(false);
  });
});

describe('max players validation', () => {
  it.each([1, 10, 20, 100])('accepts %d', (n) => {
    expect(isValidMaxPlayers(n)).toBe(true);
  });

  it.each([0, -1, -10, 101, 1000, 2.5, Number.NaN])( 'rejects %s', (n) => {
    expect(isValidMaxPlayers(n)).toBe(false);
  });

  it('allows the 10-player design target', () => {
    expect(isValidMaxPlayers(10)).toBe(true);
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0.0 B'],
    [50, '50.0 B'],
    [999, '999 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [1024 * 1024 * 1024, '1.0 GB'],
    [500 * 1024 * 1024 * 1024, '500 GB'],
    [6 * 1024 * 1024 * 1024, '6.0 GB'],
  ] as const)('formats %d as %j', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  it('returns an em dash rather than a fake number for unusable input', () => {
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('does not invent a unit beyond TB', () => {
    const huge = 1024 ** 5 * 3;
    expect(formatBytes(huge)).toMatch(/TB$/);
  });
});
