import { describe, expect, it } from 'vitest';
import { isPlausiblePublicAddress } from '@/lib/networking/verify';

/**
 * Address plausibility. This is an honesty control, not just input validation.
 *
 * Saving an address that can never be joined produces the worst failure mode in
 * the whole product: the panel looks correct, the user shares the address with
 * friends, and nobody can connect — with no error anywhere. Rejecting the
 * obviously-unreachable ranges up front turns that silent failure into an
 * immediate, explainable one.
 *
 * The range table below is shared with `CgnatDetectionTests` in the C# agent
 * suite (`DirectProvider.IsPrivateOrCgnat`). The two functions are inverses of
 * each other for IP literals: what the agent calls private-or-CGNAT, the panel
 * must call implausible.
 */

/** Addresses that can never be reached from the internet. */
const UNREACHABLE = [
  // RFC6598 carrier-grade NAT — Airtel / Jio / Vi mobile broadband.
  '100.64.0.1',
  '100.64.0.0',
  '100.100.50.25',
  '100.127.255.254',
  // RFC1918 private
  '10.0.0.5',
  '10.255.255.255',
  '192.168.1.10',
  '192.168.0.1',
  '172.16.0.1',
  '172.31.255.255',
  // Loopback and link-local
  '127.0.0.1',
  '127.0.0.53',
  'localhost',
  '::1',
  '169.254.1.1',
  '0.0.0.0',
];

/** Addresses that are genuinely routable, including the ones just outside each block. */
const REACHABLE = [
  '100.63.255.255', // just below the CGNAT block
  '100.128.0.1', // just above the CGNAT block
  '172.15.0.1', // just below 172.16/12
  '172.32.0.1', // just above 172.16/12
  '11.0.0.1',
  '192.169.0.1',
  '8.8.8.8',
  '49.44.0.1', // a real Indian ISP range
  '203.0.113.45', // TEST-NET-3, routable-shaped
  'play.example.com', // a manual endpoint may be a DNS name
  'tunnel.playit.gg',
];

describe('isPlausiblePublicAddress', () => {
  it.each(UNREACHABLE)('rejects the unreachable address %s', (address) => {
    expect(isPlausiblePublicAddress(address)).toBe(false);
  });

  it.each(REACHABLE)('accepts the routable address %s', (address) => {
    expect(isPlausiblePublicAddress(address)).toBe(true);
  });

  it.each(['', '   ', '\t'])('rejects blank input %j', (address) => {
    expect(isPlausiblePublicAddress(address)).toBe(false);
  });

  it('trims and is case-insensitive', () => {
    expect(isPlausiblePublicAddress('  PLAY.Example.COM  ')).toBe(true);
    expect(isPlausiblePublicAddress('  LOCALHOST  ')).toBe(false);
    expect(isPlausiblePublicAddress('  127.0.0.1  ')).toBe(false);
  });

  describe('the whole CGNAT block is rejected, not just its edges', () => {
    it('covers 100.64.0.0/10 exhaustively at the boundaries', () => {
      // 100.64/10 spans 100.64.x – 100.127.x. Off-by-one here is the exact
      // mistake that would let a Jio or Airtel address through.
      for (const second of [63, 64, 65, 100, 126, 127, 128, 129]) {
        const expected = second >= 64 && second <= 127;
        expect(
          isPlausiblePublicAddress(`100.${second}.0.1`),
          `100.${second}.0.1 should be ${expected ? 'rejected' : 'accepted'}`,
        ).toBe(!expected);
      }
    });

    it('covers 172.16.0.0/12 exhaustively at the boundaries', () => {
      for (const second of [15, 16, 17, 24, 31, 32, 33]) {
        const expected = second >= 16 && second <= 31;
        expect(
          isPlausiblePublicAddress(`172.${second}.0.1`),
          `172.${second}.0.1 should be ${expected ? 'rejected' : 'accepted'}`,
        ).toBe(!expected);
      }
    });
  });

  it('rejects the entire loopback /8, not only 127.0.0.1', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '127.255.255.254']) {
      expect(isPlausiblePublicAddress(address)).toBe(false);
    }
  });

  it('does not reject a public address that merely contains a private-looking octet', () => {
    // Guards against an over-broad substring check.
    expect(isPlausiblePublicAddress('52.10.16.31')).toBe(true);
    expect(isPlausiblePublicAddress('13.192.168.1')).toBe(true);
    expect(isPlausiblePublicAddress('100.200.64.127')).toBe(true);
  });
});

describe('panel and agent agree on every IP literal', () => {
  /**
   * Expected verdict of the agent's `DirectProvider.IsPrivateOrCgnat` for the
   * same address. Kept here explicitly so a change to either side has to be made
   * twice, deliberately.
   */
  const agentSaysPrivateOrCgnat: Record<string, boolean> = Object.fromEntries([
    ...UNREACHABLE.filter((a) => a !== 'localhost' && !a.includes(':')).map((a) => [a, true]),
    ...REACHABLE.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)).map((a) => [a, false]),
  ]);

  it('is the exact inverse of the agent check for IPv4 literals', () => {
    for (const [address, agentSaysPrivate] of Object.entries(agentSaysPrivateOrCgnat)) {
      expect(
        isPlausiblePublicAddress(address),
        `panel and agent disagree about ${address}`,
      ).toBe(!agentSaysPrivate);
    }
  });

  it('documents the one deliberate divergence: hostnames', () => {
    // The agent only ever compares IP literals, so it calls anything unparseable
    // private. The panel must additionally accept a DNS name, because a manual
    // endpoint is usually a tunnel hostname. That difference is intentional.
    expect(isPlausiblePublicAddress('tunnel.playit.gg')).toBe(true);
  });
});
