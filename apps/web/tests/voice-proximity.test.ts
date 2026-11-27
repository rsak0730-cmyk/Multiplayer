import { describe, expect, it } from 'vitest';
import {
  POSITION_FRESHNESS_MS,
  buildVoiceParticipants,
  finalVolume,
  isLinkActive,
  isPlayerTransmitting,
  isPositionFresh,
  isSessionLive,
  resolveAudibleSpeakers,
  type LinkRow,
  type PositionRow,
  type PreferenceRow,
  type SessionRow,
} from '../src/lib/voice/proximity';
import type { PermissionState } from '@oghost/shared';

const NOW = new Date('2026-11-27T12:00:00.000Z');

function link(id: string, name: string, revoked: string | null = null): LinkRow {
  return { id, player_name: name, revoked_at: revoked };
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    link_id: 'link-1',
    identity: 'p-sess-1',
    mic_permission_state: 'mic_active' as PermissionState,
    connected: true,
    transmitting: true,
    revoked_at: null,
    expires_at: new Date(NOW.getTime() + 60_000).toISOString(),
    ...overrides,
  };
}

function position(linkId: string, x: number, z: number, dimension = 'overworld', ageMs = 0): PositionRow {
  return {
    link_id: linkId,
    x,
    y: 64,
    z,
    dimension,
    updated_at: new Date(NOW.getTime() - ageMs).toISOString(),
  };
}

describe('isPositionFresh', () => {
  it('accepts a recent report', () => {
    expect(isPositionFresh(NOW.toISOString(), NOW)).toBe(true);
    expect(isPositionFresh(new Date(NOW.getTime() - 1000).toISOString(), NOW)).toBe(true);
    expect(isPositionFresh(new Date(NOW.getTime() - POSITION_FRESHNESS_MS).toISOString(), NOW)).toBe(true);
  });

  it('rejects a report older than the window', () => {
    // A player who disconnects stops reporting. Without this their last
    // coordinate would keep them audible at a fixed distance forever.
    expect(isPositionFresh(new Date(NOW.getTime() - POSITION_FRESHNESS_MS - 1).toISOString(), NOW)).toBe(false);
    expect(isPositionFresh(new Date(NOW.getTime() - 60_000).toISOString(), NOW)).toBe(false);
  });

  it('accepts a slightly future timestamp from node clock skew', () => {
    // Rejecting these would silence a player because someone else's clock is
    // fast, which is not the player's fault and not a security concern.
    expect(isPositionFresh(new Date(NOW.getTime() + 5_000).toISOString(), NOW)).toBe(true);
    expect(isPositionFresh(new Date(NOW.getTime() + POSITION_FRESHNESS_MS + 1).toISOString(), NOW)).toBe(false);
  });

  it('rejects an unparseable timestamp', () => {
    expect(isPositionFresh('not-a-date', NOW)).toBe(false);
    expect(isPositionFresh('', NOW)).toBe(false);
  });
});

describe('isLinkActive', () => {
  it('is active only while never revoked', () => {
    expect(isLinkActive(link('a', 'Steve'))).toBe(true);
    // Revocation is permanent, not a window: there is no `now` parameter, so
    // nothing can treat an unlink as temporary.
    expect(isLinkActive(link('a', 'Steve', NOW.toISOString()))).toBe(false);
    expect(isLinkActive(link('a', 'Steve', new Date(NOW.getTime() - 86_400_000).toISOString()))).toBe(false);
  });
});

describe('isSessionLive', () => {
  it('requires connected, unrevoked and unexpired', () => {
    expect(isSessionLive(session(), NOW)).toBe(true);
    expect(isSessionLive(session({ connected: false }), NOW)).toBe(false);
    expect(isSessionLive(session({ revoked_at: NOW.toISOString() }), NOW)).toBe(false);
    expect(isSessionLive(session({ expires_at: new Date(NOW.getTime() - 1).toISOString() }), NOW)).toBe(false);
  });

  it('treats an unparseable expiry as expired', () => {
    expect(isSessionLive(session({ expires_at: 'garbage' }), NOW)).toBe(false);
  });
});

describe('isPlayerTransmitting', () => {
  it('requires BOTH the device reporting mic_active AND a published track', () => {
    // This is the §4 invariant: an OS grant is not a live microphone, and a track
    // appearing without the device reporting activation is not attributed to the
    // player either. Both facts must agree.
    expect(isPlayerTransmitting({ mic_permission_state: 'mic_active', transmitting: true })).toBe(true);
    expect(isPlayerTransmitting({ mic_permission_state: 'mic_active', transmitting: false })).toBe(false);
    expect(isPlayerTransmitting({ mic_permission_state: 'permission_granted', transmitting: true })).toBe(false);
    expect(isPlayerTransmitting({ mic_permission_state: 'mic_muted', transmitting: true })).toBe(false);
  });

  it('is false for every non-transmitting state, whatever the track flag says', () => {
    const states: PermissionState[] = [
      'not_requested',
      'permission_required',
      'permission_granted',
      'permission_denied',
      'permission_permanently_denied',
      'permission_revoked',
      'mic_muted',
      'device_unavailable',
      'disconnected',
    ];
    for (const state of states) {
      expect(isPlayerTransmitting({ mic_permission_state: state, transmitting: true }), state).toBe(false);
      expect(isPlayerTransmitting({ mic_permission_state: state, transmitting: false }), state).toBe(false);
    }
  });

  it('fails closed on an unrecognised state', () => {
    // An unknown value must never be read as "speaking".
    expect(isPlayerTransmitting({ mic_permission_state: 'mic_on', transmitting: true })).toBe(false);
    expect(isPlayerTransmitting({ mic_permission_state: '', transmitting: true })).toBe(false);
  });
});

describe('buildVoiceParticipants', () => {
  const links = [link('link-1', 'Steve'), link('link-2', 'Alex')];

  it('includes one participant per live session', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions: [session(), session({ id: 'sess-2', link_id: 'link-2', identity: 'p-sess-2' })],
      positions: [position('link-1', 0, 0), position('link-2', 10, 0)],
      now: NOW,
    });
    expect(participants).toHaveLength(2);
    expect(participants.map((p) => p.playerName).sort()).toEqual(['Alex', 'Steve']);
  });

  it('excludes a disconnected, revoked or expired session', () => {
    for (const dead of [
      session({ connected: false }),
      session({ revoked_at: NOW.toISOString() }),
      session({ expires_at: new Date(NOW.getTime() - 1).toISOString() }),
    ]) {
      const participants = buildVoiceParticipants({ links, sessions: [dead], positions: [], now: NOW });
      expect(participants).toHaveLength(0);
    }
  });

  it('excludes a session whose link was revoked', () => {
    // Unlinking a device must end its presence immediately, even if the session
    // row itself has not been revoked yet.
    const participants = buildVoiceParticipants({
      links: [link('link-1', 'Steve', NOW.toISOString())],
      sessions: [session()],
      positions: [position('link-1', 0, 0)],
      now: NOW,
    });
    expect(participants).toHaveLength(0);
  });

  it('excludes a session whose link is missing entirely', () => {
    const participants = buildVoiceParticipants({
      links: [],
      sessions: [session()],
      positions: [position('link-1', 0, 0)],
      now: NOW,
    });
    expect(participants).toHaveLength(0);
  });

  it('sets micActive from both the state and the track flag', () => {
    const active = buildVoiceParticipants({ links, sessions: [session()], positions: [], now: NOW });
    expect(active[0].micActive).toBe(true);

    const grantedOnly = buildVoiceParticipants({
      links,
      sessions: [session({ mic_permission_state: 'permission_granted' as PermissionState })],
      positions: [],
      now: NOW,
    });
    expect(grantedOnly[0].micActive).toBe(false);
  });

  it('turns a stale position into null rather than keeping the old coordinate', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions: [session()],
      positions: [position('link-1', 100, 100, 'overworld', POSITION_FRESHNESS_MS + 5_000)],
      now: NOW,
    });
    expect(participants[0].position).toBeNull();
  });

  it('turns an unrecognised dimension into null rather than guessing', () => {
    // A guess here is how cross-dimension audio would leak.
    const participants = buildVoiceParticipants({
      links,
      sessions: [session()],
      positions: [{ ...position('link-1', 0, 0), dimension: 'minecraft:the_nether' }],
      now: NOW,
    });
    expect(participants[0].position).toBeNull();
  });

  it('normalises the dimension BDS actually reports', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions: [session()],
      positions: [{ ...position('link-1', 0, 0), dimension: 'minecraft:nether' }],
      now: NOW,
    });
    expect(participants[0].position?.dimension).toBe('nether');
  });

  it('drops a non-finite coordinate', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions: [session()],
      positions: [{ ...position('link-1', 0, 0), x: Number.NaN }],
      now: NOW,
    });
    expect(participants[0].position).toBeNull();
  });

  it('keeps the freshest position when the add-on sends duplicates', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions: [session()],
      positions: [position('link-1', 500, 500, 'overworld', 8_000), position('link-1', 1, 1, 'overworld', 100)],
      now: NOW,
    });
    expect(participants[0].position).toMatchObject({ x: 1, z: 1 });
  });

  it('carries deafen and the individual mute list from preferences', () => {
    const prefs: PreferenceRow[] = [
      { link_id: 'link-1', deafened: true, global_volume: '0.80', muted_players: ['Alex'], per_player_volume: {} },
    ];
    const participants = buildVoiceParticipants({ links, sessions: [session()], positions: [], preferences: prefs, now: NOW });
    expect(participants[0].deafened).toBe(true);
    expect(participants[0].mutedPlayers).toEqual(['Alex']);
  });

  it('tolerates malformed preference JSON instead of throwing', () => {
    // Preferences come from a jsonb column a companion app writes. A wrong shape
    // must degrade to "no mutes", not break routing for the whole server.
    const prefs = [
      { link_id: 'link-1', deafened: 'yes', global_volume: null, muted_players: 'Alex', per_player_volume: ['Alex'] },
    ] as unknown as PreferenceRow[];
    const participants = buildVoiceParticipants({ links, sessions: [session()], positions: [], preferences: prefs, now: NOW });
    expect(participants[0].deafened).toBe(false);
    expect(participants[0].mutedPlayers).toEqual([]);
  });

  it('includes only members of groups that are still standing', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions: [session(), session({ id: 'sess-2', link_id: 'link-2' })],
      positions: [],
      groupMembers: [
        { group_id: 'g-active', link_id: 'link-1' },
        { group_id: 'g-disbanded', link_id: 'link-1' },
        { group_id: 'g-expired', link_id: 'link-2' },
      ],
      activeGroups: [
        { id: 'g-active', disbanded_at: null, expires_at: null },
        { id: 'g-disbanded', disbanded_at: NOW.toISOString(), expires_at: null },
        { id: 'g-expired', disbanded_at: null, expires_at: new Date(NOW.getTime() - 1).toISOString() },
      ],
      now: NOW,
    });
    expect(participants.find((p) => p.playerName === 'Steve')?.groupIds).toEqual(['g-active']);
    expect(participants.find((p) => p.playerName === 'Alex')?.groupIds).toEqual([]);
  });

  it('includes a temporary group that has not yet reached its deadline', () => {
    // The other branch of the null-expiry rule: a group WITH a deadline stays
    // active until it passes, so a party room does not vanish early.
    const participants = buildVoiceParticipants({
      links,
      sessions: [session()],
      positions: [],
      groupMembers: [{ group_id: 'g-timed', link_id: 'link-1' }],
      activeGroups: [{ id: 'g-timed', disbanded_at: null, expires_at: new Date(NOW.getTime() + 60_000).toISOString() }],
      now: NOW,
    });
    expect(participants[0].groupIds).toEqual(['g-timed']);
  });

  it('drops a temporary group once its deadline has passed', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions: [session()],
      positions: [],
      groupMembers: [{ group_id: 'g-timed', link_id: 'link-1' }],
      activeGroups: [{ id: 'g-timed', disbanded_at: null, expires_at: new Date(NOW.getTime() - 1).toISOString() }],
      now: NOW,
    });
    expect(participants[0].groupIds).toEqual([]);
  });
});

describe('resolveAudibleSpeakers', () => {
  const links = [link('link-1', 'Steve'), link('link-2', 'Alex')];
  const sessions = [session(), session({ id: 'sess-2', link_id: 'link-2', identity: 'p-sess-2' })];
  const config = { mode: 'proximity' as const, voiceRange: 32 };

  it('routes a nearby speaker with the correct gain', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions,
      positions: [position('link-1', 0, 0), position('link-2', 24, 0)],
      now: NOW,
    });
    const heard = resolveAudibleSpeakers({ listenerSessionId: 'sess-1', participants, config });
    expect(heard).toHaveLength(1);
    expect(heard[0].playerName).toBe('Alex');
    expect(heard[0].gain).toBeCloseTo(0.5, 10);
  });

  it('SEPARATES DIMENSIONS end to end, from database rows to the audible list', () => {
    // Same coordinates, different dimension: the whole point of §7's rule.
    const participants = buildVoiceParticipants({
      links,
      sessions,
      positions: [position('link-1', 0, 0, 'overworld'), position('link-2', 0, 0, 'nether')],
      now: NOW,
    });
    expect(resolveAudibleSpeakers({ listenerSessionId: 'sess-1', participants, config })).toEqual([]);
  });

  it('returns nothing when the listener is not present', () => {
    // Failing closed: routing audio to someone we cannot place is worse than
    // routing nothing.
    const participants = buildVoiceParticipants({ links, sessions: [sessions[1]], positions: [], now: NOW });
    expect(resolveAudibleSpeakers({ listenerSessionId: 'sess-1', participants, config })).toEqual([]);
    expect(resolveAudibleSpeakers({ listenerSessionId: 'sess-unknown', participants: [], config })).toEqual([]);
  });

  it('routes nothing when a speaker has no fresh position', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions,
      positions: [position('link-1', 0, 0)], // Alex never reported
      now: NOW,
    });
    expect(resolveAudibleSpeakers({ listenerSessionId: 'sess-1', participants, config })).toEqual([]);
  });

  it('honours global mode by ignoring distance', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions,
      positions: [position('link-1', 0, 0), position('link-2', 5000, 5000)],
      now: NOW,
    });
    const heard = resolveAudibleSpeakers({
      listenerSessionId: 'sess-1',
      participants,
      config: { mode: 'global', voiceRange: 32 },
    });
    expect(heard).toHaveLength(1);
    expect(heard[0].gain).toBe(1);
  });

  it('honours disabled mode by routing nobody', () => {
    const participants = buildVoiceParticipants({
      links,
      sessions,
      positions: [position('link-1', 0, 0), position('link-2', 1, 0)],
      now: NOW,
    });
    expect(
      resolveAudibleSpeakers({ listenerSessionId: 'sess-1', participants, config: { mode: 'disabled', voiceRange: 32 } }),
    ).toEqual([]);
  });
});

describe('finalVolume', () => {
  it('applies proximity gain when the listener has no preferences', () => {
    expect(finalVolume({ gain: 0.5, playerName: 'Alex' })).toBe(0.5);
    expect(finalVolume({ gain: 1, playerName: 'Alex' })).toBe(1);
  });

  it('returns 0 for a silent or non-finite gain', () => {
    expect(finalVolume({ gain: 0, playerName: 'Alex' })).toBe(0);
    expect(finalVolume({ gain: -1, playerName: 'Alex' })).toBe(0);
    expect(finalVolume({ gain: Number.NaN, playerName: 'Alex' })).toBe(0);
  });

  it('lets an individual mute beat a proximity gain of 1', () => {
    // A mute the player set must not be undone by standing closer.
    const prefs: PreferenceRow = {
      link_id: 'l',
      deafened: false,
      global_volume: 1,
      muted_players: ['Alex'],
      per_player_volume: {},
    };
    expect(finalVolume({ gain: 1, playerName: 'Alex', preferences: prefs })).toBe(0);
    expect(finalVolume({ gain: 1, playerName: 'Steve', preferences: prefs })).toBe(1);
  });

  it('multiplies per-player and global volume', () => {
    const prefs: PreferenceRow = {
      link_id: 'l',
      deafened: false,
      global_volume: 0.5,
      muted_players: [],
      per_player_volume: { Alex: 0.5 },
    };
    expect(finalVolume({ gain: 1, playerName: 'Alex', preferences: prefs })).toBeCloseTo(0.25, 10);
    expect(finalVolume({ gain: 0.5, playerName: 'Alex', preferences: prefs })).toBeCloseTo(0.125, 10);
    expect(finalVolume({ gain: 1, playerName: 'Steve', preferences: prefs })).toBeCloseTo(0.5, 10);
  });

  it('handles numeric columns arriving as strings from Postgres', () => {
    // numeric comes back as text through the driver. Treating "0.50" as absent
    // would silently reset every player's volume to unity.
    const prefs: PreferenceRow = {
      link_id: 'l',
      deafened: false,
      global_volume: '0.50',
      muted_players: [],
      per_player_volume: { Alex: '0.25' },
    };
    expect(finalVolume({ gain: 1, playerName: 'Alex', preferences: prefs })).toBeCloseTo(0.125, 10);
  });

  it('clamps to 2 so a boosted slider cannot clip', () => {
    const prefs: PreferenceRow = {
      link_id: 'l',
      deafened: false,
      global_volume: 2,
      muted_players: [],
      per_player_volume: { Alex: 5 },
    };
    expect(finalVolume({ gain: 1, playerName: 'Alex', preferences: prefs })).toBe(2);
  });

  it('treats a negative or garbage volume as silence rather than inverting audio', () => {
    const prefs: PreferenceRow = {
      link_id: 'l',
      deafened: false,
      global_volume: 'not-a-number',
      muted_players: [],
      per_player_volume: { Alex: -3 },
    };
    expect(finalVolume({ gain: 1, playerName: 'Alex', preferences: prefs })).toBe(0);
    // A garbage global falls back to unity rather than to zero, so one bad
    // column does not deafen everyone.
    expect(finalVolume({ gain: 1, playerName: 'Steve', preferences: prefs })).toBe(1);
  });
});
