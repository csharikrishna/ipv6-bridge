# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1] - 2026-09-13

A final-audit pass over 2.1.0's embeddable API, before its first npm publish,
found one critical bug and one contract violation. Neither shipped to npm.

### Fixed

- **A malformed TLS option crashed the host process.** `BridgeHttpsAgent` and
  `createConnector()` called `tls.connect()` in a way that let a synchronous
  throw (from an invalid `secureProtocol`, cipher list, or similar) escape as
  an uncaught exception rather than a request error — on the very first
  request, before any application-level error handler had a chance to run.
  Reproduced directly: a bad `secureProtocol` value took down the entire
  process with no `error` event and no rejected promise to catch. Both now
  route connection setup through a single guarded path that always reports
  failure through the callback.
- `createLookup()` silently ignored the documented `dns.lookup(hostname,
  family, callback)` integer-shorthand form, since `(4).family` is
  `undefined`. It now handles that form (and a `null` options argument), and
  errors with `EAI_ADDRFAMILY` rather than silently returning a different
  family when the requested one isn't available.

## [2.1.0] - 2026-09-13

### Added

- **Embedded API.** The bridge can now be used from inside an application, with
  no proxy and no system configuration. Previously the only way to use it was to
  run a proxy and point clients at it, which is impractical for a deployed
  service.
  - `createAgent()` and `createHttpsAgent()` — drop-in agents for `http`/`https`
    and any client that accepts one (axios, got, node-fetch). Connections try
    native IPv6, then NAT64 synthesis, then direct IPv4, with keep-alive pooling.
    TLS certificates are validated against the requested hostname rather than
    the synthesized address the connection travelled over.
  - `createAgents()` — both protocols at once.
  - `createLookup()` — a `dns.lookup`-compatible function for anything taking a
    `lookup` option, including `net.connect` and many database drivers.
  - `createConnector()` — an undici connector, so Node's global `fetch` can use
    the bridge. undici remains outside this package's dependencies.
  - `resolve()` — report which route would be taken, without connecting.
  - `getStats()` — the data behind `/status`, available to embedded users so a
    service can alert when translation stops happening.
- A test fixture certificate covering `localhost` and `127.0.0.1`, so TLS
  behaviour is verified locally without network access.

## [2.0.0] - 2026-09-13

A correctness, security and production-readiness release. An audit found that
the plain-HTTP proxy path never worked with real proxy clients, that the
listener was an open relay by default, and that failed translation was
indistinguishable from success. All of that is fixed here.

### Fixed

- **Plain HTTP proxying never worked.** Request targets were built by
  concatenating the `Host` header with `req.url`. Real proxy clients send
  absolute-form targets (RFC 7230 section 5.3.2), so every request produced a
  malformed URL and returned `500`. Absolute-form is now parsed directly, with
  origin-form accepted as a fallback.
- **Proxy credentials leaked to origin servers.** `Proxy-Authorization` and
  other hop-by-hop headers were forwarded verbatim. They are now stripped in
  both directions per RFC 7230 section 6.1, including headers named by the
  `Connection` header.
- **CONNECT to IPv6 literals was broken.** `[::1]:443` was split on every colon,
  yielding the hostname `[`, and the client hung with no response. Authority
  parsing now handles bracketed literals, bare literals and `host:port`.
- **Detection reported a false positive on dual-stack networks.** `needsBridge()`
  never checked whether IPv4 already worked, so the bridge activated on healthy
  networks where it could only cause harm. IPv4 reachability is now the first check.
- **DNS resolution failed on DoH-only and split-DNS hosts.** Resolution used
  `dns.resolve*`, which bypasses the system resolver, hosts file and
  DNS-over-HTTPS configuration. It now uses `dns.lookup`.
- **Failed translation was silent.** A DNS64 failure fell through to a direct
  IPv4 connection with no log, making a non-functioning bridge look like a
  working one. Fallbacks now log a warning and are counted separately.
- **`stop()` never resolved with an open CONNECT tunnel**, hanging any test
  suite that used the programmatic API. Live sockets are now torn down.
- **Concurrent `start()` calls leaked an uncloseable server.** The guard ran
  before an `await`, so both callers passed it. The second call now rejects.
- **Every DNS resolution leaked a 5-second timer**, keeping the event loop alive
  long after the work finished. The timeout is now cleared.
- **CONNECT failures closed the socket silently**; they now return `502` or `504`.
- Path traversal in the demo application allowed reading files outside its
  public directory, and its "bridge running" indicator reported the status of an
  unrelated website. Both are fixed, and the demo now binds to loopback.

### Added

- **Full RFC 6052 prefix support** — `/32`, `/40`, `/48`, `/56`, `/64` and `/96`,
  validated against the official section 2.4 test vectors, including the
  reserved `u` octet at bits 64–71.
- **NAT64 prefix discovery (RFC 7050)** — the bridge resolves `ipv4only.arpa` at
  startup to learn the prefix the network actually uses, instead of assuming the
  well-known one.
- **SOCKS5 listener (RFC 1928/1929)** — carries any TCP protocol, so ssh, git and
  database clients can use the same translation. Enable with `IPV6_BRIDGE_SOCKS_PORT`.
- **`ipv6-bridge doctor`** — diagnoses resolvers, connectivity, NAT64 availability,
  prefix mismatches and listener exposure, and explains what each result means.
- **Operational endpoints** — `/healthz`, `/status`, `/metrics` (Prometheus) and
  `/proxy.pac`. `/status` reports a `translationRate` so operators can confirm
  the bridge is actually translating.
- **Connection failover** — candidate addresses are tried in preference order
  (native IPv6, then NAT64, then direct IPv4) instead of giving up on the first.
- **DNS caching** with a bounded LRU and TTL expiry.
- **Keep-alive connection pooling** for upstream HTTP requests.
- **Authentication and access control** — `IPV6_BRIDGE_AUTH` for Basic
  credentials and `IPV6_BRIDGE_ALLOW` for a client CIDR allowlist, enforced on
  the HTTP, CONNECT and SOCKS5 paths.
- **Bypass rules** — `IPV6_BRIDGE_BYPASS` routes matching hosts directly.
- Continuous integration across Node 18/20/22 on Linux, Windows and macOS.

### Changed

- **The proxy now binds to `127.0.0.1` by default** instead of all interfaces.
  This is a breaking change: previously any host on the same network could relay
  traffic through it without authentication. Set `IPV6_BRIDGE_HOST` to expose it
  deliberately, and pair that with `IPV6_BRIDGE_AUTH` or `IPV6_BRIDGE_ALLOW`.
- Non-global IPv4 addresses are no longer synthesized with the well-known prefix
  (RFC 6052 section 3.1); they are reached directly over IPv4 instead. This makes
  targets such as `127.0.0.1` and `192.168.x.x` work through the proxy.
- Synthesized addresses are emitted in RFC 5952 canonical form, so
  `64:ff9b::0808:0808` is now written `64:ff9b::808:808`. The address is unchanged.
- Configuration is validated at startup; an invalid prefix, port or timeout fails
  immediately with an explanatory message.
- `start()` accepts an options object (`host`, `force`, `discoverPrefix`, `socksPort`).
- The logger gained a `silent` level, and `index.js` no longer writes directly to
  the console, so library consumers can suppress output.
- Detection endpoints are configurable via `IPV4_TEST_URL`, `IPV6_TEST_URL` and
  `NAT64_TEST_HOST`, and accept any 2xx/3xx response as reachable.
- `npm test` no longer relies on shell glob expansion, so it works on Windows.
- Tests run entirely against local servers and need no network access.

### Removed

- `.npmignore`, which was redundant with the `files` field in `package.json` and
  listed paths that no longer existed.

## [1.0.0] - 2026-01-31

### Added

- DNS64 resolver for IPv4-to-IPv6 address synthesis (RFC 6052)
- HTTP/HTTPS proxy with NAT64 routing (RFC 6146)
- Auto-detection of IPv6-only networks (`needsBridge()`)
- IP version detection (`detectIPVersion()`)
- Command-line interface (`npx ipv6-bridge start`)
- Programmatic API (`start()` / `stop()`)
- Environment variable configuration (`IPV6_BRIDGE_PORT`, `FORCE_BRIDGE`, `NAT64_PREFIX`)
- Interactive demo application with diagnostics
- Dual-stack test server for manual testing
- Comprehensive test suite
