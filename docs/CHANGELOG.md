# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
