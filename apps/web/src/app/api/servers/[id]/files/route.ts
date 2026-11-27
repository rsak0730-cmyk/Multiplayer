import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadServerContext } from '@/lib/api/server-context';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { auditLog, clientIp } from '@/lib/audit';
import { NODE_COMMANDS, MAX_UPLOAD_BYTES } from '@oghost/shared';
import { z } from 'zod';

export const runtime = 'nodejs';

const pathSchema = z.string().max(500);

/**
 * Protected paths — the agent also enforces this, but we reject early so the
 * user gets a clear message. These are BDS-critical files that must be
 * managed through the dedicated UIs instead of raw file editing.
 */
const PROTECTED_RELATIVE = new Set([
  'bedrock_server.exe',
  'bedrock_server.pdb',
  'allowlist.json',
  'server_admin_allowlist.json',
  'permissions.json',
  'valid_known_packs.json',
]);

function isProtected(relativePath: string): boolean {
  const clean = relativePath.replace(/\\/g, '/');
  if (PROTECTED_RELATIVE.has(clean)) return true;
  // Never let anyone touch the agent's own state directory.
  return clean.startsWith('.oghost/');
}

/** Reject path traversal before it ever reaches the node. */
function isSafeRelativePath(relativePath: string): boolean {
  const clean = relativePath.replace(/\\/g, '/');
  if (clean.startsWith('/')) return false;
  if (clean.includes('\0')) return false;
  const segments = clean.split('/');
  if (segments.some((s) => s === '..')) return false;
  if (segments.some((s) => s === '' && segments.indexOf(s) !== segments.length - 1)) {
    // allow trailing slash for directories
  }
  return true;
}

/**
 * GET /api/servers/:id/files?path=<relative>
 * Enqueues a file_list command and returns the command id. The agent answers
 * asynchronously; the UI polls /api/servers/:id/commands/:commandId.
 *
 * POST /api/servers/:id/files — { op: 'mkdir'|'delete'|'edit'|'download', path, content? }
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
  const loaded = await loadServerContext(params.id);
  if ('error' in loaded) return loaded.error;
  const { ctx } = loaded;

  const url = new URL(request.url);
  const rawPath = url.searchParams.get('path') ?? '';
  const parsed = pathSchema.safeParse(rawPath);
  if (!parsed.success || !isSafeRelativePath(parsed.data)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }
  if (!ctx.nodeOnline) {
    return NextResponse.json(
      { error: `Node "${ctx.node.name}" is offline — files cannot be browsed.`, code: 'NODE_OFFLINE' },
      { status: 409 },
    );
  }

  const admin = createAdminClient();
  const { data: command, error } = await admin
    .from('node_commands')
    .insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: NODE_COMMANDS.FILE_LIST,
      payload: { path: parsed.data },
      status: 'pending',
    })
    .select('*')
    .single();
  if (error || !command) {
    return NextResponse.json({ error: error?.message ?? 'Failed to queue listing' }, { status: 500 });
  }
  return NextResponse.json({ queued: true, command_id: command.id });
}

const opSchema = z.object({
  op: z.enum(['mkdir', 'delete', 'edit', 'download', 'upload_intent', 'upload_commit']),
  // `path` is the target for mkdir/delete/edit/download/upload_commit, and the
  // destination directory for upload_intent (may be empty for the server root).
  path: z.string().max(500).optional(),
  content: z.string().max(2_000_000).optional(),
  file_name: z.string().trim().min(1).max(200).optional(),
  size_bytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES).optional(),
  storage_path: z.string().trim().min(1).max(600).optional(),
  as_text: z.boolean().optional(),
});

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!checkRateLimit(`files:${clientIp(request) ?? 'unknown'}`)) {
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
  const parsed = opSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { op, content } = parsed.data;
  const path = parsed.data.path ?? '';

  if (!isSafeRelativePath(path)) {
    return NextResponse.json({ error: 'Invalid path' }, { status: 400 });
  }
  if (isProtected(path) && op !== 'download') {
    return NextResponse.json(
      {
        error: `"${path}" is a protected Bedrock system file. Manage it through Permissions / Allowlist instead of the file editor.`,
        code: 'PROTECTED_PATH',
      },
      { status: 403 },
    );
  }
  if (!ctx.nodeOnline) {
    return NextResponse.json(
      { error: `Node "${ctx.node.name}" is offline.`, code: 'NODE_OFFLINE' },
      { status: 409 },
    );
  }
  if (op === 'upload_intent') {
    // Step 1 of 2: register the upload and hand back a signed storage URL.
    // Bytes never transit this function (Vercel body limit is ~4.5 MB).
    const fileName = (parsed.data.file_name ?? '').trim();
    const sizeBytes = parsed.data.size_bytes ?? 0;
    if (!fileName || fileName.includes('/') || fileName.includes('\\')) {
      return NextResponse.json({ error: 'A valid file_name is required' }, { status: 400 });
    }
    if (!Number.isInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes` },
        { status: 400 },
      );
    }
    const destDir = path;
    if (destDir && !isSafeRelativePath(destDir)) {
      return NextResponse.json({ error: 'Invalid destination path' }, { status: 400 });
    }
    const safeName = fileName.replace(/[^A-Za-z0-9._\- ]/g, '_');
    const storagePath = `${ctx.userId}/${ctx.server.id}/files/${Date.now()}-${safeName.replace(/ /g, '_')}`;

    const admin0 = createAdminClient();
    const { data: signed, error: signError } = await admin0.storage
      .from('oghost-server-files')
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
      action: 'server.file_upload_started',
      targetType: 'server',
      targetId: ctx.server.id,
      details: { file_name: safeName, size_bytes: sizeBytes, dest: destDir || '/' },
      ipAddress: clientIp(request),
    });
    return NextResponse.json({
      signed_upload_url: signed.signedUrl,
      token: signed.token,
      storage_path: storagePath,
      destination_path: destDir ? `${destDir}/${safeName}` : safeName,
    });
  }

  if (op === 'upload_commit') {
    // Step 2 of 2: the bytes are in storage — tell the node to pull them down.
    if (!path) {
      return NextResponse.json({ error: 'path is required' }, { status: 400 });
    }
    const storagePath = (parsed.data.storage_path ?? '').trim();
    if (!storagePath.startsWith(`${ctx.userId}/${ctx.server.id}/`)) {
      // Only objects this user owns for this server may be pulled to the node.
      return NextResponse.json({ error: 'Storage path is not yours' }, { status: 403 });
    }
    const admin1 = createAdminClient();
    const { data: signed, error: signError } = await admin1.storage
      .from('oghost-server-files')
      .createSignedUrl(storagePath, 60 * 15);
    if (signError || !signed) {
      return NextResponse.json(
        {
          error: `File is not in storage yet: ${signError?.message ?? 'unknown error'}`,
          code: 'UPLOAD_NOT_FOUND',
        },
        { status: 409 },
      );
    }
    const { data: command, error } = await admin1
      .from('node_commands')
      .insert({
        node_id: ctx.node.id,
        server_id: ctx.server.id,
        command_type: NODE_COMMANDS.FILE_UPLOAD,
        payload: { path, download_url: signed.signedUrl },
        status: 'pending',
      })
      .select('*')
      .single();
    if (error || !command) {
      return NextResponse.json(
        { error: error?.message ?? 'Failed to queue the transfer' },
        { status: 500 },
      );
    }
    await auditLog({
      ownerId: ctx.userId,
      actorType: 'user',
      action: 'server.file_uploaded',
      targetType: 'server',
      targetId: ctx.server.id,
      details: { path },
      ipAddress: clientIp(request),
    });
    return NextResponse.json({ queued: true, command_id: command.id });
  }

  if (!path) {
    return NextResponse.json({ error: 'path is required' }, { status: 400 });
  }
  if (op === 'edit' && content === undefined) {
    return NextResponse.json({ error: 'content is required for edit' }, { status: 400 });
  }

  const commandType =
    op === 'mkdir'
      ? NODE_COMMANDS.FILE_MKDIR
      : op === 'delete'
        ? NODE_COMMANDS.FILE_DELETE
        : op === 'edit'
          ? NODE_COMMANDS.FILE_EDIT
          : NODE_COMMANDS.FILE_DOWNLOAD;

  const admin = createAdminClient();
  const { data: command, error } = await admin
    .from('node_commands')
    .insert({
      node_id: ctx.node.id,
      server_id: ctx.server.id,
      command_type: commandType,
      payload: { path, content: content ?? null, as_text: Boolean(parsed.data.as_text) },
      status: 'pending',
    })
    .select('*')
    .single();
  if (error || !command) {
    return NextResponse.json({ error: error?.message ?? 'Failed to queue operation' }, { status: 500 });
  }

  await auditLog({
    ownerId: ctx.userId,
    actorType: 'user',
    action: `server.file_${op}`,
    targetType: 'server',
    targetId: ctx.server.id,
    details: { path },
    ipAddress: clientIp(request),
  });

  return NextResponse.json({ queued: true, command_id: command.id });
}
