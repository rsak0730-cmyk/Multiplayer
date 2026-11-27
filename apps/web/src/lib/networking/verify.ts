import net from 'node:net';

/**
 * Networking verification helpers.
 *
 * HONESTY RULE: a server is only marked `networking_verified` after an
 * actual connectivity check succeeds. We never fabricate addresses.
 *
 * What we can verify from Vercel (TCP/UDP reachability + BDS handshake
 * probing) is limited — Vercel functions cannot open arbitrary UDP
 * sockets to arbitrary hosts reliably. So:
 *  - `probeTcp` does a real TCP connect test (useful for direct provider).
 *  - Full Bedrock protocol verification (RakNet handshake) is performed
 *    by the Windows agent on the node and reported via heartbeat.
 *  - The UI distinguishes: unverified / agent-reported / verified.
 */

export interface ProbeResult {
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
}

/** Real TCP connect probe with timeout. */
export function probeTcp(host: string, port: number, timeoutMs = 5000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    const done = (reachable: boolean, error: string | null) => {
      socket.destroy();
      resolve({
        reachable,
        latencyMs: reachable ? Date.now() - started : null,
        error,
      });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (err) => done(false, err.message));
    socket.connect(port, host);
  });
}

/**
 * Reject addresses that can never be joined from the internet.
 *
 * This mirrors `DirectProvider.IsPrivateOrCgnat` in the Windows agent so the
 * panel and the node agree. It deliberately includes RFC 6598 (100.64.0.0/10):
 * that is the carrier-grade NAT block used by Airtel, Jio and Vi mobile
 * broadband, and an address in it looks public to a user who has never had one,
 * but nobody outside the carrier can reach it. Accepting it here would let
 * someone save a server address their friends can never join.
 *
 * Hostnames are allowed — a manual endpoint may be a DNS name.
 */
export function isPlausiblePublicAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (!a) return false;
  if (a === 'localhost' || a === '127.0.0.1' || a === '::1') return false;
  if (a === '0.0.0.0') return false;
  // RFC1918 private
  if (/^192\.168\./.test(a) || /^10\./.test(a)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return false;
  // RFC6598 carrier-grade NAT — the CGNAT signature on Indian mobile broadband
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) return false;
  // Link-local (includes the Windows APIPA fallback)
  if (/^169\.254\./.test(a)) return false;
  // Loopback /8 in general, not just 127.0.0.1
  if (/^127\./.test(a)) return false;
  return true;
}
