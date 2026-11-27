import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { clientIp } from '@/lib/audit';
import { z } from 'zod';

export const runtime = 'nodejs';

const profileSchema = z.object({
  display_name: z.string().trim().max(40).optional(),
  avatar_url: z.string().url().max(500).optional(),
});

/** GET /api/profile · PUT /api/profile */
export async function GET() {
  const { user, error } = await requireUser();
  if (error) return error;

  const supabase = createClient();
  const { data, error: queryError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user!.id)
    .maybeSingle();
  if (queryError) {
    return NextResponse.json({ error: queryError.message }, { status: 500 });
  }
  return NextResponse.json({ profile: data });
}

export async function PUT(request: Request) {
  if (!checkRateLimit(`profile:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const { user, error } = await requireUser();
  if (error) return error;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = profileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid profile data' }, { status: 400 });
  }

  const supabase = createClient();
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', user!.id)
    .maybeSingle();

  const row = { id: user!.id, ...parsed.data };
  const { data, error: writeError } = existing
    ? await supabase.from('profiles').update(parsed.data).eq('id', user!.id).select('*').single()
    : await supabase.from('profiles').insert(row).select('*').single();
  if (writeError) {
    return NextResponse.json({ error: writeError.message }, { status: 500 });
  }
  return NextResponse.json({ profile: data });
}
