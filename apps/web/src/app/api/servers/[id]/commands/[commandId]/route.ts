import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { loadServerContext } from '@/lib/api/server-context';

export const runtime = 'nodejs';

/**
 * GET /api/servers/:id/commands/:commandId
 * Poll the result of an enqueued agent command. Returns status + result.
 * Ownership is enforced by loading the server first (RLS), then checking
 * the command belongs to that server's node.
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string; commandId: string } },
) {
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const supabase = createClient();
  const { data: command, error } = await supabase
    .from('node_commands')
    .select('*')
    .eq('id', params.commandId)
    .eq('node_id', ctx.node.id)
    .maybeSingle();
  if (error || !command) {
    return NextResponse.json({ error: 'Command not found' }, { status: 404 });
  }
  return NextResponse.json({ command });
}
