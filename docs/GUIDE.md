# IPv6 Bridge — User Guide

A practical guide: what this tool is for, when you need it, when you don't, and
how to use it in real situations.

If you only read one thing: run `npx ipv6-bridge doctor`. It tells you whether
you need this tool and what is wrong with your network if you do.

---

## Contents

1. [The problem this solves](#1-the-problem-this-solves)
2. [Do you need this?](#2-do-you-need-this)
3. [Install and first run](#3-install-and-first-run)
4. [Connecting your applications](#4-connecting-your-applications)
5. [Real-world scenarios](#5-real-world-scenarios)
6. [Checking that it actually works](#6-checking-that-it-actually-works)
7. [Using it from Node.js](#7-using-it-from-nodejs)
8. [Configuration recipes](#8-configuration-recipes)
9. [Troubleshooting](#9-troubleshooting)
10. [When *not* to use this](#10-when-not-to-use-this)
11. [Glossary](#11-glossary)

---

## 1. The problem this solves

The internet ran out of IPv4 addresses. The replacement, IPv6, has been rolling
out for years — mobile carriers, cloud providers and some ISPs now hand out
IPv6-only connections.

The catch: a large share of the internet still has no IPv6 address at all. If
your network gives you only IPv6, those sites are simply unreachable. Your
browser resolves `example.com`, gets back an IPv4 address like `93.184.216.34`,
and has no way to send a packet to it.

The standard fix is a pair of technologies:

- **DNS64** invents an IPv6 address that contains the IPv4 address inside it.
  `93.184.216.34` becomes `64:ff9b::5db8:d822`.
- **NAT64** is a gateway on your network that recognises those addresses,
  unpacks the IPv4 address, and forwards the traffic.

**IPv6 Bridge does the DNS64 half, on your machine, in user space.** It runs a
local proxy that synthesizes those addresses and routes your traffic to them, so
your NAT64 gateway can do the rest.

### What it is not

It does **not** replace a NAT64 gateway. If your network operator does not run
one, no user-space tool can invent IPv4 connectivity out of nothing. `doctor`
tells you whether a gateway exists.

---

## 2. Do you need this?

Run this first:

```bash
npx ipv6-bridge doctor
```

Use this table to interpret the result:

| Your situation | Do you need IPv6 Bridge? |
|---|---|
| Normal home/office internet (IPv4 works) | **No.** Everything already works. |
| IPv6-only network, and your DNS already does DNS64 | **Probably not.** Your OS is already being handed synthesized addresses. |
| IPv6-only network, DNS does *not* do DNS64, but a NAT64 gateway exists | **Yes.** This is exactly the gap it fills. |
| IPv6-only network with no NAT64 gateway at all | **No** — nothing can help. Ask your operator. |
| You want to test how your app behaves on IPv6-only | **Yes**, with `FORCE_BRIDGE=1`. |

`ipv6-bridge start` applies this logic itself and exits quietly if it isn't
needed, so it is safe to run anywhere.

### How to tell you're on an IPv6-only network

Common signs:

- Some websites load and others time out, with no obvious pattern
- `ping6 google.com` works but `ping 93.184.216.34` does not
- Your IP settings show an address starting with `2` or `3` (e.g. `2406:...`)
  and no IPv4 address other than a private `192.168.x.x` one
- Mobile tethering from certain carriers (T-Mobile US, Jio, and others operate
  IPv6-only mobile cores)

---

## 3. Install and first run

You need Node.js 18 or newer.

### Run it without installing

```bash
npx ipv6-bridge start
```

### Install globally

```bash
npm install -g ipv6-bridge
ipv6-bridge start
```

### Add it to a project

```bash
npm install ipv6-bridge
```

### What you'll see

```
$ ipv6-bridge start

IPv6 Bridge running on http://127.0.0.1:8080
Configure your browser/system proxy to 127.0.0.1:8080
NAT64 prefix: 64:ff9b::/96
Status: http://127.0.0.1:8080/status
PAC:    http://127.0.0.1:8080/proxy.pac
```

If instead it prints *"IPv6 bridge not needed"* and exits, that is the tool
working correctly — your network doesn't need it. To run it anyway (to test, or
to demo it):

```bash
FORCE_BRIDGE=1 ipv6-bridge start
```

Stop it with `Ctrl+C`.

---

## 4. Connecting your applications

The bridge is a proxy. **Nothing routes through it automatically** — you have to
point applications at it. This is the single most common source of confusion.

### curl

```bash
curl -x http://127.0.0.1:8080 https://example.com
```

### Browsers — automatic (recommended)

Point your browser's "Automatic proxy configuration URL" at:

```
http://127.0.0.1:8080/proxy.pac
```

This routes external traffic through the bridge while leaving `localhost` and
your bypass list alone.

- **Firefox** — Settings → Network Settings → Automatic proxy configuration URL
- **Chrome/Edge** — uses the system proxy settings (below)
- **macOS** — System Settings → Network → Details → Proxies → Automatic Proxy Configuration
- **Windows** — Settings → Network & Internet → Proxy → Use setup script

### Browsers — manual

Set the HTTP and HTTPS proxy to `127.0.0.1` port `8080`.

### Node.js applications

```bash
export HTTP_PROXY=http://127.0.0.1:8080
export HTTPS_PROXY=http://127.0.0.1:8080
export NO_PROXY=localhost,127.0.0.1
```

Note that Node's built-in `fetch`/`http` do **not** read these variables
automatically; most HTTP client libraries (axios, got, node-fetch with an agent)
do. `npm` reads them.

### npm, pip, apt and other package managers

```bash
npm config set proxy http://127.0.0.1:8080
npm config set https-proxy http://127.0.0.1:8080

pip install --proxy http://127.0.0.1:8080 requests

# apt: /etc/apt/apt.conf.d/95proxy
Acquire::http::Proxy "http://127.0.0.1:8080";
```

### Docker

```bash
docker run \
  -e HTTP_PROXY=http://host.docker.internal:8080 \
  -e HTTPS_PROXY=http://host.docker.internal:8080 \
  myimage
```

Start the bridge with `IPV6_BRIDGE_HOST=0.0.0.0` so containers can reach it, and
add `IPV6_BRIDGE_ALLOW` to limit who can.

### ssh, git, databases — use SOCKS5

An HTTP proxy can only carry HTTP. For anything else, enable SOCKS5:

```bash
IPV6_BRIDGE_SOCKS_PORT=1080 ipv6-bridge start
```

Then:

```bash
# git over HTTPS
git config --global http.proxy socks5h://127.0.0.1:1080

# ssh
ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:1080 %h %p' user@host

# psql, redis-cli and others via a SOCKS-aware wrapper
```

The `h` in `socks5h` matters: it makes the client send the *hostname* to the
proxy rather than resolving it locally, so the bridge performs DNS64 resolution.

---

## 5. Real-world scenarios

### Scenario A — Developer on an IPv6-only mobile hotspot

*You are tethered to a carrier that assigns IPv6-only. `npm install` hangs and
half of GitHub is unreachable.*

```bash
npx ipv6-bridge doctor      # confirm: IPv4 unreachable, IPv6 works, NAT64 present
npx ipv6-bridge start

npm config set proxy http://127.0.0.1:8080
npm config set https-proxy http://127.0.0.1:8080
```

Undo when you're back on a normal network:

```bash
npm config delete proxy && npm config delete https-proxy
```

### Scenario B — CI pipeline that must test IPv6-only behaviour

*You want to catch IPv6 bugs before your users do.*

```javascript
// jest.globalSetup.js
const { start } = require('ipv6-bridge');

module.exports = async () => {
  global.__BRIDGE__ = await start(8080, { force: true });
  process.env.HTTP_PROXY = 'http://127.0.0.1:8080';
};
```

```javascript
// jest.globalTeardown.js
const { stop } = require('ipv6-bridge');
module.exports = async () => { await stop(); };
```

`stop()` tears down open tunnels, so the suite always exits cleanly.

### Scenario C — Small team behind one IPv6-only uplink

*Several machines on a LAN need IPv4 access through a single bridge host.*

```bash
IPV6_BRIDGE_HOST=0.0.0.0 \
IPV6_BRIDGE_AUTH=team:choose-a-real-secret \
IPV6_BRIDGE_ALLOW=192.168.1.0/24 \
IPV6_BRIDGE_SOCKS_PORT=1080 \
  ipv6-bridge start
```

Give colleagues the PAC URL `http://<bridge-host>:8080/proxy.pac`.

**Never** expose it without `IPV6_BRIDGE_AUTH` or `IPV6_BRIDGE_ALLOW` — an open
proxy will be found and abused, and the traffic will be attributed to you.

### Scenario D — Corporate network with internal services

*Internal hosts must be reached directly; everything else goes through NAT64.*

```bash
IPV6_BRIDGE_BYPASS='*.internal.company.com,10.0.0.0/8,192.168.0.0/16' \
  ipv6-bridge start
```

Bypassed hosts are connected to directly and counted separately in `/status`.

### Scenario E — Operator-assigned NAT64 prefix

*Your ISP uses its own prefix instead of the well-known `64:ff9b::/96`.*

Usually you don't need to do anything: the bridge discovers the prefix via
RFC 7050 at startup. `doctor` shows what it found. To pin it explicitly:

```bash
NAT64_PREFIX=2001:db8:122:344::/64 ipv6-bridge start
```

All RFC 6052 prefix lengths are supported: `/32`, `/40`, `/48`, `/56`, `/64`, `/96`.

### Scenario F — Monitoring it in production

```bash
curl http://127.0.0.1:8080/healthz     # liveness probe
curl http://127.0.0.1:8080/metrics     # Prometheus scrape target
```

Alert on `ipv6_bridge_translation_rate` dropping to `0` while
`ipv6_bridge_route_total{mode="direct_ipv4_fallback"}` climbs — that means
translation is failing and traffic is going out untranslated.

---

## 6. Checking that it actually works

This is the question most proxies can't answer. Run:

```bash
ipv6-bridge status
```

```
IPv6 Bridge on 127.0.0.1:8080
  Uptime          143s
  NAT64 prefix    64:ff9b::/96

  HTTP requests   27
  CONNECT tunnels 4
  SOCKS5 sessions 0
  Errors          0 (0 timeouts)

  Routing
    via NAT64          24
    native IPv6        7
    direct IPv4        0
    untranslated fallback 0

  DNS cache       12 entries, hit rate 0.71

  Translating 100% of routed connections.
```

What the routing modes mean:

| Mode | Meaning |
|---|---|
| `via NAT64` | The bridge synthesized an IPv6 address and used it. **This is the bridge doing its job.** |
| `native IPv6` | The site already had an IPv6 address; no translation needed. |
| `direct IPv4` | A private/loopback target, connected to directly. Expected and correct. |
| `untranslated fallback` | DNS64 failed and traffic went out untranslated. **If this is climbing, something is wrong.** |

If you see the warning *"nothing has been translated through NAT64"*, the bridge
is passing your traffic through without doing anything. Run `doctor`.

---

## 7. Using it from Node.js

```javascript
const { start, stop } = require('ipv6-bridge');

// Returns the server, or null if the bridge isn't needed on this network
const server = await start(8080);

if (server) {
  console.log(`Listening on port ${server.address().port}`);
}

await stop();
```

With options:

```javascript
const server = await start(8080, {
  host: '127.0.0.1',      // interface to bind (default: loopback)
  force: true,            // start even if detection says it isn't needed
  discoverPrefix: true,   // RFC 7050 prefix discovery (default: true)
  socksPort: 1080,        // also serve SOCKS5
});
```

Notes:

- `start()` returns `null` rather than throwing when the bridge isn't needed —
  check for it.
- Calling `start()` twice rejects with "already running".
- `stop()` always resolves, even with open CONNECT tunnels, so it is safe in
  test teardown.
- Environment variables are read when the module first loads, so set them before
  `require('ipv6-bridge')`.

See [API.md](API.md) for the complete reference.

---

## 8. Configuration recipes

Every setting is an environment variable. The full list is in
`ipv6-bridge --help` and [API.md](API.md).

```bash
# Run on a different port
IPV6_BRIDGE_PORT=9090 ipv6-bridge start

# Debug what it is deciding, request by request
LOG_LEVEL=debug ipv6-bridge start

# Silence it entirely (library use)
LOG_LEVEL=silent ipv6-bridge start

# Slow/lossy network: allow longer per-address attempts
IPV6_CONNECT_ATTEMPT_TIMEOUT=8000 IPV6_CONN_TIMEOUT=30000 ipv6-bridge start

# Busy proxy: cache DNS longer and pool more sockets
IPV6_DNS_CACHE_TTL=120000 IPV6_MAX_SOCKETS_PER_HOST=256 ipv6-bridge start

# Restricted network where the default probes are blocked
IPV4_TEST_URL=http://example.com IPV6_TEST_URL=http://ipv6.example.com ipv6-bridge start

# Turn off the control endpoints
IPV6_BRIDGE_CONTROL=off ipv6-bridge start
```

Invalid values are rejected at startup with an explanation rather than failing
mysteriously later:

```
$ NAT64_PREFIX=garbage ipv6-bridge start
Configuration error: Invalid NAT64_PREFIX: Invalid NAT64 prefix "garbage": not a valid IPv6 address
```

---

## 9. Troubleshooting

**Start here:** `ipv6-bridge doctor`.

### "IPv6 bridge not needed" and it exits

Working as intended — IPv4 already works on this network. Use `FORCE_BRIDGE=1`
to run it anyway.

### Everything returns 502 Bad Gateway

The bridge reached your target and failed. Usually one of:

- No NAT64 gateway on this network (`doctor` says so)
- Wrong NAT64 prefix (`doctor` reports what the network advertises)
- The destination is genuinely down

### Requests work but `status` shows nothing translated

Your traffic is bypassing the bridge's purpose — it is connecting directly. On a
dual-stack network with `FORCE_BRIDGE=1`, this is expected. On an IPv6-only
network it means DNS64 is failing; run `doctor`.

### It's slow, a few seconds per request

Each candidate address gets `IPV6_CONNECT_ATTEMPT_TIMEOUT` (3s) before the next
is tried. If the NAT64 route is unreachable, every new connection waits for that
timeout before falling back. Either fix the NAT64 route or stop forcing the
bridge on a network that doesn't need it.

### `dns.resolve` errors in doctor, but everything works

Normal on machines using DNS-over-HTTPS. The bridge uses the system resolver,
which works. `doctor` labels this as informational.

### My browser isn't using the proxy

Check that you configured it — nothing routes automatically. Verify with:

```bash
curl -x http://127.0.0.1:8080 http://example.com
ipv6-bridge status   # the counter should have gone up
```

### Port already in use

```bash
IPV6_BRIDGE_PORT=9090 ipv6-bridge start
```

To find the culprit: `lsof -i :8080` (macOS/Linux) or
`netstat -ano | findstr 8080` (Windows).

---

## 10. When *not* to use this

Be honest about the boundaries:

- **You have working IPv4.** You gain nothing and add a hop. The tool refuses to
  start for exactly this reason.
- **Your network has no NAT64 gateway.** Nothing in user space can fix that.
- **You need transparent, system-wide interception.** This is a proxy;
  applications must be pointed at it. For whole-system translation you want
  something kernel-level such as Jool or Tayga, or `clatd` for 464XLAT.
- **You need UDP.** SOCKS5 `UDP ASSOCIATE` is not implemented, so QUIC and plain
  DNS won't go through it.
- **You're deploying it as a public internet proxy.** It has no rate limiting or
  abuse controls. An open proxy will be found and abused within hours.

---

## 11. Glossary

**IPv4** — the original internet addressing scheme (`93.184.216.34`). Exhausted.

**IPv6** — its replacement (`2606:2800:220:1:248:1893:25c8:1946`). Vastly larger.

**Dual-stack** — a network with both. What most people have; nothing to fix.

**IPv6-only** — a network with no IPv4 at all, where IPv4-only sites are
unreachable without translation.

**NAT64** — a gateway that translates IPv6 packets to IPv4 and back. Run by your
network operator; this tool cannot replace it.

**DNS64** — inventing an IPv6 address that encodes an IPv4 address inside it, so
traffic can be routed to a NAT64 gateway. This is what IPv6 Bridge does.

**NAT64 prefix** — the IPv6 range used for those synthesized addresses. The
well-known one is `64:ff9b::/96`; operators often assign their own.

**Forward proxy** — a server your applications send requests *through*. That is
what IPv6 Bridge is, which is why applications must be configured to use it.

**PAC file** — a small script that tells a browser which proxy to use for which
destination. Served at `/proxy.pac`.

**SOCKS5** — a protocol-agnostic proxy standard. Carries any TCP connection,
which is why it works for ssh and git where an HTTP proxy cannot.

---

## Further reading

- [README.md](../README.md) — overview and quick start
- [API.md](API.md) — programmatic API and every configuration value
- [ARCHITECTURE.md](ARCHITECTURE.md) — how it works internally, and why
- [ROADMAP.md](ROADMAP.md) — what's shipped and what's planned
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to work on it
