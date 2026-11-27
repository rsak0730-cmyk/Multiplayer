import { describe, expect, it } from 'vitest';
import { compareVersions, parseDownloadPage } from '@/lib/bds/version-discovery';

/**
 * Version discovery is what keeps OG HOST from rotting. No Minecraft version is
 * hard-coded anywhere in the project; the current build is scraped from the
 * official download page at runtime. These tests pin the parser against
 * representative HTML so a page-layout change is caught here rather than
 * silently installing the wrong server — or nothing at all.
 *
 * Every version string below is a fixture. None of them is claimed to be
 * "the latest".
 */
describe('parseDownloadPage', () => {
  it('finds the stable download link', () => {
    const release = parseDownloadPage(`
      <html><body>
      <a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.zip">Download</a>
      </body></html>
    `);

    expect(release).not.toBeNull();
    expect(release!.version).toBe('1.21.20');
    expect(release!.channel).toBe('stable');
    expect(release!.downloadUrl).toMatch(/bedrock-server-1\.21\.20\.zip$/);
    expect(release!.source).toBe('download-page');
    expect(Number.isNaN(Date.parse(release!.discoveredAt))).toBe(false);
  });

  it('prefers stable when both channels are present', () => {
    const release = parseDownloadPage(`
      <a href="https://minecraft.azureedge.net/binaries/bedrock-server-preview-1.22.0.05.zip">Preview</a>
      <a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.zip">Stable</a>
    `);

    expect(release!.version).toBe('1.21.20');
    expect(release!.channel).toBe('stable');
  });

  it('falls back to the preview build when no stable link exists', () => {
    const release = parseDownloadPage(`
      <a href="https://minecraft.azureedge.net/binaries/bedrock-server-preview-1.22.0.05.zip">Preview</a>
    `);

    expect(release).not.toBeNull();
    expect(release!.version).toBe('1.22.0.05');
    expect(release!.channel).toBe('preview');
  });

  it('handles four-segment versions', () => {
    const release = parseDownloadPage(
      '<a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.03.zip">x</a>',
    );
    expect(release!.version).toBe('1.21.20.03');
  });

  it('ignores unrelated links on the page', () => {
    const release = parseDownloadPage(`
      <a href="https://www.minecraft.net/static/client-installer.exe">Get Minecraft</a>
      <a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.zip">Server</a>
      <a href="https://example.com/assets/theme.css">Styles</a>
    `);
    expect(release!.version).toBe('1.21.20');
  });

  it.each([
    ['an empty page', ''],
    ['a page with no links', '<html><body>No links here</body></html>'],
    ['a non-zip archive', '<a href="https://example.com/not-a-server.tar.gz">x</a>'],
    ['an unrelated zip', '<a href="https://example.com/mods.zip">x</a>'],
  ])('returns null rather than guessing for %s', (_label, html) => {
    expect(parseDownloadPage(html)).toBeNull();
  });

  it('returns null when a bedrock zip carries no version', () => {
    // "bedrock-server-latest.zip" would be a trap: we would have no idea what
    // we installed and could not offer a rollback. Refuse instead.
    expect(
      parseDownloadPage('<a href="https://minecraft.azureedge.net/binaries/bedrock-server-latest.zip">x</a>'),
    ).toBeNull();
  });

  it('never reports a downloadUrl that is not the link it parsed', () => {
    const release = parseDownloadPage(
      '<a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.zip">x</a>',
    );
    expect(release!.downloadUrl).toBe(
      'https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.zip',
    );
  });
});

/**
 * This table is deliberately identical to `VersionComparisonTests` in the C#
 * agent suite. Both sides compare versions — the panel to decide whether an
 * update is available, the agent to decide whether an update is safe — and they
 * must reach the same verdict on the same inputs.
 */
describe('compareVersions (mirrors the agent implementation)', () => {
  it.each([
    ['1.21.0', '1.20.80', 1],
    ['1.20.80', '1.21.0', -1],
    ['1.21.20', '1.21.20', 0],
    ['1.21.20.03', '1.21.20', 1],
    ['1.21.20', '1.21.20.03', -1],
    ['1.21.2', '1.21.20', -1],
    ['2.0.0', '1.99.99', 1],
    ['1.0', '1.0.0', 0],
  ] as const)('compareVersions(%j, %j) === %d', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });

  it('compares segments numerically, not as strings', () => {
    // The classic bug: "1.21.9" > "1.21.20" when compared lexicographically.
    expect(compareVersions('1.21.20', '1.21.9')).toBe(1);
    expect(compareVersions('1.21.9', '1.21.20')).toBe(-1);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
  });

  it('treats a malformed segment as zero instead of throwing', () => {
    expect(() => compareVersions('1.beta.0', '1.0.0')).not.toThrow();
    expect(compareVersions('1.beta.0', '1.0.0')).toBe(0);
  });

  it('signals an update only when the discovered version is strictly newer', () => {
    expect(compareVersions('1.21.30', '1.21.20') > 0).toBe(true);
    expect(compareVersions('1.21.20', '1.21.20') > 0).toBe(false);
    expect(compareVersions('1.21.10', '1.21.20') > 0).toBe(false);
  });

  it('is antisymmetric', () => {
    for (const [a, b] of [['1.21.20', '1.21.30'], ['1.20.80', '1.21.0'], ['1.21.20.03', '1.21.20']] as const) {
      expect(compareVersions(a, b)).toBe(-compareVersions(b, a));
    }
  });
});
