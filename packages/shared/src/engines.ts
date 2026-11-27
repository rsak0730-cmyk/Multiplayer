/**
 * Engine catalog and compatibility model.
 *
 * OG HOST supports more than one Minecraft server engine, and the single most
 * important thing this module does is refuse to pretend otherwise. Every engine
 * declares, per host platform, whether it is supported — and a status that is not
 * `supported` must carry a reason. That makes "does this work on my phone?" a
 * question the data answers rather than a claim the UI invents.
 *
 * THE STATUS VOCABULARY
 * ---------------------
 *   supported        implemented and verified
 *   experimental     implemented and working, not fully verified
 *   unverified       implemented, never executed in a verified environment
 *   not-implemented  technically conceivable; OG HOST does not do it yet
 *   unsupported      cannot work, or is known not to
 *
 * These five are deliberately distinct. Collapsing "we wrote the code" into
 * "it works" is how a dashboard ends up claiming a feature that has never run,
 * which §25 of the platform requirements forbids.
 *
 * WHAT IS ACTUALLY VERIFIED TODAY
 * -------------------------------
 * Almost nothing in this catalog has been executed. The Windows agent contains a
 * complete BDS implementation that has never been compiled in this repository's
 * environment (there is no .NET toolchain here), so BDS on Windows is `unverified`
 * rather than `supported`. Every other engine is `not-implemented`: the adapters
 * do not exist yet. The catalog is the contract those adapters will be written
 * against, and it is tested for internal consistency, not for runtime behaviour.
 *
 * Version numbers are the other honesty problem. Runtime requirements drift — a
 * Paper build that needed Java 17 last year needs 21 this year — so this module
 * stores the *kind* of runtime and a policy for resolving the version, and marks
 * any concrete minimum as unconfirmed where it was not read from an official
 * source at build time. The engine manager must confirm against release metadata
 * before installing. §25: do not execute unverified installation packages.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type ServerEdition = 'bedrock' | 'java';

/**
 * Declared as a const tuple FIRST and the type derived from it, so the runtime
 * list used by validators (zod, SQL mirrors, UI dropdowns) and the compile-time
 * union cannot drift apart. Adding an engine is then one edit, not two that have
 * to be kept in step by hand.
 */
export const ENGINE_ID_VALUES = ['bds', 'powernukkitx', 'pocketmine-mp', 'paper', 'purpur'] as const;

export type EngineId = (typeof ENGINE_ID_VALUES)[number];

/** Operating systems a hosting node may report. */
export type HostOs = 'windows' | 'linux' | 'android' | 'macos';

export type RuntimeKind = 'native' | 'jvm' | 'php';

export type SupportStatus =
  | 'supported'
  | 'experimental'
  | 'unverified'
  | 'not-implemented'
  | 'unsupported';

/**
 * What a server engine accepts as an installable package.
 *
 * Kept as one flat vocabulary across editions on purpose: the whole point is
 * that a Java plugin and a Bedrock behavior pack are different kinds of thing,
 * and `canInstallPackage` is what stops one being written into the other's
 * directory. §25: never assume they are interchangeable.
 */
export type PackageKind =
  | 'behavior-pack'
  | 'resource-pack'
  | 'java-plugin'
  | 'pocketmine-plugin'
  | 'powernukkitx-plugin';

export type WorldFormat = 'bedrock-leveldb' | 'java-anvil';

/**
 * Which command grammar the console speaks. This routes a command to the correct
 * allowlist, so a wrong value means sending one engine's commands to another.
 *
 * `pocketmine` is its own value on purpose. PocketMine-MP speaks the Bedrock
 * *protocol* but reimplements the server in PHP, so its command set matches
 * neither BDS nor Bukkit. Labelling it `bedrock` would feed it the BDS allowlist
 * and labelling it `java` would feed it Bukkit commands; both would fail at
 * runtime, and a console that rejects everything looks broken to the user.
 */
export type ConsoleDialect = 'bedrock' | 'java' | 'pocketmine';

export interface PlatformSupport {
  status: SupportStatus;
  /** Required unless status is `supported`. Explains why, in user-facing terms. */
  reason?: string;
  /** What would have to be true, or tested, to raise this status. */
  requiresVerification?: string;
}

export interface RuntimeRequirement {
  kind: RuntimeKind;
  /** Human label, e.g. "Java runtime (JDK/JRE)". */
  label: string;
  /**
   * Minimum major version, or null when it must be resolved from release
   * metadata at install time. Null is the honest default for anything that was
   * not read from an official source when this file was written.
   */
  minimumMajorVersion: number | null;
  /** True only when the minimum above came from an official, dated source. */
  minimumVersionConfirmed: boolean;
  /** Where the engine manager must obtain the authoritative version. */
  resolvedFrom: 'release-metadata' | 'catalog';
}

export interface EngineDescriptor {
  id: EngineId;
  displayName: string;
  edition: ServerEdition;
  /**
   * True only for the official Mojang Bedrock Dedicated Server.
   *
   * §25: do not pretend PowerNukkitX is official BDS. Exactly one engine in this
   * catalog may set this, and a test enforces it.
   */
  official: boolean;
  publisher: string;
  /** Trusted release source. The only place an installation package may come from. */
  sourceUrl: string;
  /**
   * Whether the publisher provides a checksum or signature we can verify against.
   *
   * Defaults to the safe answer. Where this could not be confirmed from the
   * publisher it is `false`, because claiming a checksum exists that does not
   * would let the engine manager skip integrity verification entirely — §5 and
   * §25 ("never execute unverified packages").
   */
  hashPublished: boolean;
  /**
   * Where the checksum is obtained. Required whenever `hashPublished` is true, so
   * the claim is falsifiable instead of merely asserted; a test enforces it.
   */
  hashSource?: string;
  /** How the facts in this descriptor were obtained. */
  provenance: 'existing-implementation' | 'upstream-documentation' | 'assumed-needs-confirmation';
  packageFormat: 'zip' | 'jar' | 'phar';
  runtime: RuntimeRequirement;
  platforms: Record<HostOs, PlatformSupport>;
  /**
   * World formats this engine can read. More than one is possible, and an empty
   * array means "must be determined by inspecting the world directory".
   */
  worldFormats: WorldFormat[];
  /** True when worldFormats was confirmed by running the engine, not by reading docs. */
  worldFormatsConfirmed: boolean;
  acceptedPackages: PackageKind[];
  consoleDialect: ConsoleDialect;
  /**
   * True only once the dialect has been checked by actually driving that engine's
   * console. Nothing here has been, so every value is false: a dialect is a
   * documented expectation until an allowlist is verified against the real process.
   * §9 forbids sending one engine's commands to another, and the way to keep that
   * promise is to refuse to treat an unverified grammar as verified.
   */
  consoleDialectConfirmed: boolean;
  defaultPort: number;
  defaultPortProtocol: 'udp' | 'tcp';
  /** Rough RAM the engine needs to start, in MB. A planning figure, not a promise. */
  minimumRamMb: number;
  knownLimitations: string[];
  /**
   * Whether OG VOICE can integrate with this engine. §18: the Bedrock behavior
   * pack must not be assumed to work with PowerNukkitX or PocketMine-MP, and each
   * engine needs its own check for identity, position and dimension access.
   */
  voiceIntegration: PlatformSupport;
}

// ---------------------------------------------------------------------------
// The Android answer, stated once and reused
// ---------------------------------------------------------------------------

/**
 * Why no engine in this catalog runs on Android today.
 *
 * This is the single most consequential limitation in the multi-engine design and
 * it is a platform constraint, not a missing feature:
 *
 *   * Mojang publishes BDS for Windows and Linux only, both x86_64. There is no
 *     Android build and no ARM build, so there is nothing to install.
 *   * Android's ART is not a drop-in JVM for server JARs, and Android ships no
 *     PHP runtime. An ordinary app cannot launch Paper, Purpur, PowerNukkitX or
 *     PocketMine-MP.
 *   * The route that does work in practice is a Linux-compatible environment —
 *     a proot/chroot distribution, or an OpenJDK installed by Termux — which
 *     lives outside an app's own sandbox and needs a separate app plus
 *     user-granted permissions to drive.
 *
 * On top of that, Android terminates background work aggressively. Even with a
 * runtime, a foreground service with the right type and notification is the only
 * way to keep a server alive, and no amount of care makes that equivalent to a
 * desktop host. §25: never promise unlimited Android uptime.
 *
 * Nothing here has been tested on a device. An Android node can register and
 * report its real capabilities; the honest result today is that no engine in this
 * catalog is installable on it.
 */
const ANDROID_NEEDS_JVM: PlatformSupport = {
  status: 'unsupported',
  reason:
    'This engine needs a Java runtime. Android\'s ART is not a drop-in JVM for server JARs and an ordinary app cannot launch one, so there is nothing OG HOST can install.',
  requiresVerification:
    'Running the JAR inside a Linux-compatible environment (proot/chroot or a Termux-provided OpenJDK), driven by a foreground service. Untested on any device.',
};

const ANDROID_NEEDS_PHP: PlatformSupport = {
  status: 'unsupported',
  reason:
    'This engine needs a PHP runtime, which Android does not provide to ordinary applications.',
  requiresVerification:
    'A PHP runtime inside a Linux-compatible environment on the device. Untested on any device.',
};

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export const ENGINES: readonly EngineDescriptor[] = [
  {
    id: 'bds',
    displayName: 'Minecraft Bedrock Dedicated Server',
    edition: 'bedrock',
    official: true,
    publisher: 'Mojang Studios',
    sourceUrl: 'https://www.minecraft.net/en-us/download/server/bedrock',
    // The download page publishes no checksum, so the existing agent validates by
    // inspecting the archive for bedrock_server(.exe) and by preferring the stable
    // `bedrock-server-` filename over `-preview-`. That is weaker than a hash and
    // is recorded as such rather than claimed as verification.
    hashPublished: false,
    provenance: 'existing-implementation',
    packageFormat: 'zip',
    runtime: {
      kind: 'native',
      label: 'Native platform binary (no separate runtime)',
      minimumMajorVersion: null,
      minimumVersionConfirmed: false,
      resolvedFrom: 'release-metadata',
    },
    platforms: {
      windows: {
        status: 'unverified',
        reason:
          'Fully implemented in the OG HOST Windows agent (installer, version discovery, process manager, 68-command allowlist) but never compiled or executed in this repository\u2019s verification environment, which has no .NET toolchain.',
        requiresVerification: 'A Windows host running the built agent against a real Bedrock client.',
      },
      linux: {
        status: 'not-implemented',
        reason:
          'Mojang publishes an official x86_64 Linux build, but no OG HOST agent exists for Linux and the Windows agent is not portable.',
        requiresVerification: 'A Linux agent, then a real client join test.',
      },
      android: {
        status: 'unsupported',
        reason:
          'Mojang publishes no Android and no ARM build. The official binaries are x86_64, so there is nothing that could be installed on a phone even with a compatibility layer short of CPU emulation.',
        requiresVerification:
          'An official ARM/Android build from Mojang. None exists as of this writing; do not advertise Android BDS support.',
      },
      macos: {
        status: 'unsupported',
        reason: 'Mojang discontinued the macOS Bedrock server build.',
      },
    },
    worldFormats: ['bedrock-leveldb'],
    worldFormatsConfirmed: false,
    acceptedPackages: ['behavior-pack', 'resource-pack'],
    consoleDialect: 'bedrock',
    consoleDialectConfirmed: false,
    defaultPort: 19132,
    defaultPortProtocol: 'udp',
    minimumRamMb: 1024,
    knownLimitations:
      [
        'Closed source and EULA-restricted: OG HOST downloads it from Mojang and must not redistribute the binary.',
        'No Java plugin support of any kind. Behavior packs are not plugins.',
        'No supported public API for chunk scheduling or direct LevelDB access, so features depending on those are UNSUPPORTED rather than pending.',
        'The download page publishes no checksum, so package integrity cannot be verified cryptographically.',
        'Console command surface is limited; the agent enforces a 68-entry allowlist and refuses anything else.',
      ],
    voiceIntegration: {
      status: 'unverified',
      reason:
        'The only server-to-service transport available to a behavior pack is the experimental @minecraft/server-net module together with @minecraft/server-admin. Neither is available on Realms, and the exact beta module versions are pinned once, in the add-on manifest, rather than repeated here. XUID is not cleanly exposed to scripting, so identity must come from the OG HOST pairing flow.',
      requiresVerification: 'A live BDS with the add-on installed and two companion apps connected.',
    },
  },

  {
    id: 'powernukkitx',
    displayName: 'PowerNukkitX',
    edition: 'bedrock',
    official: false,
    publisher: 'PowerNukkitX project',
    // Queried live via the GitHub releases API: the latest release ships a single
    // `powernukkitx.jar` asset and no checksum, so integrity cannot be verified
    // cryptographically. Nothing else about this engine was confirmed at runtime.
    sourceUrl: 'https://github.com/PowerNukkitX/PowerNukkitX/releases',
    hashPublished: false,
    provenance: 'assumed-needs-confirmation',
    packageFormat: 'jar',
    runtime: {
      kind: 'jvm',
      label: 'Java runtime',
      // Deliberately null: the required Java version differs between
      // PowerNukkitX releases and was not read from an official source here.
      minimumMajorVersion: null,
      minimumVersionConfirmed: false,
      resolvedFrom: 'release-metadata',
    },
    platforms: {
      windows: {
        status: 'not-implemented',
        reason: 'No engine adapter exists yet. The Windows agent launches only bedrock_server.exe.',
        requiresVerification: 'A JVM adapter in the agent, then a real Bedrock client join test.',
      },
      linux: { status: 'not-implemented', reason: 'No OG HOST Linux agent exists.' },
      android: ANDROID_NEEDS_JVM,
      macos: { status: 'not-implemented', reason: 'No OG HOST macOS agent exists.' },
    },
    worldFormats: [],
    worldFormatsConfirmed: false,
    acceptedPackages: ['powernukkitx-plugin'],
    consoleDialect: 'java',
    consoleDialectConfirmed: false,
    defaultPort: 19132,
    defaultPortProtocol: 'udp',
    minimumRamMb: 1024,
    knownLimitations: [
      'Bedrock-protocol compatible, but it is NOT the official Mojang server and must never be presented as one.',
      'Runs on a Java runtime, so it needs JVM management the BDS path does not.',
      'Plugins are PowerNukkitX plugins, not Bedrock behavior packs. The two are not interchangeable.',
      'World format support was not confirmed from an authoritative source and must be inspected before any world import or conversion is offered.',
      'No checksum published on the release page, so integrity must be confirmed another way before execution.',
    ],
    voiceIntegration: {
      status: 'not-implemented',
      reason:
        'The OG VOICE add-on is a Bedrock behavior pack using @minecraft/server-net. Whether PowerNukkitX exposes equivalent scripting, identity, position and dimension data has not been established, and it must not be assumed.',
      requiresVerification: 'An independent check of this engine\u2019s scripting/event surface.',
    },
  },

  {
    id: 'pocketmine-mp',
    displayName: 'PocketMine-MP',
    edition: 'bedrock',
    official: false,
    publisher: 'PMMP team',
    // Queried live via the GitHub releases API: the assets are the phar, start
    // scripts, core-permissions.rst and build_info.json. No checksum asset exists.
    sourceUrl: 'https://github.com/pmmp/PocketMine-MP/releases',
    hashPublished: false,
    provenance: 'assumed-needs-confirmation',
    packageFormat: 'phar',
    runtime: {
      kind: 'php',
      label: 'PHP runtime',
      minimumMajorVersion: null,
      minimumVersionConfirmed: false,
      resolvedFrom: 'release-metadata',
    },
    platforms: {
      windows: {
        status: 'not-implemented',
        reason: 'No PHP runtime manager or engine adapter exists in the agent.',
        requiresVerification: 'A PHP runtime manager, then a real Bedrock client join test.',
      },
      linux: { status: 'not-implemented', reason: 'No OG HOST Linux agent exists.' },
      android: ANDROID_NEEDS_PHP,
      macos: { status: 'not-implemented', reason: 'No OG HOST macOS agent exists.' },
    },
    worldFormats: ['bedrock-leveldb'],
    worldFormatsConfirmed: false,
    acceptedPackages: ['pocketmine-plugin'],
    consoleDialect: 'pocketmine',
    consoleDialectConfirmed: false,
    defaultPort: 19132,
    defaultPortProtocol: 'udp',
    minimumRamMb: 512,
    knownLimitations: [
      'Reimplements the Bedrock protocol in PHP; it is not the official server and does not support all vanilla behaviour.',
      'Does not load Bedrock behavior packs or resource packs. Plugins are PocketMine-MP plugins.',
      'Feature parity with vanilla Bedrock is partial, so anything depending on exact vanilla behaviour must be treated as unsupported here.',
      'World format support must be confirmed by inspection before offering import or conversion.',
      'The release page publishes no checksum asset alongside the phar, so package integrity cannot be verified cryptographically. A build_info.json asset exists but its contents were not inspected, so it must not be assumed to contain a usable hash.',
      'Its console command set is its own. It is neither the BDS command grammar nor Bukkit\u2019s, so neither allowlist may be applied to it.',
    ],
    voiceIntegration: {
      status: 'not-implemented',
      reason:
        'A Bedrock behavior pack cannot be assumed to load here. Whether player identity, position and dimension are reachable through this engine\u2019s plugin API has not been established.',
      requiresVerification: 'An independent check of the plugin API surface.',
    },
  },

  {
    id: 'paper',
    displayName: 'Paper',
    edition: 'java',
    official: false,
    publisher: 'PaperMC',
    sourceUrl: 'https://api.papermc.io/v2/projects/paper',
    // PaperMC's v2 API exposes a SHA-256 checksum per build download, which the
    // engine manager must verify before executing anything. §5: do not execute
    // unverified packages. NOTE: api.papermc.io is not reachable from this
    // environment, so the field was not read live here; the engine manager must
    // fail closed if the checksum is missing from a response rather than install.
    hashPublished: true,
    hashSource: 'https://api.papermc.io/v2/projects/paper/versions/{version}/builds/{build}',
    provenance: 'assumed-needs-confirmation',
    packageFormat: 'jar',
    runtime: {
      kind: 'jvm',
      label: 'Java runtime',
      minimumMajorVersion: null,
      minimumVersionConfirmed: false,
      resolvedFrom: 'release-metadata',
    },
    platforms: {
      windows: {
        status: 'not-implemented',
        reason:
          'No Java engine adapter exists. The agent\u2019s process manager launches bedrock_server.exe and refuses anything else by design.',
        requiresVerification: 'A JVM adapter and a Java-edition client join test.',
      },
      linux: { status: 'not-implemented', reason: 'No OG HOST Linux agent exists.' },
      android: ANDROID_NEEDS_JVM,
      macos: { status: 'not-implemented', reason: 'No OG HOST macOS agent exists.' },
    },
    worldFormats: ['java-anvil'],
    worldFormatsConfirmed: false,
    acceptedPackages: ['java-plugin'],
    consoleDialect: 'java',
    consoleDialectConfirmed: false,
    defaultPort: 25565,
    defaultPortProtocol: 'tcp',
    minimumRamMb: 2048,
    knownLimitations: [
      'Java Edition. A Bedrock client cannot join without a proxy such as Geyser, which is a separate component and is not part of this catalog.',
      'Java worlds use the Anvil format and are NOT interchangeable with Bedrock LevelDB worlds. Conversion is a separate, lossy-risk process.',
      'Java plugins cannot be installed into a Bedrock engine, and Bedrock behavior packs cannot be installed here.',
      'Console commands differ from Bedrock; the agent must use the Java dialect and never send one engine\u2019s commands to another.',
    ],
    voiceIntegration: {
      status: 'not-implemented',
      reason:
        'OG VOICE currently integrates through a Bedrock behavior pack. A Java-edition integration would need a Java plugin exposing identity, position and dimension, which does not exist.',
      requiresVerification: 'A Java plugin written against this engine\u2019s API.',
    },
  },

  {
    id: 'purpur',
    displayName: 'Purpur',
    edition: 'java',
    official: false,
    publisher: 'PurpurMC',
    sourceUrl: 'https://api.purpurmc.org/v2/purpur',
    // Purpur is distributed through its own API, which publishes no GitHub release
    // assets. A checksum endpoint could not be confirmed (api.purpurmc.org is not
    // reachable from this environment), so this is recorded as absent rather than
    // assumed present. If a checksum field is later confirmed, raise it and add a
    // hashSource; until then the engine manager must not install Purpur without an
    // operator-pinned expected hash.
    hashPublished: false,
    provenance: 'assumed-needs-confirmation',
    packageFormat: 'jar',
    runtime: {
      kind: 'jvm',
      label: 'Java runtime',
      minimumMajorVersion: null,
      minimumVersionConfirmed: false,
      resolvedFrom: 'release-metadata',
    },
    platforms: {
      windows: {
        status: 'not-implemented',
        reason: 'No Java engine adapter exists in the agent.',
        requiresVerification: 'A JVM adapter and a Java-edition client join test.',
      },
      linux: { status: 'not-implemented', reason: 'No OG HOST Linux agent exists.' },
      android: ANDROID_NEEDS_JVM,
      macos: { status: 'not-implemented', reason: 'No OG HOST macOS agent exists.' },
    },
    worldFormats: ['java-anvil'],
    worldFormatsConfirmed: false,
    acceptedPackages: ['java-plugin'],
    consoleDialect: 'java',
    consoleDialectConfirmed: false,
    defaultPort: 25565,
    defaultPortProtocol: 'tcp',
    minimumRamMb: 2048,
    knownLimitations: [
      'A fork of Paper with additional configuration. Same Java Edition constraints apply.',
      'Java worlds only; not interchangeable with Bedrock LevelDB worlds.',
      'Because it forks Paper, plugin compatibility is usually but not always identical — compatibility must be evidenced per plugin, never assumed.',
      'No publisher checksum could be confirmed, so package integrity cannot be verified cryptographically. Installation must not proceed without an operator-pinned expected hash.',
      'Inherits every Paper limitation. Being a Paper fork does not make its behaviour identical to Paper\u2019s.',
    ],
    voiceIntegration: {
      status: 'not-implemented',
      reason: 'Same situation as Paper: a Java plugin integration would be required and does not exist.',
      requiresVerification: 'A Java plugin written against this engine\u2019s API.',
    },
  },
];

export const ENGINE_IDS: readonly EngineId[] = ENGINES.map((engine) => engine.id);
export const HOST_OSES: readonly HostOs[] = ['windows', 'linux', 'android', 'macos'];

const BY_ID = new Map<EngineId, EngineDescriptor>(ENGINES.map((engine) => [engine.id, engine]));

export function engineById(id: string): EngineDescriptor | null {
  return BY_ID.get(id as EngineId) ?? null;
}

export function isEngineId(value: string): value is EngineId {
  return BY_ID.has(value as EngineId);
}

// ---------------------------------------------------------------------------
// Compatibility queries
// ---------------------------------------------------------------------------

/** Can this engine run on this host OS, and if not, why? */
export function enginePlatformSupport(engineId: string, os: string): PlatformSupport {
  const engine = engineById(engineId);
  if (!engine) {
    return { status: 'unsupported', reason: `Unknown engine "${engineId}".` };
  }
  const support = engine.platforms[os as HostOs];
  if (!support) {
    return { status: 'unsupported', reason: `Unknown host platform "${os}".` };
  }
  return support;
}

/** True only for a status that means OG HOST can actually install and run it. */
export function isPlatformRunnable(status: SupportStatus): boolean {
  return status === 'supported' || status === 'experimental' || status === 'unverified';
}

export function enginesForPlatform(os: string): EngineDescriptor[] {
  return ENGINES.filter((engine) => isPlatformRunnable(engine.platforms[os as HostOs]?.status ?? 'unsupported'));
}

export function enginesByEdition(edition: ServerEdition): EngineDescriptor[] {
  return ENGINES.filter((engine) => engine.edition === edition);
}

/**
 * May this package kind be installed into this engine?
 *
 * The rule §14 and §25 care about most: a Java plugin must never land in a
 * Bedrock add-on directory, and a behavior pack must never be offered to Paper.
 * Returning false is not enough on its own — the caller must show the reason, so
 * the result carries one.
 */
export function canInstallPackage(
  engineId: string,
  kind: PackageKind,
): { allowed: boolean; reason: string } {
  const engine = engineById(engineId);
  if (!engine) return { allowed: false, reason: `Unknown engine "${engineId}".` };
  if (engine.acceptedPackages.includes(kind)) {
    return { allowed: true, reason: `${engine.displayName} accepts ${kind} packages.` };
  }
  const crossEdition =
    (engine.edition === 'bedrock' && kind === 'java-plugin') ||
    (engine.edition === 'java' && kind !== 'java-plugin');
  return {
    allowed: false,
    reason: crossEdition
      ? `${engine.displayName} is a ${engine.edition}-edition engine and cannot use ${kind} packages. Bedrock add-ons and Java plugins are not interchangeable.`
      : `${engine.displayName} does not accept ${kind} packages.`,
  };
}

/**
 * Can a world of this format be used by this engine?
 *
 * Bedrock LevelDB and Java Anvil are different formats. Claiming otherwise would
 * mean silently corrupting a world, so an engine whose formats are unconfirmed
 * answers "unknown" rather than "yes".
 */
export function canUseWorldFormat(
  engineId: string,
  format: WorldFormat,
): { allowed: boolean; confirmed: boolean; reason: string } {
  const engine = engineById(engineId);
  if (!engine) return { allowed: false, confirmed: false, reason: `Unknown engine "${engineId}".` };
  if (engine.worldFormats.length === 0) {
    return {
      allowed: false,
      confirmed: false,
      reason: `${engine.displayName} has no confirmed world format. The world directory must be inspected before import or conversion is offered.`,
    };
  }
  if (!engine.worldFormats.includes(format)) {
    return {
      allowed: false,
      confirmed: engine.worldFormatsConfirmed,
      reason: `${engine.displayName} reads ${engine.worldFormats.join(' or ')} worlds, not ${format}. Conversion is a separate process and may lose data.`,
    };
  }
  return {
    allowed: true,
    confirmed: engine.worldFormatsConfirmed,
    reason: engine.worldFormatsConfirmed
      ? `${engine.displayName} reads ${format} worlds.`
      : `${engine.displayName} is documented to read ${format} worlds, but this has not been confirmed by running it. Verify with a backup before relying on it.`,
  };
}

// ---------------------------------------------------------------------------
// Node recommendation (§11)
// ---------------------------------------------------------------------------

export interface NodeSnapshot {
  id: string;
  name: string;
  operatingSystem: HostOs;
  online: boolean;
  ramAvailableMb: number | null;
  storageAvailableMb: number | null;
  cpuPercent: number | null;
  /** Servers already running on this node. Load matters, but is not decisive. */
  activeServers: number;
  /** Battery percent, when the node reports one. Desktops report null. */
  batteryPercent?: number | null;
  /** Thermal state, when the platform exposes it. */
  throttling?: boolean;
}

export interface NodeRecommendation {
  nodeId: string;
  nodeName: string;
  score: number;
  eligible: boolean;
  /** Plain-language reasons, including what is missing when not eligible. */
  reasons: string[];
}

/**
 * Scoring weights.
 *
 * EXPERIMENTAL INITIAL VALUES, in the same spirit as the network route-scoring
 * weights elsewhere in this project. They encode a preference — favour a node
 * with headroom, penalise load, penalise a phone that is hot or low on battery —
 * and they have not been tuned against real hardware. They are exposed so they
 * can be measured and adjusted rather than buried in a formula.
 */
export const NODE_SCORE_WEIGHTS = {
  ramHeadroom: 40,
  storageHeadroom: 20,
  cpuHeadroom: 20,
  lowLoad: 10,
  powerStability: 10,
} as const;

const REQUIRED_STORAGE_MB = 4096;

/**
 * Rank the nodes that could host a given engine.
 *
 * Deterministic and explainable: §11 requires recommendations with clear
 * explanations, and requires that when nothing is compatible the missing
 * requirement is named. Resources are never pooled across devices, so a node is
 * judged only on its own free RAM, storage and CPU.
 */
export function recommendNodes(params: {
  nodes: readonly NodeSnapshot[];
  engineId: string;
  requestedRamMb?: number;
}): NodeRecommendation[] {
  const engine = engineById(params.engineId);
  const requestedRam = Math.max(params.requestedRamMb ?? 0, engine?.minimumRamMb ?? 0);

  return params.nodes
    .map((node) => {
      const reasons: string[] = [];
      let eligible = true;

      if (!engine) {
        return {
          nodeId: node.id,
          nodeName: node.name,
          score: 0,
          eligible: false,
          reasons: [`Unknown engine "${params.engineId}".`],
        };
      }

      const support = node.operatingSystem
        ? enginePlatformSupport(engine.id, node.operatingSystem)
        : { status: 'unsupported' as SupportStatus, reason: 'This node reports no operating system.' };
      if (!isPlatformRunnable(support.status)) {
        eligible = false;
        reasons.push(
          `${engine.displayName} on ${node.operatingSystem}: ${support.status}. ${support.reason ?? ''}`.trim(),
        );
      }

      if (!node.online) {
        eligible = false;
        reasons.push('This device is offline. Start the OG HOST agent on it and wait for it to connect.');
      }

      if (node.ramAvailableMb === null) {
        eligible = false;
        reasons.push('This device has not reported its available memory, so it cannot be assessed.');
      } else if (node.ramAvailableMb < requestedRam) {
        eligible = false;
        reasons.push(
          `Needs ${requestedRam} MB of free memory; this device has ${node.ramAvailableMb} MB available.`,
        );
      }

      if (node.storageAvailableMb === null) {
        eligible = false;
        reasons.push('This device has not reported its available storage, so it cannot be assessed.');
      } else if (node.storageAvailableMb < REQUIRED_STORAGE_MB) {
        eligible = false;
        reasons.push(
          `Needs at least ${REQUIRED_STORAGE_MB} MB of free storage for the engine, runtime and a world; this device has ${node.storageAvailableMb} MB.`,
        );
      }

      if (node.batteryPercent !== undefined && node.batteryPercent !== null && node.batteryPercent < 20) {
        // Not disqualifying on its own — a plugged-in phone can sit at 15% — but
        // it must be surfaced, because Android throttles or kills work when low.
        reasons.push(
          `Battery is at ${Math.round(node.batteryPercent)}%. Android may restrict or stop the server to save power.`,
        );
      }
      if (node.throttling === true) {
        reasons.push('This device is reporting thermal throttling, so performance will be reduced.');
      }

      const w = NODE_SCORE_WEIGHTS;
      const ramScore =
        node.ramAvailableMb === null ? 0 : clamp01((node.ramAvailableMb - requestedRam) / Math.max(requestedRam, 1));
      const storageScore =
        node.storageAvailableMb === null
          ? 0
          : clamp01((node.storageAvailableMb - REQUIRED_STORAGE_MB) / (REQUIRED_STORAGE_MB * 4));
      const cpuScore = node.cpuPercent === null ? 0 : clamp01(1 - node.cpuPercent / 100);
      const loadScore = clamp01(1 - node.activeServers / 5);
      const powerScore =
        node.batteryPercent === undefined || node.batteryPercent === null
          ? 1 // A desktop with no battery is not penalised for not having one.
          : clamp01(node.batteryPercent / 100) * (node.throttling === true ? 0.5 : 1);

      const score = Math.round(
        ramScore * w.ramHeadroom +
          storageScore * w.storageHeadroom +
          cpuScore * w.cpuHeadroom +
          loadScore * w.lowLoad +
          powerScore * w.powerStability,
      );

      if (eligible && reasons.length === 0) {
        reasons.push(`${engine.displayName} can run on this device with ${node.ramAvailableMb} MB of memory free.`);
      }

      return { nodeId: node.id, nodeName: node.name, score: eligible ? score : 0, eligible, reasons };
    })
    .sort((a, b) => {
      // Eligible nodes first, then by score, then by name so the order is stable
      // and a re-render does not shuffle the list under the user's cursor.
      if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
      if (b.score !== a.score) return b.score - a.score;
      return a.nodeName.localeCompare(b.nodeName);
    });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Status labels for the UI.
 *
 * Worded so none of them can be read as "this works" when it does not.
 */
export function supportStatusLabel(status: SupportStatus): string {
  switch (status) {
    case 'supported':
      return 'Supported';
    case 'experimental':
      return 'Experimental — works, not fully verified';
    case 'unverified':
      return 'Implemented — never run in a verified environment';
    case 'not-implemented':
      return 'Not implemented yet';
    case 'unsupported':
      return 'Unsupported on this device';
  }
}
