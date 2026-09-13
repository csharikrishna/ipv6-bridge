/**
 * IPv6 Bridge — Production Usage Example
 *
 * Shows the pieces that matter when the bridge is more than a local
 * convenience: access control, SOCKS5 for non-HTTP traffic, prefix discovery,
 * health monitoring and a clean shutdown.
 *
 * Run:
 *   FORCE_BRIDGE=1 node examples/production-usage.js
 */

const http = require('http');
const { start, stop } = require('../src/index');

const PROXY_PORT = Number(process.env.IPV6_BRIDGE_PORT) || 8080;
const SOCKS_PORT = Number(process.env.IPV6_BRIDGE_SOCKS_PORT) || 1080;

// Access control must be configured before the bridge is required, because
// configuration is read and validated at load time.
if (!process.env.IPV6_BRIDGE_HOST) {
  // Loopback is the default; set IPV6_BRIDGE_HOST to expose the proxy, and
  // always pair that with IPV6_BRIDGE_AUTH or IPV6_BRIDGE_ALLOW.
  process.env.IPV6_BRIDGE_HOST = '127.0.0.1';
}

/** Poll /status and report whether translation is actually happening. */
function fetchStatus(port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => {
      req.destroy();
      reject(new Error('status request timed out'));
    });
  });
}

async function main() {
  const server = await start(PROXY_PORT, {
    // Run RFC 7050 discovery so the network's real NAT64 prefix is used.
    discoverPrefix: true,
    // Serve SOCKS5 as well, for ssh/git/database clients.
    socksPort: SOCKS_PORT,
  });

  if (!server) {
    console.log('Bridge not needed on this network.');
    return;
  }

  const { port } = server.address();
  console.log(`Proxy:  http://127.0.0.1:${port}`);
  console.log(`SOCKS5: 127.0.0.1:${SOCKS_PORT}`);
  console.log(`Health: http://127.0.0.1:${port}/healthz`);
  console.log(`Metrics: http://127.0.0.1:${port}/metrics\n`);

  // Periodically check that the bridge is doing what it claims. A translation
  // rate of zero alongside rising fallbacks means DNS64 is failing.
  const monitor = setInterval(async () => {
    try {
      const status = await fetchStatus(port);
      const { nat64, directIpv4Fallback } = status.routes;

      if (directIpv4Fallback > 0 && nat64 === 0) {
        console.warn(
          `[warn] ${directIpv4Fallback} connection(s) fell back to untranslated IPv4 ` +
          `and none were translated. Run "ipv6-bridge doctor" to find out why.`
        );
      } else {
        console.log(
          `[ok] translated=${nat64} fallback=${directIpv4Fallback} ` +
          `rate=${status.translationRate ?? 'n/a'} ` +
          `cache=${status.dnsCache.hitRate}`
        );
      }
    } catch (err) {
      console.error(`[error] status check failed: ${err.message}`);
    }
  }, 15000);

  const shutdown = async (signal) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    clearInterval(monitor);
    await stop();
    console.log('Stopped cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('Failed to start:', error.message);
  process.exit(1);
});
