# IPv6 Bridge

[![npm version](https://img.shields.io/npm/v/ipv6-bridge.svg)](https://www.npmjs.com/package/ipv6-bridge)
[![npm downloads](https://img.shields.io/npm/dm/ipv6-bridge.svg)](https://www.npmjs.com/package/ipv6-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> DNS64-aware HTTP proxy for IPv6-only networks — access IPv4 sites seamlessly.

IPv4 addresses are exhausted globally. Many ISPs now deploy IPv6-only networks, but millions of websites still only support IPv4. IPv6 Bridge solves this by running a local application-layer proxy that synthesizes DNS64 addresses and routes HTTP/HTTPS traffic through your ISP's NAT64 gateway.

## Why IPv6 Bridge? (The Advantage)

While there are other NAT64/DNS64 bridges out there (like Tayga or Jool), **IPv6 Bridge** occupies a very specific, developer-friendly niche:

1. **100% User-Space & Zero Dependencies**: Most IPv6 bridges require installing complex C++ binaries, compiling Linux kernel modules, or configuring OS-level `TUN/TAP` interfaces. This project runs entirely in user-space using pure Node.js standard libraries. Just run it.
2. **It Tells You What's Wrong**: `ipv6-bridge doctor` checks your resolvers, connectivity, NAT64 availability and prefix configuration, then explains each result in plain language. Kernel-level translators can't tell you why your network is broken.
3. **Honest About What It Did**: `/status` reports a `translationRate` — the share of traffic that actually went through NAT64. When DNS64 fails and the bridge falls back to a direct connection, it says so, loudly. A bridge that silently stops bridging is worse than one that fails.
4. **Intelligent Auto-Detection**: It checks whether IPv4 already works before doing anything, so it stays out of the way on dual-stack networks and only activates when you are genuinely stuck on an IPv6-only network without NAT64.
5. **Programmatic API**: Designed for software engineers, it exports a clean `start()` and `stop()` API. You can import this package directly into your automated testing pipelines (like Cypress or Jest) to simulate IPv6 environments during CI/CD builds.
6. **Standards Compliant**: Implements every RFC 6052 prefix length (`/32` through `/96`), verified against the RFC's own test vectors, discovers your network's real prefix via RFC 7050, and honours the section 3.1 rule that the well-known prefix must never carry non-global IPv4 addresses.

## Production Features

| Capability | How |
|-----------|-----|
| Any TCP protocol (ssh, git, databases) | SOCKS5 listener — `IPV6_BRIDGE_SOCKS_PORT=1080` |
| Automatic prefix configuration | RFC 7050 discovery via `ipv4only.arpa` |
| Observability | `/status`, `/metrics` (Prometheus), `/healthz` |
| Client onboarding | `/proxy.pac` auto-configuration file |
| Access control | `IPV6_BRIDGE_AUTH`, `IPV6_BRIDGE_ALLOW` |
| Performance | DNS caching, keep-alive connection pooling |
| Reliability | Failover across candidate addresses |
| Split routing | `IPV6_BRIDGE_BYPASS=*.internal.company.com` |

## Quick Start

**New here? Start with [docs/GUIDE.md](docs/GUIDE.md)** — it covers when you need this, how to connect your applications, and worked examples.

### 1. Find out whether you need it

```bash
npx ipv6-bridge doctor
```

This checks your resolvers, IPv4/IPv6 reachability and whether a NAT64 gateway exists, then explains each result.

### 2. Start it

```bash
npx ipv6-bridge start
```

The bridge auto-detects whether it's needed and exits quietly if it isn't — so it's safe to run anywhere. To run it anyway (to test or demo):

```bash
FORCE_BRIDGE=1 npx ipv6-bridge start
```

### 3. Point an application at it

Nothing routes through the proxy automatically — that's the most common point of confusion.

```bash
curl -x http://127.0.0.1:8080 https://example.com
```

For browsers, use the auto-config URL `http://127.0.0.1:8080/proxy.pac`. See the [guide](docs/GUIDE.md#4-connecting-your-applications) for npm, Docker, ssh, git and more.

### 4. Confirm it's actually translating

```bash
npx ipv6-bridge status
```

### Use it inside your application (no proxy, no system config)

If you don't want to run a proxy at all, drop the bridge straight into your app's
outbound connections:

```bash
npm i ipv6-bridge
```

```javascript
const { createHttpsAgent } = require('ipv6-bridge');
const agent = createHttpsAgent();

// Connects over native IPv6 when possible, through NAT64 when translation is
// needed, and over IPv4 as a last resort — without any system configuration.
https.get('https://some-ipv4-only-api.example', { agent }, handleResponse);
```

Works with anything that accepts an agent (axios, got, node-fetch) or a `lookup`
function (`net.connect`, `http.request`). For Node's global `fetch`, use
`createConnector()` with undici.

```javascript
const { getStats } = require('ipv6-bridge');
getStats().translationRate; // did translation actually happen?
```

See [Using it from Node.js](docs/GUIDE.md#7-using-it-from-nodejs) for the full set.

### Run it as a proxy

```javascript
const { start, stop } = require('ipv6-bridge');

const server = await start(8080);
// → returns the server, or null if bridge isn't needed

await stop();
```

## How It Works

**The "Language Translator" Analogy**
> Imagine you only speak English (IPv6), but you need to call a business in Japan where they only speak Japanese (IPv4). If you call them directly, you won't understand each other.
>
> This project acts like a live, bilingual phone operator sitting right next to you. When you try to make the call, the software intercepts it, looks up the Japanese translation for the phone number (**DNS64**), and then acts as a middleman translating your English sentences into Japanese and back again in real-time (**application-layer proxy**). The result is that you have a seamless conversation without even realizing a translation is happening.

### Technical Flow

```text
Your App → HTTP request → IPv6 Bridge (localhost:8080)
                               │
                          DNS64 resolution
                          example.com → 142.251.32.14 → 64:ff9b::8efb:200e
                               │
                          Outbound via IPv6
                               │
                          ISP NAT64 Gateway
                               │
                          IPv4 Internet (google.com)
```

1. **Detection** — checks whether IPv4 already works, whether IPv6 works, and whether your ISP already provides NAT64
2. **DNS64** — resolves hostnames through the system resolver; if only an IPv4 address exists, synthesizes an IPv6 address using the NAT64 prefix (`64:ff9b::`)
3. **Proxy** — routes HTTP/HTTPS through IPv6; the ISP's NAT64 gateway translates to IPv4
4. **Response** — data flows back through the same path, transparently

For a deep dive, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `IPV6_BRIDGE_PORT` | `8080` | Proxy listen port |
| `IPV6_BRIDGE_HOST` | `127.0.0.1` | Interface to bind to |
| `IPV6_BRIDGE_SOCKS_PORT` | _(off)_ | Serve SOCKS5 on this port |
| `IPV6_BRIDGE_AUTH` | _(none)_ | Require `user:password` from clients |
| `IPV6_BRIDGE_ALLOW` | _(any)_ | Client allowlist, e.g. `192.168.1.0/24` |
| `IPV6_BRIDGE_BYPASS` | _(none)_ | Hosts to reach directly, e.g. `*.internal.com` |
| `IPV6_BRIDGE_CONTROL` | `on` | Serve `/healthz`, `/status`, `/metrics`, `/proxy.pac` |
| `IPV6_BRIDGE_DISCOVER_PREFIX` | `on` | Discover the NAT64 prefix via RFC 7050 |
| `FORCE_BRIDGE` | _(unset)_ | Start even if not needed |
| `NAT64_PREFIX` | `64:ff9b::/96` | NAT64 prefix, with optional `/length` |
| `IPV6_DNS_TIMEOUT` | `5000` | DNS resolution timeout (ms) |
| `IPV6_DNS_CACHE_TTL` | `30000` | DNS cache entry lifetime (ms) |
| `IPV6_CONN_TIMEOUT` | `10000` | Proxy connection timeout (ms) |
| `IPV4_TEST_URL` | `http://ipv4.google.com` | Endpoint used to detect working IPv4 |
| `IPV6_TEST_URL` | `http://ipv6.google.com` | Endpoint used to detect working IPv6 |
| `NAT64_TEST_HOST` | `ipv4.google.com` | IPv4-only host used to probe for NAT64 |
| `LOG_LEVEL` | `info` | Log verbosity (`silent`, `error`, `warn`, `info`, `debug`) |

See [docs/API.md](docs/API.md) for the complete list. Invalid values (a malformed `NAT64_PREFIX`, a port outside 1–65535) fail immediately at startup with a clear message rather than surfacing later as unexplainable connection errors.

## Diagnosing a network

```bash
npx ipv6-bridge doctor
```

Reports whether your resolvers agree, whether IPv4/IPv6/NAT64 are reachable, which NAT64 prefix your network advertises versus the one configured, and whether the listener is exposed. Exits non-zero on failure, so it works in provisioning scripts.

## Monitoring

With the bridge running:

```bash
curl http://127.0.0.1:8080/status     # JSON: counters, routes, DNS cache
curl http://127.0.0.1:8080/metrics    # Prometheus exposition format
curl http://127.0.0.1:8080/healthz    # liveness probe
```

The field that matters most is `translationRate` — the share of connections routed through NAT64. If it sits at `0` while `routes.directIpv4Fallback` climbs, the bridge is passing traffic through untranslated, and `doctor` will tell you why.

## Non-HTTP protocols

The HTTP proxy only carries HTTP. For ssh, git, database clients and anything else over TCP, enable the SOCKS5 listener:

```bash
IPV6_BRIDGE_SOCKS_PORT=1080 npx ipv6-bridge start

git config --global http.proxy socks5h://127.0.0.1:1080
ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:1080 %h %p' user@host
```

## Security

The proxy binds to `127.0.0.1` by default so that only processes on your own machine can use it, and it performs no authentication unless you configure some.

Binding to a routable interface turns your machine into an open relay that anyone on the same network can send traffic through, attributed to your IP address. If you do expose it, pair that with access control — the bridge warns at startup if you don't:

```bash
IPV6_BRIDGE_HOST=0.0.0.0 \
IPV6_BRIDGE_AUTH=user:secret \
IPV6_BRIDGE_ALLOW=192.168.1.0/24 \
  npx ipv6-bridge start
```

Credentials are required on the HTTP, CONNECT and SOCKS5 paths alike. `/healthz` stays reachable without them so load balancers keep working.

## API

### `start(port?, options?): Promise<http.Server | null>`

Starts the proxy. Returns the server instance, or `null` if the bridge isn't needed.

- `options.host` — interface to bind to (defaults to `127.0.0.1`)
- `options.force` — start even if detection says the bridge isn't needed

### `stop(): Promise<void>`

Stops the running bridge and tears down live connections, including open CONNECT tunnels.

See [docs/API.md](docs/API.md) for the full API reference.

## Testing

```bash
npm test
```

The suite runs entirely against local servers and needs no network access.

### Demo Application

An interactive diagnostics tool:

```bash
npm run demo
# Open http://127.0.0.1:3000
```

### Dual-Stack Test Server

Test IPv4 and IPv6 endpoints with real-time logging:

```bash
cd test-server && node server.js
```

See [test-server/README.md](test-server/README.md) for details.

## Project Structure

```
src/
  cli.js        CLI entry point
  config.js     Configuration and validation
  connect.js    Outbound connections, failover, pooling
  detect.js     Network detection
  discovery.js  NAT64 prefix discovery (RFC 7050)
  dns64.js      DNS64 resolver
  doctor.js     Diagnostics
  cache.js      Bounded TTL cache
  index.js      Public API (start/stop)
  ipv6.js       IPv6 and RFC 6052 address primitives
  logger.js     Structured logger
  netmatch.js   CIDR and hostname matching
  proxy.js      HTTP/HTTPS proxy
  socks5.js     SOCKS5 server
  stats.js      Runtime counters
tests/          Test suite
demo-app/       Interactive demo
test-server/    Dual-stack test server
examples/       Usage examples
docs/           Extended documentation
```

## Limitations

This project is an **application-layer proxy**, not a packet-level NAT64 implementation. Be aware of the following:

- **Not transparent** — applications must be configured to use the proxy. System services, games, and mobile apps won't route through it automatically. `/proxy.pac` helps for browsers; SOCKS5 helps for everything else.
- **TCP only** — SOCKS5 covers arbitrary TCP, but UDP (`UDP ASSOCIATE`) and inbound `BIND` are not implemented, as neither is possible from user space without inbound reachability.
- **No HTTP/2 or HTTP/3 to the origin** — upstream requests are HTTP/1.1. Clients still negotiate whatever they like inside a CONNECT tunnel, so HTTPS is unaffected.
- **Requires an upstream NAT64 gateway** — this project synthesizes DNS64 addresses but relies on your network's NAT64 infrastructure for the actual packet translation. `doctor` tells you whether one exists.
- **Private addresses are not translated** — RFC 6052 section 3.1 forbids carrying non-global IPv4 addresses over the well-known prefix, so targets like `127.0.0.1` or `192.168.x.x` are connected to directly over IPv4 instead.
- **DNS cache uses a fixed TTL** — the system resolver does not expose record TTLs, so cached entries expire on `IPV6_DNS_CACHE_TTL` (30s) rather than the DNS TTL.

## Roadmap

We have an extensive roadmap planned for future releases, including DNS caching, SOCKS5 support, and Happy Eyeballs (RFC 8305).

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full breakdown of planned features and protocol expansions.

## Documentation

| Document | What's in it |
|----------|--------------|
| [docs/GUIDE.md](docs/GUIDE.md) | **Start here.** When to use it, connecting applications, worked scenarios, troubleshooting, glossary |
| [docs/API.md](docs/API.md) | Programmatic API, every environment variable, operational endpoints |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works internally and why the design choices were made |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What has shipped and what is planned |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | Release history |
| [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) | How to work on the project |

`ipv6-bridge --help` lists every command, option and endpoint.

## Standards

- [RFC 6052](https://tools.ietf.org/html/rfc6052) — IPv6 Addressing of IPv4/IPv6 Translators
- [RFC 6146](https://tools.ietf.org/html/rfc6146) — Stateful NAT64
- [RFC 6147](https://tools.ietf.org/html/rfc6147) — DNS64
- [RFC 6890](https://tools.ietf.org/html/rfc6890) — Special-Purpose IP Address Registries
- [RFC 7230](https://tools.ietf.org/html/rfc7230) — HTTP/1.1 Message Syntax and Routing

## Contributing

See [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

## License

[MIT](LICENSE)
