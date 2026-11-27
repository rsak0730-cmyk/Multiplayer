using System.Text.Json;
using System.Text.Json.Serialization;

namespace OGHost.Agent.Models;

/// <summary>Payload shapes exchanged with the OG HOST control plane.</summary>
public sealed record HeartbeatRequest(
    [property: JsonPropertyName("hostname")] string Hostname,
    [property: JsonPropertyName("operating_system")] string OperatingSystem,
    [property: JsonPropertyName("agent_version")] string AgentVersion,
    [property: JsonPropertyName("agent_platform")] string AgentPlatform,
    [property: JsonPropertyName("cpu_percent")] double CpuPercent,
    [property: JsonPropertyName("ram_total_mb")] long RamTotalMb,
    [property: JsonPropertyName("ram_available_mb")] long RamAvailableMb,
    [property: JsonPropertyName("storage_total_mb")] long StorageTotalMb,
    [property: JsonPropertyName("storage_available_mb")] long StorageAvailableMb,
    [property: JsonPropertyName("disk_used_mb")] long DiskUsedMb,
    [property: JsonPropertyName("uptime_seconds")] long UptimeSeconds,
    [property: JsonPropertyName("servers")] IReadOnlyList<HeartbeatServer> Servers);

public sealed record HeartbeatServer(
    [property: JsonPropertyName("server_id")] string ServerId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("installed_version")] string? InstalledVersion,
    [property: JsonPropertyName("online_players")] int OnlinePlayers,
    [property: JsonPropertyName("public_address")] string? PublicAddress,
    [property: JsonPropertyName("public_port")] int? PublicPort,
    [property: JsonPropertyName("networking_verified")] bool NetworkingVerified,
    [property: JsonPropertyName("last_error")] string? LastError);

public sealed record PairingClaimRequest(
    [property: JsonPropertyName("code")] string Code,
    [property: JsonPropertyName("hostname")] string Hostname,
    [property: JsonPropertyName("operating_system")] string OperatingSystem,
    [property: JsonPropertyName("agent_version")] string AgentVersion);

public sealed record PairingClaimResponse(
    [property: JsonPropertyName("node_id")] string NodeId,
    [property: JsonPropertyName("token")] string Token,
    [property: JsonPropertyName("message")] string? Message);

public sealed record NodeCommand(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("node_id")] string NodeId,
    [property: JsonPropertyName("server_id")] string? ServerId,
    [property: JsonPropertyName("command_type")] string CommandType,
    [property: JsonPropertyName("payload")] JsonElement Payload,
    [property: JsonPropertyName("status")] string Status);

public sealed record CommandResultRequest(
    [property: JsonPropertyName("command_id")] string CommandId,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("result")] object? Result,
    [property: JsonPropertyName("error_message")] string? ErrorMessage);

public sealed record ConsoleLogBatch(
    [property: JsonPropertyName("server_id")] string ServerId,
    [property: JsonPropertyName("lines")] IReadOnlyList<ConsoleLogLine> Lines);

public sealed record ConsoleLogLine(
    [property: JsonPropertyName("line")] string Line,
    [property: JsonPropertyName("stream")] string Stream);

public sealed record NodeEventRequest(
    [property: JsonPropertyName("event_type")] string EventType,
    [property: JsonPropertyName("message")] string? Message);

public sealed record PollResponse(
    [property: JsonPropertyName("commands")] IReadOnlyList<NodeCommand> Commands);

public sealed record FileEntry(
    [property: JsonPropertyName("name")] string Name,
    [property: JsonPropertyName("path")] string Path,
    [property: JsonPropertyName("is_directory")] bool IsDirectory,
    [property: JsonPropertyName("size_bytes")] long SizeBytes,
    [property: JsonPropertyName("modified_at")] string? ModifiedAt);

/// <summary>
/// Safe accessors over a command payload. Never throws on missing or
/// wrongly-typed fields — a malformed command must fail loudly at the
/// handler, not crash the agent loop.
/// </summary>
public readonly struct CommandPayload
{
    private readonly JsonElement _element;

    public CommandPayload(JsonElement element) => _element = element;

    /// <summary>Raw payload element, for handlers that persist it verbatim.</summary>
    public JsonElement Raw => _element;

    public bool IsObject => _element.ValueKind == JsonValueKind.Object;

    public string? String(string name)
    {
        if (!IsObject || !_element.TryGetProperty(name, out var p)) return null;
        return p.ValueKind == JsonValueKind.String ? p.GetString() : p.ToString();
    }

    public int? Int(string name)
    {
        if (!IsObject || !_element.TryGetProperty(name, out var p)) return null;
        return p.ValueKind switch
        {
            JsonValueKind.Number when p.TryGetInt32(out var v) => v,
            JsonValueKind.String when int.TryParse(p.GetString(), out var v) => v,
            _ => null,
        };
    }

    public long? Long(string name)
    {
        if (!IsObject || !_element.TryGetProperty(name, out var p)) return null;
        return p.ValueKind switch
        {
            JsonValueKind.Number when p.TryGetInt64(out var v) => v,
            JsonValueKind.String when long.TryParse(p.GetString(), out var v) => v,
            _ => null,
        };
    }

    public bool Bool(string name, bool fallback = false)
    {
        if (!IsObject || !_element.TryGetProperty(name, out var p)) return fallback;
        return p.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String => bool.TryParse(p.GetString(), out var v) && v,
            _ => fallback,
        };
    }
}
