using Microsoft.Extensions.Logging;
using OGHost.Agent.Models;

namespace OGHost.Agent.Services;

/// <summary>Outcome of a file operation.</summary>
public sealed record FileOperationResult(
    bool Success,
    string? Error,
    IReadOnlyList<FileEntry>? Entries = null,
    string? Content = null);

/// <summary>
/// Confined file access inside one server's directory.
///
/// Every path is resolved and then re-verified to be inside the server root,
/// so a traversal attempt such as <c>../../Windows/System32</c> cannot escape.
/// Bedrock system files are additionally protected from modification, because
/// corrupting them bricks a server and the panel has dedicated UIs for them.
///
/// There is deliberately no operation here that executes anything.
/// </summary>
public sealed class ServerFileManager
{
    /// <summary>Files the agent refuses to edit or delete.</summary>
    private static readonly HashSet<string> Protected = new(StringComparer.OrdinalIgnoreCase)
    {
        "bedrock_server.exe",
        "bedrock_server.pdb",
        "allowlist.json",
        "server_admin_allowlist.json",
        "permissions.json",
        "valid_known_packs.json",
    };

    private const long MaxTextFileBytes = 2 * 1024 * 1024;
    private const long MaxDownloadBytes = 512 * 1024 * 1024;

    private readonly ILogger<ServerFileManager> _logger;
    private readonly BdsInstaller _installer;

    public ServerFileManager(BdsInstaller installer, ILogger<ServerFileManager> logger)
    {
        _installer = installer;
        _logger = logger;
    }

    /// <summary>
    /// Resolve <paramref name="relativePath"/> inside a server root.
    /// Returns null when the result would escape the root.
    /// </summary>
    public static string? ResolveInsideRoot(string root, string relativePath)
    {
        var normalisedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var cleaned = (relativePath ?? string.Empty)
            .Replace('\\', '/')
            .TrimStart('/');

        if (cleaned.Contains('\0')) return null;

        var candidate = Path.GetFullPath(Path.Combine(normalisedRoot, cleaned));
        var normalisedCandidate = candidate.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;

        if (!normalisedCandidate.StartsWith(normalisedRoot, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        return candidate.TrimEnd(Path.DirectorySeparatorChar);
    }

    public static bool IsProtected(string relativePath)
    {
        var name = Path.GetFileName(relativePath.Replace('\\', '/'));
        if (Protected.Contains(name)) return true;
        // Never let anyone touch the agent's own state file.
        return relativePath.Replace('\\', '/').StartsWith(".oghost", StringComparison.OrdinalIgnoreCase);
    }

    public FileOperationResult List(string serverId, string relativePath)
    {
        var root = _installer.ServerDirectory(serverId);
        var target = ResolveInsideRoot(root, relativePath);
        if (target is null) return Fail("Path is outside the server directory.");
        if (!Directory.Exists(target)) return Fail("Directory does not exist.");

        try
        {
            var entries = new List<FileEntry>();
            foreach (var dir in Directory.GetDirectories(target))
            {
                var name = Path.GetFileName(dir);
                entries.Add(new FileEntry(
                    name,
                    ToRelative(root, dir),
                    true,
                    0,
                    Directory.GetLastWriteTimeUtc(dir).ToString("O")));
            }
            foreach (var file in Directory.GetFiles(target))
            {
                var info = new FileInfo(file);
                entries.Add(new FileEntry(
                    info.Name,
                    ToRelative(root, file),
                    false,
                    info.Length,
                    info.LastWriteTimeUtc.ToString("O")));
            }
            return new FileOperationResult(true, null, entries);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Listing failed for {Path}", target);
            return Fail(ex.Message);
        }
    }

    public FileOperationResult MakeDirectory(string serverId, string relativePath)
    {
        var root = _installer.ServerDirectory(serverId);
        var target = ResolveInsideRoot(root, relativePath);
        if (target is null) return Fail("Path is outside the server directory.");
        try
        {
            Directory.CreateDirectory(target);
            return new FileOperationResult(true, null);
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    public FileOperationResult Delete(string serverId, string relativePath)
    {
        var root = _installer.ServerDirectory(serverId);
        var target = ResolveInsideRoot(root, relativePath);
        if (target is null) return Fail("Path is outside the server directory.");
        if (IsProtected(relativePath)) return Fail($"“{relativePath}” is a protected Bedrock system file.");
        try
        {
            if (Directory.Exists(target))
            {
                // Refuse to delete the world through the file manager: that is
                // what backups exist for, and an accidental tap on a phone
                // should not erase months of building.
                if (target.Contains($"{Path.DirectorySeparatorChar}worlds{Path.DirectorySeparatorChar}",
                        StringComparison.OrdinalIgnoreCase))
                {
                    return Fail("World folders cannot be deleted through the file manager. Use Backups → restore instead.");
                }
                Directory.Delete(target, recursive: true);
            }
            else if (File.Exists(target))
            {
                File.Delete(target);
            }
            else
            {
                return Fail("File or folder does not exist.");
            }
            return new FileOperationResult(true, null);
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    public FileOperationResult ReadText(string serverId, string relativePath)
    {
        var root = _installer.ServerDirectory(serverId);
        var target = ResolveInsideRoot(root, relativePath);
        if (target is null) return Fail("Path is outside the server directory.");
        if (!File.Exists(target)) return Fail("File does not exist.");
        var info = new FileInfo(target);
        if (info.Length > MaxTextFileBytes)
        {
            return Fail($"File is {info.Length / 1024} KB — too large to edit in the browser (limit 2 MB).");
        }
        try
        {
            return new FileOperationResult(true, null, null, File.ReadAllText(target));
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    public FileOperationResult WriteText(string serverId, string relativePath, string content)
    {
        var root = _installer.ServerDirectory(serverId);
        var target = ResolveInsideRoot(root, relativePath);
        if (target is null) return Fail("Path is outside the server directory.");
        if (IsProtected(relativePath)) return Fail($"“{relativePath}” is a protected Bedrock system file.");
        if (content.Length > MaxTextFileBytes) return Fail("Content is too large (limit 2 MB).");
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            // Keep one generation of history so a bad edit is recoverable.
            if (File.Exists(target))
            {
                var backup = target + ".oghost-prev";
                File.Copy(target, backup, overwrite: true);
            }
            File.WriteAllText(target, content);
            return new FileOperationResult(true, null);
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    /// <summary>Write a downloaded stream to a path inside the server root.</summary>
    public async Task<FileOperationResult> WriteStreamAsync(
        string serverId, string relativePath, Stream content, CancellationToken ct)
    {
        var root = _installer.ServerDirectory(serverId);
        var target = ResolveInsideRoot(root, relativePath);
        if (target is null) return Fail("Path is outside the server directory.");
        if (IsProtected(relativePath)) return Fail($"“{relativePath}” is a protected Bedrock system file.");
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            await using var file = File.Create(target);
            await content.CopyToAsync(file, ct);
            if (file.Length > MaxDownloadBytes)
            {
                file.Dispose();
                File.Delete(target);
                return Fail("File exceeds the 512 MB limit.");
            }
            return new FileOperationResult(true, null);
        }
        catch (Exception ex)
        {
            return Fail(ex.Message);
        }
    }

    public string? ResolveRead(string serverId, string relativePath)
    {
        var root = _installer.ServerDirectory(serverId);
        var target = ResolveInsideRoot(root, relativePath);
        if (target is null || !File.Exists(target)) return null;
        return target;
    }

    public long SizeOf(string serverId, string relativePath)
    {
        var path = ResolveRead(serverId, relativePath);
        return path is null ? 0 : new FileInfo(path).Length;
    }

    private static string ToRelative(string root, string fullPath)
    {
        var normalisedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var relative = fullPath.StartsWith(normalisedRoot, StringComparison.OrdinalIgnoreCase)
            ? fullPath[normalisedRoot.Length..]
            : fullPath;
        return relative.Replace(Path.DirectorySeparatorChar, '/');
    }

    private static FileOperationResult Fail(string error) => new(false, error);
}
