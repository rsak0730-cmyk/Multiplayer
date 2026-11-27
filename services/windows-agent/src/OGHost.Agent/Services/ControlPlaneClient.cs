using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using OGHost.Agent.Models;

namespace OGHost.Agent.Services;

/// <summary>
/// All communication with the OG HOST control plane. Outbound HTTPS only —
/// the agent never listens on a port, so it works behind NAT and CGNAT with
/// no router or firewall configuration.
/// </summary>
public sealed class ControlPlaneClient
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly IHttpClientFactory _httpFactory;
    private readonly AgentConfigStore _config;
    private readonly ILogger<ControlPlaneClient> _logger;

    public ControlPlaneClient(
        IHttpClientFactory httpFactory, AgentConfigStore config, ILogger<ControlPlaneClient> logger)
    {
        _httpFactory = httpFactory;
        _config = config;
        _logger = logger;
    }

    private HttpClient Http => _httpFactory.CreateClient(ControlPlaneHttp.ClientName);

    private HttpRequestMessage Create(HttpMethod method, string path)
    {
        var baseUrl = _config.Options.ControlPlaneUrl.TrimEnd('/');
        var request = new HttpRequestMessage(method, $"{baseUrl}{path}");
        var token = _config.Options.NodeToken;
        if (!string.IsNullOrWhiteSpace(token))
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
        return request;
    }

    /// <summary>Exchange a pairing code for a node id + long-lived token.</summary>
    public async Task<PairingClaimResponse?> ClaimPairingAsync(
        string code, string hostname, string os, string agentVersion, CancellationToken ct)
    {
        using var request = Create(HttpMethod.Post, "/api/agent/pairing/claim");
        request.Content = JsonContent.Create(
            new PairingClaimRequest(code, hostname, os, agentVersion), options: JsonOptions);
        using var response = await Http.SendAsync(request, ct);
        var body = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Pairing failed ({Status}): {Body}", (int)response.StatusCode, Truncate(body));
            return null;
        }
        return JsonSerializer.Deserialize<PairingClaimResponse>(body, JsonOptions);
    }

    public async Task<bool> SendHeartbeatAsync(HeartbeatRequest payload, CancellationToken ct)
    {
        using var request = Create(HttpMethod.Post, "/api/agent/heartbeat");
        request.Content = JsonContent.Create(payload, options: JsonOptions);
        using var response = await Http.SendAsync(request, ct);
        if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            _logger.LogError("Control plane rejected the node token. Rotate it from the Devices page and update config.json.");
            return false;
        }
        if (!response.IsSuccessStatusCode)
        {
            _logger.LogWarning("Heartbeat failed with {Status}", (int)response.StatusCode);
            return false;
        }
        return true;
    }

    public async Task<IReadOnlyList<NodeCommand>> PollCommandsAsync(CancellationToken ct)
    {
        using var request = Create(HttpMethod.Get, "/api/agent/commands/poll");
        using var response = await Http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) return Array.Empty<NodeCommand>();
        var body = await response.Content.ReadAsStringAsync(ct);
        var parsed = JsonSerializer.Deserialize<PollResponse>(body, JsonOptions);
        return parsed?.Commands ?? Array.Empty<NodeCommand>();
    }

    public async Task ReportResultAsync(
        string commandId, bool success, object? result, string? error, CancellationToken ct)
    {
        using var request = Create(HttpMethod.Post, "/api/agent/commands/result");
        request.Content = JsonContent.Create(
            new CommandResultRequest(
                commandId,
                success ? "completed" : "failed",
                result,
                error is null ? null : Truncate(error, 1800)),
            options: JsonOptions);
        try
        {
            using var response = await Http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Failed to report command {Id} result ({Status})", commandId, (int)response.StatusCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not report command {Id} result", commandId);
        }
    }

    public async Task PushConsoleLogsAsync(string serverId, IReadOnlyList<ConsoleLogLine> lines, CancellationToken ct)
    {
        if (lines.Count == 0) return;
        using var request = Create(HttpMethod.Post, "/api/agent/console-logs");
        request.Content = JsonContent.Create(new ConsoleLogBatch(serverId, lines), options: JsonOptions);
        try
        {
            await Http.SendAsync(request, ct);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Console log push failed; will retry next batch");
        }
    }

    public async Task PushEventAsync(string eventType, string? message, CancellationToken ct)
    {
        using var request = Create(HttpMethod.Post, "/api/agent/events");
        request.Content = JsonContent.Create(new NodeEventRequest(eventType, Truncate(message ?? string.Empty, 1800)), options: JsonOptions);
        try
        {
            await Http.SendAsync(request, ct);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Event push failed ({Type})", eventType);
        }
    }

    private static string Truncate(string value, int max = 500) =>
        value.Length <= max ? value : value[..max] + "…";
}
