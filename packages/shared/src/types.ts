/** Shared domain types. Mirrors the Supabase schema (see supabase/migrations). */

export type NodeStatus = 'online' | 'offline' | 'revoked' | 'unknown';
export type ServerStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'installing'
  | 'updating'
  | 'error'
  | 'unknown';

export type GameMode = 'survival' | 'creative' | 'adventure';
export type Difficulty = 'peaceful' | 'easy' | 'normal' | 'hard';
export type PermissionLevel = 'visitor' | 'member' | 'operator';
export type NetworkProvider = 'direct' | 'playit' | 'manual' | 'custom';
export type BackupStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'restoring';
export type BdsChannel = 'stable' | 'preview';

export interface NodeRecord {
  id: string;
  owner_id: string;
  name: string;
  hostname: string | null;
  operating_system: string | null;
  agent_version: string | null;
  agent_platform: string;
  status: NodeStatus;
  cpu_percent: number | null;
  ram_total_mb: number | null;
  ram_available_mb: number | null;
  storage_total_mb: number | null;
  storage_available_mb: number | null;
  disk_used_mb: number | null;
  uptime_seconds: number | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
}

export interface ServerRecord {
  id: string;
  owner_id: string;
  node_id: string;
  name: string;
  description: string;
  game_type: string;
  minecraft_version: string | null;
  installed_version: string | null;
  available_version: string | null;
  status: ServerStatus;
  max_players: number;
  world_name: string;
  port: number;
  network_provider: NetworkProvider;
  public_address: string | null;
  public_port: number | null;
  networking_verified: boolean;
  networking_verified_at: string | null;
  auto_update: boolean;
  auto_start_on_node_boot: boolean;
  online_players: number;
  last_error: string | null;
  last_started_at: string | null;
  last_stopped_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ServerConfigRecord {
  id: string;
  server_id: string;
  owner_id: string;
  server_name: string;
  gamemode: GameMode;
  force_gamemode: boolean;
  difficulty: Difficulty;
  spawn_monsters: boolean;
  spawn_animals: boolean;
  spawn_npcs: boolean;
  pvp: boolean;
  command_block_output: boolean;
  force_command_block_output: boolean;
  function_command_limit: number;
  max_players: number;
  online_mode: boolean;
  allow_list: boolean;
  server_port: number;
  server_portv6: number;
  enable_lan_transfer: boolean;
  enable_command_blocking: boolean;
  compression_threshold: number;
  compression_algorithm: 'deflate' | 'none';
  tick_command_redstone_conduction: number;
  enable_scripting: boolean;
  enable_external_server_requests: boolean;
  bedrock_blocking_player_prefix: string;
  level_name: string;
  level_seed: string;
  default_player_permission_level: PermissionLevel;
  texture_pack_required: boolean;
  server_auth_inputs_allowlist_only: boolean;
  synced_skins_required: boolean;
  dedicated_server_allowlist_file: string;
  server_admin_allowlist_file: string;
  created_at: string;
  updated_at: string;
}

export interface NodeCommandRecord {
  id: string;
  node_id: string;
  server_id: string | null;
  command_type: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled';
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  result: Record<string, unknown> | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface BackupRecord {
  id: string;
  server_id: string;
  owner_id: string;
  name: string;
  file_name: string;
  size_bytes: number;
  minecraft_version: string | null;
  status: BackupStatus;
  storage_provider: 'local' | 'google_drive';
  drive_file_id: string | null;
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export interface VersionRecord {
  id: string;
  server_id: string;
  owner_id: string;
  version: string;
  channel: BdsChannel;
  action: 'installed' | 'updated' | 'rolled_back' | 'verified';
  install_path: string | null;
  archive_checksum_sha256: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  created_at: string;
  completed_at: string | null;
  error_message: string | null;
}

export interface AddonRecord {
  id: string;
  server_id: string;
  owner_id: string;
  file_name: string;
  addon_type: 'mcpack' | 'mcaddon' | 'mcworld';
  size_bytes: number;
  status: 'pending' | 'installing' | 'installed' | 'failed';
  installed_path: string | null;
  created_at: string;
  installed_at: string | null;
  error_message: string | null;
}

export interface NetworkEndpointRecord {
  id: string;
  server_id: string;
  owner_id: string;
  provider: NetworkProvider;
  address: string | null;
  port: number | null;
  status: 'unknown' | 'pending' | 'active' | 'verified' | 'failed' | 'stopped';
  verified: boolean;
  verified_at: string | null;
  last_checked_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ConsoleLogRecord {
  id: number;
  server_id: string;
  owner_id: string;
  line: string;
  stream: 'stdout' | 'stderr' | 'system';
  created_at: string;
}

/** Agent heartbeat payload (agent -> control plane). */
export interface HeartbeatPayload {
  hostname: string;
  operating_system: string;
  agent_version: string;
  agent_platform: string;
  cpu_percent: number;
  ram_total_mb: number;
  ram_available_mb: number;
  storage_total_mb: number;
  storage_available_mb: number;
  disk_used_mb: number;
  uptime_seconds: number;
  servers: Array<{
    server_id: string;
    status: ServerStatus;
    installed_version: string | null;
    online_players: number;
    public_address?: string | null;
    public_port?: number | null;
    networking_verified?: boolean;
    last_error?: string | null;
  }>;
}

/** Agent command result payload (agent -> control plane). */
export interface CommandResultPayload {
  status: 'completed' | 'failed';
  result?: Record<string, unknown>;
  error_message?: string;
}
