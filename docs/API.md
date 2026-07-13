# API Reference

Complete API documentation for IPv6 Bridge.

## Programmatic API

### `start(port?)`

Starts the IPv6 Bridge proxy server.

```javascript
const { start, stop } = require('ipv6-bridge');

const server = await start(8080);
```

**Parameters:**
- `port` (number, default: `8080`) — Port to listen on.

**Returns:** `Promise<http.Server | null>`
- Returns the HTTP server instance if the bridge started.
- Returns `null` if the bridge was not needed (dual-stack or working NAT64 detected).

**Throws:** `Error` if the bridge is already running or startup fails.

**Behavior:**
1. Runs network detection (`needsBridge()`).
2. If the bridge is not needed and `FORCE_BRIDGE` is not set, returns `null`.
3. Otherwise, creates and starts the proxy server.

---

### `stop()`

Stops the running bridge server. Safe to call if no server is running.

```javascript
stop();
```

---

## CLI

```bash
# Start on default port (8080)
npx ipv6-bridge start

# Custom port
IPV6_BRIDGE_PORT=9090 npx ipv6-bridge start

# Force start even if bridge is not needed
FORCE_BRIDGE=1 npx ipv6-bridge start

# Show help
npx ipv6-bridge --help
```

Stop the bridge with `Ctrl+C` or by sending `SIGTERM` to the process.

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `IPV6_BRIDGE_PORT` | `8080` | Port for the proxy server |
| `FORCE_BRIDGE` | (unset) | Set to any value to start the bridge even when detection says it's not needed |
| `NAT64_PREFIX` | `64:ff9b::` | Custom NAT64 prefix (RFC 6052). Only change if your ISP uses a non-standard prefix. |

### Source Configuration

Edit `src/config.js` to change compile-time defaults:

```javascript
module.exports = {
  NAT64_PREFIX: process.env.NAT64_PREFIX || '64:ff9b::',
  DEFAULT_PORT: 8080,
  IPV6_GOOGLE: 'http://ipv6.google.com',
  IPV4_GOOGLE: 'ipv4.google.com',
};
```

---

## Internal Modules

### `dns64.js`

#### `resolveIPv6(hostname)`

Resolves a hostname to IPv6 addresses using DNS64 (RFC 6052).

1. Tries native AAAA resolution first.
2. Falls back to A resolution and synthesizes IPv6 using the NAT64 prefix.

**Returns:** `Promise<string[]>` — Array of IPv6 addresses.

#### `ipv4ToIPv6(ipv4)`

Converts an IPv4 address to an IPv6 address using the NAT64 prefix.

```javascript
ipv4ToIPv6('192.0.2.1');
// → '64:ff9b::c000:0201'
```

#### `detectIPVersion(addr)`

Detects whether an address is IPv4, IPv6, or a hostname.

**Returns:** `'ipv4'` | `'ipv6'` | `'hostname'` | `null`

---

### `detect.js`

#### `hasIPv6()`

Tests if the system has IPv6 connectivity by connecting to `ipv6.google.com`.

**Returns:** `Promise<boolean>`

#### `needsBridge()`

Determines if the bridge is needed:
1. If no IPv6 → `false` (bridge can't help).
2. If IPv6 is available, tests ISP NAT64 by resolving an IPv4-only host via DNS64 and connecting.
3. If NAT64 works → `false`. If it fails → `true`.

**Returns:** `Promise<boolean>`

---

## Troubleshooting

### Bridge says "not needed" but I want to test it

Set `FORCE_BRIDGE=1` in your environment:

```bash
FORCE_BRIDGE=1 npx ipv6-bridge start
```

### DNS resolution fails

- Check that your DNS servers are reachable.
- The bridge uses your system's DNS resolver. If DNS is broken, the bridge can't resolve hostnames.
- Try resolving manually: `node -e "require('dns').resolve4('google.com', console.log)"`

### Connection timeouts

- The bridge uses a 5-second timeout for connections and DNS resolution.
- Check your network connectivity.
- If using a VPN, ensure it supports IPv6.

### Port already in use

- Change the port with `IPV6_BRIDGE_PORT=9090 npx ipv6-bridge start`.
- Check what's using the port: `lsof -i :8080` (macOS/Linux) or `netstat -ano | findstr 8080` (Windows).
