import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { loadServerContext } from '@/lib/api/server-context';
import { addonTypeFromFileName, MAX_UPLOAD_BYTES } from '@oghost/shared';
import { z } from 'zod';

export const runtime = 'nodejs';

const requestSchema = z.object({
  file_name: z.string().trim().min(1).max(200),
  size_bytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
});

/**
 * GET  /api/servers/:id/addons — list add-ons
 * POST /api/servers/:id/addons — begin an add-on upload
 *
 * The browser never POSTs the file bytes to this function (Vercel body
 * limit is ~4.5 MB). Instead we:
 *   1. validate the extension (.mcpack / .mcaddon / .mcworld only)
 *   2. create the addon record
 *   3. return a signed Supabase Storage upload URL scoped to this owner
 *   4. the browser PUTs the file straight to Storage
 *   5. the caller then hits /addons/:addonId/install, which issues a signed
 *      download URL and queues the install command for the node's agent
 *
 * Bedrock add-ons are NOT Java plugins: the official BDS does not load .jar
 * files, so .jar is rejected here with an explanatory message.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const supabase = createClient();
  const { data, error } = await supabase
    .from('server_addons')
    .select('*')
    .eq('server_id', ctx.server.id)
    .order('created_at', { ascending: false });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ addons: data ?? [] });
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`addons:${clientIp(request) ?? 'unknown'}`)) {
    return rateLimitResponse();
  }
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { file_name, size_bytes } = parsed.data;

  if (file_name.toLowerCase().endsWith('.jar')) {
    return NextResponse.json(
      {
        error:
          'That is a Java Edition plugin. The official Minecraft Bedrock Dedicated Server cannot load .jar plugins — it uses Bedrock add-ons (.mcpack, .mcaddon) and behaviour/resource packs instead.',
        code: 'JAVA_PLUGIN_REJECTED',
      },
      { status: 415 },
    );
  }

  const addonType = addonTypeFromFileName(file_name);
  if (!addonType) {
    return NextResponse.json(
      {
        error: 'Unsupported file type. Bedrock add-ons must be .mcpack, .mcaddon or .mcworld.',
        code: 'UNSUPPORTED_ADDON_TYPE',
      },
      { status: 415 },
    );
  }

  const admin = createAdminClient();
  const { data: addon, error } = await admin
    .from('server_addons')
    .insert({
      server_id: ctx.server.id,
      owner_id: ctx.userId,
      file_name,
      addon_type: addonType,
      size_bytes,
      status: 'pending',
    })
    .select('*')
    .single();
  if (error || !addon) {
    return NextResponse.json({ error: error?.message ?? 'Failed to register add-on' }, { status: 500 });
  }

  // Storage path is owner-prefixed so the RLS storage policies apply.
  const storagePath = `${ctx.userId}/${ctx.server.id}/${addon.id}-${file_name.replace(/[^A-Za-z0-9._-]/g, '_')}`;
  const { data: signed, error: signError } = await admin.storage
    .from('oghost-addons')
    .createSignedUploadUrl(storagePath);
  if (signError || !signed) {
    return NextResponse.json(
      { error: signError?.message ?? 'Failed to create upload URL' },
      { status: 500 },
    );
  }

  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: 'addon.upload_started',
    targetType: 'addon',
    targetId: addon.id,
    details: { file_name, addon_type: addonType, size_bytes },
    ipAddress: clientIp(request),
  });

  return NextResponse.json(
    {
      addon,
      storage_path: storagePath,
      signed_upload_url: signed.signedUrl,
      token: signed.token,
      next_step: `PUT the file to signed_upload_url, then POST /api/servers/${ctx.server.id}/addons/${addon.id}/install`,
    },
    { status: 201 },
  );
}
