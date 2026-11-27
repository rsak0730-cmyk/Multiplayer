using Microsoft.Extensions.Logging;
using OGHost.Agent.Models;
using OGHost.Agent.Networking;

namespace OGHost.Agent.Services;

/// <summary>
/// Executes commands from the control plane.
///
/// This is an allowlist dispatcher: <see cref="Handlers"/> enumerates every
/// command the agent understands, and anything else is rejected with an error
/// rather than passed anywhere near a process. There is no shell, no
/// "run this string", and no way to reach the operating system through here
/// beyond the specific operations implemented below.
/// </summary>
public sealed class CommandDispatcher
{
    private readonly ILogger<CommandDispatcher> _logger;
    private readonly AgentConfigStore _config;
    private readonly ControlPlaneClient _client;
    private readonly BdsInstaller _installer;
    private readonly BdsVersionDiscovery _discovery;
    private readonly ServerProcessManager _processes;
    private readonly ServerFileManager _files;
    private readonly BackupManager _backups;
    private readonly AddonInstaller _addons;
    private readonly NetworkManager _network;
    private readonly IHttpClientFactory _httpFactory;

    private HttpClient Http => _httpFactory.CreateClient(HttpClients.Transfers);

    private readonly Dictionary<string, Func<NodeCommand, CommandPayload, CancellationToken, Task<object?>>> _handlers;

    public CommandDispatcher(
        AgentConfigStore config,
        ControlPlaneClient client,
        BdsInstaller installer,
        BdsVersionDiscovery discovery,
        ServerProcessManager processes,
        ServerFileManager files,
        BackupManager backups,
        AddonInstaller addons,
        NetworkManager network,
        IHttpClientFactory httpFactory,
        ILogger<CommandDispatcher> logger)
    {
        _config = config;
        _client = client;
        _installer = installer;
        _discovery = discovery;
        _processes = processes;
        _files = files;
        _backups = backups;
        _addons = addons;
        _network = network;
        _httpFactory = httpFactory;
        _logger = logger;

        _handlers = new Dictionary<string, Func<NodeCommand, CommandPayload, CancellationToken, Task<object?>>>(
            StringComparer.OrdinalIgnoreCase)
        {
            ["start_server"] = StartServer,
            ["stop_server"] = StopServer,
            ["restart_server"] = RestartServer,
            ["force_stop"] = ForceStop,
            ["install_bds"] = InstallBds,
            ["update_bds"] = UpdateBds,
            ["rollback_bds"] = RollbackBds,
            ["check_versions"] = CheckVersions,
            ["config_apply"] = ApplyConfig,
            ["console_command"] = ConsoleCommand,
            ["backup_world"] = BackupWorld,
            ["restore_backup"] = RestoreBackup,
            ["delete_backup"] = DeleteBackup,
            ["upload_backup"] = UploadBackup,
            ["file_list"] = FileList,
            ["file_mkdir"] = FileMkdir,
            ["file_delete"] = FileDelete,
            ["file_edit"] = FileEdit,
            ["file_download"] = FileDownload,
            ["file_upload"] = FileUpload,
            ["addon_install"] = AddonInstall,
            ["addon_remove"] = AddonRemove,
            ["networking_start"] = NetworkingStart,
            ["networking_stop"] = NetworkingStop,
            ["networking_verify"] = NetworkingVerify,
            ["schedule_backups"] = ScheduleBackups,
            ["delete_server"] = DeleteServer,
        };
    }

    /// <summary>Command types this agent understands. Anything else is refused.</summary>
    public IReadOnlyCollection<string> SupportedCommands => _handlers.Keys;

    public async Task ExecuteAsync(NodeCommand command, CancellationToken ct)
    {
        if (!_handlers.TryGetValue(command.CommandType, out var handler))
        {
            await Fail(command.Id,
                $"Command '{command.CommandType}' is not in this agent's allowlist and was refused.");
            return;
        }

        var serverId = command.ServerId;
        _logger.LogInformation("Executing {Type} (command {Id}, server {Server})",
            command.CommandType, command.Id, serverId ?? "none");

        try
        {
            var payload = new CommandPayload(command.Payload);
            var result = await handler(command, payload, ct);
            await _client.ReportResultAsync(command.Id, true, result ?? new { }, null, ct);
        }
        catch (CommandException ex)
        {
            _logger.LogWarning("Command {Id} failed: {Error}", command.Id, ex.Message);
            await Fail(command.Id, ex.Message);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Command {Id} threw", command.Id);
            await Fail(command.Id, ex.Message);
        }
    }

    private async Task Fail(string commandId, string message) =>
        await _client.ReportResultAsync(commandId, false, null, message, CancellationToken.None);

    private string RequireServerId(NodeCommand command) =>
        command.ServerId ?? throw new CommandException("This command requires a server id.");

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    private async Task<object?> StartServer(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var worldName = payload.String("world_name") ?? "world";
        var port = payload.Int("port") ?? 19132;
        var maxPlayers = payload.Int("max_players") ?? 10;

        // If BDS is missing, install it first — the panel asks for this when a
        // server was created while the node was offline.
        if (_installer.GetInstalledVersion(serverId) is null)
        {
            var install = await _installer.InstallAsync(
                serverId, worldName, payload.String("minecraft_version"),
                payload.Bool("preview", _config.Options.UsePreviewChannel) ? "preview" : "stable", ct);
            if (!install.Success) throw new CommandException(install.Error ?? "BDS installation failed.");
        }

        var managed = _processes.GetOrAdd(serverId, worldName);
        managed.Port = port;
        managed.MaxPlayers = maxPlayers;

        var (ok, error, version) = await _processes.StartAsync(serverId, worldName, port, maxPlayers, ct);
        if (!ok) throw new CommandException(error ?? "The server failed to start.");

        object? networking = null;
        if (payload.Bool("establish_networking", true))
        {
            try
            {
                networking = await StartNetworkingInternal(
                    serverId, payload.String("network_provider") ?? "direct", port, payload, ct);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Networking setup failed after a successful start");
                networking = new { ok = false, error = ex.Message };
            }
        }

        await _client.PushEventAsync("server_started",
            $"{managed.WorldName} started on BDS {version ?? "unknown"}", ct);

        return new
        {
            status = "running",
            installed_version = version,
            online_players = 0,
            networking,
        };
    }

    private async Task<object?> StopServer(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var timeout = payload.Int("timeout_seconds") ?? 30;
        var (ok, error) = await _processes.StopAsync(serverId, timeout, ct);
        if (!ok) throw new CommandException(error ?? "The server did not stop cleanly.");
        _network.Invalidate(serverId);
        await _client.PushEventAsync("server_stopped", "Stopped safely", ct);
        return new { status = "stopped", online_players = 0, networking_verified = false };
    }

    private async Task<object?> RestartServer(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var timeout = payload.Int("timeout_seconds") ?? 30;
        await _processes.StopAsync(serverId, timeout, ct);
        _network.Invalidate(serverId);

        var managed = _processes.Get(serverId);
        var worldName = payload.String("world_name") ?? managed?.WorldName ?? "world";
        var port = payload.Int("port") ?? managed?.Port ?? 19132;
        var maxPlayers = payload.Int("max_players") ?? managed?.MaxPlayers ?? 10;

        var (ok, error, version) = await _processes.StartAsync(serverId, worldName, port, maxPlayers, ct);
        if (!ok) throw new CommandException(error ?? "The server failed to restart.");
        return new { status = "running", installed_version = version };
    }

    private Task<object?> ForceStop(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var (ok, error) = _processes.ForceStop(serverId);
        _network.Invalidate(serverId);
        if (!ok) throw new CommandException(error ?? "Force stop failed.");
        return Task.FromResult<object?>(new { status = "stopped", forced = true });
    }

    // ---------------------------------------------------------------------
    // BDS install / versions
    // ---------------------------------------------------------------------

    private async Task<object?> InstallBds(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var worldName = payload.String("world_name") ?? "world";
        var channel = payload.Bool("preview", _config.Options.UsePreviewChannel) ? "preview" : "stable";

        var result = await _installer.InstallAsync(serverId, worldName, payload.String("minecraft_version"), channel, ct);
        if (!result.Success) throw new CommandException(result.Error ?? "Installation failed.");

        if (payload.Bool("then_start"))
        {
            var managed = _processes.GetOrAdd(serverId, worldName);
            var (ok, error, version) = await _processes.StartAsync(
                serverId, worldName, managed.Port, managed.MaxPlayers, ct);
            if (!ok)
            {
                throw new CommandException(
                    $"BDS {result.Version} installed successfully, but the server failed to start: {error}");
            }
            return new
            {
                installed_version = version ?? result.Version,
                install_path = result.InstallPath,
                checksum_sha256 = result.ChecksumSha256,
                status = "running",
            };
        }

        return new
        {
            installed_version = result.Version,
            install_path = result.InstallPath,
            checksum_sha256 = result.ChecksumSha256,
            status = "stopped",
        };
    }

    private async Task<object?> UpdateBds(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var state = _installer.ReadState(serverId);
        var worldName = payload.String("world_name") ?? state.WorldName ?? "world";
        var channel = payload.String("channel") ??
                      (payload.Bool("preview", _config.Options.UsePreviewChannel) ? "preview" : "stable");
        var previous = _installer.GetInstalledVersion(serverId);

        // Never update a running server.
        var managed = _processes.Get(serverId);
        if (managed?.Process is { HasExited: false })
        {
            throw new CommandException(
                "Refusing to update while the server is running. Stop it first — updates never replace a live server.");
        }

        // Back up before touching anything, so a failed update is recoverable.
        if (payload.Bool("backup_before_update", true))
        {
            var backup = await _backups.CreateAsync(
                serverId, worldName, $"pre-update-{DateTime.UtcNow:yyyyMMddHHmmss}", safeStopIfRunning: false, ct);
            if (!backup.Success)
            {
                throw new CommandException(
                    $"Refusing to update because the safety backup failed: {backup.Error}");
            }
        }

        var result = await _installer.UpdateAsync(serverId, worldName, payload.String("target_version"), channel, ct);
        if (!result.Success)
        {
            // Roll back automatically if we still have the previous version.
            if (payload.Bool("rollback_on_failure", true) && previous is not null)
            {
                var rolled = _installer.Rollback(serverId, worldName, previous);
                if (rolled.Success)
                {
                    throw new CommandException(
                        $"Update failed ({result.Error}). Rolled back to {previous} automatically.");
                }
                throw new CommandException(
                    $"Update failed ({result.Error}) and rollback to {previous} also failed ({rolled.Error}).");
            }
            throw new CommandException(result.Error ?? "Update failed.");
        }

        object? health = null;
        if (payload.Bool("restart_after_update"))
        {
            var (ok, error, version) = await _processes.StartAsync(
                serverId, worldName, managed?.Port ?? 19132, managed?.MaxPlayers ?? 10, ct);
            if (!ok && payload.Bool("rollback_on_failure", true) && previous is not null)
            {
                var rolled = _installer.Rollback(serverId, worldName, previous);
                if (!rolled.Success)
                {
                    // Never claim a rollback that did not happen.
                    throw new CommandException(
                        $"Updated to {result.Version} but the server failed to start ({error}), " +
                        $"and the automatic rollback to {previous} also failed ({rolled.Error}). " +
                        $"The server is currently pointing at {result.Version}.");
                }
                throw new CommandException(
                    $"Updated to {result.Version} but the server failed to start ({error}). Rolled back to {previous}.");
            }
            health = new { started = ok, error, version };
        }

        await _client.PushEventAsync("bds_updated", $"{previous ?? "none"} → {result.Version}", ct);
        return new
        {
            previous_version = previous,
            installed_version = result.Version,
            install_path = result.InstallPath,
            checksum_sha256 = result.ChecksumSha256,
            note = result.Error, // non-fatal message such as "already up to date"
            health,
        };
    }

    private Task<object?> RollbackBds(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var version = payload.String("target_version")
                      ?? throw new CommandException("target_version is required for a rollback.");
        var state = _installer.ReadState(serverId);
        var worldName = state.WorldName ?? "world";

        var managed = _processes.Get(serverId);
        if (managed?.Process is { HasExited: false })
        {
            throw new CommandException("Stop the server before rolling back.");
        }

        var result = _installer.Rollback(serverId, worldName, version);
        if (!result.Success) throw new CommandException(result.Error ?? "Rollback failed.");
        return Task.FromResult<object?>(new
        {
            installed_version = result.Version,
            install_path = result.InstallPath,
            rolled_back = true,
        });
    }

    private async Task<object?> CheckVersions(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var channel = payload.String("channel") ??
                      (_config.Options.UsePreviewChannel ? "preview" : "stable");
        _discovery.InvalidateCache();
        var latest = await _discovery.DiscoverAsync(channel, ct);
        var installed = _installer.GetInstalledVersion(serverId);
        var availableLocally = _installer.GetInstalledVersions();

        return new
        {
            installed_version = installed,
            latest_version = latest?.Version,
            latest_download_url = latest?.DownloadUrl,
            discovery_source = latest is null ? "unavailable" : "official-download-page",
            update_available = latest is not null && installed is not null
                ? BdsVersionDiscovery.CompareVersions(latest.Version, installed) > 0
                : (bool?)null,
            versions_on_disk = availableLocally,
            checked_at = DateTime.UtcNow,
        };
    }

    // ---------------------------------------------------------------------
    // Configuration
    // ---------------------------------------------------------------------

    private Task<object?> ApplyConfig(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var properties = payload.String("properties");
        if (string.IsNullOrWhiteSpace(properties))
        {
            throw new CommandException("No server.properties content was supplied.");
        }

        var serverDir = _installer.ServerDirectory(serverId);
        if (!Directory.Exists(serverDir))
        {
            throw new CommandException("BDS is not installed for this server yet.");
        }

        var managed = _processes.Get(serverId);
        if (managed?.Process is { HasExited: false })
        {
            // Write it, but be explicit that a restart is required.
            _logger.LogInformation("Server is running; server.properties written but needs a restart to take effect");
        }

        var path = Path.Combine(serverDir, "server.properties");
        if (File.Exists(path)) File.Copy(path, path + ".oghost-prev", overwrite: true);
        File.WriteAllText(path, properties);

        return Task.FromResult<object?>(new
        {
            written = true,
            path,
            restart_required = managed?.Process is { HasExited: false },
        });
    }

    private async Task<object?> ConsoleCommand(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var text = payload.String("command") ?? string.Empty;

        // Second allowlist check. The control plane already validated this, but
        // the agent never trusts its input — a compromised or buggy caller must
        // still not be able to reach the process with arbitrary text.
        if (!ServerProcessManager.IsAllowedCommand(text, out var reason))
        {
            throw new CommandException(reason);
        }

        var (ok, error) = await _processes.SendCommandAsync(serverId, text, ct);
        if (!ok) throw new CommandException(error ?? "Could not send the command.");
        return new { sent = text.Trim() };
    }

    // ---------------------------------------------------------------------
    // Backups
    // ---------------------------------------------------------------------

    private async Task<object?> BackupWorld(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var state = _installer.ReadState(serverId);
        var worldName = payload.String("world_name") ?? state.WorldName ?? "world";
        var name = payload.String("name") ?? $"backup-{DateTime.UtcNow:yyyyMMdd-HHmmss}";

        var result = await _backups.CreateAsync(
            serverId, worldName, name, payload.Bool("safe_stop_if_running"), ct);
        if (!result.Success) throw new CommandException(result.Error ?? "Backup failed.");

        if (payload.String("backup_id") is { } backupId)
        {
            return new
            {
                backup_id = backupId,
                status = "completed",
                file_name = result.FileName,
                size_bytes = result.SizeBytes,
                minecraft_version = _installer.GetInstalledVersion(serverId),
                completed_at = DateTime.UtcNow,
            };
        }
        return new
        {
            status = "completed",
            file_name = result.FileName,
            size_bytes = result.SizeBytes,
        };
    }

    private async Task<object?> RestoreBackup(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var fileName = payload.String("file_name")
                       ?? throw new CommandException("file_name is required.");
        var state = _installer.ReadState(serverId);
        var worldName = state.WorldName ?? "world";

        var result = await _backups.RestoreAsync(serverId, worldName, fileName, ct);
        if (!result.Success) throw new CommandException(result.Error ?? "Restore failed.");
        return new
        {
            restored = fileName,
            world_name = worldName,
            status = "completed",
            note = "Start the server to play on the restored world.",
        };
    }

    private Task<object?> DeleteBackup(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var fileName = payload.String("file_name") ?? throw new CommandException("file_name is required.");
        var deleted = _backups.Delete(serverId, fileName);
        return Task.FromResult<object?>(new { deleted, file_name = fileName });
    }

    /// <summary>
    /// Upload a backup archive to the owner's private storage bucket so it can
    /// be downloaded from a phone. The signed URL is fetched from the control
    /// plane path that issued the command; we only PUT bytes to it.
    /// </summary>
    private async Task<object?> UploadBackup(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var fileName = payload.String("file_name") ?? throw new CommandException("file_name is required.");
        var uploadUrl = payload.String("upload_url");
        var path = _backups.BackupPath(serverId, fileName);
        if (!File.Exists(path)) throw new CommandException($"Backup file “{fileName}” is not on this device.");

        if (string.IsNullOrWhiteSpace(uploadUrl))
        {
            // No signed upload URL was supplied; report the local path so the
            // panel can tell the user the file exists but is not downloadable.
            return new { uploaded = false, local_path = path, size_bytes = new FileInfo(path).Length };
        }

        await using var stream = File.OpenRead(path);
        using var content = new StreamContent(stream);
        content.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue("application/zip");
        using var request = new HttpRequestMessage(HttpMethod.Put, uploadUrl) { Content = content };
        using var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
        {
            throw new CommandException($"Upload to storage failed ({(int)response.StatusCode}).");
        }
        return new { uploaded = true, size_bytes = new FileInfo(path).Length };
    }

    private Task<object?> ScheduleBackups(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        // The schedule itself is owned by BackupScheduler; here we just persist
        // what the panel asked for so it survives an agent restart.
        var serverId = RequireServerId(command);
        var file = Path.Combine(_installer.ServerDirectory(serverId), ".oghost-schedule.json");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, payload.Raw.ToString());
        return Task.FromResult<object?>(new { saved = true, path = file });
    }

    // ---------------------------------------------------------------------
    // Files
    // ---------------------------------------------------------------------

    private Task<object?> FileList(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var result = _files.List(serverId, payload.String("path") ?? string.Empty);
        if (!result.Success) throw new CommandException(result.Error ?? "Listing failed.");
        return Task.FromResult<object?>(new { entries = result.Entries });
    }

    private Task<object?> FileMkdir(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var path = payload.String("path") ?? throw new CommandException("path is required.");
        var result = _files.MakeDirectory(serverId, path);
        if (!result.Success) throw new CommandException(result.Error ?? "Could not create the folder.");
        return Task.FromResult<object?>(new { created = path });
    }

    private Task<object?> FileDelete(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var path = payload.String("path") ?? throw new CommandException("path is required.");
        var result = _files.Delete(serverId, path);
        if (!result.Success) throw new CommandException(result.Error ?? "Could not delete.");
        return Task.FromResult<object?>(new { deleted = path });
    }

    private Task<object?> FileEdit(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var path = payload.String("path") ?? throw new CommandException("path is required.");
        var content = payload.String("content") ?? throw new CommandException("content is required.");
        var result = _files.WriteText(serverId, path, content);
        if (!result.Success) throw new CommandException(result.Error ?? "Could not write the file.");
        return Task.FromResult<object?>(new { written = path, bytes = content.Length });
    }

    private Task<object?> FileDownload(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var path = payload.String("path") ?? throw new CommandException("path is required.");
        var asText = payload.Bool("as_text");

        if (asText)
        {
            var read = _files.ReadText(serverId, path);
            if (!read.Success) throw new CommandException(read.Error ?? "Could not read the file.");
            return Task.FromResult<object?>(new { path, content = read.Content });
        }

        var resolved = _files.ResolveRead(serverId, path);
        if (resolved is null) throw new CommandException("File does not exist.");
        // The control plane turns this local path into a signed storage URL by
        // asking us to upload it; here we report the size and path so the panel
        // can decide. For small text-ish files we inline the content instead.
        var info = new FileInfo(resolved);
        if (info.Length <= 2 * 1024 * 1024)
        {
            var text = _files.ReadText(serverId, path);
            if (text.Success)
            {
                return Task.FromResult<object?>(new { path, content = text.Content, size_bytes = info.Length });
            }
        }
        return Task.FromResult<object?>(new
        {
            path,
            size_bytes = info.Length,
            note = "File is binary or too large to inline; use the backup download path for large archives.",
        });
    }

    private async Task<object?> FileUpload(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var path = payload.String("path") ?? throw new CommandException("path is required.");
        var url = payload.String("download_url") ?? throw new CommandException("download_url is required.");

        using var response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        var result = await _files.WriteStreamAsync(serverId, path, stream, ct);
        if (!result.Success) throw new CommandException(result.Error ?? "Could not write the file.");
        return new { written = path, size_bytes = _files.SizeOf(serverId, path) };
    }

    // ---------------------------------------------------------------------
    // Add-ons
    // ---------------------------------------------------------------------

    private async Task<object?> AddonInstall(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var fileName = payload.String("file_name") ?? throw new CommandException("file_name is required.");
        var addonType = payload.String("addon_type") ?? "mcpack";
        var url = payload.String("download_url") ?? throw new CommandException("download_url is required.");
        var state = _installer.ReadState(serverId);
        var worldName = state.WorldName ?? "world";

        var managed = _processes.Get(serverId);
        if (managed?.Process is { HasExited: false } && addonType == "mcworld")
        {
            throw new CommandException("Stop the server before replacing its world with a .mcworld file.");
        }

        var result = await _addons.InstallFromUrlAsync(serverId, worldName, fileName, addonType, url, ct);
        if (!result.Success) throw new CommandException(result.Error ?? "Add-on installation failed.");

        return new
        {
            addon_id = payload.String("addon_id"),
            status = "installed",
            installed_path = result.InstalledPath,
            pack_id = result.PackId,
            note = managed?.Process is { HasExited: false }
                ? "Installed. Restart the server for Bedrock to load the new packs."
                : "Installed. It will be loaded on the next start.",
        };
    }

    private Task<object?> AddonRemove(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var installedPath = payload.String("installed_path");
        if (string.IsNullOrWhiteSpace(installedPath))
        {
            return Task.FromResult<object?>(new { removed = false, note = "No installed path recorded." });
        }
        var root = _installer.ServerDirectory(serverId);
        var resolved = ServerFileManager.ResolveInsideRoot(root, Path.GetRelativePath(root, installedPath));
        if (resolved is null || !Directory.Exists(resolved))
        {
            return Task.FromResult<object?>(new { removed = false, note = "Directory not found." });
        }
        Directory.Delete(resolved, recursive: true);
        return Task.FromResult<object?>(new { removed = true, path = resolved });
    }

    // ---------------------------------------------------------------------
    // Networking
    // ---------------------------------------------------------------------

    private async Task<object?> NetworkingStart(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var provider = payload.String("provider") ?? "direct";
        var localPort = payload.Int("local_port") ?? _processes.Get(serverId)?.Port ?? 19132;

        var managed = _processes.Get(serverId);
        if (managed?.Process is not { HasExited: false })
        {
            throw new CommandException(
                "The Minecraft server is not running. Start it first — networking is established against a live Bedrock process so the verification is real.");
        }

        return await StartNetworkingInternal(serverId, provider, localPort, payload, ct);
    }

    private async Task<object?> StartNetworkingInternal(
        string serverId, string provider, int localPort, CommandPayload payload, CancellationToken ct)
    {
        var verify = payload.Bool("verify_with_raknet_ping", true);
        var (ok, address, port, verified, detail) = await _network.StartAsync(
            serverId, provider, localPort,
            payload.String("manual_address"), payload.Int("manual_port"),
            verify, ct);

        if (!ok) throw new CommandException(detail ?? "Networking could not be established.");

        return new
        {
            provider,
            address,
            port,
            verified,
            detail,
            // Explicit so the panel cannot mistake "tunnel up" for "joinable".
            status = verified ? "verified" : "active",
            endpoint_id = payload.String("endpoint_id"),
        };
    }

    private async Task<object?> NetworkingStop(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        await _network.StopAsync(serverId, ct);
        return new { stopped = true, verified = false };
    }

    private async Task<object?> NetworkingVerify(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        var (verified, detail) = await _network.ReverifyAsync(serverId, ct);
        var state = _network.GetState(serverId);
        return new
        {
            verified,
            detail,
            address = state?.Address,
            port = state?.Port,
            status = verified ? "verified" : "active",
        };
    }

    // ---------------------------------------------------------------------
    // Server removal
    // ---------------------------------------------------------------------

    private Task<object?> DeleteServer(NodeCommand command, CommandPayload payload, CancellationToken ct)
    {
        var serverId = RequireServerId(command);
        _processes.ForceStop(serverId);

        if (!payload.Bool("remove_files", true))
        {
            return Task.FromResult<object?>(new { deleted = false, note = "Process stopped; files kept." });
        }

        try
        {
            var dir = _installer.ServerDirectory(serverId);
            if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not fully delete the server directory");
            return Task.FromResult<object?>(new { deleted = false, error = ex.Message });
        }
        return Task.FromResult<object?>(new { deleted = true });
    }
}

/// <summary>A command failure with a user-readable reason.</summary>
public sealed class CommandException : Exception
{
    public CommandException(string message) : base(message) { }
}
