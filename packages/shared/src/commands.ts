/**
 * Command vocabulary between the web control plane and the Windows agent.
 * The agent implements an allowlist — anything not listed here is rejected.
 * There is intentionally NO "shell" / "exec" command.
 */
export const NODE_COMMANDS = {
  START_SERVER: 'start_server',
  STOP_SERVER: 'stop_server',
  RESTART_SERVER: 'restart_server',
  FORCE_STOP: 'force_stop',
  INSTALL_BDS: 'install_bds',
  UPDATE_BDS: 'update_bds',
  ROLLBACK_BDS: 'rollback_bds',
  APPLY_CONFIG: 'config_apply',
  CONSOLE_COMMAND: 'console_command',
  BACKUP_WORLD: 'backup_world',
  RESTORE_BACKUP: 'restore_backup',
  FILE_LIST: 'file_list',
  FILE_UPLOAD: 'file_upload',
  FILE_DOWNLOAD: 'file_download',
  FILE_DELETE: 'file_delete',
  FILE_MKDIR: 'file_mkdir',
  FILE_EDIT: 'file_edit',
  ADDON_INSTALL: 'addon_install',
  NETWORKING_START: 'networking_start',
  NETWORKING_STOP: 'networking_stop',
  CHECK_VERSIONS: 'check_versions',
} as const;

export type NodeCommandType =
  (typeof NODE_COMMANDS)[keyof typeof NODE_COMMANDS];

/** Console commands the agent will forward to BDS stdin. */
export const ALLOWED_BDS_COMMANDS = [
  'say',
  'tell',
  'tellraw',
  'list',
  'whitelist',
  'op',
  'deop',
  'kick',
  'ban',
  'pardon',
  'gamemode',
  'difficulty',
  'time',
  'weather',
  'tp',
  'teleport',
  'give',
  'xp',
  'effect',
  'enchant',
  'kill',
  'fill',
  'setblock',
  'clone',
  'structure',
  'save',
  'stop',
  'help',
  'version',
  'locate',
  'summon',
  'execute',
  'scoreboard',
  'gamerule',
  'setworldspawn',
  'spawnpoint',
  'clear',
  'fillbiome',
  'fog',
  'function',
  'kickall',
  'reload',
  'script',
  'testfor',
  'testforblock',
  'testforblocks',
  'title',
  'titleraw',
  'tickingarea',
  'transfer',
  'event',
  'inputpermission',
  'allowlist',
  'permission',
  'replaceitem',
  'ride',
  'rotate',
  'sculk',
  'setmaxplayers',
  'simulationdistance',
  'stopsound',
  'tag',
  'worldborder',
  'worldbuilder',
  'playsound',
  'me',
  'w',
  'msg',
] as const;

/** Returns true if the raw console input is an allowlisted BDS command. */
export function isAllowedBdsCommand(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return false;
  // Block shell metacharacters outright — BDS stdin is not a shell, but
  // belt-and-braces against injection through any future transport.
  if (/[;&|`$><\n\r]/.test(trimmed)) return false;
  const head = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
  return (ALLOWED_BDS_COMMANDS as readonly string[]).includes(head);
}
