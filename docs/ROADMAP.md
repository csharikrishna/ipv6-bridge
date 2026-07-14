# Future Roadmap & Project Vision

While **IPv6 Bridge** currently functions as a lightweight, zero-dependency DNS64-aware HTTP proxy for local development, there are numerous opportunities to expand it into a more robust, production-grade utility.

The roadmap is divided into three tiers based on complexity and alignment with the core project vision.

## 🟢 Tier 1: High-Priority Networking Improvements (Planned)

These enhancements directly improve the performance and correctness of the proxy without adding massive architectural complexity.

- **DNS Cache with TTL**: Currently, every request triggers a new DNS lookup. Implementing an in-memory LRU cache respecting DNS TTLs will drastically reduce latency and upstream DNS load.
- **Connection Pooling & Keep-Alive**: Reusing persistent TCP sockets instead of opening and closing connections for every HTTP request to massively improve throughput.
- **Happy Eyeballs (RFC 8305)**: Instead of waiting for AAAA resolution to fail before trying A records, race both IPv4 and IPv6 simultaneously for faster connection establishment.
- **Improved Network Detection**: Moving beyond simple HTTP ping tests to inspect system routing tables, network interfaces, and OS-level DNS64/NAT64 presence for more robust auto-detection.
- **Custom NAT64 Prefix Formats**: Support configurable prefix lengths (`/32`, `/40`, `/48`, `/56`, `/64`) per RFC 6052, rather than assuming `/96`.

## 🟡 Tier 2: Protocol Expansions (Under Consideration)

Expanding beyond a simple HTTP/HTTPS proxy to support a wider array of applications.

- **SOCKS5 Support**: Implementing a SOCKS5 interface would allow the bridge to proxy non-HTTP protocols like SSH, FTP, SMTP, MQTT, and direct database connections (Redis, Postgres).
- **PAC (Proxy Auto-Configuration)**: Provide a `.pac` file endpoint so operating systems can automatically route appropriate traffic through the bridge.
- **Per-Domain Routing Policies**: Configurable bypass lists (e.g., route `*.internal.company.com` directly, but proxy everything else).

## ⚪ Tier 3: Enterprise & Production Features (Out of Scope for v1)

These features are valuable for production deployments but would significantly increase the complexity of the current lightweight developer utility.

- **Authentication**: Basic Auth, Bearer Tokens, or IP whitelisting to secure the proxy when exposed to a LAN.
- **Rate Limiting & Circuit Breakers**: Protecting the proxy from abuse and handling failing upstream endpoints gracefully.
- **Observability**: Adding `/metrics`, `/health`, and `/status` endpoints for Prometheus scraping.
- **HTTP/2 & HTTP/3**: Native support for modern HTTP multiplexing (requires significant architectural changes away from Node's core `http` module).

---

*Contributions are welcome! If you're interested in tackling any of these roadmap items, please check out our [CONTRIBUTING.md](CONTRIBUTING.md) and open an issue to discuss the implementation plan.*
