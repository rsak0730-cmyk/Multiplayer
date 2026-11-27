/** Shared constants. No Minecraft version numbers are hard-coded anywhere. */

export const AGENT_VERSION = '0.1.0';
export const CONTROL_PLANE_API_VERSION = 'v1';

/** Agent heartbeat interval (seconds). */
export const HEARTBEAT_INTERVAL_SECONDS = 15;
/** Node is considered online if last seen within this window. */
export const NODE_ONLINE_WINDOW_SECONDS = 90;
/** Pairing code lifetime. */
export const PAIRING_CODE_TTL_MINUTES = 10;
/** Max pairing attempts per code before invalidation. */
export const PAIRING_MAX_ATTEMPTS = 5;
/** Max upload size for add-ons / files (bytes). 256 MB. */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;
/** Console log lines retained per server in the database buffer. */
export const CONSOLE_LOG_RETENTION_DAYS = 7;
/** Default BDS ports. */
export const DEFAULT_BDS_PORT = 19132;
export const DEFAULT_BDS_PORT_V6 = 19133;
/** Conservative defaults for low-end hardware (6 GB RAM target host). */
export const DEFAULT_MAX_PLAYERS = 10;
export const DEFAULT_VIEW_DISTANCE_TICKS = 7;
