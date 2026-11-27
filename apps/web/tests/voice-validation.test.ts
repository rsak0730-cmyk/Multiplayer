import { describe, expect, it } from 'vitest';
import { PERMISSION_STATES, VOICE_CODE_LENGTH } from '@oghost/shared';
import {
  PLAYER_NAME_RE,
  agentIssueCodeSchema,
  issueCodeSchema,
  isValidVoicePlayerName,
  positionsSchema,
  redeemCodeSchema,
  sessionStateSchema,
  validationError,
  voiceConfigPatchSchema,
} from '../src/lib/voice/validation';

describe('player name validation', () => {
  it.each(['Steve', 'Alex', 'Player One', 'Player_One', 'a-b.c', 'X', 'Notch123'])(
    'accepts %j',
    (name) => {
      expect(isValidVoicePlayerName(name)).toBe(true);
    },
  );

  it('accepts exactly 32 characters and refuses 33', () => {
    expect(isValidVoicePlayerName('a'.repeat(32))).toBe(true);
    expect(isValidVoicePlayerName('a'.repeat(33))).toBe(false);
  });

  it('refuses an empty name', () => {
    expect(isValidVoicePlayerName('')).toBe(false);
  });

  it('refuses Bedrock colour and format codes', () => {
    // § is how Bedrock renders coloured text. A name containing it can display as
    // invisible or as another player's name, which is an impersonation vector in
    // every player list and speaking indicator.
    expect(isValidVoicePlayerName('Steve§k')).toBe(false);
    expect(isValidVoicePlayerName('§cAdmin')).toBe(false);
  });

  it.each(['Steve\n', 'Steve\r\n', 'Steve\t', '  Steve  '])(
    'normalises surrounding whitespace in %j instead of rejecting it',
    (name) => {
      // Stripping is the safer behaviour: if "Steve" and "Steve " were distinct
      // names they would be distinct identity links, and a trailing space would
      // let a player appear as someone else in a player list.
      expect(isValidVoicePlayerName(name)).toBe(true);
      expect(issueCodeSchema.parse({ player_name: name }).player_name).toBe('Steve');
    },
  );

  it.each(['Ste\nve', 'Ste\tve', 'Steve\u0000', '\u0000Steve', 'Steve\u200b', '\u200bSteve'])(
    'refuses embedded control and invisible characters in %j',
    (name) => {
      // These cannot be trimmed away. U+200B is the dangerous one: it is not
      // whitespace to String.trim, so it survives normalisation and would render
      // as an invisible character in every player list.
      expect(isValidVoicePlayerName(name)).toBe(false);
      expect(issueCodeSchema.safeParse({ player_name: name }).success).toBe(false);
    },
  );

  it.each(['<script>alert(1)</script>', 'Steve"OR"1=1', "Steve'--", 'Steve/../../etc'])(
    'refuses markup and injection attempts in %j',
    (name) => {
      expect(isValidVoicePlayerName(name)).toBe(false);
    },
  );

  it('refuses emoji and non-ASCII, which would break a fixed-width player list', () => {
    expect(isValidVoicePlayerName('Steve🎮')).toBe(false);
    expect(isValidVoicePlayerName('Stéve')).toBe(false);
  });

  it('is anchored, so a valid substring cannot smuggle an invalid name through', () => {
    expect(PLAYER_NAME_RE.source.startsWith('^')).toBe(true);
    expect(PLAYER_NAME_RE.source.endsWith('$')).toBe(true);
    expect(isValidVoicePlayerName('Steve\nSteve')).toBe(false);
  });
});

describe('issueCodeSchema', () => {
  it('requires a player name', () => {
    expect(issueCodeSchema.safeParse({}).success).toBe(false);
    expect(issueCodeSchema.safeParse({ player_name: '' }).success).toBe(false);
    expect(issueCodeSchema.safeParse({ player_name: 'Steve§k' }).success).toBe(false);
  });

  it('trims the name', () => {
    const parsed = issueCodeSchema.parse({ player_name: '  Steve  ' });
    expect(parsed.player_name).toBe('Steve');
  });

  it('defaults issued_via to dashboard', () => {
    expect(issueCodeSchema.parse({ player_name: 'Steve' }).issued_via).toBe('dashboard');
  });

  it('refuses an unknown channel', () => {
    expect(issueCodeSchema.safeParse({ player_name: 'Steve', issued_via: 'chat' }).success).toBe(false);
  });

  it('has no server_id — the owner route takes it from the path', () => {
    expect('server_id' in issueCodeSchema.parse({ player_name: 'Steve' })).toBe(false);
  });
});

describe('agentIssueCodeSchema', () => {
  it('requires a server uuid, because agent routes carry no path parameter', () => {
    expect(agentIssueCodeSchema.safeParse({ player_name: 'Steve' }).success).toBe(false);
    expect(agentIssueCodeSchema.safeParse({ player_name: 'Steve', server_id: 'not-a-uuid' }).success).toBe(false);
    expect(
      agentIssueCodeSchema.safeParse({ player_name: 'Steve', server_id: 'a1b2c3d4-1111-4111-8111-111111111111' }).success,
    ).toBe(true);
  });

  it('still enforces the player-name rules', () => {
    const serverId = 'a1b2c3d4-1111-4111-8111-111111111111';
    // Embedded control characters, which normalisation cannot strip.
    expect(agentIssueCodeSchema.safeParse({ player_name: 'Ste\nve', server_id: serverId }).success).toBe(false);
    expect(agentIssueCodeSchema.safeParse({ player_name: 'Steve§k', server_id: serverId }).success).toBe(false);
    expect(agentIssueCodeSchema.safeParse({ player_name: '', server_id: serverId }).success).toBe(false);
    expect(agentIssueCodeSchema.safeParse({ player_name: 'Steve', server_id: serverId }).success).toBe(true);
  });
});

describe('redeemCodeSchema', () => {
  it('normalises case, spaces and separators before validating length', () => {
    // A player retypes what they read off a Minecraft screen.
    expect(redeemCodeSchema.parse({ code: 'abcd2345' }).code).toBe('ABCD2345');
    expect(redeemCodeSchema.parse({ code: ' abcd2345 ' }).code).toBe('ABCD2345');
    expect(redeemCodeSchema.parse({ code: 'ABCD-2345' }).code).toBe('ABCD2345');
    expect(redeemCodeSchema.parse({ code: 'ab cd 23 45' }).code).toBe('ABCD2345');
  });

  it.each(['', 'ABC', 'ABCD234', 'ABCD23456', 'ABCDEFGHJK'])('rejects the wrong length %j', (code) => {
    expect(redeemCodeSchema.safeParse({ code }).success).toBe(false);
  });

  it('reports the expected length in the message', () => {
    const result = redeemCodeSchema.safeParse({ code: 'ABC' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(validationError(result.error).error).toContain(String(VOICE_CODE_LENGTH));
    }
  });

  it('does not require server_id — the player types a code and nothing else', () => {
    expect(redeemCodeSchema.parse({ code: 'ABCD2345' }).server_id).toBeUndefined();
  });

  it('accepts an optional server_id and refuses a malformed one', () => {
    expect(redeemCodeSchema.parse({ code: 'ABCD2345', server_id: 'a1b2c3d4-1111-4111-8111-111111111111' }).server_id).toBe(
      'a1b2c3d4-1111-4111-8111-111111111111',
    );
    expect(redeemCodeSchema.safeParse({ code: 'ABCD2345', server_id: 'nope' }).success).toBe(false);
  });

  it('defaults platform to unknown rather than guessing', () => {
    expect(redeemCodeSchema.parse({ code: 'ABCD2345' }).platform).toBe('unknown');
  });

  it('refuses a platform outside the supported set', () => {
    expect(redeemCodeSchema.safeParse({ code: 'ABCD2345', platform: 'playstation' }).success).toBe(false);
    expect(redeemCodeSchema.safeParse({ code: 'ABCD2345', platform: 'android' }).success).toBe(true);
  });

  it('bounds device_name and app_version so they cannot carry a payload', () => {
    expect(redeemCodeSchema.safeParse({ code: 'ABCD2345', device_name: 'x'.repeat(65) }).success).toBe(false);
    expect(redeemCodeSchema.safeParse({ code: 'ABCD2345', app_version: 'x'.repeat(33) }).success).toBe(false);
    expect(redeemCodeSchema.safeParse({ code: 'ABCD2345', device_name: 'Pixel 8' }).success).toBe(true);
  });

  it('has no player_name field, so a guest cannot claim an identity', () => {
    // §12: never trust a player-supplied username. The name comes from the code
    // row, which the add-on created. There is no field here to supply one.
    const parsed = redeemCodeSchema.parse({ code: 'ABCD2345', player_name: 'Notch' });
    expect('player_name' in parsed).toBe(false);
  });
});

describe('sessionStateSchema', () => {
  it.each(PERMISSION_STATES)('accepts the documented state %s', (state) => {
    expect(sessionStateSchema.safeParse({ mic_permission_state: state }).success).toBe(true);
  });

  it.each(['mic_on', 'MIC_ACTIVE', 'granted', '', 'active'])('refuses %j', (state) => {
    expect(sessionStateSchema.safeParse({ mic_permission_state: state }).success).toBe(false);
  });

  it('requires a state', () => {
    expect(sessionStateSchema.safeParse({}).success).toBe(false);
  });

  it('bounds the reported metrics', () => {
    expect(sessionStateSchema.safeParse({ mic_permission_state: 'mic_active', metrics: { packet_loss: 1.5 } }).success).toBe(
      false,
    );
    expect(sessionStateSchema.safeParse({ mic_permission_state: 'mic_active', metrics: { rtt_ms: -5 } }).success).toBe(
      false,
    );
    expect(
      sessionStateSchema.safeParse({ mic_permission_state: 'mic_active', metrics: { rtt_ms: 40, jitter_ms: 8, packet_loss: 0.01 } })
        .success,
    ).toBe(true);
    expect(
      sessionStateSchema.safeParse({ mic_permission_state: 'mic_active', metrics: { rtt_ms: null } }).success,
    ).toBe(true);
  });
});

describe('positionsSchema', () => {
  const player = { player_name: 'Steve', x: 1, y: 64, z: 2, dimension: 'overworld' as const };

  it('accepts a well-formed report', () => {
    expect(positionsSchema.safeParse({ players: [player] }).success).toBe(true);
  });

  it.each(['overworld', 'nether', 'the end'])('accepts dimension %j', (dimension) => {
    expect(positionsSchema.safeParse({ players: [{ ...player, dimension }] }).success).toBe(true);
  });

  it.each(['minecraft:overworld', 'the_nether', 'end', '', 'OVERWORLD'])('refuses dimension %j', (dimension) => {
    // The add-on must send the normalised value. Accepting a raw id here would
    // mean the routing layer had to guess, and guessing risks cross-dimension
    // audio. Refusing at the boundary keeps the rule in one place.
    expect(positionsSchema.safeParse({ players: [{ ...player, dimension }] }).success).toBe(false);
  });

  it('refuses non-finite coordinates', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(positionsSchema.safeParse({ players: [{ ...player, x: bad }] }).success).toBe(false);
    }
  });

  it('accepts negative coordinates, which most of a world consists of', () => {
    expect(positionsSchema.safeParse({ players: [{ ...player, x: -10000, z: -10000 }] }).success).toBe(true);
  });

  it('bounds the player array so a hostile payload cannot cause unbounded work', () => {
    const many = Array.from({ length: 121 }, (_, i) => ({ ...player, player_name: `P${i}` }));
    expect(positionsSchema.safeParse({ players: many }).success).toBe(false);
    expect(positionsSchema.safeParse({ players: many.slice(0, 120) }).success).toBe(true);
  });

  it('rejects a player name that would spoof the player list', () => {
    expect(positionsSchema.safeParse({ players: [{ ...player, player_name: 'Steve§k' }] }).success).toBe(false);
    expect(positionsSchema.safeParse({ players: [{ ...player, player_name: '' }] }).success).toBe(false);
  });

  it('accepts the optional version telemetry the dashboard displays', () => {
    const parsed = positionsSchema.parse({
      players: [player],
      engine_version: '1.21.50',
      script_api_version: '2.9.0-beta',
      server_net_available: true,
    });
    expect(parsed.engine_version).toBe('1.21.50');
    expect(parsed.server_net_available).toBe(true);
  });

  it('refuses an over-long version string', () => {
    expect(positionsSchema.safeParse({ players: [], engine_version: 'x'.repeat(33) }).success).toBe(false);
  });
});

describe('voiceConfigPatchSchema — §13 ownership limits', () => {
  it('accepts every setting an owner is allowed to change', () => {
    const parsed = voiceConfigPatchSchema.parse({
      enabled: false,
      mode: 'global',
      voice_range: 64,
      falloff_start: 0.75,
      ignore_altitude: true,
      default_push_to_talk: false,
      max_participants: 20,
    });
    expect(parsed.mode).toBe('global');
    expect(parsed.voice_range).toBe(64);
  });

  it('refuses an empty patch rather than silently succeeding', () => {
    expect(voiceConfigPatchSchema.safeParse({}).success).toBe(false);
  });

  it('enforces the shared range limits', () => {
    expect(voiceConfigPatchSchema.safeParse({ voice_range: 3 }).success).toBe(false);
    expect(voiceConfigPatchSchema.safeParse({ voice_range: 513 }).success).toBe(false);
    expect(voiceConfigPatchSchema.safeParse({ voice_range: 4 }).success).toBe(true);
    expect(voiceConfigPatchSchema.safeParse({ voice_range: 512 }).success).toBe(true);
    expect(voiceConfigPatchSchema.safeParse({ voice_range: 32.5 }).success).toBe(false);
  });

  it('enforces the mode enum and the falloff bounds', () => {
    expect(voiceConfigPatchSchema.safeParse({ mode: 'nearby' }).success).toBe(false);
    expect(voiceConfigPatchSchema.safeParse({ falloff_start: 0 }).success).toBe(false);
    expect(voiceConfigPatchSchema.safeParse({ falloff_start: 1.5 }).success).toBe(false);
    expect(voiceConfigPatchSchema.safeParse({ falloff_start: 1 }).success).toBe(true);
  });

  it('CANNOT be used to write a microphone permission state', () => {
    // The enforcement for "an owner can never override a player's device
    // permission" is the absence of a field. Zod strips unknown keys, so an owner
    // who sends one gets it discarded rather than applied — and rather than a
    // confusing 400 for a field that should never have been sent.
    const parsed = voiceConfigPatchSchema.parse({ mode: 'global', mic_permission_state: 'mic_active' });
    expect(parsed).toEqual({ mode: 'global' });
    expect('mic_permission_state' in parsed).toBe(false);
  });

  it('CANNOT be used to enable recording or audio storage', () => {
    // §18: no recording and no audio storage by default, and neither is an owner
    // toggle on this route.
    const parsed = voiceConfigPatchSchema.parse({
      mode: 'proximity',
      recording_enabled: true,
      audio_storage_enabled: true,
    });
    expect(parsed).toEqual({ mode: 'proximity' });
    expect('recording_enabled' in parsed).toBe(false);
    expect('audio_storage_enabled' in parsed).toBe(false);
  });

  it('CANNOT be used for mass assignment of ownership or identity', () => {
    const parsed = voiceConfigPatchSchema.parse({
      mode: 'global',
      owner_id: '00000000-0000-4000-8000-000000000000',
      server_id: '00000000-0000-4000-8000-000000000001',
      add_on_status: 'installed',
      detected_engine_version: '99.99.99',
      server_net_available: true,
    });
    expect(parsed).toEqual({ mode: 'global' });
    // add_on_status and the detected versions are agent-reported facts. Letting
    // an owner write them would let the dashboard claim an add-on installed when
    // it did not — the "never pretend it installed" failure §3 forbids.
    expect('add_on_status' in parsed).toBe(false);
    expect('detected_engine_version' in parsed).toBe(false);
    expect('server_net_available' in parsed).toBe(false);
  });

  it('CANNOT be used to alter another player\u2019s volume, mute list or session', () => {
    const parsed = voiceConfigPatchSchema.parse({
      mode: 'global',
      deafened: true,
      muted_players: ['Alex'],
      global_volume: 0,
      revoked_at: new Date().toISOString(),
    });
    expect(parsed).toEqual({ mode: 'global' });
  });
});

describe('validationError', () => {
  it('returns the first message and its field path', () => {
    const result = voiceConfigPatchSchema.safeParse({ voice_range: 1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      const error = validationError(result.error);
      expect(error.field).toBe('voice_range');
      expect(typeof error.error).toBe('string');
      expect(error.error.length).toBeGreaterThan(0);
    }
  });

  it('reports a nested path for the positions array', () => {
    const result = positionsSchema.safeParse({ players: [{ player_name: 'Steve', x: 'nope', y: 1, z: 1, dimension: 'overworld' }] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(validationError(result.error).field).toContain('players');
    }
  });

  it('reports the schema-level message for an empty patch', () => {
    const result = voiceConfigPatchSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(validationError(result.error).error).toBe('No changes supplied.');
      expect(validationError(result.error).field).toBeNull();
    }
  });
});
