# Roadmap & Project Vision

**IPv6 Bridge** is a zero-dependency DNS64/NAT64 bridge for hosts stranded on
IPv6-only networks. This document tracks what has shipped and what is still
open.

## Shipped in 2.0

These were the Tier 1 and Tier 2 items on the previous roadmap.

- **DNS cache** — bounded LRU with TTL expiry, so repeat requests skip resolution.
- **Connection pooling & keep-alive** — upstream sockets are reused across requests.
- **Connection failover** — candidates are tried in preference order (native IPv6,
  then NAT64, then direct IPv4) instead of failing on the first unreachable address.
- **Improved network detection** — IPv4 reachability is checked first, so the bridge
  no longer activates on healthy dual-stack networks.
- **Custom NAT64 prefix formats** — every RFC 6052 prefix length (`/32`, `/40`,
  `/48`, `/56`, `/64`, `/96`), validated against the RFC's own test vectors.
- **NAT64 prefix discovery (RFC 7050)** — the network's real prefix is discovered
  from `ipv4only.arpa` rather than assumed.
- **SOCKS5 support** — ssh, git, databases and any other TCP protocol.
- **PAC (Proxy Auto-Configuration)** — served at `/proxy.pac`.
- **Per-domain routing policies** — `IPV6_BRIDGE_BYPASS` for split routing.
- **Authentication** — Basic credentials and a client CIDR allowlist, enforced on
  the HTTP, CONNECT and SOCKS5 paths.
- **Observability** — `/healthz`, `/status` and Prometheus `/metrics`, including a
  `translationRate` that shows whether translation is actually happening.
- **Diagnostics** — `ipv6-bridge doctor`.

## Open

### Reliability

- **Full Happy Eyeballs (RFC 8305)** — connection attempts are currently
  sequential with a per-attempt timeout. True Happy Eyeballs races families with
  a staggered delay, which lowers worst-case latency on partially broken networks.
- **Real DNS TTLs** — the system resolver does not expose them, so the cache uses
  a fixed TTL. Honouring real TTLs would need a resolver that reports them without
  reintroducing the `dns.resolve*` failure mode on DoH-only hosts.
- **Circuit breaking** — remember recently failed upstreams instead of retrying
  every candidate on every request.

### Protocol coverage

- **HTTP/2 and HTTP/3 to the origin** — upstream requests are HTTP/1.1. This needs
  a move away from Node's core `http` module for the upstream leg.
- **SOCKS5 UDP (`UDP ASSOCIATE`)** — would extend coverage to DNS, QUIC and
  game traffic.
- **WebSocket** — works today inside a CONNECT tunnel, but not for plain-HTTP
  `Upgrade` requests, which the proxy currently strips.

### Operations

- **Rate limiting** — per-client request and bandwidth caps for shared deployments.
- **Structured JSON logging** — for log aggregation pipelines.
- **Container image** — a published image with sensible defaults.

### Reach

- **Transparent interception** — the largest remaining adoption barrier is that
  applications must be configured to use the proxy. A TUN-based mode would remove
  that, at the cost of admin rights and platform-specific code, so it would need
  to be an opt-in mode rather than a replacement for the user-space design.

---

*Contributions are welcome! If you're interested in tackling any of these roadmap
items, please check out our [CONTRIBUTING.md](CONTRIBUTING.md) and open an issue
to discuss the implementation plan.*
