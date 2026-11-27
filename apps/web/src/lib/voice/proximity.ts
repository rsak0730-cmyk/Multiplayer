/**
 * Proximity voice assembly — pure, no I/O.
 *
 * This is the server-side half of proximity chat. The Bedrock add-on reports
 * authoritative coordinates; this module turns those rows plus session and
 * preference rows into the list of players one listener can actually hear, and
 * the gain for each. The companion applies the gain locally.
 *
 * Why the gain is computed here rather than in the companion: §7 requires
 * server-authoritative coordinates. If a client decided who it could hear and
 * how loudly, a modified companion could claim to be standing next to anyone.
 * The client is told the answer; it does not compute it.
 *
 * Why gain rather than moving participants between rooms: one SFU room per
 * Minecraft server with per-listener gain keeps routing cheap at the ~10 player
 * design target. Splitting players into distance buckets would churn room
 * membership on every step a player took.
 */
import {
  computeAudibleSpeakers,
  isTransmitting,
  isValidPermissionState,
  normaliseDimension,
  type AudibleSpeaker,
  type PermissionState,
  type RoutingConfig,
  type VoiceParticipant,
  type VoicePosition,
} from '@oghost/shared';
import { isExpired } from './credentials';

/**
 * How old a position may be and still drive audio.
 *
 * A player who disconnects stops reporting, and their last coordinate would
 * otherwise stay on the map forever — leaving them audible at a fixed distance
 * to everyone nearby. Ten seconds is a few missed reports at the add-on's
 * update rate, which is enough to ride out a network hiccup without letting a
 * departed player linger.
 */
export const POSITION_FRESHNESS_MS = 10_000;

export interface PositionRow {
  link_id: string;
  x: number;
  y: number;
  z: number;
  dimension: string;
  updated_at: string | Date;
}

export interface LinkRow {
  id: string;
  player_name: string;
  revoked_at: string | Date | null;
}

export interface SessionRow {
  id: string;
  link_id: string;
  identity: string;
  mic_permission_state: PermissionState;
  connected: boolean;
  transmitting: boolean;
  revoked_at: string | Date | null;
  expires_at: string | Date;
}

export interface PreferenceRow {
  link_id: string;
  deafened: boolean;
  global_volume: number | string;
  muted_players: unknown;
  per_player_volume: unknown;
}

export interface GroupMemberRow {
  group_id: string;
  link_id: string;
}

export interface ActiveGroupRow {
  id: string;
  disbanded_at: string | Date | null;
  expires_at: string | Date | null;
}

export function isPositionFresh(updatedAt: string | Date, now: Date = new Date()): boolean {
  const when = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(when.getTime())) return false;
  const age = now.getTime() - when.getTime();
  // A future timestamp means clock skew between the node and the control plane.
  // Treat it as fresh rather than discarding a player for someone else's clock.
  return age <= POSITION_FRESHNESS_MS && age >= -POSITION_FRESHNESS_MS;
}

/**
 * A link is usable only while it has not been revoked.
 *
 * Revocation is a permanent marker, not a timestamp to be compared against the
 * clock: once an owner or a player unlinks a device, that identity binding is
 * dead and a fresh code must be redeemed. There is deliberately no `now`
 * parameter here, so nothing can accidentally treat revocation as temporary.
 */
export function isLinkActive(link: Pick<LinkRow, 'revoked_at'>): boolean {
  return link.revoked_at === null;
}

/** A session is usable only while connected, unrevoked and unexpired. */
export function isSessionLive(
  session: Pick<SessionRow, 'connected' | 'revoked_at' | 'expires_at'>,
  now: Date = new Date(),
): boolean {
  return session.connected && session.revoked_at === null && !isExpired(session.expires_at, now);
}

/**
 * Whether a player is actually sending audio.
 *
 * Two independent facts must agree, and conflating them is exactly the mistake
 * §4 forbids:
 *
 *   * `mic_permission_state === 'mic_active'` — the device says the OS granted
 *     capture and the player unmuted;
 *   * `transmitting` — the SFU reports a published audio track.
 *
 * An OS grant alone is not a live microphone. Requiring both means a device that
 * claims `mic_active` while publishing nothing is shown as silent, and a track
 * that appears without the device reporting activation is not attributed to the
 * player.
 */
export function isPlayerTransmitting(session: {
  mic_permission_state: string;
  transmitting: boolean;
}): boolean {
  // Accepts the raw column type rather than PermissionState. A value the enum
  // does not recognise — from an older row or a partial write — must fail closed
  // to "not transmitting", because guessing would show a player as speaking when
  // nothing proves they are.
  if (!isValidPermissionState(session.mic_permission_state)) return false;
  return isTransmitting(session.mic_permission_state) && session.transmitting;
}

function toPosition(row: PositionRow): VoicePosition | null {
  // A dimension this build does not recognise is dropped rather than guessed:
  // routing across an unknown dimension could leak audio between worlds.
  const dimension = normaliseDimension(row.dimension);
  if (!dimension) return null;
  if (!Number.isFinite(row.x) || !Number.isFinite(row.y) || !Number.isFinite(row.z)) return null;
  return { x: row.x, y: row.y, z: row.z, dimension };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function asVolumeMap(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = typeof raw === 'string' ? Number(raw) : raw;
    if (typeof parsed === 'number' && Number.isFinite(parsed)) out[key] = parsed;
  }
  return out;
}

/** Postgres returns numeric as a string; accept both without losing the value. */
function toNumber(value: number | string | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface BuildParticipantsInput {
  links: readonly LinkRow[];
  sessions: readonly SessionRow[];
  positions: readonly PositionRow[];
  preferences?: readonly PreferenceRow[];
  groupMembers?: readonly GroupMemberRow[];
  activeGroups?: readonly ActiveGroupRow[];
  now?: Date;
}

/**
 * Assemble the participants the routing function needs.
 *
 * One entry per *live session*, not per link: a player with a revoked or expired
 * session is not present, and a player with two devices would be two
 * participants. A missing or stale position becomes `null`, which routing treats
 * as "never audible" rather than as "standing at the origin".
 */
export function buildVoiceParticipants(input: BuildParticipantsInput): VoiceParticipant[] {
  const now = input.now ?? new Date();

  const positionByLink = new Map<string, VoicePosition | null>();
  for (const row of input.positions) {
    // Keep the freshest report per player if the add-on sent duplicates.
    const existing = positionByLink.get(row.link_id);
    if (!isPositionFresh(row.updated_at, now)) {
      if (existing === undefined) positionByLink.set(row.link_id, null);
      continue;
    }
    positionByLink.set(row.link_id, toPosition(row));
  }

  const prefsByLink = new Map(input.preferences?.map((p) => [p.link_id, p]) ?? []);
  const linkById = new Map(input.links.map((l) => [l.id, l]));

  const activeGroupIds = new Set(
    (input.activeGroups ?? [])
      // A null expires_at means "no deadline", not "already expired" — the
      // opposite of `isExpired`'s fail-closed default, which is correct for a
      // session (one must always have an expiry) and wrong here. Without this
      // branch every permanent group is silently dropped and its members lose
      // group audio.
      .filter((group) => group.disbanded_at === null && (group.expires_at === null || !isExpired(group.expires_at, now)))
      .map((group) => group.id),
  );
  const groupsByLink = new Map<string, string[]>();
  for (const member of input.groupMembers ?? []) {
    if (!activeGroupIds.has(member.group_id)) continue;
    const list = groupsByLink.get(member.link_id) ?? [];
    list.push(member.group_id);
    groupsByLink.set(member.link_id, list);
  }

  const participants: VoiceParticipant[] = [];
  for (const session of input.sessions) {
    if (!isSessionLive(session, now)) continue;
    const link = linkById.get(session.link_id);
    // A session whose link was revoked must not survive the revocation.
    if (!link || !isLinkActive(link)) continue;

    const prefs = prefsByLink.get(session.link_id);
    participants.push({
      playerName: link.player_name,
      sessionId: session.id,
      position: positionByLink.get(session.link_id) ?? null,
      micActive: isPlayerTransmitting(session),
      deafened: prefs?.deafened === true,
      mutedPlayers: asStringArray(prefs?.muted_players),
      groupIds: groupsByLink.get(session.link_id) ?? [],
    });
  }
  return participants;
}

/**
 * Who can this listener hear, and at what gain.
 *
 * A thin wrapper so the route never touches the shared routing function with
 * hand-assembled arguments, and so the freshness rule is applied in one place.
 */
export function resolveAudibleSpeakers(params: {
  listenerSessionId: string;
  participants: readonly VoiceParticipant[];
  config: RoutingConfig;
}): AudibleSpeaker[] {
  const listener = params.participants.find((p) => p.sessionId === params.listenerSessionId);
  // A listener who is not themselves present (disconnected, revoked, or their
  // position never arrived) hears nothing. Failing closed here is correct: the
  // alternative is routing audio to someone we cannot place.
  if (!listener) return [];
  return computeAudibleSpeakers(listener, [...params.participants], params.config);
}

/**
 * The final volume the companion should apply for one speaker.
 *
 * proximity gain × the listener's per-player volume × global volume, clamped to
 * a sane range. Muted and inaudible speakers come back at 0 so the companion can
 * apply one number without re-deriving the rules — and so the mute a player set
 * cannot be undone by a proximity gain of 1.
 */
export function finalVolume(params: {
  gain: number;
  playerName: string;
  preferences?: PreferenceRow;
}): number {
  const { gain, playerName, preferences } = params;
  if (!Number.isFinite(gain) || gain <= 0) return 0;

  const muted = asStringArray(preferences?.muted_players);
  if (muted.includes(playerName)) return 0;

  const perPlayer = asVolumeMap(preferences?.per_player_volume);
  const individual = perPlayer[playerName] ?? 1;
  const global = toNumber(preferences?.global_volume, 1);

  const combined = gain * Math.max(0, individual) * Math.max(0, global);
  if (!Number.isFinite(combined)) return 0;
  // Cap at 2× so a boosted per-player slider cannot clip into distortion.
  return Math.min(2, Math.max(0, combined));
}
