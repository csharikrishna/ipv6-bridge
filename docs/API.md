# API Reference

Complete API documentation for IPv6 Bridge.

## Embedded API

These let an application use DNS64/NAT64 translation directly, with no proxy
and no system configuration. Every outbound connection tries native IPv6 first,
then a NAT64-synthesized address, then direct IPv4.

None of this can create connectivity the host does not have.

### `createAgent(options?)`

An `http.Agent` that resolves through DNS64, fails over across candidate
addresses, and pools sockets keyed by the original hostname.

```javascript
const { createAgent } = require('ipv6-bridge');
http.get('http://example.com', { agent: createAgent() }, handler);
```

**Parameters:** any `http.Agent` option. Defaults: `keepAlive: true`,
`keepAliveMsecs` from `IPV6_KEEP_ALIVE_MS`, `maxSockets` from
`IPV6_MAX_SOCKETS_PER_HOST`.

**Returns:** `http.Agent`

### `createHttpsAgent(options?)`

The same, performing the TLS handshake over the bridged socket.

```javascript
const { createHttpsAgent } = require('ipv6-bridge');
https.get('https://example.com', { agent: createHttpsAgent() }, handler);
```

The certificate is validated against the **requested hostname**, never the
synthesized address the connection travelled over, so certificate verification
works normally and must not be disabled.

**Returns:** `https.Agent`

### `createAgents(options?)`

Both at once, for clients that take a pair.

**Returns:** `{ http: http.Agent, https: https.Agent }`

```javascript
const agents = createAgents();
axios.create({ httpAgent: agents.http, httpsAgent: agents.https });
```

### `createLookup()`

A `dns.lookup`-compatible function applying DNS64 synthesis. Usable anywhere a
`lookup` option is accepted.

```javascript
net.connect({ host: 'db.example', port: 5432, lookup: createLookup() });
```

Supports the `all` and `family` options. Lighter-touch than an agent, but it
only changes resolution — no failover or pooling.

**Returns:** `(hostname, options, callback) => void`

### `createConnector()`

A connector for undici, and therefore Node's global `fetch`. undici is not a
dependency; this is for projects that already use it.

```javascript
const { Agent, setGlobalDispatcher } = require('undici');
setGlobalDispatcher(new Agent({ connect: createConnector() }));
```

**Returns:** `(options, callback) => void`

### `resolve(hostname)`

Resolve the way the bridge would, without connecting. Useful for logging and
assertions.

```javascript
await resolve('8.8.8.8');
// → [ { host: '64:ff9b::808:808', family: 6, mode: 'nat64' },
//     { host: '8.8.8.8', family: 4, mode: 'direct-ipv4' } ]
```

**Returns:** `Promise<Array<{host: string, family: number, mode: string}>>`

### `getStats()`

A snapshot of counters, routing modes, DNS cache statistics and the active
prefix — the same data the proxy serves at `/status`, available to embedded
users.

```javascript
const stats = getStats();
stats.translationRate;           // 0 means nothing is being translated
stats.routes.directIpv4Fallback; // connections that could not be translated
```

**Returns:** `object`

### `discoverPrefix()`

Run RFC 7050 discovery and report the network's NAT64 prefix, without changing
configuration.

**Returns:** `Promise<{prefix, length, bytes, source}|null>`

---

## Proxy API

### `start(port?, options?)`

Starts the IPv6 Bridge proxy server.

```javascript
const { start, stop } = require('ipv6-bridge');

const server = await start(8080);
```

**Parameters:**
- `port` (number, default: `8080`) — Port to listen on.
- `options.host` (string, default: `127.0.0.1`) — Interface to bind to.
- `options.force` (boolean) — Start even if detection says the bridge isn't needed.
- `options.discoverPrefix` (boolean, default: `true`) — Run RFC 7050 prefix discovery.
- `options.socksPort` (number|null) — Also start a SOCKS5 listener on this port.

**Returns:** `Promise<http.Server | null>`
- Returns the HTTP server instance if the bridge started.
- Returns `null` if the bridge was not needed (IPv4 works, or NAT64 already works).

**Throws:** `Error` if the bridge is already running or startup fails.

**Behavior:**
1. Runs network detection (`needsBridge()`).
2. If the bridge is not needed and neither `options.force` nor `FORCE_BRIDGE` is set, returns `null`.
3. Optionally discovers the network's NAT64 prefix (RFC 7050).
4. Creates and starts the proxy, plus a SOCKS5 listener if configured.

Concurrent calls are safe: a second `start()` while one is in flight rejects rather than leaving an untracked server running.

---

### `stop()`

Stops the running bridge and any SOCKS5 listener, tearing down live connections.

```javascript
await stop();
```

Open CONNECT tunnels are destroyed rather than waited on, so `stop()` always resolves — important when the bridge is started and stopped inside a test suite.

Safe to call when nothing is running.

---

## CLI

```bash
# Start on the default port (8080)
npx ipv6-bridge start

# Custom port
IPV6_BRIDGE_PORT=9090 npx ipv6-bridge start

# Force start even if the bridge is not needed
FORCE_BRIDGE=1 npx ipv6-bridge start

# Diagnose this network
npx ipv6-bridge doctor

# Show help
npx ipv6-bridge --help
```

Stop the bridge with `Ctrl+C` or by sending `SIGTERM`.

### `doctor`

Runs diagnostics and explains what it found:

- whether the system resolver and direct DNS queries agree
- whether IPv4, IPv6 and an upstream NAT64 gateway are reachable
- which NAT64 prefix is configured, and which one the network advertises
- whether the listener is exposed without access control

Exits non-zero if any check fails, so it can be used in provisioning scripts.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IPV6_BRIDGE_PORT` | `8080` | Port for the proxy server |
| `IPV6_BRIDGE_HOST` | `127.0.0.1` | Interface to bind to |
| `IPV6_BRIDGE_SOCKS_PORT` | _(off)_ | Serve SOCKS5 on this port |
| `IPV6_BRIDGE_AUTH` | _(none)_ | Require `user:password` from clients |
| `IPV6_BRIDGE_ALLOW` | _(any)_ | Client allowlist, e.g. `192.168.1.0/24` |
| `IPV6_BRIDGE_BYPASS` | _(none)_ | Hosts to reach directly, e.g. `*.internal.com` |
| `IPV6_BRIDGE_CONTROL` | `on` | Serve `/healthz`, `/status`, `/metrics`, `/proxy.pac` |
| `IPV6_BRIDGE_DISCOVER_PREFIX` | `on` | Discover the NAT64 prefix via RFC 7050 |
| `FORCE_BRIDGE` | _(unset)_ | Start the bridge even when detection says it isn't needed |
| `NAT64_PREFIX` | `64:ff9b::/96` | NAT64 prefix, with an optional `/length` |
| `IPV6_DNS_TIMEOUT` | `5000` | DNS resolution timeout (ms) |
| `IPV6_DNS_CACHE_TTL` | `30000` | DNS cache entry lifetime (ms) |
| `IPV6_DNS_CACHE_MAX` | `1000` | Maximum cached DNS entries |
| `IPV6_CONN_TIMEOUT` | `10000` | Proxy connection timeout (ms) |
| `IPV6_CONNECT_ATTEMPT_TIMEOUT` | `3000` | Timeout per candidate address before trying the next |
| `IPV6_KEEP_ALIVE_MS` | `15000` | Idle lifetime of pooled upstream sockets |
| `IPV6_MAX_SOCKETS_PER_HOST` | `64` | Maximum pooled sockets per upstream host |
| `IPV4_TEST_URL` | `http://ipv4.google.com` | Endpoint used to detect working IPv4 |
| `IPV6_TEST_URL` | `http://ipv6.google.com` | Endpoint used to detect working IPv6 |
| `NAT64_TEST_HOST` | `ipv4.google.com` | IPv4-only host used to probe for NAT64 |
| `LOG_LEVEL` | `info` | `silent`, `error`, `warn`, `info` or `debug` |

Invalid values are rejected at startup with an explanatory message rather than causing confusing failures later.

### NAT64 prefix formats

`NAT64_PREFIX` accepts any prefix length RFC 6052 defines — `/32`, `/40`, `/48`, `/56`, `/64` or `/96`. Without a length, `/96` is assumed.

```bash
NAT64_PREFIX=64:ff9b::/96            # well-known prefix (default)
NAT64_PREFIX=2001:db8:122:344::/64   # operator-assigned prefix
```

The well-known prefix `64:ff9b::` is only valid at `/96`, and per RFC 6052 section 3.1 it is never used to carry non-global IPv4 addresses.

---

## Operational endpoints

When `IPV6_BRIDGE_CONTROL` is on, the proxy answers these paths directly (as ordinary origin-form requests, not proxied ones):

| Path | Description |
|------|-------------|
| `/healthz` | Liveness check. Always reachable, even when authentication is enabled. |
| `/status` | JSON snapshot of counters, routing modes, DNS cache and active prefix. |
| `/metrics` | The same data in Prometheus text exposition format. |
| `/proxy.pac` | A proxy auto-configuration file pointing clients at the bridge. |

The most useful field in `/status` is `translationRate`: the share of connections that actually went through NAT64. A rate of `0` with a rising `routes.directIpv4Fallback` means the bridge is not translating anything.

```bash
curl http://127.0.0.1:8080/status
```

---

## Internal Modules

### `dns64.js`

#### `resolveCandidates(hostname)`

Resolves a hostname into an ordered list of connection candidates, most preferred first: native IPv6, then NAT64-synthesized, then direct IPv4.

**Returns:** `Promise<Array<{host: string, family: number, mode: string}>>`

#### `resolveIPv6(hostname)`

Resolves a hostname to IPv6 addresses using DNS64.

**Returns:** `Promise<string[]>`

#### `ipv4ToIPv6(ipv4)` / `ipv6ToIPv4(address)`

Converts between an IPv4 address and its IPv4-embedded IPv6 form using the active prefix.

```javascript
ipv4ToIPv6('192.0.2.1');   // → '64:ff9b::c000:201'
ipv6ToIPv4('64:ff9b::c000:201'); // → '192.0.2.1'
```

Output is RFC 5952 canonical form, so leading zeros are suppressed.

#### `isGlobalIPv4(address)` / `canSynthesize(address)`

Whether an address is globally routable, and whether it may be synthesized with the active prefix.

#### `detectIPVersion(addr)`

**Returns:** `'ipv4'` | `'ipv6'` | `'hostname'` | `null`

---

### `ipv6.js`

Address primitives: `parseIPv6`, `formatIPv6`, `parsePrefix`, `embedIPv4`, `extractIPv4`. Implements the RFC 6052 section 2.2 embedding rules for every prefix length, including the reserved `u` octet at bits 64–71.

---

### `discovery.js`

#### `discoverPrefix()`

Discovers the network's NAT64 prefix per RFC 7050 by resolving `ipv4only.arpa` and looking for its known IPv4 addresses inside the synthesized AAAA records.

**Returns:** `Promise<{prefix, length, bytes, source}|null>`

---

### `detect.js`

#### `hasIPv4()` / `hasIPv6()` / `hasWorkingNAT64()`

Individual reachability probes. Any 2xx or 3xx response counts as reachable.

#### `needsBridge()`

Returns `true` only when IPv4 is unreachable, IPv6 works, and no upstream NAT64 gateway responds.

---

### `socks5.js`

#### `createSocksServer(port, host?)`

Starts a SOCKS5 listener (RFC 1928) supporting the CONNECT command, with optional username/password authentication (RFC 1929). Lets non-HTTP protocols — ssh, git, database clients — use the same DNS64/NAT64 translation.

---

## Troubleshooting

Run `npx ipv6-bridge doctor` first; it checks everything below automatically.

### Bridge says "not needed" but I want to test it

```bash
FORCE_BRIDGE=1 npx ipv6-bridge start
```

### Everything returns 502, or nothing seems translated

Check `/status`. If `translationRate` is `0` and `routes.directIpv4Fallback` is climbing, DNS64 is failing and the bridge is passing traffic through untranslated. Common causes:

- The network has no NAT64 gateway. Confirm with `doctor`.
- The NAT64 prefix is wrong. `doctor` reports the prefix the network advertises.

### DNS resolution fails

- The bridge uses the system resolver, so if `ping example.com` fails, so will the bridge.
- `dns.resolve` failing while `dns.lookup` works is normal on DoH-only hosts and does not affect the bridge.

### Connection timeouts

- Each candidate address gets `IPV6_CONNECT_ATTEMPT_TIMEOUT` (3s) before the next is tried.
- On a dual-stack network with `FORCE_BRIDGE`, expect a delay while the unreachable NAT64 route times out before falling back.

### Port already in use

- Change the port with `IPV6_BRIDGE_PORT=9090 npx ipv6-bridge start`.
- Check what's using it: `lsof -i :8080` (macOS/Linux) or `netstat -ano | findstr 8080` (Windows).
