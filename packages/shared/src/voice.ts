/**
 * OG VOICE — shared, pure voice-domain logic.
 *
 * SECURITY BOUNDARY: this module is imported by browser bundles, so it must
 * never contain a secret, never sign a token, and never talk to a voice server.
 * LiveKit token minting lives in `apps/web/src/lib/voice/tokens.ts`, which is
 * server-only — the same discipline as the Supabase service-role key.
 *
 * Everything here is deterministic and unit-tested. Proximity maths in
 * particular must be exact: getting it wrong means a player hears someone three
 * dimensions away, which is both a gameplay bug and a privacy failure.
 */

// ---------------------------------------------------------------------------
// Bedrock dimensions
// ---------------------------------------------------------------------------

/** The only dimensions official Bedrock Dedicated Server reports. */
export const BEDROCK_DIMENSIONS = ['overworld', 'nether', 'the end'] as const;
export type BedrockDimension = (typeof BEDROCK_DIMENSIONS)[number];

/** Normalise a dimension id as reported by the Bedrock scripting API. */
export function normaliseDimension(raw: string): BedrockDimension | null {
  const d = raw.trim().toLowerCase();
  if (d === 'overworld' || d === 'minecraft:overworld') return 'overworld';
  if (d === 'nether' || d === 'minecraft:nether') return 'nether';
  if (d === 'the end' || d === 'theend' || d === 'minecraft:the_end') return 'the end';
  return null;
}

// ---------------------------------------------------------------------------
// Positions and distance
// ---------------------------------------------------------------------------

export interface VoicePosition {
  x: number;
  y: number;
  z: number;
  dimension: BedrockDimension;
}

/**
 * Straight-line distance in blocks.
 *
 * Uses all three axes: Bedrock builds vertically, and ignoring Y would let two
 * players on different floors of a tower hear each other at full volume through
 * what is effectively solid rock. Y is included, but see `horizontalDistance`
 * for the case where a server owner wants floors to share audio.
 */
export function distanceBetween(a: VoicePosition, b: VoicePosition): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Distance ignoring altitude — for multi-storey builds that should share audio. */
export function horizontalDistance(a: VoicePosition, b: VoicePosition): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

// ---------------------------------------------------------------------------
// Voice range
// ---------------------------------------------------------------------------

/**
 * Range presets in blocks. §7 of the spec lists these as examples, not as
 * guaranteed-optimal values, and they are exposed as owner-configurable
 * numbers rather than baked in: a server owner can set any value.
 */
export const VOICE_RANGE_PRESETS = {
  short: 16,
  normal: 32,
  long: 64,
  extended: 128,
} as const;
export type VoiceRangePreset = keyof typeof VOICE_RANGE_PRESETS;

export const MIN_VOICE_RANGE = 4;
export const MAX_VOICE_RANGE = 512;

export function isValidVoiceRange(range: number): boolean {
  return Number.isFinite(range) && range >= MIN_VOICE_RANGE && range <= MAX_VOICE_RANGE;
}

export function resolveVoiceRange(rangeOrPreset: number | VoiceRangePreset): number | null {
  if (typeof rangeOrPreset === 'number') {
    return isValidVoiceRange(rangeOrPreset) ? rangeOrPreset : null;
  }
  return VOICE_RANGE_PRESETS[rangeOrPreset] ?? null;
}

// ---------------------------------------------------------------------------
// Voice modes
// ---------------------------------------------------------------------------

export const VOICE_MODES = ['proximity', 'global', 'disabled'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];

export function isValidVoiceMode(mode: string): mode is VoiceMode {
  return (VOICE_MODES as readonly string[]).includes(mode);
}

// ---------------------------------------------------------------------------
// Proximity attenuation
// ---------------------------------------------------------------------------

/**
 * Volume gain for a speaker heard by a listener, in the range 0..1.
 *
 * The curve matches how proximity voice actually feels in play: full volume
 * while the speaker is close, then a linear fade to silence exactly at the
 * configured range, and hard silence beyond it. A linear fade is used rather
 * than an exponential one because it is predictable for a server owner tuning
 * `voiceRange` — "half the range means half the volume at that point" is a claim
 * that can be tested and reasoned about.
 *
 * `falloffStart` is the fraction of the range at which fading begins. With the
 * default 0.5 and a range of 32, a speaker 16 blocks away is at full volume and
 * one 24 blocks away is at half.
 */
export function proximityGain(
  distance: number,
  voiceRange: number,
  falloffStart = DEFAULT_FALLOFF_START,
): number {
  if (!Number.isFinite(distance) || !Number.isFinite(voiceRange) || voiceRange <= 0) return 0;
  if (distance < 0) return 0;
  if (distance >= voiceRange) return 0;

  const start = voiceRange * Math.min(Math.max(falloffStart, 0), 1);
  if (distance <= start) return 1;

  const span = voiceRange - start;
  if (span <= 0) return 0;
  const gain = 1 - (distance - start) / span;
  return Math.min(1, Math.max(0, gain));
}

export const DEFAULT_FALLOFF_START = 0.5;

// ---------------------------------------------------------------------------
// Who can hear whom — the routing decision
// ---------------------------------------------------------------------------

export interface VoiceParticipant {
  /** Minecraft player name, as observed server-side by the BDS integration. */
  playerName: string;
  /** Stable OG VOICE session id, bound to (server, playerName) after linking. */
  sessionId: string;
  position: VoicePosition | null;
  /** True while the participant's microphone is actually transmitting. */
  micActive: boolean;
  /** True if the participant has deafened (hearing nobody). */
  deafened: boolean;
  /** Players this participant has individually muted. */
  mutedPlayers?: string[];
  /** Optional group/parties the participant belongs to. */
  groupIds?: string[];
}

export interface RoutingConfig {
  mode: VoiceMode;
  voiceRange: number;
  falloffStart?: number;
  /** When true, altitude is ignored so multi-storey builds share audio. */
  ignoreAltitude?: boolean;
}

export interface AudibleSpeaker {
  sessionId: string;
  playerName: string;
  /** 0..1 gain the companion should apply. 0 means do not play this track. */
  gain: number;
  /** Why this speaker is audible — surfaced in diagnostics, never guessed. */
  reason: 'proximity' | 'global' | 'group';
  distance: number | null;
}

/**
 * Decide which speakers a listener can hear, and at what gain.
 *
 * This is the authoritative routing rule and is deliberately a pure function so
 * it can be exhaustively tested: dimension separation, range cutoff, fade,
 * deafen, individual mute and group override are all privacy- or gameplay-relevant
 * and none of them may be approximated.
 *
 * Note what it does NOT do: it never grants microphone access. A participant is
 * only ever a candidate speaker if `micActive` is true, which is set by the
 * companion application after the device operating system has granted
 * permission and the player has explicitly unmuted. The server cannot make it
 * true — see docs/VOICE-ARCHITECTURE.md.
 */
export function computeAudibleSpeakers(
  listener: VoiceParticipant,
  participants: readonly VoiceParticipant[],
  config: RoutingConfig,
): AudibleSpeaker[] {
  if (config.mode === 'disabled') return [];
  // A deafened listener hears nobody, regardless of mode or groups.
  if (listener.deafened) return [];

  const muted = new Set(listener.mutedPlayers ?? []);
  const falloff = config.falloffStart ?? DEFAULT_FALLOFF_START;
  const groups = new Set(listener.groupIds ?? []);
  const out: AudibleSpeaker[] = [];

  for (const speaker of participants) {
    if (speaker.sessionId === listener.sessionId) continue; // never hear your own mic
    if (!speaker.micActive) continue; // nothing to route
    if (muted.has(speaker.playerName)) continue; // individual mute wins

    // A shared group is heard at full volume regardless of distance or
    // dimension — that is what makes party/team channels usable.
    const sharedGroup = (speaker.groupIds ?? []).find((g) => groups.has(g));
    if (sharedGroup) {
      out.push({
        sessionId: speaker.sessionId,
        playerName: speaker.playerName,
        gain: 1,
        reason: 'group',
        distance: distanceOrHorizontal(listener.position, speaker.position, config),
      });
      continue;
    }

    if (config.mode === 'global') {
      out.push({
        sessionId: speaker.sessionId,
        playerName: speaker.playerName,
        gain: 1,
        reason: 'global',
        distance: distanceOrHorizontal(listener.position, speaker.position, config),
      });
      continue;
    }

    // Proximity mode requires both positions to be known. If either is missing
    // we cannot compute a distance, so we do not route audio: guessing would
    // mean a player hears someone who may be in another dimension.
    if (!listener.position || !speaker.position) continue;

    // Dimension separation is absolute: no cross-dimension proximity audio.
    if (listener.position.dimension !== speaker.position.dimension) continue;

    const distance = config.ignoreAltitude
      ? horizontalDistance(listener.position, speaker.position)
      : distanceBetween(listener.position, speaker.position);

    const gain = proximityGain(distance, config.voiceRange, falloff);
    if (gain <= 0) continue;

    out.push({
      sessionId: speaker.sessionId,
      playerName: speaker.playerName,
      gain,
      reason: 'proximity',
      distance,
    });
  }

  return out;
}

function distanceOrHorizontal(
  a: VoicePosition | null,
  b: VoicePosition | null,
  config: RoutingConfig,
): number | null {
  if (!a || !b) return null;
  if (a.dimension !== b.dimension) return null;
  return config.ignoreAltitude ? horizontalDistance(a, b) : distanceBetween(a, b);
}

// ---------------------------------------------------------------------------
// Microphone / device permission states (§4)
// ---------------------------------------------------------------------------

/**
 * Device permission and microphone states.
 *
 * `PERMISSION_GRANTED` and `MIC_ACTIVE` are deliberately distinct. An
 * operating-system grant means the app *may* capture; it does not mean audio is
 * being transmitted. Conflating them is how a UI ends up telling a server owner
 * that a player's microphone is live when it is not — §4 forbids exactly that.
 */
export const PERMISSION_STATES = [
  'not_requested',
  'permission_required',
  'permission_granted',
  'permission_denied',
  'permission_permanently_denied',
  'permission_revoked',
  'mic_active',
  'mic_muted',
  'device_unavailable',
  'disconnected',
] as const;
export type PermissionState = (typeof PERMISSION_STATES)[number];

export function isValidPermissionState(state: string): state is PermissionState {
  return (PERMISSION_STATES as readonly string[]).includes(state);
}

/**
 * States in which the companion is capturing and transmitting audio right now.
 * Only `mic_active` qualifies. Nothing else may be displayed as "live".
 */
export function isTransmitting(state: PermissionState): boolean {
  return state === 'mic_active';
}

/** States where the operating system has said no, and re-prompting is futile. */
export function needsSettingsRedirect(state: PermissionState): boolean {
  return state === 'permission_permanently_denied' || state === 'permission_revoked';
}

/**
 * Can this state transition to that one?
 *
 * Modelled as an explicit table because the privacy rules in §4 are really
 * transition rules: capture must stop *immediately* on revoke, and a grant must
 * never by itself start transmission. Encoding them here means a UI cannot put
 * a player into an illegal state without a test failing.
 */
const PERMISSION_TRANSITIONS: Record<PermissionState, readonly PermissionState[]> = {
  not_requested: ['permission_required', 'disconnected'],
  permission_required: [
    'permission_granted',
    'permission_denied',
    'permission_permanently_denied',
    'device_unavailable',
    'disconnected',
  ],
  permission_granted: ['mic_active', 'mic_muted', 'permission_revoked', 'device_unavailable', 'disconnected'],
  permission_denied: ['permission_required', 'permission_permanently_denied', 'disconnected'],
  permission_permanently_denied: ['permission_required', 'disconnected'],
  permission_revoked: ['permission_required', 'mic_muted', 'disconnected'],
  mic_active: ['mic_muted', 'permission_revoked', 'device_unavailable', 'disconnected'],
  mic_muted: ['mic_active', 'permission_revoked', 'permission_granted', 'device_unavailable', 'disconnected'],
  device_unavailable: ['permission_granted', 'permission_required', 'disconnected'],
  disconnected: ['not_requested', 'permission_required'],
};

export function canTransitionPermission(from: PermissionState, to: PermissionState): boolean {
  if (from === to) return true;
  return PERMISSION_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Revocation must always be reachable from any capturing state, and must land on
 * a non-transmitting state. §4: "If permission is revoked while playing:
 * immediately stop microphone capture... Keep the player connected to Minecraft."
 */
export function revokeStopsTransmission(from: PermissionState): boolean {
  if (!isTransmitting(from)) return true;
  return canTransitionPermission(from, 'permission_revoked') && !isTransmitting('permission_revoked');
}

// ---------------------------------------------------------------------------
// Connection quality (§11)
// ---------------------------------------------------------------------------

/**
 * Voice connection quality, classified from **measured voice-session metrics**.
 *
 * §11 is explicit that ordinary internet ping must not be substituted for voice
 * quality, so this takes RTT, jitter and packet loss from the actual audio
 * session. Thresholds are stated here rather than hidden in a UI so they can be
 * reviewed and tuned against real measurements — they are initial values, not
 * scientifically derived ones, and §9 of the networking spec requires labelling
 * them as such.
 */
export const CONNECTION_QUALITIES = ['excellent', 'good', 'unstable', 'poor', 'disconnected'] as const;
export type ConnectionQuality = (typeof CONNECTION_QUALITIES)[number];

export interface VoiceMetrics {
  /** Round-trip time in milliseconds, measured on the voice session. */
  rttMs: number | null;
  /** Inter-arrival jitter in milliseconds. */
  jitterMs: number | null;
  /** Fraction of audio packets lost, 0..1. */
  packetLoss: number | null;
  connected: boolean;
}

export const QUALITY_THRESHOLDS = {
  excellent: { rttMs: 80, jitterMs: 20, packetLoss: 0.01 },
  good: { rttMs: 160, jitterMs: 50, packetLoss: 0.03 },
  unstable: { rttMs: 300, jitterMs: 120, packetLoss: 0.08 },
} as const;

export function classifyConnectionQuality(metrics: VoiceMetrics): ConnectionQuality {
  if (!metrics.connected) return 'disconnected';

  // Missing metrics must not be reported as excellent. An unknown measurement
  // is not evidence of a good connection.
  const { rttMs, jitterMs, packetLoss } = metrics;
  if (rttMs === null || jitterMs === null || packetLoss === null) return 'unstable';
  if (!Number.isFinite(rttMs) || !Number.isFinite(jitterMs) || !Number.isFinite(packetLoss)) return 'unstable';

  const { excellent, good, unstable } = QUALITY_THRESHOLDS;
  if (rttMs <= excellent.rttMs && jitterMs <= excellent.jitterMs && packetLoss <= excellent.packetLoss) {
    return 'excellent';
  }
  if (rttMs <= good.rttMs && jitterMs <= good.jitterMs && packetLoss <= good.packetLoss) return 'good';
  if (rttMs <= unstable.rttMs && jitterMs <= unstable.jitterMs && packetLoss <= unstable.packetLoss) {
    return 'unstable';
  }
  return 'poor';
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * Deterministic LiveKit room name for an OG HOST server.
 *
 * One room per Minecraft server. Proximity is then handled by per-listener gain
 * (see `computeAudibleSpeakers`) rather than by moving participants between
 * rooms, which keeps a single SFU room and is comfortably within bandwidth for
 * the 10-player design target.
 *
 * LiveKit room names must match `[A-Za-z0-9_-]+`, so the UUID is used verbatim
 * with a fixed prefix. The prefix also makes rooms identifiable in LiveKit's own
 * admin tooling without exposing anything sensitive.
 */
export function voiceRoomName(serverId: string): string {
  const cleaned = serverId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cleaned)) {
    throw new Error(`voiceRoomName: not a valid server id: ${serverId}`);
  }
  return `oghost-${cleaned}`;
}

/** LiveKit participant identity for a linked voice session. Must be stable. */
export function voiceParticipantIdentity(sessionId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    throw new Error('voiceParticipantIdentity: expected a session UUID');
  }
  return `p-${sessionId}`;
}

// ---------------------------------------------------------------------------
// Verification codes (§12)
// ---------------------------------------------------------------------------

/**
 * Verification code shape: 8 characters from an unambiguous alphabet, displayed
 * in-game and typed into a companion app on a phone.
 *
 * `0/O` and `1/I/L` are excluded because a player reads this off a Minecraft
 * screen, often small and often at a distance. §12 requires short-lived,
 * one-time, rate-limited codes; the entropy and lifetime are enforced by the
 * issuing API route and the database constraint, and this is the format both
 * sides agree on.
 */
export const VOICE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const VOICE_CODE_LENGTH = 8;
/**
 * Derived from the alphabet rather than written by hand.
 *
 * A hand-written `/^[A-Z2-9]{8}$/` looks equivalent and is not: it accepts O
 * and I, which the alphabet deliberately excludes. Deriving it means the format
 * check can never drift from the generator. The alphabet is alphanumeric only,
 * so interpolating it into a character class is safe.
 */
export const VOICE_CODE_RE = new RegExp(`^[${VOICE_CODE_ALPHABET}]{${VOICE_CODE_LENGTH}}$`);
export const VOICE_CODE_TTL_SECONDS = 120;
export const VOICE_CODE_MAX_ATTEMPTS = 5;

export function isValidVoiceCode(code: string): boolean {
  return VOICE_CODE_RE.test(code.trim().toUpperCase());
}

/** Normalise user input before comparison or hashing. */
export function normaliseVoiceCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, '');
}

/**
 * Entropy of a code, in bits. Exposed so the rate-limiting maths in the API
 * route is checkable rather than assumed: 8 characters from a 31-symbol
 * alphabet is ~39.7 bits, which is ample given a 120-second lifetime and a
 * 5-attempt cap — brute force would need ~2^39 tries in two minutes.
 */
export function voiceCodeEntropyBits(): number {
  return VOICE_CODE_LENGTH * Math.log2(VOICE_CODE_ALPHABET.length);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Short, honest label for a permission state — never implies capture it lacks. */
export function permissionStateLabel(state: PermissionState): string {
  switch (state) {
    case 'not_requested':
      return 'Microphone not requested';
    case 'permission_required':
      return 'Waiting for your device permission';
    case 'permission_granted':
      return 'Microphone allowed, not transmitting';
    case 'permission_denied':
      return 'Microphone denied — you can still listen';
    case 'permission_permanently_denied':
      return 'Microphone blocked in device settings';
    case 'permission_revoked':
      return 'Microphone permission revoked — capture stopped';
    case 'mic_active':
      return 'Microphone live';
    case 'mic_muted':
      return 'Microphone muted';
    case 'device_unavailable':
      return 'No microphone device available';
    case 'disconnected':
      return 'Voice disconnected';
  }
}
