using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace OGHost.Agent.Services;

/// <summary>A discovered official Bedrock Dedicated Server build.</summary>
public sealed record BdsRelease(string Version, string Channel, string DownloadUrl);

/// <summary>
/// Discovers the current official Minecraft Bedrock Dedicated Server release at
/// runtime. NO version number is hard-coded anywhere in OG HOST: Minecraft
/// ships new builds constantly and a pinned version would rot within weeks.
///
/// Sources, in order:
///   1. The official Bedrock server download page (HTML link extraction).
///   2. An operator-supplied direct URL (Agent:BdsDownloadUrlOverride).
///
/// If discovery fails the agent reports the failure honestly instead of
/// guessing a version or downloading from an unofficial mirror.
/// </summary>
public sealed class BdsVersionDiscovery
{
    private const string DownloadPage =
        "https://www.minecraft.net/en-us/download/server/bedrock";

    private static readonly Regex VersionRegex = new(@"(\d+\.\d+\.\d+(?:\.\d+)?)", RegexOptions.Compiled);
    private static readonly Regex ZipUrlRegex =
        new(@"https:[^""'\s<>]+\.zip", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private readonly IHttpClientFactory _httpFactory;

    private HttpClient Http => _httpFactory.CreateClient(HttpClients.Downloads);
    private readonly ILogger<BdsVersionDiscovery> _logger;
    private readonly AgentConfigStore _config;

    private BdsRelease? _cached;
    private DateTime _cachedAt = DateTime.MinValue;

    public BdsVersionDiscovery(IHttpClientFactory httpFactory, AgentConfigStore config, ILogger<BdsVersionDiscovery> logger)
    {
        _httpFactory = httpFactory;
        _config = config;
        _logger = logger;
    }

    /// <summary>
    /// Discover the latest release. Results are cached for 30 minutes so
    /// repeated version checks do not hammer the official page.
    /// </summary>
    public async Task<BdsRelease?> DiscoverAsync(string channel, CancellationToken ct)
    {
        var usePreview = channel.Equals("preview", StringComparison.OrdinalIgnoreCase);
        if (_cached is not null && (DateTime.UtcNow - _cachedAt).TotalMinutes < 30 &&
            _cached.Channel == (usePreview ? "preview" : "stable"))
        {
            return _cached;
        }

        // Operator override wins: useful when the page layout changes or the
        // node has no browser-like access to minecraft.net.
        var overrideUrl = Environment.GetEnvironmentVariable("OGHOST_BDS_URL");
        if (!string.IsNullOrWhiteSpace(overrideUrl))
        {
            var fromOverride = FromUrl(overrideUrl, usePreview ? "preview" : "stable");
            if (fromOverride is not null)
            {
                _cached = fromOverride;
                _cachedAt = DateTime.UtcNow;
                return fromOverride;
            }
        }

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, DownloadPage);
            request.Headers.TryAddWithoutValidation("User-Agent", "OGHOST-Agent/0.1 (+https://github.com/)");
            using var response = await Http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("BDS download page returned {Status}", (int)response.StatusCode);
                return null;
            }

            var html = await response.Content.ReadAsStringAsync(ct);
            var release = ParsePage(html, usePreview);
            if (release is null)
            {
                _logger.LogWarning("Could not find a Bedrock server download link on the official page");
                return null;
            }

            _cached = release;
            _cachedAt = DateTime.UtcNow;
            _logger.LogInformation("Discovered BDS {Version} ({Channel})", release.Version, release.Channel);
            return release;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "BDS version discovery failed");
            return null;
        }
    }

    /// <summary>Extract the stable (preferred) or preview download link.</summary>
    internal BdsRelease? ParsePage(string html, bool preferPreview)
    {
        var urls = ZipUrlRegex.Matches(html).Select(m => m.Value).Distinct().ToList();
        if (urls.Count == 0) return null;

        string? Pick(Func<string, bool> predicate) => urls.FirstOrDefault(predicate);

        var stable = Pick(u => u.Contains("bedrock-server-", StringComparison.OrdinalIgnoreCase) &&
                               !u.Contains("preview", StringComparison.OrdinalIgnoreCase));
        var preview = Pick(u => u.Contains("bedrock-server-preview-", StringComparison.OrdinalIgnoreCase));

        var chosen = preferPreview ? (preview ?? stable) : (stable ?? preview);
        if (chosen is null) return null;
        return FromUrl(chosen, preferPreview && preview is not null ? "preview" : "stable");
    }

    private static BdsRelease? FromUrl(string url, string channel)
    {
        var match = VersionRegex.Match(url);
        if (!match.Success) return null;
        return new BdsRelease(match.Groups[1].Value, channel, url);
    }

    /// <summary>Compare dotted versions. Returns 1 if a &gt; b, -1 if a &lt; b, else 0.</summary>
    public static int CompareVersions(string a, string b)
    {
        var pa = a.Split('.').Select(p => int.TryParse(p, out var v) ? v : 0).ToArray();
        var pb = b.Split('.').Select(p => int.TryParse(p, out var v) ? v : 0).ToArray();
        var len = Math.Max(pa.Length, pb.Length);
        for (var i = 0; i < len; i++)
        {
            var x = i < pa.Length ? pa[i] : 0;
            var y = i < pb.Length ? pb[i] : 0;
            if (x != y) return x > y ? 1 : -1;
        }
        return 0;
    }

    public void InvalidateCache()
    {
        _cached = null;
        _cachedAt = DateTime.MinValue;
    }

    public string DownloadPageUrl => DownloadPage;
}
