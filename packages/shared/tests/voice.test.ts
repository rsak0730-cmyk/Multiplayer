import { describe, expect, it } from 'vitest';
import {
  BEDROCK_DIMENSIONS,
  DEFAULT_FALLOFF_START,
  MAX_VOICE_RANGE,
  MIN_VOICE_RANGE,
  PERMISSION_STATES,
  QUALITY_THRESHOLDS,
  VOICE_CODE_ALPHABET,
  VOICE_CODE_LENGTH,
  VOICE_CODE_MAX_ATTEMPTS,
  VOICE_CODE_TTL_SECONDS,
  VOICE_MODES,
  VOICE_RANGE_PRESETS,
  canTransitionPermission,
  classifyConnectionQuality,
  computeAudibleSpeakers,
  distanceBetween,
  horizontalDistance,
  isTransmitting,
  isValidPermissionState,
  isValidVoiceCode,
  isValidVoiceMode,
  isValidVoiceRange,
  needsSettingsRedirect,
  normaliseDimension,
  normaliseVoiceCode,
  permissionStateLabel,
  proximityGain,
  resolveVoiceRange,
  revokeStopsTransmission,
  voiceCodeEntropyBits,
  voiceParticipantIdentity,
  voiceRoomName,
  type VoiceParticipant,
  type VoicePosition,
} from '../src/voice';

const at = (x: number, y: number, z: number, dimension: VoicePosition['dimension'] = 'overworld'): VoicePosition => ({
  x,
  y,
  z,
  dimension,
});

function participant(overrides: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return {
    playerName: 'Steve',
    sessionId: '11111111-1111-4111-8111-111111111111',
    position: at(0, 64, 0),
    micActive: true,
    deafened: false,
    ...overrides,
  };
}

describe('dimension handling', () => {
  it.each(BEDROCK_DIMENSIONS)('accepts %s', (dimension) => {
    expect(normaliseDimension(dimension)).toBe(dimension);
  });

  it.each([
    ['minecraft:overworld', 'overworld'],
    ['Minecraft:Nether', 'nether'],
    ['minecraft:the_end', 'the end'],
    [' the end ', 'the end'],
    ['THEEND', 'the end'],
  ] as const)('normalises %j to %j', (raw, expected) => {
    expect(normaliseDimension(raw)).toBe(expected);
  });

  it.each(['', 'overworld2', 'end', 'the_end', 'minecraft:void', 'nether_', 'the nether', 'overworldx'])(
    'rejects %j',
    (raw) => {
      expect(normaliseDimension(raw)).toBeNull();
    },
  );

  it('recognises exactly the three dimensions official BDS reports', () => {
    expect(BEDROCK_DIMENSIONS).toEqual(['overworld', 'nether', 'the end']);
  });
});

describe('distance', () => {
  it('computes straight-line 3D distance', () => {
    expect(distanceBetween(at(0, 0, 0), at(3, 0, 4))).toBe(5);
    expect(distanceBetween(at(0, 0, 0), at(0, 0, 0))).toBe(0);
  });

  it('counts altitude, so separate floors are not treated as adjacent', () => {
    // A tower: 3 blocks across, 40 up. Ignoring Y would report 3 blocks and let
    // two players on different floors hear each other at full volume.
    const a = at(0, 64, 0);
    const b = at(3, 104, 4);
    expect(distanceBetween(a, b)).toBeCloseTo(Math.sqrt(9 + 1600 + 16), 10);
    expect(horizontalDistance(a, b)).toBe(5);
    expect(horizontalDistance(a, b)).toBeLessThan(distanceBetween(a, b));
  });

  it('is symmetric', () => {
    const a = at(10, 64, -20);
    const b = at(-5, 80, 33);
    expect(distanceBetween(a, b)).toBe(distanceBetween(b, a));
  });
});

describe('voice range', () => {
  it('matches the spec example presets', () => {
    expect(VOICE_RANGE_PRESETS).toEqual({ short: 16, normal: 32, long: 64, extended: 128 });
  });

  it.each([MIN_VOICE_RANGE, 16, 32, 64, 128, MAX_VOICE_RANGE])('accepts %d', (range) => {
    expect(isValidVoiceRange(range)).toBe(true);
  });

  it('accepts a fractional range, since distance is continuous', () => {
    // A slider can produce 32.5 blocks and the gain maths handles it exactly;
    // forcing integers would reject a legitimate value for no benefit.
    expect(isValidVoiceRange(32.5)).toBe(true);
    expect(proximityGain(32.5, 32.5)).toBe(0);
    expect(proximityGain(24, 32.5)).toBeGreaterThan(0);
  });

  it.each([0, -1, MIN_VOICE_RANGE - 1, MAX_VOICE_RANGE + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects %s',
    (range) => {
      expect(isValidVoiceRange(range)).toBe(false);
    },
  );

  it('resolves both presets and raw numbers, and refuses invalid input', () => {
    expect(resolveVoiceRange('normal')).toBe(32);
    expect(resolveVoiceRange('extended')).toBe(128);
    expect(resolveVoiceRange(48)).toBe(48);
    expect(resolveVoiceRange(2)).toBeNull();
    expect(resolveVoiceRange('not-a-preset' as never)).toBeNull();
  });

  it('validates modes', () => {
    expect(VOICE_MODES).toEqual(['proximity', 'global', 'disabled']);
    for (const mode of VOICE_MODES) expect(isValidVoiceMode(mode)).toBe(true);
    expect(isValidVoiceMode('nearby')).toBe(false);
    expect(isValidVoiceMode('')).toBe(false);
  });
});

describe('proximityGain fade curve', () => {
  const range = 32;

  it('is full volume inside the falloff start', () => {
    expect(proximityGain(0, range)).toBe(1);
    expect(proximityGain(8, range)).toBe(1);
    expect(proximityGain(16, range)).toBe(1); // exactly at 0.5 * range
  });

  it('fades linearly to silence at the range boundary', () => {
    expect(proximityGain(24, range)).toBeCloseTo(0.5, 10);
    expect(proximityGain(28, range)).toBeCloseTo(0.25, 10);
    expect(proximityGain(31.9, range)).toBeGreaterThan(0);
    expect(proximityGain(range, range)).toBe(0); // exactly at range is silent
  });

  it('is silent beyond the range', () => {
    expect(proximityGain(33, range)).toBe(0);
    expect(proximityGain(1000, range)).toBe(0);
  });

  it('never exceeds 1 or goes below 0 for any input', () => {
    for (const distance of [-100, -1, 0, 1, 15.9, 16, 16.1, 24, 31.99, 32, 33, 1e9]) {
      const gain = proximityGain(distance, range);
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });

  it('returns 0 rather than NaN for unusable configuration', () => {
    expect(proximityGain(10, 0)).toBe(0);
    expect(proximityGain(10, -5)).toBe(0);
    expect(proximityGain(Number.NaN, range)).toBe(0);
    expect(proximityGain(10, Number.NaN)).toBe(0);
  });

  it('honours a custom falloff start', () => {
    // falloffStart 0.75 of range 40 → full until 30, silent at 40.
    expect(proximityGain(30, 40, 0.75)).toBe(1);
    expect(proximityGain(35, 40, 0.75)).toBeCloseTo(0.5, 10);
    expect(proximityGain(40, 40, 0.75)).toBe(0);
  });

  it('clamps an out-of-range falloff start instead of producing nonsense', () => {
    // falloffStart -1 clamps to 0: fading begins immediately, so gain at 5 of 32
    // is 1 - 5/32 rather than a negative-start artefact.
    expect(proximityGain(0, 32, -1)).toBe(1);
    expect(proximityGain(5, 32, -1)).toBeCloseTo(1 - 5 / 32, 10);

    // falloffStart 2 clamps to 1: full volume until the range boundary itself.
    expect(proximityGain(31, 32, 2)).toBe(1);
    expect(proximityGain(32, 32, 2)).toBe(0);
  });

  it('is monotonically non-increasing with distance', () => {
    let previous = 1;
    for (let d = 0; d <= 40; d += 0.5) {
      const gain = proximityGain(d, range);
      expect(gain, `gain increased at distance ${d}`).toBeLessThanOrEqual(previous);
      previous = gain;
    }
  });

  it('defaults the falloff start to half the range', () => {
    expect(DEFAULT_FALLOFF_START).toBe(0.5);
  });
});

describe('computeAudibleSpeakers — proximity mode', () => {
  const config = { mode: 'proximity' as const, voiceRange: 32 };

  it('routes a nearby speaker with the correct gain', () => {
    const listener = participant({ position: at(0, 64, 0) });
    const speaker = participant({
      playerName: 'Alex',
      sessionId: '22222222-2222-4222-8222-222222222222',
      position: at(24, 64, 0),
    });

    const heard = computeAudibleSpeakers(listener, [speaker], config);
    expect(heard).toHaveLength(1);
    expect(heard[0].playerName).toBe('Alex');
    expect(heard[0].gain).toBeCloseTo(0.5, 10);
    expect(heard[0].reason).toBe('proximity');
    expect(heard[0].distance).toBeCloseTo(24, 10);
  });

  it('SEPARATES DIMENSIONS — a speaker in the Nether is never heard in the Overworld', () => {
    const listener = participant({ position: at(0, 64, 0, 'overworld') });
    const speakers = [
      participant({ playerName: 'Netherite', sessionId: '22222222-2222-4222-8222-222222222222', position: at(0, 64, 0, 'nether') }),
      participant({ playerName: 'Ender', sessionId: '33333333-3333-4333-8333-333333333333', position: at(0, 64, 0, 'the end') }),
    ];
    // Identical coordinates, different dimensions: zero audio must be routed.
    expect(computeAudibleSpeakers(listener, speakers, config)).toEqual([]);
  });

  it('routes two players at the same coordinates in the same dimension', () => {
    const listener = participant({ position: at(100, 64, 100, 'nether') });
    const speaker = participant({
      playerName: 'Alex',
      sessionId: '22222222-2222-4222-8222-222222222222',
      position: at(100, 64, 100, 'nether'),
    });
    const heard = computeAudibleSpeakers(listener, [speaker], config);
    expect(heard).toHaveLength(1);
    expect(heard[0].gain).toBe(1);
  });

  it('cuts off exactly at the configured range', () => {
    const speaker = (z: number) =>
      participant({ playerName: 'Alex', sessionId: '22222222-2222-4222-8222-222222222222', position: at(0, 64, z) });
    const listener = participant({ position: at(0, 64, 0) });

    expect(computeAudibleSpeakers(listener, [speaker(31.9)], config)).toHaveLength(1);
    expect(computeAudibleSpeakers(listener, [speaker(32)], config)).toHaveLength(0);
    expect(computeAudibleSpeakers(listener, [speaker(200)], config)).toHaveLength(0);
  });

  it('never routes a speaker whose microphone is not transmitting', () => {
    // This is the privacy invariant: micActive is set by the companion after the
    // OS grants permission AND the player unmutes. The server cannot set it.
    const listener = participant({ position: at(0, 64, 0) });
    const silent = participant({
      playerName: 'Alex',
      sessionId: '22222222-2222-4222-8222-222222222222',
      position: at(2, 64, 0),
      micActive: false,
    });
    expect(computeAudibleSpeakers(listener, [silent], config)).toEqual([]);
  });

  it('never routes the listener their own microphone', () => {
    const listener = participant({ position: at(0, 64, 0) });
    expect(computeAudibleSpeakers(listener, [listener], config)).toEqual([]);
  });

  it('honours an individual mute even at point-blank range', () => {
    const listener = participant({ position: at(0, 64, 0), mutedPlayers: ['Alex'] });
    const speaker = participant({
      playerName: 'Alex',
      sessionId: '22222222-2222-4222-8222-222222222222',
      position: at(1, 64, 0),
    });
    expect(computeAudibleSpeakers(listener, [speaker], config)).toEqual([]);
  });

  it('deafen silences everything, including groups', () => {
    const listener = participant({ position: at(0, 64, 0), deafened: true, groupIds: ['party'] });
    const speaker = participant({
      playerName: 'Alex',
      sessionId: '22222222-2222-4222-8222-222222222222',
      position: at(1, 64, 0),
      groupIds: ['party'],
    });
    expect(computeAudibleSpeakers(listener, [speaker], config)).toEqual([]);
  });

  it('routes nothing when either position is unknown, rather than guessing', () => {
    const listener = participant({ position: null });
    const speaker = participant({
      playerName: 'Alex',
      sessionId: '22222222-2222-4222-8222-222222222222',
      position: at(1, 64, 0),
    });
    // Guessing here could mean hearing someone in another dimension.
    expect(computeAudibleSpeakers(listener, [speaker], config)).toEqual([]);
    expect(computeAudibleSpeakers(participant(), [{ ...speaker, position: null }], config)).toEqual([]);
  });

  it('respects ignoreAltitude for multi-storey builds', () => {
    const listener = participant({ position: at(0, 64, 0) });
    const above = participant({
      playerName: 'Alex',
      sessionId: '22222222-2222-4222-8222-222222222222',
      position: at(0, 104, 0), // 40 blocks straight up
    });
    expect(computeAudibleSpeakers(listener, [above], config)).toEqual([]);
    const heard = computeAudibleSpeakers(listener, [above], { ...config, ignoreAltitude: true });
    expect(heard).toHaveLength(1);
    expect(heard[0].gain).toBe(1);
  });

  it('handles several speakers with independent gains', () => {
    const listener = participant({ position: at(0, 64, 0) });
    const mk = (name: string, z: number) =>
      participant({ playerName: name, sessionId: `${name}-${'2'.repeat(31)}`.slice(0, 36), position: at(0, 64, z) });
    const heard = computeAudibleSpeakers(listener, [mk('A', 4), mk('B', 24), mk('C', 80)], config);
    expect(heard.map((h) => h.playerName).sort()).toEqual(['A', 'B']);
    expect(heard.find((h) => h.playerName === 'A')!.gain).toBe(1);
    expect(heard.find((h) => h.playerName === 'B')!.gain).toBeCloseTo(0.5, 10);
  });
});

describe('computeAudibleSpeakers — global, group and disabled modes', () => {
  const alex = (overrides: Partial<VoiceParticipant> = {}) =>
    participant({
      playerName: 'Alex',
      sessionId: '22222222-2222-4222-8222-222222222222',
      position: at(500, 64, 500),
      ...overrides,
    });

  it('global mode ignores distance but still separates nothing it should not', () => {
    const listener = participant({ position: at(0, 64, 0) });
    const heard = computeAudibleSpeakers(listener, [alex()], { mode: 'global', voiceRange: 32 });
    expect(heard).toHaveLength(1);
    expect(heard[0].gain).toBe(1);
    expect(heard[0].reason).toBe('global');
  });

  it('global mode still respects deafen, individual mute and mic state', () => {
    const config = { mode: 'global' as const, voiceRange: 32 };
    expect(computeAudibleSpeakers(participant({ deafened: true }), [alex()], config)).toEqual([]);
    expect(
      computeAudibleSpeakers(participant({ mutedPlayers: ['Alex'] }), [alex()], config),
    ).toEqual([]);
    expect(computeAudibleSpeakers(participant(), [alex({ micActive: false })], config)).toEqual([]);
  });

  it('a shared group is heard across distance and across dimensions', () => {
    // Party/team channels must work regardless of where members are — that is
    // their whole purpose — but only for members of the same group.
    const listener = participant({ position: at(0, 64, 0, 'overworld'), groupIds: ['party-1'] });
    const farAway = alex({ position: at(9000, 30, -9000, 'nether'), groupIds: ['party-1'] });

    const heard = computeAudibleSpeakers(listener, [farAway], { mode: 'proximity', voiceRange: 32 });
    expect(heard).toHaveLength(1);
    expect(heard[0].reason).toBe('group');
    expect(heard[0].gain).toBe(1);
    // Distance across dimensions is not meaningful, so it is reported as null
    // rather than as a fabricated number.
    expect(heard[0].distance).toBeNull();
  });

  it('does not admit a player to a group they are not in', () => {
    // §7: "Do not allow unauthorized players to join private voice groups."
    const listener = participant({ position: at(0, 64, 0), groupIds: ['party-1'] });
    const outsider = alex({ position: at(9000, 64, 9000), groupIds: ['party-2'] });
    expect(computeAudibleSpeakers(listener, [outsider], { mode: 'proximity', voiceRange: 32 })).toEqual([]);
  });

  it('an individual mute overrides a shared group', () => {
    const listener = participant({ groupIds: ['party-1'], mutedPlayers: ['Alex'] });
    expect(
      computeAudibleSpeakers(listener, [alex({ groupIds: ['party-1'] })], { mode: 'proximity', voiceRange: 32 }),
    ).toEqual([]);
  });

  it('disabled mode routes nothing at all', () => {
    const listener = participant({ groupIds: ['party-1'] });
    const speaker = alex({ groupIds: ['party-1'] });
    expect(computeAudibleSpeakers(listener, [speaker], { mode: 'disabled', voiceRange: 32 })).toEqual([]);
  });
});

describe('permission states (§4)', () => {
  it('exposes every state the spec requires', () => {
    expect(PERMISSION_STATES).toEqual([
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
    ]);
    for (const state of PERMISSION_STATES) expect(isValidPermissionState(state)).toBe(true);
    expect(isValidPermissionState('mic_on')).toBe(false);
  });

  it('treats ONLY mic_active as transmitting', () => {
    // An OS grant is not a live microphone. Confusing them is how a dashboard
    // tells a server owner a player is transmitting when they are not.
    for (const state of PERMISSION_STATES) {
      expect(isTransmitting(state), `isTransmitting(${state})`).toBe(state === 'mic_active');
    }
  });

  it('a granted permission never transitions straight to transmitting', () => {
    // Granting OS permission must not silently start capture; the player has to
    // unmute. privacy rule: "No microphone activation without player consent."
    expect(canTransitionPermission('permission_granted', 'mic_active')).toBe(true);
    expect(canTransitionPermission('not_requested', 'mic_active')).toBe(false);
    expect(canTransitionPermission('permission_required', 'mic_active')).toBe(false);
    expect(canTransitionPermission('permission_denied', 'mic_active')).toBe(false);
  });

  it('revocation is reachable from every capturing state and stops transmission', () => {
    for (const state of PERMISSION_STATES) {
      expect(revokeStopsTransmission(state), `revokeStopsTransmission(${state})`).toBe(true);
    }
    expect(canTransitionPermission('mic_active', 'permission_revoked')).toBe(true);
    expect(isTransmitting('permission_revoked')).toBe(false);
  });

  it('keeps the player connected to Minecraft when the mic is revoked', () => {
    // Revocation must not disconnect the voice session, only stop capture.
    expect(canTransitionPermission('mic_active', 'disconnected')).toBe(true);
    expect(canTransitionPermission('mic_active', 'permission_revoked')).toBe(true);
    expect(canTransitionPermission('permission_revoked', 'permission_required')).toBe(true);
  });

  it('flags the states that need a device-settings redirect', () => {
    expect(needsSettingsRedirect('permission_permanently_denied')).toBe(true);
    expect(needsSettingsRedirect('permission_revoked')).toBe(true);
    for (const state of PERMISSION_STATES) {
      if (state === 'permission_permanently_denied' || state === 'permission_revoked') continue;
      expect(needsSettingsRedirect(state), state).toBe(false);
    }
  });

  it('rejects impossible transitions', () => {
    expect(canTransitionPermission('disconnected', 'mic_active')).toBe(false);
    expect(canTransitionPermission('device_unavailable', 'mic_active')).toBe(false);
    expect(canTransitionPermission('permission_denied', 'mic_muted')).toBe(false);
    expect(canTransitionPermission('not_requested', 'permission_granted')).toBe(false);
  });

  it('labels every state without ever implying unearned capture', () => {
    for (const state of PERMISSION_STATES) {
      const label = permissionStateLabel(state);
      expect(label.length).toBeGreaterThan(0);
      if (state !== 'mic_active') {
        expect(label.toLowerCase(), `label for ${state} must not claim a live mic`).not.toContain('live');
      }
    }
    expect(permissionStateLabel('permission_granted')).toContain('not transmitting');
  });
});

describe('connection quality classification (§11)', () => {
  const good = { connected: true, rttMs: 40, jitterMs: 8, packetLoss: 0.001 };

  it('classifies a healthy voice session as excellent', () => {
    expect(classifyConnectionQuality(good)).toBe('excellent');
  });

  it('is disconnected whenever the session is down, whatever the metrics say', () => {
    expect(classifyConnectionQuality({ ...good, connected: false })).toBe('disconnected');
    expect(
      classifyConnectionQuality({ connected: false, rttMs: null, jitterMs: null, packetLoss: null }),
    ).toBe('disconnected');
  });

  it('never reports excellent when a metric is missing', () => {
    // An unknown measurement is not evidence of a good connection.
    expect(classifyConnectionQuality({ ...good, rttMs: null })).toBe('unstable');
    expect(classifyConnectionQuality({ ...good, jitterMs: null })).toBe('unstable');
    expect(classifyConnectionQuality({ ...good, packetLoss: null })).toBe('unstable');
    expect(classifyConnectionQuality({ connected: true, rttMs: Number.NaN, jitterMs: 5, packetLoss: 0 })).toBe(
      'unstable',
    );
  });

  it('degrades as RTT rises', () => {
    expect(classifyConnectionQuality({ ...good, rttMs: 100 })).toBe('good');
    expect(classifyConnectionQuality({ ...good, rttMs: 200 })).toBe('unstable');
    expect(classifyConnectionQuality({ ...good, rttMs: 500 })).toBe('poor');
  });

  it('degrades as jitter rises', () => {
    expect(classifyConnectionQuality({ ...good, jitterMs: 30 })).toBe('good');
    expect(classifyConnectionQuality({ ...good, jitterMs: 80 })).toBe('unstable');
    expect(classifyConnectionQuality({ ...good, jitterMs: 400 })).toBe('poor');
  });

  it('degrades as packet loss rises', () => {
    expect(classifyConnectionQuality({ ...good, packetLoss: 0.02 })).toBe('good');
    expect(classifyConnectionQuality({ ...good, packetLoss: 0.05 })).toBe('unstable');
    expect(classifyConnectionQuality({ ...good, packetLoss: 0.4 })).toBe('poor');
  });

  it('is driven by the worst metric, not the average', () => {
    // Two perfect metrics must not mask one terrible one.
    expect(classifyConnectionQuality({ connected: true, rttMs: 20, jitterMs: 5, packetLoss: 0.5 })).toBe('poor');
  });

  it('thresholds are ordered so the bands cannot overlap', () => {
    const { excellent, good: g, unstable } = QUALITY_THRESHOLDS;
    expect(excellent.rttMs).toBeLessThan(g.rttMs);
    expect(g.rttMs).toBeLessThan(unstable.rttMs);
    expect(excellent.jitterMs).toBeLessThan(g.jitterMs);
    expect(g.jitterMs).toBeLessThan(unstable.jitterMs);
    expect(excellent.packetLoss).toBeLessThan(g.packetLoss);
    expect(g.packetLoss).toBeLessThan(unstable.packetLoss);
  });

  it('uses only the five labels the spec allows', () => {
    const seen = new Set<string>();
    for (const connected of [true, false]) {
      for (const rttMs of [null, 10, 100, 200, 900]) {
        for (const jitterMs of [null, 5, 40, 100, 500]) {
          for (const packetLoss of [null, 0, 0.02, 0.06, 0.9]) {
            seen.add(classifyConnectionQuality({ connected, rttMs, jitterMs, packetLoss }));
          }
        }
      }
    }
    for (const label of seen) {
      expect(['excellent', 'good', 'unstable', 'poor', 'disconnected']).toContain(label);
    }
  });
});

describe('room and identity naming', () => {
  it('derives a deterministic, LiveKit-legal room name from the server id', () => {
    const id = 'A1B2C3D4-1111-4111-8111-111111111111';
    const room = voiceRoomName(id);
    expect(room).toBe('oghost-a1b2c3d4-1111-4111-8111-111111111111');
    expect(room).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(voiceRoomName(id)).toBe(room); // stable across calls
  });

  it('refuses to build a room name from a malformed server id', () => {
    for (const bad of ['', 'not-a-uuid', '../../../etc/passwd', 'oghost-evil', '12345678-1111-4111-8111']) {
      expect(() => voiceRoomName(bad)).toThrow();
    }
  });

  it('derives a stable participant identity from the session id', () => {
    const session = '22222222-2222-4222-8222-222222222222';
    expect(voiceParticipantIdentity(session)).toBe(`p-${session}`);
    expect(() => voiceParticipantIdentity('Steve')).toThrow();
    expect(() => voiceParticipantIdentity('')).toThrow();
  });
});

describe('verification codes (§12)', () => {
  it('uses an alphabet without visually ambiguous characters', () => {
    // Players read this off a Minecraft screen. 0/O and 1/I/L are excluded.
    expect(VOICE_CODE_ALPHABET).not.toMatch(/[01OI]/);
    expect(VOICE_CODE_ALPHABET.length).toBe(31);
    expect(new Set(VOICE_CODE_ALPHABET.split('')).size).toBe(VOICE_CODE_ALPHABET.length);
    expect(VOICE_CODE_LENGTH).toBe(8);
  });

  it('has enough entropy for its short lifetime and attempt cap', () => {
    const bits = voiceCodeEntropyBits();
    expect(bits).toBeGreaterThan(39);
    const space = Math.pow(VOICE_CODE_ALPHABET.length, VOICE_CODE_LENGTH);
    // With 5 attempts per code and a 120s life, the success probability of a
    // blind guess must be negligible.
    expect(VOICE_CODE_MAX_ATTEMPTS / space).toBeLessThan(1e-10);
    expect(VOICE_CODE_TTL_SECONDS).toBe(120);
  });

  it.each(['ABCD2345', 'K7M2QP9R', 'ZZZZZZZZ', '22222222'])('accepts %j', (code) => {
    expect(isValidVoiceCode(code)).toBe(true);
  });

  it.each(['', 'ABCD234', 'ABCD23456', 'ABCD-2345', 'abcd0123', 'ABCD234O', 'ABCD234I', 'ABCD 234'])(
    'rejects %j',
    (code) => {
      expect(isValidVoiceCode(code)).toBe(false);
    },
  );

  it('normalises case, spaces and separators', () => {
    expect(normaliseVoiceCode(' abcd2345 ')).toBe('ABCD2345');
    expect(normaliseVoiceCode('ABCD-2345')).toBe('ABCD2345');
    expect(normaliseVoiceCode('ab cd 23 45')).toBe('ABCD2345');
    expect(isValidVoiceCode(normaliseVoiceCode(' abcd2345 '))).toBe(true);
  });
});
