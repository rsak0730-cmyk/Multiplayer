# OG HOST — Networking

This is the document to read before claiming multiplayer works. It is blunt
about what is proven and what is not, because the difference decides whether
your friends can actually join.

---

## The problem, precisely

Minecraft **Bedrock** gameplay is **UDP**, carrying the **RakNet** protocol on
port 19132 by default. Three consequences follow, and they rule out most of the
obvious free options:

1. **HTTP/HTTPS tunnels cannot carry it.** ngrok's HTTP tunnel, cloudflared's
   `http://` tunnels, localtunnel, serveo and friends terminate TCP and speak
   HTTP. Bedrock traffic is not HTTP. Pointing one at port 19132 produces a
   tunnel that reports "online" and a server nobody can join.
2. **You need a UDP-capable relay or a real public IPv4.** Nothing in between
   works.
3. **CGNAT removes the public IPv4 option.** On carrier-grade NAT you have no
   inbound address at all, so port forwarding is impossible — there is nothing
   to forward to.

### CGNAT on Indian mobile broadband

Airtel, Jio and Vi mobile broadband (and most 4G/5G home-airfiber plans) place
customers behind CGNAT. You can confirm it yourself: if your router's WAN IP is
in `100.64.0.0/10` (or `10/8`, `172.16/12`, `192.168/16`), you are behind NAT
and direct inbound connections will fail.

`DirectProvider.IsPrivateOrCgnat()` detects exactly these ranges — including
RFC 6598 `100.64.0.0/10`, which is the CGNAT signature — and **refuses to
report such an address as public**. Handing a user a CGNAT address and calling
it their server address would be a lie that costs them an evening.

Fixed-line broadband (ACT, Airtel Xstream Fiber, JioFiber) sometimes offers a
public IPv4, usually on request. If you have one, direct mode works and is the
simplest option.

---

## Providers

The provider layer is an interface, so adding one does not touch the website:

```csharp
public interface INetworkProvider
{
    string Id { get; }
    string Name { get; }
    bool SupportsCgnat { get; }
    string? CurrentAddress { get; }
    int? CurrentPort { get; }
    Task<NetworkResult> StartAsync(int localPort, CancellationToken ct);
    Task StopAsync(CancellationToken ct);
}
```

| Provider | CGNAT | Cost | Status in this repo |
| --- | --- | --- | --- |
| `direct` | No | Free | **Implemented.** Reports the real public IPv4, or fails with an explanation when it detects CGNAT/private addressing. |
| `playit` | Yes | Free tier | **Implemented, NOT verified with a real client.** See below. |
| `manual` | Depends | Yours | **Implemented.** You supply the address; verification still applies. |
| `custom` | — | — | Reserved. Implement the interface and register it. |

### `direct`

Discovers two candidate addresses and compares them:

- the LAN interface address (selected by opening a UDP socket toward `8.8.8.8:53`,
  which sends no traffic — it only makes the OS choose an interface);
- the public IPv4 from an external lookup (`api.ipify.org`, then `ifconfig.me`,
  then `icanhazip.com`).

If the external address is private or CGNAT, it fails with an explicit message
telling you to switch provider. If no external address exists but a LAN address
does, it reports the LAN address **and notes that router port forwarding is
required** — it does not claim the address is reachable.

### `playit`

Playit's agent makes an outbound connection to Playit's infrastructure and they
hand back a public `host:port` forwarding UDP to a local port. Because the
connection is outbound, CGNAT is not an obstacle. This is the realistic free
option for mobile broadband.

What the implementation does:

- requires a secret in `node_network_settings` (saved from the Networking page),
  and fails with instructions if absent;
- requires the Playit agent binary and fails with instructions if absent —
  **OG HOST does not bundle or redistribute third-party binaries**;
- passes the secret via the `PLAYIT_SECRET` environment variable rather than the
  command line, so it does not appear in process listings;
- parses the child process output for a `host:port` announcement, with a 60 s
  timeout;
- reports the address as **UNVERIFIED** until the RakNet check passes.

**Honest status.** Playit supports UDP and Bedrock is UDP, so this is the right
shape of solution. What has **not** been proven is that a current Bedrock client
successfully joins a current BDS through a Playit tunnel on a free plan. Three
things could break it, and only real testing will tell:

1. Playit's free tier may rate-limit or session-limit UDP in a way that affects
   sustained game traffic.
2. Playit's assigned host may not resolve or route correctly from a mobile
   network.
3. The output parsing is written against Playit's log format, which can change
   between their releases.

Until you have joined from a real client, treat any Playit address as untested.
The panel labels it that way.

### `manual`

For when you already have a working path: your own VPS running a UDP relay, a
router with port forwarding, or another tunnel you manage. You enter the public
address and port; private and loopback ranges are rejected
(`isPlausiblePublicAddress`). The endpoint is stored as **pending/unverified**
and only becomes verified after a real RakNet round trip.

---

## Verification: what "reachable" means here

OG HOST refuses to call an address reachable on the word of a tunnel. The only
evidence accepted is a genuine Bedrock protocol exchange.

`RakNetVerifier` implements the RakNet offline handshake:

```
send    Unconnected Ping Open Connections (0x02)
        | id (1) | time (8, big-endian) | magic (16) | client GUID (8) |

magic = 00 ff ff 00 fe fe fe fe fd fd fd fd 12 34 56 78

expect  Unconnected Pong (0x1c)
        | id | time | magic | server GUID | string length (2) |
        "MCPE;<server name>;<version>;<version name>;<players>;<max>;..."
```

Three attempts, because UDP is lossy and the first packet often has to warm up a
NAT mapping or a tunnel that has not seen traffic. On success we record latency
and the server name the pong reported — proof the *right* server answered, not
just that something did.

### Statuses the UI shows

| Status | Meaning |
| --- | --- |
| `verified` | A real RakNet pong came back. Safe to share. |
| `active` | The provider reports a tunnel is up and gave an address, **but no protocol round trip succeeded**. Shown as UNVERIFIED. |
| `pending` | Requested, nothing reported yet. |
| `failed` | The provider could not establish anything, with the reason. |
| `stopped` | Networking was deliberately stopped. No address offered. |
| `unknown` / no address | Nothing established. **No address is displayed at all.** |

A server's `networking_verified` flag is only ever set from a successful
verification, and is cleared when the server stops or the provider changes.

### The hairpinning caveat — read this before concluding it is broken

The agent performs the ping **from the node itself**. If that node is behind
NAT, pinging its own public address requires **NAT hairpinning** (a.k.a. NAT
loopback). Many home routers do not support it, and CGNAT essentially never
does.

So a failed self-ping means: *"we could not confirm reachability from here."*
It does **not** mean *"your friends cannot join."* The tunnel may be working
perfectly for external clients.

The agent's failure message says exactly this rather than reporting the server
as unreachable:

> No RakNet pong received. The server may be stopped, the port may not be
> forwarded, or (when probing your own public address from behind NAT)
> hairpinning may be unsupported. Confirm by joining once from a real Bedrock
> client.

**The authoritative test is always a real client.** There is no substitute:

1. Start the server and start networking.
2. On your phone (mobile data, **not** the same Wi-Fi as the host — that is what
   makes the test meaningful), open Minecraft Bedrock.
3. Servers → Add Server → enter the address and port.
4. Join. If you spawn in the world, multiplayer works.

If you join successfully from mobile data, mark it verified in your head
regardless of what the self-ping said — and tell us, because that is the
confirmation this document is waiting for.

---

## Why the website cannot verify it itself

A Vercel serverless function cannot reliably open arbitrary UDP sockets to
arbitrary hosts. `src/lib/networking/verify.ts` therefore exposes:

- `probeTcp()` — a real TCP connect test, useful for sanity checks but **not**
  proof for Bedrock, which is UDP;
- `isPlausiblePublicAddress()` — rejects loopback and private ranges so an
  obviously bogus address never reaches the database.

The UDP/RakNet verification lives in the agent, on the machine that owns the
server. That is also where it belongs architecturally: the node is the only
party that knows whether its own process is listening.

---

## Port and firewall notes

- BDS default is **UDP 19132** (and 19133 for IPv6). The panel lets you change
  it; the agent writes `server-port` and `server-portv6` into
  `server.properties`.
- Two servers on one machine must use different ports.
- The **agent itself needs no inbound ports** and no firewall exceptions — it
  only makes outbound HTTPS requests.
- `bedrock_server.exe` needs inbound **UDP** on its port allowed through Windows
  Firewall. Windows normally prompts on first run; accept it for private
  networks. Without this, even a working tunnel has nothing to forward to.
- For direct mode with port forwarding, forward **UDP** (not TCP) 19132 to the
  laptop's LAN address, and give the laptop a static DHCP lease so the forward
  does not break.

---

## Adding a provider

1. Create `Networking/MyProvider.cs` implementing `INetworkProvider`.
2. Register it in `NetworkManager` (constructor + `Resolve`).
3. Add a row to `network_providers` in a migration.
4. Extend the `provider` check constraint on `network_endpoints` and the Zod
   enum in `src/app/api/servers/[id]/networking/route.ts`.
5. Add it to `PROVIDERS` in `NetworkingPanel.tsx`.

Verification, statuses and the UI's honesty rules come for free — they are
provider-agnostic and always run against whatever address comes back.

---

## Open verification items

Tracked here so nobody mistakes them for done:

- [ ] Join a **current** Bedrock client (Android and Windows 10/11) to a BDS
      hosted on Windows 10 through the **Playit** free tier, over **mobile data
      with CGNAT**. Record the Bedrock version, BDS version and Playit plan.
- [ ] Confirm the Playit agent's current log format still matches
      `PlayitProvider.TunnelReady`, and adjust the regex if not.
- [ ] Confirm direct mode end-to-end on a connection with a real public IPv4
      (fixed-line broadband) plus router UDP forwarding.
- [ ] Measure how long a free-tier tunnel stays up, and whether it survives an
      agent restart without a new address (a changed address invalidates
      anything already shared with friends).
- [ ] Decide whether to add a second UDP-capable provider as a fallback once
      Playit's real-world behaviour is measured.
