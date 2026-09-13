# Architecture

This document explains the technical architecture of IPv6 Bridge, focusing on why DNS64 and application-level NAT64 are used and how they work together.

## DNS64 vs NAT64

### DNS64 (RFC 6147)

DNS64 translates domain names to IPv6 addresses by synthesizing them from IPv4 records. The address format itself — how the 32 bits of IPv4 are embedded into an IPv6 address — is defined by RFC 6052.

```
Query: example.com
  → DNS returns IPv4: 192.0.2.1
  → DNS64 synthesizes IPv6: 64:ff9b::c000:0201
  → Application gets a routable IPv6 address
```

**Implementation:** `src/dns64.js`

1. Look the hostname up through the system resolver
2. Use native AAAA records if any exist
3. Otherwise synthesize IPv6 from the A records using the NAT64 prefix

### NAT64 (RFC 6146)

NAT64 translates packets between IPv6 and IPv4 at the network level. There are two complementary approaches:

- **ISP-level NAT64**: The ISP operates a gateway that recognizes the `64:ff9b::` prefix and translates packets automatically.
- **Application-level NAT64** (this project): An HTTP/HTTPS proxy intercepts requests, applies DNS64, and routes traffic through IPv6 so the ISP gateway can translate it.

Both approaches work together. If the ISP provides NAT64, the bridge is optional. If not, the bridge provides application-level translation.

## Why the system resolver, not `dns.resolve*`

`src/dns64.js` resolves names with `dns.lookup`, which calls the operating system's resolver (`getaddrinfo`).

The obvious alternative, `dns.resolve4` / `dns.resolve6`, talks directly to DNS servers over port 53 and ignores the hosts file, mDNS, DNS-over-HTTPS, and split-DNS configuration. On a host configured for DoH-only resolution — increasingly common, and exactly the kind of modern network this project targets — `dns.resolve*` fails outright with `ECONNREFUSED` even though ordinary name resolution works perfectly.

Using the system resolver means the bridge resolves names the same way every other program on the machine does.

## Address selection rules

RFC 6052 section 3.1 forbids representing **non-global** IPv4 addresses with the well-known prefix `64:ff9b::/96`. A NAT64 gateway will not route `64:ff9b::7f00:1` anywhere useful, because `127.0.0.1` is meaningless outside the local host.

The bridge therefore classifies every IPv4 address before synthesizing:

| Address | Action |
|---------|--------|
| Global (e.g. `8.8.8.8`) | Synthesize `64:ff9b::0808:0808` and route via NAT64 |
| Non-global (e.g. `127.0.0.1`, `192.168.1.5`, `10.0.0.2`) | Connect directly over IPv4 |

When an operator-assigned network-specific prefix (NSP) is configured instead of the well-known prefix, the section 3.1 restriction does not apply and all addresses are synthesized.

The non-global ranges are those listed in RFC 6890: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4` and `240/4`.

## End-to-End Flow

```
Step 1: Browser sends GET http://google.com/ via proxy (localhost:8080)

Step 2: proxy.js parses the absolute-form request target (RFC 7230 5.3.2)
         → "GET http://google.com/ HTTP/1.1" yields hostname "google.com"

Step 3: dns64.js resolves the hostname through the system resolver
         ├─ No AAAA records (IPv4-only site)
         ├─ A record: 142.251.32.14
         ├─ Address is global, so synthesis is permitted
         └─ Synthesize: 64:ff9b::8efb:200e

Step 4: proxy.js strips hop-by-hop headers and connects outbound to
        64:ff9b::8efb:200e (family: 6)

Step 5: ISP NAT64 gateway recognizes 64:ff9b:: prefix
         → Extracts 142.251.32.14
         → Forwards request over IPv4

Step 6: Google responds → NAT64 gateway translates back to IPv6

Step 7: proxy.js pipes response to the client
```

## Request handling

The proxy serves two distinct paths:

**Plain HTTP** — clients configured to use a forward proxy send an *absolute-form* request target (`GET http://example.com/path HTTP/1.1`) per RFC 7230 section 5.3.2. The proxy parses that directly, and accepts origin-form (`GET /path` plus a `Host` header) as a fallback for gateway-style use.

**HTTPS via CONNECT** — the client sends `CONNECT example.com:443`, the proxy opens a TCP tunnel to the resolved address and relays bytes in both directions without inspecting them. Authority parsing handles bracketed IPv6 literals (`[2001:db8::1]:443`), bare IPv6 literals, and `host:port`.

### Header handling

Hop-by-hop headers are removed in both directions per RFC 7230 section 6.1: `Connection`, `Proxy-Connection`, `Keep-Alive`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Transfer-Encoding` and `Upgrade`, plus any header named inside the `Connection` header.

`Proxy-Authorization` matters most: it carries credentials meant for the proxy itself, and forwarding it would leak them to every origin server the client visits.

### Failure reporting

When DNS64 resolution fails, the proxy falls back to a direct IPv4 connection — but logs a warning saying the request is **not** being translated. Silent fallback would make the bridge indistinguishable from a plain proxy, leaving users unable to tell whether translation ever happened.

Connection failures return a real status code (`502 Bad Gateway`, `504 Gateway Timeout`) on both the HTTP and CONNECT paths, rather than closing the socket and leaving the client to time out.

## Connection handling

Resolution produces an ordered list of candidates rather than a single address:

```
resolveCandidates("example.com")
  → [ { native IPv6 }, { NAT64-synthesized }, { direct IPv4 } ]
```

`connect.js` tries them in order, giving each `IPV6_CONNECT_ATTEMPT_TIMEOUT`
before moving on. A single unreachable address is the normal case on a partially
broken network, so failing on the first attempt would make the bridge less
reliable than the stack it replaces.

Reaching the direct-IPv4 candidate when a NAT64 route existed means translation
failed, so that case is logged as a warning and counted separately from a
deliberate direct connection.

Successful HTTP connections are pooled by a keep-alive agent keyed on the
original hostname, so pooling survives the fact that the dialled address is
synthesized rather than literal.

## Component Diagram

```
cli.js ──→ index.js ──→ detect.js    (is the bridge needed?)
                   │
                   ├──→ discovery.js (RFC 7050: what prefix does this network use?)
                   │
                   ├──→ proxy.js ──┐
                   │               ├──→ connect.js ──→ dns64.js ──→ ipv6.js
                   └──→ socks5.js ─┘                       │
                                                      cache.js

config.js ──→ validated settings, consumed by everything
stats.js  ──→ counters, surfaced at /status and /metrics
doctor.js ──→ standalone diagnostics
```

### Component Roles

| Component | Role | Necessity |
|-----------|------|-----------|
| `dns64.js` | DNS64 resolution and candidate ordering | Critical |
| `ipv6.js` | Address parsing and RFC 6052 embedding | Critical |
| `connect.js` | Outbound connections, failover, pooling | Critical |
| `proxy.js` | HTTP/HTTPS proxy with IPv6 routing | Critical |
| `config.js` | Centralized configuration and validation | Required |
| `index.js` | Public API (`start`/`stop`) | Required |
| `cli.js` | CLI entry point | Required |
| `detect.js` | Auto-detects networks needing the bridge | Important |
| `discovery.js` | RFC 7050 NAT64 prefix discovery | Important |
| `socks5.js` | SOCKS5 listener for non-HTTP protocols | Optional |
| `doctor.js` | Diagnostics | Optional |
| `stats.js` | Runtime counters for `/status` and `/metrics` | Optional |
| `cache.js` | Bounded TTL cache for DNS results | Optional |
| `netmatch.js` | CIDR and hostname matching for allow/bypass lists | Optional |
| `logger.js` | Level-filtered structured logging | Required |

## Prefix discovery (RFC 7050)

Most networks that provide NAT64 assign their own prefix rather than using the
well-known one, so assuming `64:ff9b::/96` is wrong more often than it is right.

RFC 7050 defines the discovery mechanism: the name `ipv4only.arpa` has exactly
two A records, `192.0.0.170` and `192.0.0.171`, and no AAAA records of its own.
A DNS64 resolver therefore synthesizes AAAA records for it, and whatever wraps
those known IPv4 addresses reveals the prefix and its length.

At startup the bridge resolves that name and, for each returned address, tries
every RFC 6052 prefix length until the embedded bytes match a known address. An
explicitly configured `NAT64_PREFIX` always wins; discovery only fills in a
default, and logs when the network disagrees with the configuration.

## Detection logic

`needsBridge()` answers one question: *would this machine be unable to reach IPv4-only servers without help?*

```
1. Does plain IPv4 work?          → yes: bridge NOT needed (dual-stack)
2. Does IPv6 work?                → no:  bridge cannot help
3. Does the ISP already do NAT64? → yes: bridge NOT needed
4. Otherwise                      → bridge IS needed
```

Step 1 is what keeps the bridge from activating on an ordinary dual-stack network, where routing traffic through a nonexistent NAT64 gateway would break connections that already work.

Probes accept any 2xx or 3xx response as "reachable"; requiring exactly `200` would misreport a network as broken the moment a test endpoint starts redirecting. All three endpoints are configurable so detection still works where the defaults are blocked.

## Design Decisions

### Why Application-Level NAT64?

- **No kernel changes**: Works without modifying the system network stack.
- **Cross-platform**: Same code on Windows, macOS, Linux, and containers.
- **No admin rights**: Runs as a normal user process.
- **Covers primary use cases**: HTTP/HTTPS is 95%+ of internet traffic.

### Why loopback-only by default

The proxy has no authentication. Bound to a routable interface it is an open relay: anyone on the same network can push traffic through it under the host's IP address. Loopback is the only safe default, and exposing it is an explicit, warned-about opt-in.

### What We Don't Do

- **Packet-level translation**: The ISP gateway handles this.
- **Kernel-level NAT64**: Would require kernel modules and admin rights.
- **DNS server**: We use the system DNS resolver and enhance results with DNS64 synthesis.

## Deployment Scenarios

| Scenario | Behavior |
|----------|----------|
| Dual-stack (IPv4 + IPv6) | Detection sees working IPv4; `start()` returns `null` |
| ISP has NAT64 | Detection reaches an IPv4-only host over the synthesized address; `start()` returns `null` |
| IPv6-only, no ISP NAT64 | Bridge starts proxy; DNS64 synthesizes addresses; ISP gateway translates |
| No connectivity at all | `start()` returns `null` — the bridge cannot help |
| Forced start (`FORCE_BRIDGE=1`) | Bridge starts regardless of detection |
