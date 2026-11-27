import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateAgent } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

/**
 * POST /api/agent/console-logs
 * Agent pushes BDS stdout/stderr lines. Capped batch size.
 * Body: { server_id, lines: [{ line, stream }] }
 */
export async function POST(request: Request) {
  if (!checkRateLimit(`logs:${request.headers.get('x-forwarded-for') ?? 'agent'}`)) {
    return rateLimitResponse();
  }
  const { node, error } = await authenticateAgent(request);
  if (error) return error;

  let body: { server_id?: string; lines?: Array<{ line: string; stream?: string }> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.server_id || !Array.isArray(body.lines)) {
    return NextResponse.json({ error: 'server_id and lines required' }, { status: 400 });
  }

  const admin = createAdminClient();
  // Verify the server belongs to this node (ownership chain).
  const { data: server } = await admin
    .from('servers')
    .select('id, owner_id')
    .eq('id', body.server_id)
    .eq('node_id', node.id)
    .maybeSingle();
  if (!server) {
    return NextResponse.json({ error: 'Server not found on this node' }, { status: 404 });
  }

  const rows = body.lines.slice(0, 200).map((l) => ({
    server_id: server.id,
    owner_id: server.owner_id,
    line: String(l.line ?? '').slice(0, 4000),
    stream: l.stream === 'stderr' || l.stream === 'system' ? l.stream : 'stdout',
  }));
  if (rows.length > 0) {
    const { error: insertError } = await admin.from('server_console_logs').insert(rows);
    if (insertError) {
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true, inserted: rows.length });
}
