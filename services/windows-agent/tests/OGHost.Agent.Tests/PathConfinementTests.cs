using OGHost.Agent.Services;
using Xunit;

namespace OGHost.Agent.Tests;

/// <summary>
/// Path confinement is the second security boundary: the file manager must
/// never read, write or delete anything outside one server's own directory,
/// even when the panel (or an attacker who compromised it) sends a hostile path.
/// </summary>
public sealed class PathConfinementTests
{
    private static string Root()
    {
        var root = Path.Combine(Path.GetTempPath(), $"oghost-path-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        return root;
    }

    [Fact]
    public void Resolves_a_simple_relative_path_inside_the_root()
    {
        var root = Root();
        var resolved = ServerFileManager.ResolveInsideRoot(root, "worlds/level");
        Assert.NotNull(resolved);
        Assert.StartsWith(Path.GetFullPath(root), resolved!, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Resolves_an_empty_path_to_the_root_itself()
    {
        var root = Root();
        var resolved = ServerFileManager.ResolveInsideRoot(root, "");
        Assert.Equal(Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar), resolved);
    }

    [Theory]
    [InlineData("../secret.txt")]
    [InlineData("../../Windows/System32/config/SAM")]
    [InlineData("worlds/../../outside.txt")]
    [InlineData("..\\..\\other-server\\worlds")]
    [InlineData("a/b/../../../../etc/passwd")]
    [InlineData("/etc/passwd")]
    public void Refuses_any_path_that_escapes_the_root(string hostile)
    {
        var root = Root();
        var resolved = ServerFileManager.ResolveInsideRoot(root, hostile);
        Assert.True(resolved is null ||
                    resolved.StartsWith(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase),
            $"Path '{hostile}' escaped the root: {resolved}");
        // "/etc/passwd" is rooted on both Windows and Linux, and the resolver
        // deliberately strips the leading separator so it lands INSIDE the root.
        if (!Path.IsPathRooted(hostile))
        {
            Assert.Null(resolved);
        }
    }

    /// <summary>
    /// A Windows drive-letter path is only "rooted" on Windows. On Linux the
    /// backslashes are ordinary filename characters, so the same string resolves
    /// to a harmless relative path inside the root instead of escaping it.
    /// Asserting a single behaviour for both would be testing the platform, not
    /// the confinement logic — so this case is pinned to Windows, which is the
    /// only OS the agent ships for.
    /// </summary>
    [Fact]
    public void Refuses_an_absolute_windows_path()
    {
        if (!OperatingSystem.IsWindows()) return;

        var root = Root();
        Assert.Null(ServerFileManager.ResolveInsideRoot(root, @"C:\Windows\System32\cmd.exe"));
    }

    [Fact]
    public void Refuses_null_bytes()
    {
        var root = Root();
        Assert.Null(ServerFileManager.ResolveInsideRoot(root, "world\0.txt"));
    }

    [Fact]
    public void Normalises_windows_and_posix_separators_alike()
    {
        var root = Root();
        var a = ServerFileManager.ResolveInsideRoot(root, "behavior_packs/my pack/manifest.json");
        var b = ServerFileManager.ResolveInsideRoot(root, "behavior_packs\\my pack\\manifest.json");
        Assert.Equal(a, b);
    }

    [Fact]
    public void Deeply_nested_paths_stay_inside_the_root()
    {
        var root = Root();
        var deep = string.Join('/', Enumerable.Repeat("a", 40));
        var resolved = ServerFileManager.ResolveInsideRoot(root, deep);
        Assert.NotNull(resolved);
        Assert.StartsWith(Path.GetFullPath(root), resolved!, StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData("bedrock_server.exe", true)]
    [InlineData("allowlist.json", true)]
    [InlineData("permissions.json", true)]
    [InlineData("valid_known_packs.json", true)]
    [InlineData("server_admin_allowlist.json", true)]
    [InlineData(".oghost-state.json", true)]
    [InlineData("server.properties", false)]
    [InlineData("worlds/level/level.dat", false)]
    [InlineData("behavior_packs/mypack/manifest.json", false)]
    public void Protects_bedrock_system_files_from_edits(string path, bool expectedProtected)
    {
        Assert.Equal(expectedProtected, ServerFileManager.IsProtected(path));
    }
}
