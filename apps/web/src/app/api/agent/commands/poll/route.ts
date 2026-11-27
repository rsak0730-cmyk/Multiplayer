import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateAgent } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

/**
 * GET /api/agent/commands/poll
 * Agent long-polls (or short-polls) for pending commands.
 * Claims up to 5 commands atomically-ish (single agent per node).
 */
export async function GET(request: Request) {
  if (!checkRateLimit(`poll:${request.headers.get('x-forwarded-for') ?? 'agent'}`)) {
    return rateLimitResponse();
  }
  const { node, error } = await authenticateAgent(request);
  if (error) return error;

  const admin = createAdminClient();
  const { data: pending, error: fetchError } = await admin
    .from('node_commands')
    .select('*')
    .eq('node_id', node.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(5);
  if (fetchError) {
    return NextResponse.json({ error: fetchError.message }, { status: 500 });
  }

  const claimed = [];
  for (const cmd of pending ?? []) {
    const { data: updated, error: claimError } = await admin
      .from('node_commands')
      .update({ status: 'claimed', claimed_at: new Date().toISOString() })
      .eq('id', cmd.id)
      .eq('status', 'pending')
      .select('*')
      .maybeSingle();
    if (!claimError && updated) claimed.push(updated);
  }

  return NextResponse.json({ commands: claimed });
}
