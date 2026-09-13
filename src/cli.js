#!/usr/bin/env node

/**
 * IPv6 Bridge - Command-Line Interface
 *
 * Commands:
 *   start     Start the bridge (auto-detects whether it is needed)
 *   doctor    Diagnose IPv6, DNS64 and NAT64 on this network
 *   status    Report what a running bridge is doing
 *
 * @file CLI entry point for IPv6 Bridge
 */

const http = require('http');
const { version } = require('../package.json');

let config;
let bridge;
try {
  config = require('./config');
  bridge = require('./index');
} catch (err) {
  // Configuration is validated at load time so misconfiguration fails here
  // rather than as unexplainable connection errors later.
  console.error(`Configuration error: ${err.message}`);
  console.error('\nRun "ipv6-bridge --help" to see the accepted values.');
  process.exit(1);
}

const { start, stop } = bridge;

const SHORT_HELP = `
IPv6 Bridge v${version}
Access IPv4-only sites from an IPv6-only network.

Usage: ipv6-bridge <command>

Commands:
  start     Start the proxy (auto-detects whether it is needed)
  doctor    Diagnose IPv6, DNS64 and NAT64 on this network
  status    Show what a running bridge is doing

Run "ipv6-bridge --help" for all options and examples.
`.trim();

const FULL_HELP = `
IPv6 Bridge v${version}
Access IPv4-only sites from an IPv6-only network, without kernel modules or
admin rights. Runs a local DNS64/NAT64-aware proxy in user space.

USAGE
  ipv6-bridge <command>

COMMANDS
  start                Start the proxy. Exits immediately if the bridge is not
                       needed (IPv4 already works, or NAT64 already works).
  doctor               Check resolvers, IPv4/IPv6 reachability, NAT64 gateway
                       availability, prefix configuration and listener exposure.
                       Exits non-zero if any check fails.
  status               Query a running bridge and report whether traffic is
                       actually being translated.
  --help, -h           Show this message
  --version, -v        Show the version number

GETTING STARTED
  ipv6-bridge doctor                     Find out whether you need the bridge
  ipv6-bridge start                      Start it
  ipv6-bridge status                     Confirm it is translating traffic

EXAMPLES
  # Start on a different port
  IPV6_BRIDGE_PORT=9090 ipv6-bridge start

  # Try it on a normal dual-stack network (detection would otherwise skip it)
  FORCE_BRIDGE=1 ipv6-bridge start

  # Also serve SOCKS5, so ssh / git / database clients can use it
  IPV6_BRIDGE_SOCKS_PORT=1080 ipv6-bridge start

  # Share it with a trusted LAN, with credentials required
  IPV6_BRIDGE_HOST=0.0.0.0 IPV6_BRIDGE_AUTH=user:secret \\
  IPV6_BRIDGE_ALLOW=192.168.1.0/24 ipv6-bridge start

  # Reach internal hosts directly instead of through NAT64
  IPV6_BRIDGE_BYPASS='*.internal.company.com,10.0.0.0/8' ipv6-bridge start

  # Use a prefix your operator assigned instead of the well-known one
  NAT64_PREFIX=2001:db8:122:344::/64 ipv6-bridge start

CONNECTING CLIENTS
  Browser / system proxy   127.0.0.1:${config.DEFAULT_PORT}
  Automatic (PAC) config   http://127.0.0.1:${config.DEFAULT_PORT}/proxy.pac
  curl                     curl -x http://127.0.0.1:${config.DEFAULT_PORT} https://example.com
  git over SOCKS5          git config --global http.proxy socks5h://127.0.0.1:1080
  ssh over SOCKS5          ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:1080 %h %p' host

ENDPOINTS (while running)
  /healthz        Liveness probe; reachable even when auth is enabled
  /status         JSON: counters, routing modes, DNS cache, active prefix
  /metrics        The same data in Prometheus format
  /proxy.pac      Proxy auto-configuration file for browsers

CONFIGURATION — network
  IPV6_BRIDGE_PORT              Proxy listen port (default: 8080)
  IPV6_BRIDGE_HOST              Interface to bind (default: 127.0.0.1)
  IPV6_BRIDGE_SOCKS_PORT        Serve SOCKS5 on this port (default: off)
  NAT64_PREFIX                  NAT64 prefix with optional /length
                                (default: 64:ff9b::/96; RFC 6052 allows
                                /32, /40, /48, /56, /64, /96)
  IPV6_BRIDGE_DISCOVER_PREFIX   Discover the prefix via RFC 7050 (default: on)

CONFIGURATION — access control
  IPV6_BRIDGE_AUTH              Require "user:password" from clients
  IPV6_BRIDGE_ALLOW             Client allowlist, e.g. "192.168.1.0/24"
  IPV6_BRIDGE_BYPASS            Hosts to reach directly, e.g. "*.internal.com"

CONFIGURATION — behaviour
  FORCE_BRIDGE                  Start even when detection says it is not needed
  IPV6_BRIDGE_CONTROL           Serve the endpoints above (default: on)
  LOG_LEVEL                     silent, error, warn, info, debug (default: info)

CONFIGURATION — tuning
  IPV6_DNS_TIMEOUT              DNS timeout in ms (default: 5000)
  IPV6_DNS_CACHE_TTL            DNS cache lifetime in ms (default: 30000)
  IPV6_DNS_CACHE_MAX            Maximum cached entries (default: 1000)
  IPV6_CONN_TIMEOUT             Connection timeout in ms (default: 10000)
  IPV6_CONNECT_ATTEMPT_TIMEOUT  Per-address timeout before trying the next
                                candidate, in ms (default: 3000)
  IPV6_KEEP_ALIVE_MS            Idle lifetime of pooled sockets (default: 15000)
  IPV6_MAX_SOCKETS_PER_HOST     Pooled sockets per host (default: 64)

CONFIGURATION — detection endpoints
  IPV4_TEST_URL                 Used to detect working IPv4
  IPV6_TEST_URL                 Used to detect working IPv6
  NAT64_TEST_HOST               IPv4-only host used to probe for NAT64

SECURITY
  The proxy binds to loopback and requires no credentials by default. If you
  set IPV6_BRIDGE_HOST to a routable address, also set IPV6_BRIDGE_AUTH or
  IPV6_BRIDGE_ALLOW — otherwise anyone who can reach this machine can relay
  traffic through it under your IP address.

DOCUMENTATION
  Guide         docs/GUIDE.md      (when to use it, worked examples)
  API           docs/API.md        (programmatic API, every setting)
  Architecture  docs/ARCHITECTURE.md

Stop the bridge with Ctrl+C or by sending SIGTERM.
`.trim();

/** Fetch JSON over HTTP with a short timeout. */
function fetchJson(options) {
  return new Promise((resolve, reject) => {
    const req = http.get(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error(`unexpected response from ${options.path}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('request timed out'));
    });
  });
}

async function runStatus() {
  const host = config.isLoopbackBind() ? '127.0.0.1' : config.BIND_HOST;
  const port = config.DEFAULT_PORT;

  let status;
  try {
    status = await fetchJson({ host, port, path: '/status' });
  } catch (err) {
    console.error(`No bridge is responding on ${host}:${port} (${err.message}).`);
    console.error('\nStart one with "ipv6-bridge start", or set IPV6_BRIDGE_PORT');
    console.error('if it is running on another port.');
    process.exit(1);
  }

  const { counters, routes, dnsCache } = status;
  const translated = routes.nat64;
  const untranslated = routes.directIpv4 + routes.directIpv4Fallback;

  console.log(`\nIPv6 Bridge on ${host}:${port}`);
  console.log(`  Uptime          ${status.uptimeSeconds}s`);
  console.log(`  NAT64 prefix    ${status.nat64Prefix}`);
  console.log('');
  console.log(`  HTTP requests   ${counters.httpRequests}`);
  console.log(`  CONNECT tunnels ${counters.connectRequests}`);
  console.log(`  SOCKS5 sessions ${counters.socksRequests}`);
  console.log(`  Errors          ${counters.proxyErrors} (${counters.timeouts} timeouts)`);
  console.log('');
  console.log('  Routing');
  console.log(`    via NAT64          ${routes.nat64}`);
  console.log(`    native IPv6        ${routes.nativeIpv6}`);
  console.log(`    direct IPv4        ${routes.directIpv4}`);
  console.log(`    untranslated fallback ${routes.directIpv4Fallback}`);
  console.log('');
  console.log(`  DNS cache       ${dnsCache.size} entries, hit rate ${dnsCache.hitRate}`);
  console.log('');

  const routed = Object.values(routes).reduce((sum, count) => sum + count, 0);

  if (routed === 0) {
    console.log('  No traffic yet. Send a request through the proxy, then check again.');
  } else if (translated > 0) {
    console.log(`  Translating ${Math.round(status.translationRate * 100)}% of connections`);
    console.log('  that needed it. The bridge is doing its job.');
  } else if (routes.directIpv4Fallback > 0) {
    console.log('  WARNING: connections fell back to untranslated IPv4.');
    console.log('  DNS64 is failing, so the bridge is not translating anything.');
    console.log('  Run "ipv6-bridge doctor" to find out why.');
  } else if (untranslated > 0) {
    console.log('  Nothing needed translating: these destinations were private or');
    console.log('  loopback addresses, which are always reached directly.');
  } else {
    console.log('  Nothing needed translating: every destination already had an');
    console.log('  IPv6 address, so no NAT64 synthesis was required.');
  }
  console.log('');
}

const command = process.argv[2];

if (!command) {
  console.log(SHORT_HELP);
  process.exit(0);
}

if (command === '--help' || command === '-h' || command === 'help') {
  console.log(FULL_HELP);
  process.exit(0);
}

if (command === '--version' || command === '-v' || command === 'version') {
  console.log(version);
  process.exit(0);
}

if (command === 'doctor') {
  const { diagnose, format } = require('./doctor');
  diagnose()
    .then((report) => {
      console.log(format(report));
      process.exit(report.summary.fail > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error(`Diagnostics failed: ${err.message}`);
      process.exit(1);
    });
} else if (command === 'status') {
  runStatus().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  });
} else if (command === 'start') {
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nStopping IPv6 Bridge...');
    stop()
      .then(() => process.exit(exitCode))
      .catch(() => process.exit(1));
  };

  start(config.DEFAULT_PORT)
    .then((server) => {
      if (!server) {
        console.log('Run "ipv6-bridge doctor" for details, or set FORCE_BRIDGE=1 to start anyway.');
        process.exit(0);
      }
      const { port } = server.address();
      const prefix = config.getPrefix();

      console.log(`\nIPv6 Bridge running on http://${config.BIND_HOST}:${port}`);
      console.log(`Configure your browser/system proxy to ${config.BIND_HOST}:${port}`);
      console.log(`NAT64 prefix: ${prefix.prefix}/${prefix.length}`);
      if (config.SOCKS_PORT) {
        console.log(`SOCKS5 running on ${config.BIND_HOST}:${config.SOCKS_PORT}`);
      }
      if (config.CONTROL_ENDPOINTS) {
        console.log(`Status: http://${config.BIND_HOST}:${port}/status`);
        console.log(`PAC:    http://${config.BIND_HOST}:${port}/proxy.pac`);
      }
      console.log('');
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
    shutdown(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    shutdown(1);
  });
} else {
  console.error(`Unknown command: "${command}"\n`);
  console.log(SHORT_HELP);
  process.exit(1);
}
