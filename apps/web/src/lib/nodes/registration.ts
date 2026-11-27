import type { HostOs } from '@oghost/shared';
import { normaliseHostPlatform } from '@/lib/servers/engine-selection';

/**
 * Node registration (§2 Android agent, §10 multi-device node manager).
 *
 * The claim route used to hardcode `agent_platform: 'windows'` and default the
 * node name to "Windows Node". That is fine while every agent is the Windows
 * service, and wrong the moment a phone pairs: the platform recorded at
 * registration is what engine selection later trusts, so a mislabelled device
 * would be offered engines it cannot run.
 *
 * An explicit platform claim is validated and refused when unrecognised. Only a
 * *missing* claim falls back to the legacy Windows default, and that fallback is
 * labelled so callers and tests can see which path was taken.
 */

export type AgentPlatformClaim =
  | { ok: true; platform: HostOs; source: 'reported' | 'derived' | 'legacy-default' }
  | { ok: false; error: string };

const KNOWN_PLATFORMS: readonly HostOs[] = ['windows', 'linux', 'android', 'macos'];

/**
 * Decide which platform a pairing agent is registering as.
 *
 * @param reported  `agent_platform` from the request body, if any.
 * @param operatingSystem  `operating_system` from the request body, if any — a
 *   display string such as "Android 14", used only when no platform was reported.
 */
export function resolveAgentPlatform(input: {
  reported?: string | null;
  operatingSystem?: string | null;
}): AgentPlatformClaim {
  const reported = input.reported?.trim().toLowerCase();

  if (reported) {
    // An explicit but unrecognised claim is refused rather than silently
    // rewritten: registering a device as something it is not is how a phone ends
    // up being offered a Windows-only engine.
    if (!(KNOWN_PLATFORMS as readonly string[]).includes(reported)) {
      return {
        ok: false,
        error: `Unsupported agent platform "${input.reported}". Supported values: ${KNOWN_PLATFORMS.join(', ')}.`,
      };
    }
    return { ok: true, platform: reported as HostOs, source: 'reported' };
  }

  const derived = normaliseHostPlatform({ operating_system: input.operatingSystem });
  if (derived) return { ok: true, platform: derived, source: 'derived' };

  // The shipped Windows agent sends neither field, so this is the compatibility
  // path that keeps it working exactly as before. It matches the database default
  // for both columns. A future agent should report its platform explicitly.
  return { ok: true, platform: 'windows', source: 'legacy-default' };
}

/**
 * Sensible defaults for a node's display name and operating-system label, per
 * platform. Only used when the agent did not supply its own.
 */
export function defaultNodeIdentity(platform: HostOs): { name: string; operatingSystem: string } {
  switch (platform) {
    case 'android':
      return { name: 'Android Device', operatingSystem: 'Android' };
    case 'linux':
      return { name: 'Linux Node', operatingSystem: 'Linux' };
    case 'macos':
      return { name: 'Mac Node', operatingSystem: 'macOS' };
    case 'windows':
    default:
      // Unchanged from the value the route used before platforms were modelled,
      // so an existing Windows agent registers with the name it always got.
      return { name: 'Windows Node', operatingSystem: 'Windows' };
  }
}
