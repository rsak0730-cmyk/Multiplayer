import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ENGINES,
  ENGINE_IDS,
  ENGINE_ID_VALUES,
  HOST_OSES,
  NODE_SCORE_WEIGHTS,
  canInstallPackage,
  canUseWorldFormat,
  engineById,
  enginePlatformSupport,
  enginesByEdition,
  enginesForPlatform,
  isEngineId,
  isPlatformRunnable,
  recommendNodes,
  supportStatusLabel,
  type NodeSnapshot,
  type PackageKind,
} from '../src/engines';

const ALL_PACKAGE_KINDS: PackageKind[] = [
  'behavior-pack',
  'resource-pack',
  'java-plugin',
  'pocketmine-plugin',
  'powernukkitx-plugin',
];

function node(overrides: Partial<NodeSnapshot> = {}): NodeSnapshot {
  return {
    id: 'node-1',
    name: 'Desktop',
    operatingSystem: 'windows',
    online: true,
    ramAvailableMb: 8192,
    storageAvailableMb: 100_000,
    cpuPercent: 10,
    activeServers: 0,
    ...overrides,
  };
}

describe('catalog shape', () => {
  it('contains exactly the five engines the platform requires', () => {
    expect(ENGINE_IDS).toEqual(['bds', 'powernukkitx', 'pocketmine-mp', 'paper', 'purpur']);
    expect(ENGINES).toHaveLength(5);
  });

  it('gives every engine a unique id and display name', () => {
    expect(new Set(ENGINES.map((e) => e.id)).size).toBe(ENGINES.length);
    expect(new Set(ENGINES.map((e) => e.displayName)).size).toBe(ENGINES.length);
  });

  it('derives the EngineId type from the same tuple validators use', () => {
    // One declaration for both, so a runtime list (zod enum, SQL mirror, UI
    // dropdown) cannot drift from the compile-time union.
    expect([...ENGINE_ID_VALUES].sort()).toEqual([...ENGINE_IDS].sort());
    expect(ENGINE_ID_VALUES).toHaveLength(ENGINES.length);
    for (const engine of ENGINES) {
      expect(ENGINE_ID_VALUES, engine.id).toContain(engine.id);
    }
  });

  it('looks engines up by id and rejects unknown ones', () => {
    for (const id of ENGINE_IDS) expect(engineById(id)?.id).toBe(id);
    expect(engineById('spigot')).toBeNull();
    expect(isEngineId('paper')).toBe(true);
    expect(isEngineId('spigot')).toBe(false);
  });

  it('declares a platform entry for every host OS', () => {
    for (const engine of ENGINES) {
      for (const os of HOST_OSES) {
        expect(engine.platforms[os], `${engine.id} is missing a ${os} entry`).toBeDefined();
      }
    }
  });

  it('uses an https trusted source for every engine', () => {
    for (const engine of ENGINES) {
      expect(engine.sourceUrl.startsWith('https://'), `${engine.id} source must be https`).toBe(true);
      expect(engine.publisher.length).toBeGreaterThan(0);
    }
  });
});

describe('official status is never overstated', () => {
  it('marks exactly one engine official, and it is the Mojang one', () => {
    // §25: do not pretend PowerNukkitX is official BDS.
    const official = ENGINES.filter((engine) => engine.official);
    expect(official).toHaveLength(1);
    expect(official[0].id).toBe('bds');
    expect(official[0].publisher).toBe('Mojang Studios');
  });

  it('never calls a third-party engine official in its display name', () => {
    for (const engine of ENGINES.filter((e) => !e.official)) {
      expect(engine.displayName.toLowerCase()).not.toContain('official');
      expect(engine.knownLimitations.join(' ').toLowerCase()).not.toContain('is the official');
    }
  });

  it('records the not-official fact in the limitations of every Bedrock-protocol fork', () => {
    for (const id of ['powernukkitx', 'pocketmine-mp'] as const) {
      const engine = engineById(id)!;
      expect(engine.edition).toBe('bedrock');
      expect(engine.official).toBe(false);
      expect(
        engine.knownLimitations.some((limitation) => /not the official|NOT the official/i.test(limitation)),
        `${id} must state it is not the official server`,
      ).toBe(true);
    }
  });
});

describe('edition, runtime and port consistency', () => {
  it.each([
    ['bds', 'bedrock', 'native', 19132, 'udp'],
    ['powernukkitx', 'bedrock', 'jvm', 19132, 'udp'],
    ['pocketmine-mp', 'bedrock', 'php', 19132, 'udp'],
    ['paper', 'java', 'jvm', 25565, 'tcp'],
    ['purpur', 'java', 'jvm', 25565, 'tcp'],
  ] as const)('%s is %s edition on %s runtime, port %d/%s', (id, edition, runtime, port, protocol) => {
    const engine = engineById(id)!;
    expect(engine.edition).toBe(edition);
    expect(engine.runtime.kind).toBe(runtime);
    expect(engine.defaultPort).toBe(port);
    expect(engine.defaultPortProtocol).toBe(protocol);
  });

  it('never hardcodes a runtime minimum it did not confirm from an official source', () => {
    // A wrong Java version means the server fails to start with a confusing error.
    // Where the minimum was not read from an authoritative source it must be null
    // and resolved from release metadata at install time instead.
    for (const engine of ENGINES) {
      if (!engine.runtime.minimumVersionConfirmed) {
        expect(engine.runtime.resolvedFrom, `${engine.id} must resolve its runtime version from release metadata`).toBe(
          'release-metadata',
        );
      }
      if (engine.runtime.minimumMajorVersion !== null && !engine.runtime.minimumVersionConfirmed) {
        throw new Error(
          `${engine.id} states a concrete runtime minimum without confirming it. Either confirm it or set it to null.`,
        );
      }
    }
  });

  it('groups engines by edition', () => {
    expect(enginesByEdition('java').map((e) => e.id).sort()).toEqual(['paper', 'purpur']);
    expect(enginesByEdition('bedrock').map((e) => e.id).sort()).toEqual(['bds', 'pocketmine-mp', 'powernukkitx']);
  });

  it('uses the matching console dialect for the edition', () => {
    // §8: never send one engine's commands to another. The dialect is what routes
    // a command to the right allowlist.
    expect(engineById('bds')!.consoleDialect).toBe('bedrock');
    for (const id of ['paper', 'purpur'] as const) {
      expect(engineById(id)!.consoleDialect).toBe('java');
    }
  });

  it('gives PocketMine-MP its own dialect rather than borrowing one', () => {
    // PocketMine-MP speaks the Bedrock protocol but reimplements the server in PHP.
    // Labelling it 'bedrock' would feed it the 68-entry BDS allowlist and labelling
    // it 'java' would feed it Bukkit commands; both fail at runtime, and a console
    // that rejects everything reads as a broken product rather than a wrong label.
    const dialect = engineById('pocketmine-mp')!.consoleDialect;
    expect(dialect).toBe('pocketmine');
    expect(dialect).not.toBe(engineById('bds')!.consoleDialect);
    expect(dialect).not.toBe(engineById('paper')!.consoleDialect);
  });

  it('shares a dialect only between engines that really share a command grammar', () => {
    // Purpur forks Paper and PowerNukkitX is of the Nukkit lineage, so all three
    // expose a Bukkit-derived console. BDS and PocketMine-MP each stand alone.
    const groups = new Map<string, string[]>();
    for (const engine of ENGINES) {
      groups.set(engine.consoleDialect, [...(groups.get(engine.consoleDialect) ?? []), engine.id]);
    }
    expect(groups.get('java')!.sort()).toEqual(['paper', 'powernukkitx', 'purpur']);
    expect(groups.get('bedrock')).toEqual(['bds']);
    expect(groups.get('pocketmine')).toEqual(['pocketmine-mp']);
  });

  it('treats every dialect as unverified until an engine has actually been driven', () => {
    // A shared dialect must not become a shared allowlist by accident. Sharing the
    // Bukkit grammar with Paper does not make Paper's command set valid on
    // PowerNukkitX or Purpur; each needs its own verified allowlist.
    for (const engine of ENGINES) {
      expect(engine.consoleDialectConfirmed, `${engine.id} claims a verified console it has never run`).toBe(false);
    }
  });

  it('never reuses the BDS dialect for an engine that reimplements the protocol', () => {
    // The 68-entry BDS allowlist is the one that exists today. Applying it to a
    // fork would be the single most likely way to ship a console that looks broken.
    const bdsDialect = engineById('bds')!.consoleDialect;
    for (const engine of ENGINES.filter((e) => e.id !== 'bds' && e.edition === 'bedrock')) {
      expect(engine.consoleDialect, engine.id).not.toBe(bdsDialect);
    }
  });

  it('does not let a Bedrock-protocol fork claim the BDS command grammar', () => {
    expect(engineById('powernukkitx')!.consoleDialect).not.toBe('bedrock');
    expect(engineById('pocketmine-mp')!.consoleDialect).not.toBe('bedrock');
  });
});

describe('the Android answer', () => {
  it('offers NO runnable engine on Android', () => {
    // This is the headline limitation and it must stay true until someone tests
    // it on a device. If a future change makes an engine runnable on Android,
    // this test fails and forces the claim to be justified explicitly.
    expect(enginesForPlatform('android')).toEqual([]);
  });

  it('never marks Android supported, experimental or unverified for any engine', () => {
    for (const engine of ENGINES) {
      const android = engine.platforms.android;
      expect(isPlatformRunnable(android.status), `${engine.id} must not claim Android support`).toBe(false);
      expect(android.status).toBe('unsupported');
    }
  });

  it('explains why Android is unsupported, for every engine', () => {
    for (const engine of ENGINES) {
      const android = engine.platforms.android;
      expect(android.reason, `${engine.id} must explain the Android limitation`).toBeTruthy();
      expect(android.reason!.length).toBeGreaterThan(40);
    }
  });

  it('names the official BDS Android problem specifically: no ARM or Android build exists', () => {
    const bds = engineById('bds')!.platforms.android;
    expect(bds.reason).toMatch(/no Android/i);
    expect(bds.reason).toMatch(/x86_64|ARM/i);
    expect(bds.requiresVerification).toMatch(/official ARM\/Android build from Mojang/);
  });

  it('says what would have to be verified before Android could be claimed', () => {
    for (const engine of ENGINES) {
      expect(
        engine.platforms.android.requiresVerification,
        `${engine.id} must state what verification Android needs`,
      ).toBeTruthy();
    }
  });

  it('does not advertise macOS, where Mojang discontinued the Bedrock server', () => {
    expect(isPlatformRunnable(engineById('bds')!.platforms.macos.status)).toBe(false);
  });
});

describe('support status honesty', () => {
  it('requires a reason for every status below supported', () => {
    for (const engine of ENGINES) {
      for (const os of HOST_OSES) {
        const support = engine.platforms[os];
        if (support.status === 'supported') continue;
        expect(support.reason, `${engine.id}/${os} is "${support.status}" with no reason`).toBeTruthy();
      }
    }
  });

  it('claims nothing is fully supported anywhere yet', () => {
    // The multi-engine work has not been built or run. If this fails, a status was
    // raised without the verification that justifies it.
    for (const engine of ENGINES) {
      for (const os of HOST_OSES) {
        expect(engine.platforms[os].status, `${engine.id}/${os}`).not.toBe('supported');
      }
    }
  });

  it('keeps BDS on Windows at unverified, matching the repository\u2019s own audit', () => {
    // The Windows agent implements BDS completely but has never been compiled
    // here, so "implemented" must not be reported as "supported".
    const windows = engineById('bds')!.platforms.windows;
    expect(windows.status).toBe('unverified');
    expect(windows.reason).toMatch(/never compiled|no \.NET/i);
  });

  it('labels every other engine not-implemented', () => {
    for (const engine of ENGINES.filter((e) => e.id !== 'bds')) {
      expect(engine.platforms.windows.status).toBe('not-implemented');
    }
  });

  it('returns a usable answer for unknown engines and platforms', () => {
    expect(enginePlatformSupport('spigot', 'windows').status).toBe('unsupported');
    expect(enginePlatformSupport('bds', 'chromeos').status).toBe('unsupported');
    expect(enginePlatformSupport('bds', 'chromeos').reason).toContain('chromeos');
  });

  it('words every status label so none can be read as working when it does not', () => {
    expect(supportStatusLabel('supported')).toBe('Supported');
    expect(supportStatusLabel('unverified')).toContain('never run');
    expect(supportStatusLabel('not-implemented')).toContain('Not implemented');
    expect(supportStatusLabel('unsupported')).toContain('Unsupported');
    expect(supportStatusLabel('experimental')).toContain('not fully verified');
  });

  it('only lists engines a platform can actually run', () => {
    expect(enginesForPlatform('windows').map((e) => e.id)).toEqual(['bds']);
    expect(enginesForPlatform('linux')).toEqual([]);
    expect(enginesForPlatform('macos')).toEqual([]);
  });
});

describe('packages are never interchangeable across editions', () => {
  it('lets each engine accept only its own package kinds', () => {
    expect(engineById('bds')!.acceptedPackages).toEqual(['behavior-pack', 'resource-pack']);
    expect(engineById('paper')!.acceptedPackages).toEqual(['java-plugin']);
    expect(engineById('purpur')!.acceptedPackages).toEqual(['java-plugin']);
    expect(engineById('pocketmine-mp')!.acceptedPackages).toEqual(['pocketmine-plugin']);
    expect(engineById('powernukkitx')!.acceptedPackages).toEqual(['powernukkitx-plugin']);
  });

  it('REFUSES a Java plugin on every Bedrock engine', () => {
    for (const id of ['bds', 'powernukkitx', 'pocketmine-mp'] as const) {
      const result = canInstallPackage(id, 'java-plugin');
      expect(result.allowed, `${id} must refuse a Java plugin`).toBe(false);
      expect(result.reason).toMatch(/not interchangeable/);
    }
  });

  it('REFUSES a Bedrock add-on on every Java engine', () => {
    for (const id of ['paper', 'purpur'] as const) {
      for (const kind of ['behavior-pack', 'resource-pack'] as const) {
        const result = canInstallPackage(id, kind);
        expect(result.allowed, `${id} must refuse ${kind}`).toBe(false);
        expect(result.reason).toMatch(/not interchangeable/);
      }
    }
  });

  it('refuses one fork\u2019s plugins in another fork', () => {
    // PowerNukkitX and PocketMine-MP are both Bedrock-protocol but their plugin
    // APIs are unrelated. Compatibility must be evidenced, never assumed.
    expect(canInstallPackage('pocketmine-mp', 'powernukkitx-plugin').allowed).toBe(false);
    expect(canInstallPackage('powernukkitx', 'pocketmine-plugin').allowed).toBe(false);
    expect(canInstallPackage('bds', 'pocketmine-plugin').allowed).toBe(false);
  });

  it('accepts only what is declared, for every engine and kind', () => {
    for (const engine of ENGINES) {
      for (const kind of ALL_PACKAGE_KINDS) {
        expect(canInstallPackage(engine.id, kind).allowed).toBe(engine.acceptedPackages.includes(kind));
      }
    }
  });

  it('always returns a reason, because a bare refusal is not actionable', () => {
    for (const engine of ENGINES) {
      for (const kind of ALL_PACKAGE_KINDS) {
        expect(canInstallPackage(engine.id, kind).reason.length).toBeGreaterThan(10);
      }
    }
    expect(canInstallPackage('spigot', 'java-plugin').allowed).toBe(false);
  });
});

describe('world formats are never assumed interchangeable', () => {
  it('keeps Bedrock LevelDB and Java Anvil separate', () => {
    expect(canUseWorldFormat('bds', 'java-anvil').allowed).toBe(false);
    expect(canUseWorldFormat('paper', 'bedrock-leveldb').allowed).toBe(false);
    expect(canUseWorldFormat('purpur', 'bedrock-leveldb').allowed).toBe(false);
    expect(canUseWorldFormat('bds', 'bedrock-leveldb').allowed).toBe(true);
    expect(canUseWorldFormat('paper', 'java-anvil').allowed).toBe(true);
  });

  it('never lets a Java engine claim a Bedrock world format', () => {
    for (const engine of ENGINES.filter((e) => e.edition === 'java')) {
      expect(engine.worldFormats).not.toContain('bedrock-leveldb');
      expect(engine.worldFormats.every((f) => f === 'java-anvil')).toBe(true);
    }
  });

  it('refuses to answer for an engine whose formats are unconfirmed', () => {
    // PowerNukkitX's world support was not confirmed from an authoritative source,
    // so the honest answer is "inspect it", not "yes".
    const pnx = engineById('powernukkitx')!;
    expect(pnx.worldFormats).toEqual([]);
    expect(pnx.worldFormatsConfirmed).toBe(false);
    const result = canUseWorldFormat('powernukkitx', 'bedrock-leveldb');
    expect(result.allowed).toBe(false);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/inspected|no confirmed world format/i);
  });

  it('warns when a format is documented but was never confirmed by running the engine', () => {
    const result = canUseWorldFormat('bds', 'bedrock-leveldb');
    expect(result.allowed).toBe(true);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/not been confirmed|verify with a backup/i);
  });

  it('mentions data loss when refusing a cross-format world', () => {
    // §25: do not claim all worlds can be converted without data loss.
    expect(canUseWorldFormat('paper', 'bedrock-leveldb').reason).toMatch(/may lose data|conversion/i);
  });
});

describe('download integrity', () => {
  it('records which publishers provide a verifiable checksum', () => {
    // Only Paper could be pointed at a documented checksum endpoint. Purpur was
    // downgraded to false because its API could not be reached to confirm one, and
    // asserting a checksum that does not exist would let the engine manager skip
    // integrity verification entirely.
    expect(engineById('paper')!.hashPublished).toBe(true);
    expect(engineById('purpur')!.hashPublished).toBe(false);
    expect(engineById('bds')!.hashPublished).toBe(false);
    expect(engineById('powernukkitx')!.hashPublished).toBe(false);
    expect(engineById('pocketmine-mp')!.hashPublished).toBe(false);
  });

  it('names where the checksum comes from whenever it claims one exists', () => {
    // A claim without a source is unfalsifiable. This makes hashPublished testable
    // at implementation time rather than decorative.
    for (const engine of ENGINES.filter((e) => e.hashPublished)) {
      expect(engine.hashSource, `${engine.id} claims a published checksum but names no source`).toBeTruthy();
      expect(engine.hashSource!.startsWith('https://')).toBe(true);
      expect(engine.hashSource!.startsWith(engine.sourceUrl.split('/v2/')[0])).toBe(true);
    }
    for (const engine of ENGINES.filter((e) => !e.hashPublished)) {
      expect(engine.hashSource, `${engine.id} publishes no checksum so must not name a source`).toBeUndefined();
    }
  });

  it('discloses the missing-checksum risk in the engine limitations', () => {
    // §5: do not execute arbitrary downloaded files without validation. Where no
    // checksum exists, that weakness must be visible rather than glossed over.
    for (const engine of ENGINES.filter((e) => !e.hashPublished)) {
      expect(
        engine.knownLimitations.some((l) => /checksum|hash|integrity/i.test(l)),
        `${engine.id} publishes no checksum and must say so`,
      ).toBe(true);
    }
  });

  it('lists at least one limitation for every engine', () => {
    for (const engine of ENGINES) {
      expect(engine.knownLimitations.length, `${engine.id} must document limitations`).toBeGreaterThan(0);
    }
  });
});

describe('OG VOICE compatibility is per engine, never inherited', () => {
  it('claims no engine has a verified voice integration', () => {
    for (const engine of ENGINES) {
      expect(engine.voiceIntegration.status, engine.id).not.toBe('supported');
      expect(engine.voiceIntegration.status).not.toBe('experimental');
    }
  });

  it('keeps BDS separate from the forks, because a behavior pack is not portable', () => {
    // §18: do not assume the Bedrock behavior pack works with PowerNukkitX or
    // PocketMine-MP. Each needs its own check for identity, position, dimension.
    expect(engineById('bds')!.voiceIntegration.status).toBe('unverified');
    for (const id of ['powernukkitx', 'pocketmine-mp', 'paper', 'purpur'] as const) {
      expect(engineById(id)!.voiceIntegration.status).toBe('not-implemented');
      expect(engineById(id)!.voiceIntegration.reason).toMatch(/must not be assumed|does not exist|cannot be assumed/i);
    }
  });

  it('records the experimental Bedrock scripting APIs as experimental', () => {
    const bds = engineById('bds')!.voiceIntegration;
    expect(bds.reason).toMatch(/beta|experimental/i);
    expect(bds.reason).toMatch(/Realms/i);
  });

  it('gives every engine a reason and a verification path', () => {
    for (const engine of ENGINES) {
      expect(engine.voiceIntegration.reason).toBeTruthy();
      expect(engine.voiceIntegration.requiresVerification).toBeTruthy();
    }
  });
});

describe('recommendNodes — §11 smart scheduler', () => {
  it('ranks an eligible node above an ineligible one', () => {
    const results = recommendNodes({
      nodes: [node({ id: 'offline', name: 'Offline PC', online: false }), node({ id: 'ok', name: 'Ready PC' })],
      engineId: 'bds',
    });
    expect(results[0].nodeId).toBe('ok');
    expect(results[0].eligible).toBe(true);
    expect(results[1].eligible).toBe(false);
    expect(results[1].score).toBe(0);
  });

  it('names the missing requirement when nothing is compatible', () => {
    const results = recommendNodes({
      nodes: [node({ id: 'phone', name: 'Pixel', operatingSystem: 'android', batteryPercent: 80 })],
      engineId: 'bds',
    });
    expect(results).toHaveLength(1);
    expect(results[0].eligible).toBe(false);
    expect(results[0].reasons.join(' ')).toMatch(/unsupported/i);
    expect(results[0].reasons.join(' ')).toMatch(/Android|android/i);
  });

  it('rejects every engine on an Android node, and says why', () => {
    for (const engineId of ENGINE_IDS) {
      const [result] = recommendNodes({
        nodes: [node({ operatingSystem: 'android', name: 'Phone' })],
        engineId,
      });
      expect(result.eligible, `${engineId} on Android`).toBe(false);
      expect(result.reasons.join(' ').length).toBeGreaterThan(20);
    }
  });

  it('refuses a node with insufficient memory and states the gap', () => {
    const [result] = recommendNodes({
      nodes: [node({ ramAvailableMb: 512 })],
      engineId: 'paper',
      requestedRamMb: 4096,
    });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/4096 MB/);
    expect(result.reasons.join(' ')).toMatch(/512 MB/);
  });

  it('refuses a node with insufficient storage and states the gap', () => {
    const [result] = recommendNodes({ nodes: [node({ storageAvailableMb: 100 })], engineId: 'bds' });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/storage/i);
  });

  it('never pools resources across devices to reach a requirement', () => {
    // §25: resources must not be combined across machines. Two nodes with 3 GB
    // free each must NOT satisfy a 4 GB request between them.
    const results = recommendNodes({
      nodes: [
        node({ id: 'a', name: 'A', ramAvailableMb: 3072 }),
        node({ id: 'b', name: 'B', ramAvailableMb: 3072 }),
      ],
      engineId: 'bds',
      requestedRamMb: 4096,
    });
    expect(results.every((r) => !r.eligible)).toBe(true);
    expect(results).toHaveLength(2);
  });

  it('uses the engine minimum when the caller asks for less', () => {
    // A request for 256 MB on Paper must still be judged against Paper's own
    // minimum, or a server would be scheduled onto a node that cannot start it.
    const [result] = recommendNodes({
      nodes: [node({ ramAvailableMb: 1024 })],
      engineId: 'paper',
      requestedRamMb: 256,
    });
    expect(result.eligible).toBe(false);
  });

  it('refuses to assess a node that has not reported its resources', () => {
    // Guessing would be inventing a performance number, which §16 forbids.
    const [result] = recommendNodes({ nodes: [node({ ramAvailableMb: null })], engineId: 'bds' });
    expect(result.eligible).toBe(false);
    expect(result.reasons.join(' ')).toMatch(/has not reported/i);
  });

  it('prefers a node with more headroom', () => {
    const results = recommendNodes({
      nodes: [
        node({ id: 'small', name: 'Small', ramAvailableMb: 2048, storageAvailableMb: 5000, cpuPercent: 80 }),
        node({ id: 'big', name: 'Big', ramAvailableMb: 16384, storageAvailableMb: 200000, cpuPercent: 5 }),
      ],
      engineId: 'bds',
    });
    expect(results[0].nodeId).toBe('big');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('warns about low battery without disqualifying a plugged-in device', () => {
    // Battery alone must not make a node ineligible: a device on a charger can sit
    // at 12% indefinitely and still host. But the risk has to be surfaced, because
    // Android throttles or kills work when the battery is low. Windows is used
    // here so the node is otherwise eligible and the battery warning is isolated
    // as the only caveat rather than being masked by a platform refusal.
    const [result] = recommendNodes({
      nodes: [node({ operatingSystem: 'windows', batteryPercent: 12 })],
      engineId: 'bds',
    });
    expect(result.eligible).toBe(true);
    expect(result.reasons.join(' ')).toMatch(/Battery is at 12%/);
    expect(result.reasons.join(' ')).toMatch(/may restrict or stop/i);
  });

  it('does not warn about battery on a healthy device', () => {
    const [result] = recommendNodes({ nodes: [node({ batteryPercent: 90 })], engineId: 'bds' });
    expect(result.eligible).toBe(true);
    expect(result.reasons.join(' ')).not.toMatch(/Battery/);
  });

  it('surfaces thermal throttling', () => {
    const [result] = recommendNodes({ nodes: [node({ throttling: true })], engineId: 'bds' });
    expect(result.reasons.join(' ')).toMatch(/thermal throttling/i);
  });

  it('does not penalise a desktop for having no battery', () => {
    const withBattery = recommendNodes({ nodes: [node({ batteryPercent: 100 })], engineId: 'bds' })[0];
    const without = recommendNodes({ nodes: [node({ batteryPercent: null })], engineId: 'bds' })[0];
    expect(without.score).toBe(withBattery.score);
  });

  it('orders ties by name so the list does not shuffle between renders', () => {
    const results = recommendNodes({
      nodes: [
        node({ id: '1', name: 'Zeta' }),
        node({ id: '2', name: 'Alpha' }),
        node({ id: '3', name: 'Mid' }),
      ],
      engineId: 'bds',
    });
    expect(results.every((r) => r.eligible)).toBe(true);
    expect(results.map((r) => r.nodeName)).toEqual(['Alpha', 'Mid', 'Zeta']);
  });

  it('handles an unknown engine without throwing', () => {
    const results = recommendNodes({ nodes: [node()], engineId: 'spigot' });
    expect(results).toHaveLength(1);
    expect(results[0].eligible).toBe(false);
    expect(results[0].reasons.join(' ')).toMatch(/Unknown engine/);
  });

  it('handles an empty node list', () => {
    expect(recommendNodes({ nodes: [], engineId: 'bds' })).toEqual([]);
  });

  it('exposes its weights so they can be measured rather than trusted', () => {
    // EXPERIMENTAL INITIAL VALUES. The test pins the shape so a change is a
    // deliberate, reviewable act rather than a silent retune.
    expect(Object.values(NODE_SCORE_WEIGHTS).reduce((sum, w) => sum + w, 0)).toBe(100);
    expect(NODE_SCORE_WEIGHTS.ramHeadroom).toBeGreaterThan(NODE_SCORE_WEIGHTS.storageHeadroom);
  });

  it('produces a bounded, non-negative score', () => {
    for (const engineId of ENGINE_IDS) {
      for (const candidate of [
        node(),
        node({ ramAvailableMb: 1024, storageAvailableMb: 4096, cpuPercent: 99, activeServers: 20, batteryPercent: 1 }),
      ]) {
        const [result] = recommendNodes({ nodes: [candidate], engineId });
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('catalog provenance', () => {
  it('records how each engine\u2019s facts were obtained', () => {
    const allowed = ['existing-implementation', 'upstream-documentation', 'assumed-needs-confirmation'];
    for (const engine of ENGINES) {
      expect(allowed, `${engine.id} provenance`).toContain(engine.provenance);
    }
  });

  it('never marks an unconfirmed catalog as verified', () => {
    for (const engine of ENGINES) {
      expect(engine.worldFormatsConfirmed, `${engine.id} world formats were never confirmed by running it`).toBe(false);
    }
  });

  it('requires anything not backed by an existing implementation to stay below supported', () => {
    // 'not-implemented' where the blocker is ours, 'unsupported' where the
    // blocker is the platform (Android, macOS). Neither may be raised without
    // the verification that justifies it.
    for (const engine of ENGINES.filter((e) => e.provenance !== 'existing-implementation')) {
      for (const os of HOST_OSES) {
        expect(['not-implemented', 'unsupported'], `${engine.id}/${os}`).toContain(engine.platforms[os].status);
        expect(isPlatformRunnable(engine.platforms[os].status)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The database must describe the same engines as the catalog.
//
// Migration 009 stores engine ids, editions and integrity rules as SQL CHECK
// constraints. Those are a second definition of facts that already live in
// engines.ts, and two definitions of one rule drift apart — that has already
// happened once in this codebase, when a zod schema and a validator disagreed
// about trimming player names. These tests make the SQL a mirror of the catalog,
// so adding an engine means changing one place and being told about the other.
// ---------------------------------------------------------------------------
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../supabase/migrations', import.meta.url));
const ENGINE_SQL = readFileSync(join(MIGRATIONS_DIR, '009_engine_model.sql'), 'utf8').replace(/^\s*--.*$/gm, '');

function statementsMatching(pattern: RegExp): string[] {
  return (ENGINE_SQL.match(/(?:alter|create)\s+(?:table|policy|index)[^;]+;/gis) ?? []).filter((s) =>
    pattern.test(s),
  );
}

function quotedValues(fragment: string): string[] {
  return [...fragment.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function engineIdCheckList(tableName: string): string[] {
  const match = new RegExp(
    `${tableName}[\\s\\S]*?engine_id\\s+text\\s+not\\s+null[^;]*?check\\s*\\(engine_id\\s+in\\s*\\(([^)]*)\\)\\)`,
    'i',
  ).exec(ENGINE_SQL);
  expect(match, `no engine_id CHECK found for ${tableName}`).toBeTruthy();
  return quotedValues(match![1]);
}

describe('migration 009 mirrors the engine catalog', () => {
  it('lists exactly the catalog engines on servers.engine_id', () => {
    const list = engineIdCheckList('servers');
    expect([...list].sort()).toEqual([...ENGINE_IDS].sort());
    expect(list).toHaveLength(ENGINE_IDS.length);
  });

  it('lists exactly the catalog engines on node_engines.engine_id', () => {
    expect([...engineIdCheckList('node_engines')].sort()).toEqual([...ENGINE_IDS].sort());
  });

  it('defaults servers.engine_id to bds so existing rows keep describing what they are', () => {
    const add = statementsMatching(/add\s+column\s+if\s+not\s+exists\s+engine_id/i)[0];
    expect(add).toBeTruthy();
    expect(add).toMatch(/not\s+null\s+default\s+'bds'/i);
    expect(engineById('bds')!.official).toBe(true);
  });

  it('binds every engine to the edition the catalog declares', () => {
    // Parsed from the consistency CHECK rather than restated, so the SQL is the
    // thing under test. An engine landing in the wrong branch would route Bedrock
    // commands to a Java console (§9).
    const pairs: Array<[string, 'bedrock' | 'java']> = [];
    const pattern = /engine_id\s+in\s*\(([^)]*)\)\s+and\s+game_type\s*=\s*'(bedrock|java)'/gi;
    for (const match of ENGINE_SQL.matchAll(pattern)) {
      for (const id of quotedValues(match[1])) pairs.push([id, match[2] as 'bedrock' | 'java']);
    }

    // Asserted on the raw list, never a Map: an engine listed in BOTH branches would
    // be accepted with either edition — the exact ambiguity this constraint exists to
    // remove — and a Map would silently keep only the last branch it saw.
    const ids = pairs.map(([id]) => id);
    expect(ids, 'an engine appears in more than one edition branch').toHaveLength(new Set(ids).size);
    expect([...ids].sort()).toEqual([...ENGINE_IDS].sort());
    for (const engine of ENGINES) {
      expect(pairs.find(([id]) => id === engine.id)?.[1], `${engine.id} edition in SQL`).toBe(engine.edition);
    }
  });

  it('widens game_type without dropping the value every existing row holds', () => {
    const add = statementsMatching(/add\s+constraint\s+servers_game_type_check/i)[0];
    expect(add).toBeTruthy();
    const values = quotedValues(add);
    expect(values).toContain('bedrock');
    expect(values).toContain('java');
    expect(values.sort()).toEqual(['bedrock', 'java']);
  });

  it('refuses to record an engine as installed while its download is unverified', () => {
    // §5 and §25: never execute unverified packages. 'unavailable' is allowed so
    // official BDS keeps working — Mojang publishes no checksum — but 'pending'
    // and 'failed' must block installation.
    const create = statementsMatching(/create\s+table\s+if\s+not\s+exists\s+public\.node_engines/i)[0];
    expect(create).toBeTruthy();
    expect(create).toMatch(/status\s*<>\s*'installed'\s+or\s+integrity_check\s+in\s*\(\s*'verified',\s*'unavailable'\s*\)/i);
    expect(quotedValues(create)).toEqual(
      expect.arrayContaining(['pending', 'verified', 'unavailable', 'failed']),
    );
  });

  it('lets the catalog decide which engines have no verifiable checksum', () => {
    // The migration must not claim more integrity than the catalog does. Every
    // engine recorded as hashPublished:false has to be able to reach
    // integrity_check='unavailable', which is exactly why that value exists.
    const unverifiable = ENGINES.filter((e) => !e.hashPublished).map((e) => e.id);
    expect(unverifiable.length).toBeGreaterThan(0);
    const create = statementsMatching(/create\s+table\s+if\s+not\s+exists\s+public\.node_engines/i)[0];
    expect(create).toMatch(/'unavailable'/);
    expect(ENGINES.filter((e) => e.hashPublished).map((e) => e.hashSource)).toEqual([
      'https://api.papermc.io/v2/projects/paper/versions/{version}/builds/{build}',
    ]);
  });

  it('keeps preinstalled runtimes read-only and refuses to claim a native runtime', () => {
    // §6: never overwrite a runtime the owner already had. 'native' is absent
    // because BDS needs no runtime and a row asserting one would be invented data.
    const create = statementsMatching(/create\s+table\s+if\s+not\s+exists\s+public\.node_runtimes/i)[0];
    expect(create).toBeTruthy();
    expect(quotedValues(create)).toContain('preinstalled');
    expect(quotedValues(create)).toContain('oghost-managed');
    expect(create).toMatch(/runtime_kind\s+text\s+not\s+null\s+check\s*\(runtime_kind\s+in\s*\('jvm',\s*'php'\)\)/i);
    expect(create).not.toMatch(/'native'/);
  });

  it('agrees with the catalog about which runtime each engine needs', () => {
    const create = statementsMatching(/create\s+table\s+if\s+not\s+exists\s+public\.node_runtimes/i)[0];
    for (const engine of ENGINES) {
      if (engine.runtime.kind === 'native') continue;
      expect(quotedValues(create), `${engine.id} needs ${engine.runtime.kind}`).toContain(engine.runtime.kind);
    }
  });

  it('puts both new tables behind row level security with an owner-scoped policy', () => {
    for (const table of ['node_engines', 'node_runtimes']) {
      expect(ENGINE_SQL, `${table} RLS`).toMatch(
        new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, 'i'),
      );
      const policy = statementsMatching(new RegExp(`create\\s+policy\\s+"${table}_own_select"`, 'i'))[0];
      expect(policy, `${table} owner policy`).toBeTruthy();
      // Ownership is reached through nodes.owner_id: neither table has its own.
      expect(policy).toMatch(/from\s+public\.nodes\s+n/i);
      expect(policy).toMatch(/n\.owner_id\s*=\s*auth\.uid\(\)/i);
      expect(ENGINE_SQL, `${table} revoke`).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+table\\s+public\\.${table}\\s+from\\s+anon,\\s+authenticated`, 'i'),
      );
    }
  });

  it('grants owners read access only, never a privilege that bypasses RLS', () => {
    for (const table of ['node_engines', 'node_runtimes']) {
      expect(ENGINE_SQL).toMatch(new RegExp(`grant\\s+select\\s+on\\s+table\\s+public\\.${table}\\s+to\\s+authenticated`, 'i'));
      expect(ENGINE_SQL, `${table} must not be granted truncate/references/trigger`).not.toMatch(
        new RegExp(`grant\\s+(?:all|truncate|references|trigger)[^;]*\\b${table}\\b`, 'i'),
      );
    }
  });

  it('adds no engine column that would let a browser report its own install state', () => {
    // Install state is an agent-reported fact. A column defaulting to a
    // successful-looking value would let a client assert it.
    const create = statementsMatching(/create\s+table\s+if\s+not\s+exists\s+public\.node_engines/i)[0];
    expect(create).toMatch(/status\s+text\s+not\s+null\s+default\s+'not_installed'/i);
    expect(create).toMatch(/integrity_check\s+text\s+not\s+null\s+default\s+'pending'/i);
  });
});
