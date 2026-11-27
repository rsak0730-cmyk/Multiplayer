import { createAdminClient } from '@/lib/supabase/admin';

export type AuditActor = 'user' | 'agent' | 'system';

export async function auditLog(params: {
  ownerId: string | null;
  actorType: AuditActor;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}) {
  try {
    const admin = createAdminClient();
    await admin.from('audit_logs').insert({
      owner_id: params.ownerId,
      actor_type: params.actorType,
      action: params.action,
      target_type: params.targetType ?? null,
      target_id: params.targetId ?? null,
      details: params.details ?? {},
      ip_address: params.ipAddress ?? null,
    });
  } catch {
    // Audit logging must never break the request path.
  }
}

export function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
  return request.headers.get('x-real-ip');
}
