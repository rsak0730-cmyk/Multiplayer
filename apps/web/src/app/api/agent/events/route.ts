import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateAgent } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

/**
 * POST /api/agent/events
 * Agent reports lifecycle events (started, crashed, backup done, ...).
 * Body: { event_type, message, server_id? }
 */
export async function POST(request: Request) {
  if (!checkRateLimit(`events:${request.headers.get('x-forwarded-for') ?? 'agent'}`)) {
    return rateLimitResponse();
  }
  const { node, error } = await authenticateAgent(request);
  if (error) return error;

  let body: { event_type?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.event_type) {
    return NextResponse.json({ error: 'event_type required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error: insertError } = await admin.from('node_events').insert({
    node_id: node.id,
    event_type: String(body.event_type).slice(0, 64),
    message: String(body.message ?? '').slice(0, 2000),
  });
  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
