import type { ServerConfigRecord } from '@oghost/shared';

/**
 * Render a BDS `server.properties` file from a ServerConfigRecord.
 * The Windows agent writes this verbatim into the server directory.
 * Field names match the official BDS server.properties format.
 */
export function renderServerProperties(cfg: ServerConfigRecord): string {
  const lines: Array<[string, string | boolean | number]> = [
    ['server-name', cfg.server_name],
    ['gamemode', cfg.gamemode],
    ['force-gamemode', cfg.force_gamemode],
    ['difficulty', cfg.difficulty],
    ['spawn-monsters', cfg.spawn_monsters],
    ['spawn-animals', cfg.spawn_animals],
    ['spawn-npcs', cfg.spawn_npcs],
    ['pvp', cfg.pvp],
    ['command-block-output', cfg.command_block_output],
    ['force-command-block-output', cfg.force_command_block_output],
    ['function-command-limit', cfg.function_command_limit],
    ['max-players', cfg.max_players],
    ['online-mode', cfg.online_mode],
    ['allow-list', cfg.allow_list],
    ['server-port', cfg.server_port],
    ['server-portv6', cfg.server_portv6],
    ['enable-lan-transfer', cfg.enable_lan_transfer],
    ['enable-command-blocking', cfg.enable_command_blocking],
    ['compression-threshold', cfg.compression_threshold],
    ['compression-algorithm', cfg.compression_algorithm],
    ['tick-command-redstone-conduction', cfg.tick_command_redstone_conduction],
    ['enable-scripting', cfg.enable_scripting],
    ['enable-external-server-requests', cfg.enable_external_server_requests],
    ['bedrock-blocking-player-prefix', cfg.bedrock_blocking_player_prefix],
    ['level-name', cfg.level_name],
    ['level-seed', cfg.level_seed],
    ['default-player-permission-level', cfg.default_player_permission_level],
    ['texture-pack-required', cfg.texture_pack_required],
    ['server-auth-inputs-allowlist-only', cfg.server_auth_inputs_allowlist_only],
    ['synced-skins-required', cfg.synced_skins_required],
    ['dedicated-server-allowlist-file', cfg.dedicated_server_allowlist_file],
    ['server-admin-allowlist-file', cfg.server_admin_allowlist_file],
  ];
  const bool = (v: boolean) => (v ? 'true' : 'false');
  return lines
    .map(([k, v]) => `${k}=${typeof v === 'boolean' ? bool(v) : v}`)
    .join('\n');
}
