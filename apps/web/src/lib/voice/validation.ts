/**
 * Voice API request validation — pure, no I/O.
 *
 * Every voice route parses its body through a schema here. Keeping the schemas
 * in one module means the browser, the Android companion, the Windows companion
 * and the Bedrock add-on are all held to the same contract, and the contract can
 * be tested without a database or a network.
 */
import { z } from 'zod';
import {
  MAX_VOICE_RANGE,
  MIN_VOICE_RANGE,
  PERMISSION_STATES,
  VOICE_CODE_LENGTH,
  VOICE_MODES,
  normaliseVoiceCode,
} from '@oghost/shared';

/**
 * A Minecraft display name as Bedrock reports it.
 *
 * Deliberately permissive about *characters* and strict about *length and
 * control characters*: gamertags contain spaces, and Realms names are not Xbox
 * gamertags. What must never get through is a newline, a format code or a
 * zero-width character — those are how a name spoofs another player in a UI or
 * breaks a log line.
 *
 * § is excluded specifically: Bedrock uses it for colour/format codes, and a name
 * containing it can render as invisible text.
 */
export const PLAYER_NAME_RE = /^[A-Za-z0-9 _\-.]{1,32}$/;

/**
 * Normalise a player name the same way the schemas do.
 *
 * Surrounding whitespace is stripped rather than rejected, and that is a
 * security property, not a convenience: if `"Steve"` and `"Steve "` were two
 * different names they would be two different identity links, and a player could
 * appear as someone else in a player list by adding a trailing space. Collapsing
 * them means whitespace can never create a second identity.
 *
 * Whitespace *inside* the name is kept, because Bedrock gamertags contain spaces.
 * Note that `String.trim` does not remove U+200B or U+0000, so a zero-width
 * space survives normalisation and is then rejected by the regex — which is what
 * makes an invisible-character impersonation attempt fail.
 */
export function normalisePlayerName(name: string): string {
  return name.trim();
}

export function isValidVoicePlayerName(name: string): boolean {
  // Mirrors the schema exactly: normalise, then test. Keeping the two in one
  // definition is what stops them drifting apart.
  return PLAYER_NAME_RE.test(normalisePlayerName(name));
}

const playerName = z
  .string()
  .transform((value) => normalisePlayerName(value))
  .refine((value) => PLAYER_NAME_RE.test(value), {
    message: 'Player name may contain letters, numbers, spaces, underscore, hyphen and period only, up to 32 characters.',
  });

const dimension = z.enum(['overworld', 'nether', 'the end']);

const permissionState = z.enum(PERMISSION_STATES as unknown as [string, ...string[]]);

const voiceMode = z.enum(VOICE_MODES as unknown as [string, ...string[]]);

const platform = z.enum(['android', 'windows', 'ios', 'web', 'unknown']);

/**
 * POST /api/voice/[serverId]/code
 *
 * Called by the owner from the dashboard, or by the add-on through the
 * node-authenticated route. `player_name` is trusted only because it arrives
 * from inside the server process or from the owner — never from a companion app.
 */
export const issueCodeSchema = z.object({
  player_name: playerName,
  issued_via: z.enum(['in_game', 'dashboard', 'agent']).default('dashboard'),
});

/**
 * POST /api/agent/voice/code
 *
 * The add-on reaches the control plane through the local agent, which does not
 * have the server id in its URL path — every agent route is a single endpoint
 * shared by all servers on that node. So the id moves into the body here, and
 * the route still verifies the server belongs to the authenticated node before
 * acting on it.
 */
export const agentIssueCodeSchema = issueCodeSchema.extend({
  server_id: z.string().uuid(),
});

/**
 * POST /api/voice/link
 *
 * The one voice endpoint with no prior credential: a guest with no OG HOST
 * account exchanges a code for a device session. That makes it the brute-force
 * surface, so the code is normalised here and rate-limited in the route.
 *
 * `server_id` is OPTIONAL, and that is a consequence of §4 rather than
 * convenience: the player types a code into the companion app and nothing else,
 * so the code alone must identify the server. Lookup is therefore by code hash
 * across servers. When a companion does supply `server_id` — on a re-pair with a
 * server it already knows — the route requires it to match the code's server and
 * records `cross_server_attempt` if it does not, which turns an optional field
 * into a real binding check instead of trusting a client's claim.
 */
export const redeemCodeSchema = z.object({
  server_id: z.string().uuid().optional(),
  code: z
    .string()
    .transform((value) => normaliseVoiceCode(value))
    .refine((value) => value.length === VOICE_CODE_LENGTH, {
      message: `Voice code must be ${VOICE_CODE_LENGTH} characters.`,
    }),
  platform: platform.default('unknown'),
  device_name: z.string().trim().max(64).optional(),
  app_version: z.string().trim().max(32).optional(),
});

/**
 * PATCH /api/voice/session
 *
 * Only the device that owns a session may report its microphone state. The route
 * authenticates the session token before this is ever reached, which is what
 * makes "the server cannot grant a microphone" enforceable rather than aspirational.
 */
export const sessionStateSchema = z.object({
  mic_permission_state: permissionState,
  connected: z.boolean().optional(),
  transmitting: z.boolean().optional(),
  metrics: z
    .object({
      rtt_ms: z.number().nonnegative().nullable().optional(),
      jitter_ms: z.number().nonnegative().nullable().optional(),
      packet_loss: z.number().min(0).max(1).nullable().optional(),
    })
    .optional(),
});

/** POST /api/voice/[serverId]/positions — from the add-on, via node token. */
export const positionsSchema = z.object({
  players: z
    .array(
      z.object({
        player_name: playerName,
        x: z.number().finite(),
        y: z.number().finite(),
        z: z.number().finite(),
        dimension,
      }),
    )
    // Bounded so a malformed or hostile payload cannot make the route do
    // unbounded work. Slightly above the 100-player server cap.
    .max(120),
  // Reported so the dashboard can show real compatibility instead of assuming it.
  engine_version: z.string().trim().max(32).optional(),
  script_api_version: z.string().trim().max(32).optional(),
  server_net_available: z.boolean().optional(),
});

/**
 * PATCH /api/voice/[serverId] — owner configuration.
 *
 * Notice what is absent: there is no field for microphone permission, no field
 * for another player's volume, and no field for recording. §13 lets an owner
 * manage rooms and configuration, but never override an individual player's
 * device permission. The omission is the enforcement — an owner cannot send what
 * the schema does not accept.
 */
export const voiceConfigPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    mode: voiceMode.optional(),
    voice_range: z.number().int().min(MIN_VOICE_RANGE).max(MAX_VOICE_RANGE).optional(),
    falloff_start: z.number().gt(0).max(1).optional(),
    ignore_altitude: z.boolean().optional(),
    default_push_to_talk: z.boolean().optional(),
    max_participants: z.number().int().min(2).max(100).optional(),
  })
  // An empty PATCH is a client bug, not a no-op to silently accept.
  .refine((value) => Object.keys(value).length > 0, { message: 'No changes supplied.' });

export type IssueCodeInput = z.infer<typeof issueCodeSchema>;
export type AgentIssueCodeInput = z.infer<typeof agentIssueCodeSchema>;
export type RedeemCodeInput = z.infer<typeof redeemCodeSchema>;
export type SessionStateInput = z.infer<typeof sessionStateSchema>;
export type PositionsInput = z.infer<typeof positionsSchema>;
export type VoiceConfigPatchInput = z.infer<typeof voiceConfigPatchSchema>;

/**
 * Turn a ZodError into a response body.
 *
 * Returns the first issue only: a wall of validation text is not actionable on a
 * phone screen, and the message is written for the player rather than for a log.
 */
export function validationError(error: z.ZodError): { error: string; field: string | null } {
  const first = error.issues[0];
  return {
    error: first?.message ?? 'Invalid request.',
    field: first?.path?.join('.') || null,
  };
}
