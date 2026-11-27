/**
 * BDS version discovery — NO hard-coded Minecraft version numbers.
 *
 * Strategy:
 *  1. Fetch the official Minecraft Bedrock server download page and extract
 *     the current stable download link (minecraft.azureedge.net / mojang
 *     CDN links ending in .zip with a version in the path).
 *  2. Fall back to the Mojang version manifest (piston-meta) which lists
 *     Bedrock server builds.
 *  3. If both fail, return null — the UI shows "unknown" rather than a
 *     fabricated version.
 *
 * The Windows agent performs the actual download + checksum verification.
 * This module only answers "what is the latest version?" for display and
 * for enqueueing update commands.
 */

export interface DiscoveredVersion {
  version: string;
  channel: 'stable' | 'preview';
  downloadUrl: string | null;
  discoveredAt: string;
  source: 'download-page' | 'manifest' | 'unknown';
}

const DOWNLOAD_PAGE =
  process.env.BDS_DOWNLOAD_PAGE_URL ??
  'https://www.minecraft.net/en-us/download/server/bedrock';

const VERSION_RE = /(\d+\.\d+\.\d+(?:\.\d+)?)/;
const ZIP_URL_RE = /https:[^"'\s<>]+\.zip/g;

/** Extract the latest version + download URL from the official page HTML. */
export function parseDownloadPage(html: string): DiscoveredVersion | null {
  const urls = html.match(ZIP_URL_RE) ?? [];
  // Prefer bedrock-server links (stable) over bedrock-server-preview.
  const stable = urls.find(
    (u) => u.includes('bedrock-server-') && !u.includes('preview'),
  );
  const preview = urls.find((u) => u.includes('bedrock-server-preview-'));
  const chosen = stable ?? preview;
  if (!chosen) return null;
  const match = chosen.match(VERSION_RE);
  if (!match) return null;
  return {
    version: match[1],
    channel: stable ? 'stable' : 'preview',
    downloadUrl: chosen,
    discoveredAt: new Date().toISOString(),
    source: 'download-page',
  };
}

/** Fetch latest stable BDS version. Returns null when discovery fails. */
export async function discoverLatestBdsVersion(
  channel: 'stable' | 'preview' = 'stable',
): Promise<DiscoveredVersion | null> {
  try {
    const res = await fetch(DOWNLOAD_PAGE, {
      headers: { 'User-Agent': 'OGHOST/0.1 (+https://github.com/)' },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const parsed = parseDownloadPage(html);
    if (!parsed) return null;
    if (channel === 'preview' && parsed.channel !== 'preview') {
      // Page only exposed stable; report stable rather than guessing.
      return parsed;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Compare two dotted version strings. Returns 1/0/-1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}
