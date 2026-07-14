# IPv6 Bridge

[![npm version](https://img.shields.io/npm/v/ipv6-bridge.svg)](https://www.npmjs.com/package/ipv6-bridge)
[![npm downloads](https://img.shields.io/npm/dm/ipv6-bridge.svg)](https://www.npmjs.com/package/ipv6-bridge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

> DNS64-aware HTTP proxy for IPv6-only networks — access IPv4 sites seamlessly.

IPv4 addresses are exhausted globally. Many ISPs now deploy IPv6-only networks, but millions of websites still only support IPv4. IPv6 Bridge solves this by running a local application-layer proxy that synthesizes DNS64 addresses and routes HTTP/HTTPS traffic through your ISP's NAT64 gateway.

## Why IPv6 Bridge? (The Advantage)

While there are other NAT64/DNS64 bridges out there (like Tayga or Jool), **IPv6 Bridge** occupies a very specific, developer-friendly niche:

1. **100% User-Space & Zero Dependencies**: Most IPv6 bridges require installing complex C++ binaries, compiling Linux kernel modules, or configuring OS-level `TUN/TAP` interfaces. This project runs entirely in user-space using pure Node.js standard libraries. Just run it.
2. **Intelligent Auto-Detection**: It probes your network to figure out if you are actually stuck on a broken IPv6-only network, and only activates if strictly necessary, preventing it from breaking standard IPv4-enabled environments.
3. **Programmatic API**: Designed for software engineers, it exports a clean `start()` and `stop()` API. You can import this package directly into your automated testing pipelines (like Cypress or Jest) to simulate IPv6 environments during CI/CD builds.
4. **Premium Diagnostic Dashboard**: Ships with a built-in interactive dashboard to test DNS64 connectivity visually, making network debugging incredibly approachable.
5. **RFC Compliant**: Implements DNS64 address synthesis per RFC 6052.

## Quick Start

### CLI

```bash
npx ipv6-bridge start
```

The bridge auto-detects whether it's needed. To force it:

```bash
FORCE_BRIDGE=1 npx ipv6-bridge start
```

### Programmatic

```javascript
const { start, stop } = require('ipv6-bridge');

const server = await start(8080);
// → returns the server, or null if bridge isn't needed

// Later:
await stop();
```

### Install as a Dependency

```bash
npm i ipv6-bridge
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

1. **Detection** — checks if you're on an IPv6-only network
2. **DNS64** — resolves hostnames; if only an IPv4 address exists, synthesizes an IPv6 address using the NAT64 prefix (`64:ff9b::`)
3. **Proxy** — routes HTTP/HTTPS through IPv6; the ISP's NAT64 gateway translates to IPv4
4. **Response** — data flows back through the same path, transparently

For a deep dive, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `IPV6_BRIDGE_PORT` | `8080` | Proxy listen port |
| `FORCE_BRIDGE` | _(unset)_ | Start even if not needed |
| `NAT64_PREFIX` | `64:ff9b::` | Custom NAT64 prefix |
| `IPV6_DNS_TIMEOUT` | `5000` | DNS resolution timeout (ms) |
| `IPV6_CONN_TIMEOUT` | `10000` | Proxy connection timeout (ms) |
| `LOG_LEVEL` | `info` | Log verbosity (`error`, `warn`, `info`, `debug`) |

## API

### `start(port?): Promise<http.Server | null>`

Starts the proxy. Returns the server instance, or `null` if the bridge isn't needed.

### `stop(): Promise<void>`

Stops the running bridge.

See [docs/API.md](docs/API.md) for the full API reference.

## Testing

```bash
npm test
```

### Demo Application

An interactive diagnostics tool:

```bash
cd demo-app && npm start
# Open http://localhost:3000
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
  config.js     Configuration constants
  detect.js     Network detection
  dns64.js      DNS64 resolver
  index.js      Public API (start/stop)
  logger.js     Structured logger
  proxy.js      HTTP/HTTPS proxy
tests/          Test suite
demo-app/       Interactive demo
test-server/    Dual-stack test server
examples/       Usage examples
docs/           Extended documentation
```

## Limitations

This project is an **application-layer HTTP proxy**, not a packet-level NAT64 implementation. Be aware of the following:

- **HTTP and HTTPS only** — does not proxy SSH, FTP, SMTP, WebSocket, gRPC, or other TCP/UDP protocols.
- **Not transparent** — applications must be explicitly configured to use `localhost:8080` as their HTTP proxy. System services, games, and mobile apps won't route through it automatically.
- **Requires upstream NAT64 gateway** — this project synthesizes DNS64 addresses but relies on your ISP's NAT64 infrastructure for the actual IPv6-to-IPv4 packet translation.
- **NAT64 prefix assumes /96** — currently supports the well-known `64:ff9b::/96` prefix format. Custom prefix lengths (/32, /40, /48, etc.) are not yet supported.

## Roadmap

We have an extensive roadmap planned for future releases, including DNS caching, SOCKS5 support, and Happy Eyeballs (RFC 8305). 

See [docs/ROADMAP.md](docs/ROADMAP.md) for the full breakdown of planned features and protocol expansions.

## Standards

- [RFC 6052](https://tools.ietf.org/html/rfc6052) — IPv6 Addressing of IPv4/IPv6 Translators
- [RFC 6146](https://tools.ietf.org/html/rfc6146) — Stateful NAT64
- [RFC 6147](https://tools.ietf.org/html/rfc6147) — DNS64

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
