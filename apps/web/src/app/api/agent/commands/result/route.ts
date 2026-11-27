import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { authenticateAgent } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import type { CommandResultPayload } from '@oghost/shared';

/**
 * POST /api/agent/commands/result
 * Agent reports completion/failure of a claimed command.
 */
export async function POST(request: Request) {
  if (!checkRateLimit(`result:${request.headers.get('x-forwarded-for') ?? 'agent'}`)) {
    return rateLimitResponse();
  }
  const { node, error } = await authenticateAgent(request);
  if (error) return error;

  let body: { command_id: string } & CommandResultPayload;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.command_id) {
    return NextResponse.json({ error: 'command_id required' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error: updateError } = await admin
    .from('node_commands')
    .update({
      status: body.status,
      result: body.result ?? {},
      error_message: body.error_message ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', body.command_id)
    .eq('node_id', node.id);
  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 });
  }

  // Mirror failures onto the server row for visibility.
  if (body.status === 'failed' && body.error_message) {
    const { data: cmd } = await admin
      .from('node_commands')
      .select('server_id')
      .eq('id', body.command_id)
      .maybeSingle();
    if (cmd?.server_id) {
      await admin
        .from('servers')
        .update({ last_error: body.error_message })
        .eq('id', cmd.server_id);
    }
  }

  return NextResponse.json({ ok: true });
}
