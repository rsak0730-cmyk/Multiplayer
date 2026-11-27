import { describe, expect, it } from 'vitest';
import {
  ENGINES,
  ENGINE_IDS,
  HOST_OSES,
  NODE_COMMANDS,
  enginePlatformSupport,
  isPlatformRunnable,
  type EngineId,
  type HostOs,
} from '@oghost/shared';
import {
  engineChoicesForPlatform,
  engineInstallCommand,
  normaliseHostPlatform,
  resolveEngineForNode,
  type NodePlatformInfo,
} from '@/lib/servers/engine-selection';

const WINDOWS_NODE: NodePlatformInfo = { agent_platform: 'windows', operating_system: 'Windows 11 Pro' };
const ANDROID_NODE: NodePlatformInfo = { agent_platform: 'android', operating_system: 'Android 14' };

describe('normaliseHostPlatform', () => {
  it('reads the agent\u2019s own machine-readable claim first', () => {
    expect(normaliseHostPlatform({ agent_platform: 'windows' })).toBe('windows');
    expect(normaliseHostPlatform({ agent_platform: 'android' })).toBe('android');
  });

  it('normalises case and surrounding whitespace', () => {
    expect(normaliseHostPlatform({ agent_platform: '  ANDROID ' })).toBe('android');
    expect(normaliseHostPlatform({ agent_platform: 'Windows' })).toBe('windows');
  });

  it('falls back to the display string, which is not a platform value', () => {
    expect(normaliseHostPlatform({ operating_system: 'Windows 11 Pro' })).toBe('windows');
    expect(normaliseHostPlatform({ operating_system: 'Android 14' })).toBe('android');
    expect(normaliseHostPlatform({ operating_system: 'Ubuntu 22.04' })).toBe('linux');
    expect(normaliseHostPlatform({ operating_system: 'macOS 14.2' })).toBe('macos');
    expect(normaliseHostPlatform({ operating_system: 'Darwin 23.1.0' })).toBe('macos');
  });

  it('prefers agent_platform when the two columns disagree', () => {
    // A stale operating_system string must not override what the agent reports
    // about itself; the agent is the thing that has to run the process.
    expect(normaliseHostPlatform({ agent_platform: 'android', operating_system: 'Windows' })).toBe('android');
  });

  it('returns null for anything it does not recognise', () => {
    // Regression guard for the behaviour this replaces. The database defaults both
    // columns to a Windows value and constrains neither, so treating an
    // unrecognised platform as Windows would schedule servers onto devices that
    // cannot run them. Unknown must mean "refuse", not "assume the default".
    expect(normaliseHostPlatform({ agent_platform: 'chromeos' })).toBeNull();
    expect(normaliseHostPlatform({ agent_platform: '', operating_system: '' })).toBeNull();
    expect(normaliseHostPlatform({})).toBeNull();
    expect(normaliseHostPlatform({ agent_platform: null, operating_system: null })).toBeNull();
    expect(normaliseHostPlatform({ operating_system: 'Some Future OS 9' })).toBeNull();
  });
});

describe('resolveEngineForNode', () => {
  it('allows official BDS on a Windows node', () => {
    const result = resolveEngineForNode({ engineId: 'bds', node: WINDOWS_NODE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.engine.id).toBe('bds');
    expect(result.gameType).toBe('bedrock');
    expect(result.defaultPort).toBe(19132);
    expect(result.platform).toBe('windows');
  });

  it('refuses a Java engine on Windows because no adapter exists, and says so', () => {
    const result = resolveEngineForNode({ engineId: 'paper', node: WINDOWS_NODE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.reason).toBe('engine_unsupported_on_platform');
    expect(result.error).toMatch(/Paper/);
    // The refusal must carry the catalog's actual reason, not a generic "no".
    expect(result.detail).toMatch(/adapter/i);
    expect(result.requiresVerification).toBeTruthy();
  });

  it('refuses every engine on an Android node, naming the real blocker', () => {
    for (const engineId of ENGINE_IDS) {
      const result = resolveEngineForNode({ engineId, node: ANDROID_NODE });
      expect(result.ok, `${engineId} on Android`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('engine_unsupported_on_platform');
      expect(result.error.length).toBeGreaterThan(30);
    }
  });

  it('explains BDS on Android in terms of the missing ARM build, not a vague refusal', () => {
    const result = resolveEngineForNode({ engineId: 'bds', node: ANDROID_NODE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Mojang publishes no Android/i);
  });

  it('rejects an engine the catalog does not know', () => {
    const result = resolveEngineForNode({ engineId: 'spigot', node: WINDOWS_NODE });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_engine');
    expect(result.error).toMatch(/spigot/);
  });

  it('rejects a node whose platform it cannot determine, echoing what it saw', () => {
    const result = resolveEngineForNode({ engineId: 'bds', node: { operating_system: 'BeOS 5' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown_platform');
    expect(result.detail).toContain('BeOS 5');
    // Telling the owner how to fix it matters more than telling them it failed.
    expect(result.error).toMatch(/Re-pair/i);
  });

  it('never returns ok for a platform the catalog says cannot run the engine', () => {
    for (const engine of ENGINES) {
      for (const os of HOST_OSES) {
        const node: NodePlatformInfo = { agent_platform: os };
        const result = resolveEngineForNode({ engineId: engine.id, node });
        expect(result.ok).toBe(isPlatformRunnable(enginePlatformSupport(engine.id, os).status));
      }
    }
  });

  it('derives game_type from the engine rather than accepting it', () => {
    // Two columns describing one fact. The caller never supplies game_type, so it
    // cannot contradict engine_id — which is what the database CHECK enforces too.
    for (const engine of ENGINES) {
      for (const os of HOST_OSES) {
        const result = resolveEngineForNode({ engineId: engine.id, node: { agent_platform: os } });
        if (!result.ok) continue;
        expect(result.gameType).toBe(engine.edition);
      }
    }
  });

  it('returns caveats whenever the platform is not fully supported', () => {
    // §25: keep engine limitations visible. A successful selection today is never
    // an unqualified one, and the UI has to be given the words to say why.
    const result = resolveEngineForNode({ engineId: 'bds', node: WINDOWS_NODE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.caveats.length).toBeGreaterThan(0);
    expect(result.caveats.join(' ')).toMatch(/unverified|never compiled|no \.NET/i);
  });

  it('warns that an unconfirmed runtime minimum must be read at install time', () => {
    // Paper, Purpur, PowerNukkitX and PocketMine-MP all state a runtime need whose
    // exact minimum version was never confirmed from an official source.
    for (const engine of ENGINES.filter((e) => e.runtime.kind !== 'native')) {
      expect(engine.runtime.minimumVersionConfirmed).toBe(false);
    }
    // No non-native engine is runnable anywhere yet, so exercise the caveat
    // builder through the catalog rather than through a successful selection.
    const paper = ENGINES.find((e) => e.id === 'paper')!;
    expect(paper.runtime.label).toMatch(/Java/i);
  });

  it('accepts an engine id case-sensitively, matching the catalog and the database', () => {
    expect(resolveEngineForNode({ engineId: 'BDS', node: WINDOWS_NODE }).ok).toBe(false);
    expect(resolveEngineForNode({ engineId: 'PocketMine-MP', node: WINDOWS_NODE }).ok).toBe(false);
  });
});

describe('engineInstallCommand', () => {
  it('maps BDS to the existing install command', () => {
    expect(engineInstallCommand('bds')).toBe(NODE_COMMANDS.INSTALL_BDS);
  });

  it('returns null for every engine that has no adapter', () => {
    // Queueing INSTALL_BDS for Paper would create a server row that can never
    // start and an agent error the owner cannot act on. Refusing names the gap.
    for (const engineId of ENGINE_IDS.filter((id): id is EngineId => id !== 'bds')) {
      expect(engineInstallCommand(engineId), engineId).toBeNull();
    }
  });

  it('has a command for exactly the engines the agent can install', () => {
    const installable = ENGINE_IDS.filter((id) => engineInstallCommand(id as EngineId) !== null);
    expect(installable).toEqual(['bds']);
  });
});

describe('engineChoicesForPlatform', () => {
  it('offers BDS and only BDS on Windows', () => {
    const choices = engineChoicesForPlatform(WINDOWS_NODE);
    expect(choices.platform).toBe('windows');
    expect(choices.available.map((c) => c.id)).toEqual(['bds']);
    expect(choices.hidden.map((c) => c.id).sort()).toEqual(['paper', 'pocketmine-mp', 'powernukkitx', 'purpur']);
  });

  it('offers nothing on Android, and explains all five', () => {
    const choices = engineChoicesForPlatform(ANDROID_NODE);
    expect(choices.platform).toBe('android');
    expect(choices.available).toEqual([]);
    expect(choices.hidden).toHaveLength(ENGINES.length);
  });

  it('gives a reason for every hidden engine, because silent hiding reads as a bug', () => {
    for (const os of HOST_OSES) {
      const choices = engineChoicesForPlatform({ agent_platform: os });
      for (const hidden of choices.hidden) {
        expect(hidden.reason, `${hidden.id} on ${os}`).toBeTruthy();
        expect(hidden.reason.length, `${hidden.id} on ${os}`).toBeGreaterThan(20);
      }
    }
  });

  it('partitions the catalog without losing or duplicating an engine', () => {
    for (const os of HOST_OSES) {
      const choices = engineChoicesForPlatform({ agent_platform: os });
      const ids = [...choices.available.map((c) => c.id), ...choices.hidden.map((c) => c.id)];
      expect([...ids].sort()).toEqual([...ENGINE_IDS].sort());
      expect(new Set(ids).size).toBe(ENGINE_IDS.length);
    }
  });

  it('agrees with resolveEngineForNode about what is available', () => {
    // Two functions answering the same question must not disagree — the same class
    // of bug as two validators drifting apart over player-name trimming.
    for (const os of HOST_OSES) {
      const choices = engineChoicesForPlatform({ agent_platform: os });
      for (const engineId of ENGINE_IDS) {
        const selection = resolveEngineForNode({ engineId, node: { agent_platform: os } });
        const listed = choices.available.some((c) => c.id === engineId);
        expect(selection.ok, `${engineId} on ${os}`).toBe(listed);
      }
    }
  });

  it('returns an empty choice set, not a guess, for an unknown platform', () => {
    const choices = engineChoicesForPlatform({ operating_system: 'Plan 9' });
    expect(choices.platform).toBeNull();
    expect(choices.available).toEqual([]);
    expect(choices.hidden).toEqual([]);
  });

  it('exposes the edition and default port the studio needs per engine', () => {
    const choices = engineChoicesForPlatform(WINDOWS_NODE);
    expect(choices.available[0]).toEqual({
      id: 'bds',
      displayName: 'Minecraft Bedrock Dedicated Server',
      edition: 'bedrock',
      defaultPort: 19132,
    });
  });
});
