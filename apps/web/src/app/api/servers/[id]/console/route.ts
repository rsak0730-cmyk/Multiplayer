import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { loadServerContext } from '@/lib/api/server-context';
import { z } from 'zod';

export const runtime = 'nodejs';

const querySchema = z.object({
  after: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * GET /api/servers/:id/console?after=<lastId>&limit=<n>
 * Incremental console tail for the live console UI. Polling (not websockets)
 * keeps this compatible with Vercel serverless functions.
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    after: url.searchParams.get('after') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid query' }, { status: 400 });
  }

  const supabase = createClient();
  let query = supabase
    .from('server_console_logs')
    .select('id, line, stream, created_at')
    .eq('server_id', ctx.server.id)
    .order('id', { ascending: false })
    .limit(parsed.data.limit);

  if (parsed.data.after !== undefined) {
    query = query.gt('id', parsed.data.after);
  }

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // Return oldest-first so the console renders in order.
  return NextResponse.json({ lines: (data ?? []).reverse() });
}
