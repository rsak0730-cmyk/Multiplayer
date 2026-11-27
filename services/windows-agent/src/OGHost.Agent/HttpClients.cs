namespace OGHost.Agent;

/// <summary>
/// Named <see cref="IHttpClientFactory"/> clients.
///
/// Typed clients (AddHttpClient&lt;T&gt;) register T as transient, which
/// conflicts with the singletons that own long-lived agent state. Using named
/// clients instead keeps every service a singleton and still gets proper
/// handler rotation, so DNS changes and pooled-connection expiry are handled
/// correctly on a machine that runs for weeks.
/// </summary>
public static class HttpClients
{
    /// <summary>Control plane API. Short timeouts, auth headers added per request.</summary>
    public const string ControlPlane = "control-plane";

    /// <summary>BDS download page + archives. Very long timeouts.</summary>
    public const string Downloads = "downloads";

    /// <summary>Signed-URL transfers: add-ons, file uploads, backup uploads.</summary>
    public const string Transfers = "transfers";

    /// <summary>Short lookups such as "what is my public IP".</summary>
    public const string Lookups = "lookups";
}

/// <summary>Kept for readability at call sites.</summary>
public static class ControlPlaneHttp
{
    public const string ClientName = HttpClients.ControlPlane;
}
