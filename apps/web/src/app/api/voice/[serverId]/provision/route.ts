import { NextResponse } from 'next/server';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { requireVoiceOwnerContext, provisionVoiceForServer, logVoiceEvent } from '@/lib/api/voice-context';
import { readVoiceServiceConfig, voiceConfigStatus } from '@/lib/voice/tokens';

export const runtime = 'nodejs';

/**
 * POST /api/voice/:serverId/provision — prepare voice for this server
 *
 * Idempotent: safe to call on server creation, from the dashboard, or twice by
 * accident. It creates the configuration row with §3's defaults and maps a room,
 * and it never overwrites settings an owner already chose.
 *
 * The response reports what actually happened rather than implying success. If no
 * voice server is configured, the room is not created and `ready` is false with
 * an explanation — §3 forbids pretending the integration installed.
 */
export async function POST(request: Request, { params }: { params: { serverId: string } }) {
  if (!checkRateLimit(`voice-provision:${params.serverId}`)) {
    return rateLimitResponse();
  }

  const loaded = await requireVoiceOwnerContext(params.serverId);
  if ('error' in loaded) return loaded.error;

  const result = await provisionVoiceForServer({
    serverId: loaded.ctx.server.id,
    ownerId: loaded.ctx.userId,
  });

  if (result.roomCreated) {
    await logVoiceEvent({
      serverId: loaded.ctx.server.id,
      eventType: 'service_restarted',
      detail: { reason: 'room_provisioned' },
    });
  }

  return NextResponse.json(
    {
      ready: result.ready,
      status: result.status,
      config_created: result.configCreated,
      room_created: result.roomCreated,
      room_name: result.roomName,
      sfu_url: result.sfuUrl,
      // Reported so the dashboard can distinguish "no voice server configured on
      // this deployment" from "configured but this server has no room".
      service_status: voiceConfigStatus(readVoiceServiceConfig()),
    },
    // 201 only when something was actually created; otherwise the state is
    // unchanged and 200 is the honest answer.
    { status: result.configCreated || result.roomCreated ? 201 : 200 },
  );
}
