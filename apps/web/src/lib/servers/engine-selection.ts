import {
  ENGINES,
  NODE_COMMANDS,
  engineById,
  enginePlatformSupport,
  isPlatformRunnable,
  supportStatusLabel,
  type EngineDescriptor,
  type EngineId,
  type HostOs,
  type ServerEdition,
} from '@oghost/shared';

/**
 * Engine selection for server creation (§7).
 *
 * The route that creates a server used to hardcode `game_type: 'bedrock'` and
 * send INSTALL_BDS to whatever node was named. That was correct while BDS on
 * Windows was the only thing OG HOST could host, and becomes a lie the moment a
 * second engine or a second device type exists: a Java engine would be stored as
 * Bedrock, and an install command would be queued for an engine no adapter can
 * install.
 *
 * These functions are pure and read only the engine catalog plus the node's own
 * reported platform, so the decision can be tested without a database, a node or
 * an agent. Everything here fails closed: an unknown engine, an unknown platform
 * or a missing adapter is a refusal that names the reason, never a default that
 * quietly picks something else.
 */

/**
 * The subset of a node row this needs. Structural rather than the Supabase row
 * type, so it stays testable and cannot absorb unrelated columns.
 */
export interface NodePlatformInfo {
  agent_platform?: string | null;
  operating_system?: string | null;
}

export type EngineSelection =
  | {
      ok: true;
      engine: EngineDescriptor;
      /** Edition to store in servers.game_type, derived from the engine. */
      gameType: ServerEdition;
      /** Port to use when the caller did not choose one. */
      defaultPort: number;
      platform: HostOs;
      /**
       * Limitations the UI must show alongside a successful selection. Non-empty
       * whenever the platform status is below `supported`, because §25 requires
       * engine limitations to stay visible even when creation is allowed.
       */
      caveats: string[];
    }
  | {
      ok: false;
      status: number;
      error: string;
      /** Machine-readable reason, so a client can react without parsing prose. */
      reason: 'unknown_engine' | 'unknown_platform' | 'engine_unsupported_on_platform' | 'no_engine_adapter';
      /** The catalog's own explanation, when there is one. */
      detail?: string;
      /** What would have to be true for this to become possible. */
      requiresVerification?: string;
    };

const HOST_OS_VALUES: readonly HostOs[] = ['windows', 'linux', 'android', 'macos'];

function isHostOs(value: string): value is HostOs {
  return (HOST_OS_VALUES as readonly string[]).includes(value);
}

/**
 * Work out which platform a node actually is.
 *
 * Returns null rather than guessing. The columns have database defaults
 * ('Windows' / 'windows') and no CHECK constraint, so a node could in principle
 * report anything, and the pre-existing behaviour of treating an unrecognised
 * value as Windows would schedule servers onto devices that cannot run them.
 *
 * `agent_platform` wins when it is a known value because it is the agent's own
 * machine-readable claim; `operating_system` is a display string that may be
 * "Windows 11 Pro" or "Android 14", so it is matched loosely and only as a
 * fallback.
 */
export function normaliseHostPlatform(node: NodePlatformInfo): HostOs | null {
  const platform = node.agent_platform?.trim().toLowerCase();
  if (platform && isHostOs(platform)) return platform;

  const os = node.operating_system?.trim().toLowerCase();
  if (!os) return null;
  if (isHostOs(os)) return os;
  if (os.includes('android')) return 'android';
  if (os.startsWith('windows')) return 'windows';
  if (os.includes('mac') || os.includes('darwin') || os.includes('os x')) return 'macos';
  if (os.includes('linux') || os.includes('ubuntu') || os.includes('debian') || os.includes('fedora')) {
    return 'linux';
  }
  return null;
}

/**
 * Decide whether `engineId` may be created on `node`, and with which values.
 *
 * The catalog is the only authority. Nothing here special-cases an engine, so
 * raising a platform status in engines.ts is what enables creation — and the
 * tests that hold those statuses down are what stop it happening by accident.
 */
export function resolveEngineForNode(input: {
  engineId: string;
  node: NodePlatformInfo;
}): EngineSelection {
  const engine = engineById(input.engineId as EngineId);
  if (!engine) {
    return {
      ok: false,
      status: 400,
      reason: 'unknown_engine',
      error: `"${input.engineId}" is not an engine OG HOST knows about.`,
    };
  }

  const platform = normaliseHostPlatform(input.node);
  if (!platform) {
    return {
      ok: false,
      status: 400,
      reason: 'unknown_platform',
      error:
        'This device did not report a platform OG HOST recognises, so it cannot be checked for compatibility. Re-pair the device with an agent that reports its platform.',
      detail: `agent_platform=${String(input.node.agent_platform ?? 'null')} operating_system=${String(
        input.node.operating_system ?? 'null',
      )}`,
    };
  }

  const support = enginePlatformSupport(engine.id, platform);
  if (!isPlatformRunnable(support.status)) {
    return {
      ok: false,
      status: 400,
      reason: 'engine_unsupported_on_platform',
      // The reason comes from the catalog, so the message explains the actual
      // blocker (no ARM build, no JVM, no adapter) instead of a generic refusal.
      error: `${engine.displayName} is ${supportStatusLabel(support.status).toLowerCase()} on this device. ${
        support.reason ?? ''
      }`.trim(),
      detail: support.reason,
      requiresVerification: support.requiresVerification,
    };
  }

  // Runnable, but the UI still has to say how far from verified that is.
  const caveats: string[] = [];
  if (support.status !== 'supported' && support.reason) {
    caveats.push(`${supportStatusLabel(support.status)}: ${support.reason}`);
  }
  if (support.requiresVerification) {
    caveats.push(`Needs verification: ${support.requiresVerification}`);
  }
  if (!engine.runtime.minimumVersionConfirmed && engine.runtime.kind !== 'native') {
    caveats.push(
      `The minimum ${engine.runtime.label} version for ${engine.displayName} is not confirmed and must be read from the release metadata at install time.`,
    );
  }

  return {
    ok: true,
    engine,
    gameType: engine.edition,
    defaultPort: engine.defaultPort,
    platform,
    caveats,
  };
}

/**
 * The command that installs an engine on a node, or null when no adapter exists.
 *
 * Only BDS has one today: the Windows agent's BdsInstaller. Returning null makes
 * the caller refuse and name the missing piece, rather than queueing INSTALL_BDS
 * for an engine it cannot install — which would leave a server row that can never
 * start and an agent error the owner cannot act on.
 */
export function engineInstallCommand(engineId: EngineId): string | null {
  switch (engineId) {
    case 'bds':
      return NODE_COMMANDS.INSTALL_BDS;
    default:
      return null;
  }
}

/**
 * Every engine the catalog offers for one platform, with the reason the others are
 * not listed. §7 requires the creation studio to show only supported options AND
 * to explain why the rest are hidden — hiding them silently reads as a broken UI.
 */
export function engineChoicesForPlatform(node: NodePlatformInfo): {
  platform: HostOs | null;
  available: Array<{ id: EngineId; displayName: string; edition: ServerEdition; defaultPort: number }>;
  hidden: Array<{ id: EngineId; displayName: string; reason: string }>;
} {
  const platform = normaliseHostPlatform(node);
  const available: Array<{ id: EngineId; displayName: string; edition: ServerEdition; defaultPort: number }> = [];
  const hidden: Array<{ id: EngineId; displayName: string; reason: string }> = [];

  if (!platform) return { platform: null, available, hidden };

  for (const engine of ENGINES) {
    const support = enginePlatformSupport(engine.id, platform);
    if (isPlatformRunnable(support.status)) {
      available.push({
        id: engine.id,
        displayName: engine.displayName,
        edition: engine.edition,
        defaultPort: engine.defaultPort,
      });
    } else {
      hidden.push({
        id: engine.id,
        displayName: engine.displayName,
        reason: support.reason ?? `${engine.displayName} cannot run on ${platform}.`,
      });
    }
  }

  return { platform, available, hidden };
}
