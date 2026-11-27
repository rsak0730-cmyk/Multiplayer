using OGHost.Agent.Services;
using Xunit;

namespace OGHost.Agent.Tests;

/// <summary>
/// The agent discovers the current official Bedrock Dedicated Server build by
/// parsing the official download page. These tests pin the parsing behaviour
/// with representative HTML so a page-layout change is caught by CI rather than
/// silently installing the wrong thing.
///
/// Note: no version number here is treated as "the latest" — they are fixtures.
/// </summary>
public sealed class DownloadPageParsingTests
{
    private readonly BdsVersionDiscovery _discovery =
        new(new NoOpHttpFactory(), TestDoubles.Config(), TestDoubles.Logger<BdsVersionDiscovery>());

    [Fact]
    public void Finds_the_stable_download_link()
    {
        const string html = """
            <html><body>
            <a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.zip">Download</a>
            </body></html>
            """;
        var release = _discovery.ParsePage(html, preferPreview: false);
        Assert.NotNull(release);
        Assert.Equal("1.21.20", release!.Version);
        Assert.Equal("stable", release.Channel);
        Assert.EndsWith("bedrock-server-1.21.20.zip", release.DownloadUrl);
    }

    [Fact]
    public void Prefers_stable_over_preview_when_both_are_present()
    {
        const string html = """
            <html><body>
            <a href="https://minecraft.azureedge.net/binaries/bedrock-server-preview-1.22.0.05.zip">Preview</a>
            <a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.zip">Stable</a>
            </body></html>
            """;
        var release = _discovery.ParsePage(html, preferPreview: false);
        Assert.NotNull(release);
        Assert.Equal("1.21.20", release!.Version);
        Assert.Equal("stable", release.Channel);
    }

    [Fact]
    public void Selects_the_preview_build_when_the_preview_channel_is_requested()
    {
        const string html = """
            <html><body>
            <a href="https://minecraft.azureedge.net/binaries/bedrock-server-preview-1.22.0.05.zip">Preview</a>
            <a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.zip">Stable</a>
            </body></html>
            """;
        var release = _discovery.ParsePage(html, preferPreview: true);
        Assert.NotNull(release);
        Assert.Equal("1.22.0.05", release!.Version);
        Assert.Equal("preview", release.Channel);
    }

    [Fact]
    public void Falls_back_to_stable_when_only_stable_exists_but_preview_was_requested()
    {
        const string html = """
            <a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.zip">Stable</a>
            """;
        var release = _discovery.ParsePage(html, preferPreview: true);
        Assert.NotNull(release);
        Assert.Equal("stable", release!.Channel);
    }

    [Theory]
    [InlineData("")]
    [InlineData("<html><body>No links here</body></html>")]
    [InlineData("<a href=\"https://example.com/not-a-server.tar.gz\">x</a>")]
    public void Returns_null_rather_than_guessing_when_no_link_is_found(string html)
    {
        Assert.Null(_discovery.ParsePage(html, preferPreview: false));
    }

    [Fact]
    public void Returns_null_when_a_zip_link_has_no_version_in_it()
    {
        const string html = """
            <a href="https://minecraft.azureedge.net/binaries/bedrock-server-latest.zip">x</a>
            """;
        Assert.Null(_discovery.ParsePage(html, preferPreview: false));
    }

    [Fact]
    public void Handles_four_segment_versions()
    {
        const string html = """
            <a href="https://minecraft.azureedge.net/binaries/bedrock-server-1.21.20.03.zip">x</a>
            """;
        var release = _discovery.ParsePage(html, preferPreview: false);
        Assert.NotNull(release);
        Assert.Equal("1.21.20.03", release!.Version);
    }
}
