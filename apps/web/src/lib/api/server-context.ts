import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { requireUser } from '@/lib/auth';

export interface ServerContext {
  userId: string;
  server: {
    id: string;
    node_id: string;
    name: string;
    status: string;
    installed_version: string | null;
    minecraft_version: string | null;
    max_players: number;
    port: number;
    world_name: string;
    network_provider: string;
    public_address: string | null;
    public_port: number | null;
    networking_verified: boolean;
  };
  node: {
    id: string;
    name: string;
    last_seen_at: string | null;
    revoked_at: string | null;
    status: string;
    ram_available_mb: number | null;
    storage_available_mb: number | null;
  };
  nodeOnline: boolean;
}

/**
 * Load the caller's server together with its node, verifying ownership
 * at the database level. Returns either a ServerContext or a NextResponse
 * error ready to send back.
 */
export async function loadServerContext(
  serverId: string,
): Promise<{ ctx: ServerContext } | { error: NextResponse }> {
  const { user, error: authError } = await requireUser();
  if (authError) return { error: authError };

  const supabase = createClient();
  const { data: server, error: serverError } = await supabase
    .from('servers')
    .select('*')
    .eq('id', serverId)
    .maybeSingle();
  if (serverError || !server) {
    return { error: NextResponse.json({ error: 'Server not found' }, { status: 404 }) };
  }

  const { data: node, error: nodeError } = await supabase
    .from('nodes')
    .select('*')
    .eq('id', server.node_id)
    .maybeSingle();
  if (nodeError || !node) {
    return { error: NextResponse.json({ error: 'Hosting node not found' }, { status: 404 }) };
  }

  const now = Date.now();
  const nodeOnline =
    !node.revoked_at && node.last_seen_at
      ? now - new Date(node.last_seen_at).getTime() < 90_000
      : false;

  return {
    ctx: {
      userId: user!.id,
      server,
      node,
      nodeOnline,
    },
  };
}

/** Error response when the node is offline (we refuse to fake success). */
export function nodeOfflineResponse(nodeName: string) {
  return NextResponse.json(
    {
      error: `"${nodeName}" is offline. Start the OG HOST Agent on that computer and wait for it to connect.`,
      code: 'NODE_OFFLINE',
    },
    { status: 409 },
  );
}
