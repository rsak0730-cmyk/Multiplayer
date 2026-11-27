import { createAdminClient } from '@/lib/supabase/admin';
import { NODE_COMMANDS, type NodeCommandType } from '@oghost/shared';

/**
 * Enqueue a command for a node. The agent picks it up on its next poll.
 * Returns the created command row.
 */
export async function enqueueCommand(params: {
  nodeId: string;
  serverId?: string | null;
  commandType: NodeCommandType;
  payload?: Record<string, unknown>;
}) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from('node_commands')
    .insert({
      node_id: params.nodeId,
      server_id: params.serverId ?? null,
      command_type: params.commandType,
      payload: params.payload ?? {},
      status: 'pending',
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data;
}

/** Check whether the node is currently online (seen within 90s). */
export function isNodeOnline(node: { last_seen_at: string | null; revoked_at: string | null }): boolean {
  if (node.revoked_at) return false;
  if (!node.last_seen_at) return false;
  const seen = new Date(node.last_seen_at).getTime();
  return Date.now() - seen < 90_000;
}

export { NODE_COMMANDS };
