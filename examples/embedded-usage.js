/**
 * IPv6 Bridge — Embedded Usage Example
 *
 * Using the bridge from inside an application: no proxy, no ports, no system
 * configuration. Outbound connections gain DNS64 translation, address-family
 * failover and connection pooling.
 *
 * This is the way to use the package in a deployed service.
 *
 * Run:
 *   node examples/embedded-usage.js
 */

const https = require('https');
const net = require('net');
const {
  createHttpsAgent,
  createLookup,
  resolve,
  getStats,
} = require('../src/index');

// One agent for the lifetime of the process: it pools connections, so creating
// a new one per request would throw that away.
const agent = createHttpsAgent();

function get(url) {
  return new Promise((resolve, reject) => {
    const options = { agent, headers: { 'User-Agent': 'ipv6-bridge-example' } };
    const req = https.get(url, options, (res) => {
      const via = res.socket.remoteAddress;
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, via }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('request timed out'));
    });
  });
}

async function main() {
  console.log('1. Which route would be used for each destination?\n');
  for (const host of ['example.com', '8.8.8.8', '192.168.1.1']) {
    const candidates = await resolve(host);
    const preferred = candidates[0];
    console.log(`   ${host.padEnd(16)} ${preferred.host}  (${preferred.mode})`);
    if (candidates.length > 1) {
      console.log(`   ${''.padEnd(16)} fallbacks: ${candidates.slice(1).map((c) => c.mode).join(', ')}`);
    }
  }

  console.log('\n2. Making real requests through the agent\n');
  for (const url of ['https://example.com/', 'https://api.github.com/']) {
    try {
      const { status, via } = await get(url);
      console.log(`   ${url.padEnd(28)} ${status}  via ${via}`);
    } catch (err) {
      console.log(`   ${url.padEnd(28)} failed: ${err.message}`);
    }
  }

  console.log('\n3. Using the lookup function with a raw socket\n');
  await new Promise((resolve) => {
    const socket = net.connect({ host: 'example.com', port: 443, lookup: createLookup() }, () => {
      console.log(`   connected to example.com:443 via ${socket.remoteAddress}`);
      socket.destroy();
      resolve();
    });
    socket.on('error', (err) => {
      console.log(`   connection failed: ${err.message}`);
      resolve();
    });
  });

  console.log('\n4. Did translation actually happen?\n');
  const stats = getStats();
  console.log(`   NAT64 prefix        ${stats.nat64Prefix}`);
  console.log(`   translated          ${stats.routes.nat64}`);
  console.log(`   native IPv6         ${stats.routes.nativeIpv6}`);
  console.log(`   untranslated        ${stats.routes.directIpv4 + stats.routes.directIpv4Fallback}`);
  console.log(`   translation rate    ${stats.translationRate ?? 'n/a'}`);
  console.log(`   DNS cache hit rate  ${stats.dnsCache.hitRate}`);

  if (stats.routes.directIpv4Fallback > 0 && stats.routes.nat64 === 0) {
    console.log('\n   WARNING: connections fell back to untranslated IPv4.');
    console.log('   On an IPv6-only network this means DNS64 is failing.');
    console.log('   Run "ipv6-bridge doctor" to find out why.');
  }

  // Release pooled sockets so the process can exit.
  agent.destroy();
}

main().catch((err) => {
  console.error('Error:', err.message);
  agent.destroy();
  process.exit(1);
});
