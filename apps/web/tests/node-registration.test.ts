import { describe, expect, it } from 'vitest';
import type { HostOs } from '@oghost/shared';
import { defaultNodeIdentity, resolveAgentPlatform } from '@/lib/nodes/registration';

/** The character rule OG HOST applies to user-visible names elsewhere. */
const NAME_RULE = /^[A-Za-z0-9 _-]{1,64}$/;

const PLATFORMS: readonly HostOs[] = ['windows', 'linux', 'android', 'macos'];

describe('resolveAgentPlatform', () => {
  it('accepts an explicit claim for every platform the catalog models', () => {
    for (const platform of PLATFORMS) {
      const result = resolveAgentPlatform({ reported: platform });
      expect(result.ok, platform).toBe(true);
      if (!result.ok) continue;
      expect(result.platform).toBe(platform);
      expect(result.source).toBe('reported');
    }
  });

  it('normalises case and whitespace in an explicit claim', () => {
    const result = resolveAgentPlatform({ reported: '  ANDROID ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.platform).toBe('android');
  });

  it('refuses an explicit claim it does not recognise, naming it', () => {
    // Rewriting an unknown platform to the default would register a device as
    // something it is not, and engine selection trusts that value later.
    for (const bogus of ['chromeos', 'ios', 'ipados', 'raspberry-pi-os', 'windows-phone']) {
      const result = resolveAgentPlatform({ reported: bogus });
      expect(result.ok, bogus).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain(bogus);
      expect(result.error).toMatch(/Supported values/);
      for (const platform of PLATFORMS) expect(result.error).toContain(platform);
    }
  });

  it('derives the platform from the display string when none was reported', () => {
    const cases: Array<[string, HostOs]> = [
      ['Android 14', 'android'],
      ['Windows 11 Pro', 'windows'],
      ['Ubuntu 22.04', 'linux'],
      ['macOS 14.2', 'macos'],
    ];
    for (const [operatingSystem, expected] of cases) {
      const result = resolveAgentPlatform({ operatingSystem });
      expect(result.ok, operatingSystem).toBe(true);
      if (!result.ok) continue;
      expect(result.platform, operatingSystem).toBe(expected);
      expect(result.source).toBe('derived');
    }
  });

  it('never lets a stale display string override an explicit claim', () => {
    const result = resolveAgentPlatform({ reported: 'android', operatingSystem: 'Windows' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.platform).toBe('android');
    expect(result.source).toBe('reported');
  });

  it('falls back to Windows only when nothing was reported at all', () => {
    // The shipped Windows agent sends neither field. This keeps it registering
    // exactly as it did before platforms were modelled, and matches the database
    // defaults for both columns.
    const result = resolveAgentPlatform({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.platform).toBe('windows');
    expect(result.source).toBe('legacy-default');

    const explicitNulls = resolveAgentPlatform({ reported: null, operatingSystem: null });
    expect(explicitNulls.ok).toBe(true);
    if (!explicitNulls.ok) return;
    expect(explicitNulls.source).toBe('legacy-default');
  });

  it('does not use the legacy fallback when a display string was derivable', () => {
    const result = resolveAgentPlatform({ operatingSystem: 'Android 14' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).not.toBe('legacy-default');
  });

  it('distinguishes the three sources so callers can warn about a guess', () => {
    const sources = [
      resolveAgentPlatform({ reported: 'linux' }),
      resolveAgentPlatform({ operatingSystem: 'Android 14' }),
      resolveAgentPlatform({}),
    ].map((r) => (r.ok ? r.source : null));
    expect(sources).toEqual(['reported', 'derived', 'legacy-default']);
  });
});

describe('defaultNodeIdentity', () => {
  it('keeps the pre-existing Windows values byte for byte', () => {
    // Changing these would rename nodes registered by the current agent.
    expect(defaultNodeIdentity('windows')).toEqual({ name: 'Windows Node', operatingSystem: 'Windows' });
  });

  it('gives each platform its own name and label', () => {
    expect(defaultNodeIdentity('android')).toEqual({ name: 'Android Device', operatingSystem: 'Android' });
    expect(defaultNodeIdentity('linux')).toEqual({ name: 'Linux Node', operatingSystem: 'Linux' });
    expect(defaultNodeIdentity('macos')).toEqual({ name: 'Mac Node', operatingSystem: 'macOS' });
  });

  it('produces distinct names, so two devices do not look identical in the list', () => {
    const names = PLATFORMS.map((p) => defaultNodeIdentity(p).name);
    expect(new Set(names).size).toBe(PLATFORMS.length);
  });

  it('produces names that satisfy the name rule used elsewhere in the product', () => {
    for (const platform of PLATFORMS) {
      const { name, operatingSystem } = defaultNodeIdentity(platform);
      expect(name, platform).toMatch(NAME_RULE);
      expect(operatingSystem.length, platform).toBeGreaterThan(0);
      expect(operatingSystem.length, platform).toBeLessThanOrEqual(64);
    }
  });

  it('never labels a non-Windows device as Windows', () => {
    for (const platform of PLATFORMS.filter((p) => p !== 'windows')) {
      const identity = defaultNodeIdentity(platform);
      expect(identity.name.toLowerCase()).not.toContain('windows');
      expect(identity.operatingSystem.toLowerCase()).not.toContain('windows');
    }
  });
});
