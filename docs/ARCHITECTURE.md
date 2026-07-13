# Architecture

This document explains the technical architecture of IPv6 Bridge, focusing on why DNS64 and application-level NAT64 are used and how they work together.

## DNS64 vs NAT64

### DNS64 (RFC 6052)

DNS64 translates domain names to IPv6 addresses by synthesizing them from IPv4 records.

```
Query: example.com
  → DNS returns IPv4: 192.0.2.1
  → DNS64 synthesizes IPv6: 64:ff9b::c000:0201
  → Application gets a routable IPv6 address
```

**Implementation:** `src/dns64.js`

1. Try native IPv6 resolution (AAAA records) first
2. Fall back to IPv4 resolution (A records)
3. Synthesize IPv6 using the well-known NAT64 prefix (`64:ff9b::`)

### NAT64 (RFC 6146)

NAT64 translates packets between IPv6 and IPv4 at the network level. There are two complementary approaches:

- **ISP-level NAT64**: The ISP operates a gateway that recognizes the `64:ff9b::` prefix and translates packets automatically.
- **Application-level NAT64** (this project): An HTTP/HTTPS proxy intercepts requests, applies DNS64, and routes traffic through IPv6 so the ISP gateway can translate it.

Both approaches work together. If the ISP provides NAT64, the bridge is optional. If not, the bridge provides application-level translation.

## End-to-End Flow

```
Step 1: Browser sends GET http://google.com/ via proxy (localhost:8080)

Step 2: proxy.js extracts hostname "google.com"

Step 3: dns64.js resolves hostname
         ├─ Try dns.resolve6("google.com") → fails (IPv4-only site)
         ├─ Fallback dns.resolve4("google.com") → 142.251.32.14
         └─ Synthesize: 64:ff9b::8efb:200e

Step 4: proxy.js connects outbound to 64:ff9b::8efb:200e (family: 6)

Step 5: ISP NAT64 gateway recognizes 64:ff9b:: prefix
         → Extracts 142.251.32.14
         → Forwards request over IPv4

Step 6: Google responds → NAT64 gateway translates back to IPv6

Step 7: proxy.js pipes response to the client
```

## Component Diagram

```
detect.js ──→ Checks if bridge is needed
                │
                ▼
index.js  ──→ Coordinates start/stop
                │
                ▼
proxy.js  ──→ HTTP/HTTPS proxy server
                │
                ▼
dns64.js  ──→ Resolves hostnames via DNS64
                │
                ▼
config.js ──→ NAT64 prefix, ports, test URLs


cli.js    ──→ CLI entry point → calls index.js
```

### Component Roles

| Component | Role | Necessity |
|-----------|------|-----------|
| `detect.js` | Auto-detects IPv6-only networks needing the bridge | Important |
| `dns64.js` | DNS64 resolution and IPv4→IPv6 address synthesis | Critical |
| `proxy.js` | HTTP/HTTPS proxy with IPv6 routing | Critical |
| `index.js` | Public API (`start`/`stop`) | Required |
| `cli.js` | CLI entry point (`npx ipv6-bridge start`) | Required |
| `config.js` | Centralized configuration constants | Required |

## Design Decisions

### Why Application-Level NAT64?

- **No kernel changes**: Works without modifying the system network stack.
- **Cross-platform**: Same code on Windows, macOS, Linux, and containers.
- **No admin rights**: Runs as a normal user process.
- **Covers primary use cases**: HTTP/HTTPS is 95%+ of internet traffic.

### What We Don't Do

- **Packet-level translation**: The ISP gateway handles this.
- **Kernel-level NAT64**: Would require kernel modules and admin rights.
- **DNS server**: We use the system DNS resolver and enhance results with DNS64 synthesis.

## Deployment Scenarios

| Scenario | Behavior |
|----------|----------|
| ISP has NAT64 | Bridge auto-detects it's not needed; returns `null` from `start()` |
| IPv6-only, no ISP NAT64 | Bridge starts proxy; DNS64 synthesizes addresses; ISP gateway translates |
| Dual-stack (IPv4 + IPv6) | Bridge detects IPv4 is available; returns `null` |
| Forced start (`FORCE_BRIDGE=1`) | Bridge starts regardless of detection |
