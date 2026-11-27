import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';

/** Require an authenticated user; returns user or a 401 response. */
export async function requireUser() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      user: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    };
  }
  return { user, error: null };
}

/** SHA-256 hex hash — used for pairing codes and node tokens. */
export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Generate a random pairing code: XXXXXX-XXXXXX (uppercase alphanumeric). */
export function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const part = () =>
    Array.from({ length: 6 }, () =>
      alphabet[crypto.randomInt(alphabet.length)],
    ).join('');
  return `${part()}-${part()}`;
}

/** Generate a long-lived node token (shown once at pairing time). */
export function generateNodeToken(): string {
  return `ogt_${crypto.randomBytes(32).toString('base64url')}`;
}

/**
 * Authenticate a Windows agent request via its node token.
 * The token is compared against the stored hash in constant time.
 */
export async function authenticateAgent(request: Request) {
  const authHeader = request.headers.get('authorization') ?? '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : '';
  if (!token) {
    return {
      node: null,
      error: NextResponse.json({ error: 'Missing agent token' }, { status: 401 }),
    };
  }
  const tokenHash = sha256Hex(token);
  const admin = createAdminClient();
  const { data: node } = await admin
    .from('nodes')
    .select('*')
    .eq('token_hash', tokenHash)
    .is('revoked_at', null)
    .maybeSingle();
  if (!node) {
    return {
      node: null,
      error: NextResponse.json({ error: 'Invalid agent token' }, { status: 401 }),
    };
  }
  return { node, error: null };
}
