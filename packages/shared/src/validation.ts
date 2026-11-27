/** Pure validation helpers shared by web + agent. No framework code. */

export const SERVER_NAME_RE = /^[A-Za-z0-9 _\-]{1,64}$/;
export const WORLD_NAME_RE = /^[A-Za-z0-9 _\-]{1,64}$/;
export const PAIRING_CODE_RE = /^[A-Z0-9]{6}-[A-Z0-9]{6}$/;
export const ADDON_EXTENSIONS = ['.mcpack', '.mcaddon', '.mcworld'] as const;

export function isValidServerName(name: string): boolean {
  return SERVER_NAME_RE.test(name.trim());
}

export function isValidWorldName(name: string): boolean {
  return WORLD_NAME_RE.test(name.trim());
}

export function isValidPairingCode(code: string): boolean {
  return PAIRING_CODE_RE.test(code.trim().toUpperCase());
}

export function addonTypeFromFileName(fileName: string): 'mcpack' | 'mcaddon' | 'mcworld' | null {
  const lower = fileName.toLowerCase();
  for (const ext of ADDON_EXTENSIONS) {
    if (lower.endsWith(ext)) return ext.slice(1) as 'mcpack' | 'mcaddon' | 'mcworld';
  }
  return null;
}

/**
 * Resolve a user-supplied relative path inside a server root directory.
 * Returns the absolute normalised path, or null if it escapes the root.
 * Mirrors the agent-side implementation (defence in depth).
 */
export function resolveInsideRoot(root: string, relativePath: string): string | null {
  const clean = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean.split('/').includes('..')) return null;
  const parts = clean.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  const rootNorm = root.replace(/\\/g, '/').replace(/\/+$/, '');
  return `${rootNorm}/${parts.join('/')}`;
}

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

export function isValidMaxPlayers(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 100;
}

/** Format bytes for display. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}
