/**
 * IPv6 Bridge - Network Detection
 *
 * Detects whether the system is on an IPv6-only network and whether
 * the bridge is needed to reach IPv4-only servers.
 *
 * @module detect
 */

const http = require('http');
const { resolveIPv6 } = require('./dns64');
const { IPV6_GOOGLE, IPV4_GOOGLE, DNS_TIMEOUT } = require('./config');

/**
 * Test if the network has IPv6 connectivity.
 *
 * Connects to an IPv6-capable server to verify that IPv6 is available.
 *
 * @returns {Promise<boolean>} true if IPv6 is available
 */
async function hasIPv6() {
  return new Promise((resolve) => {
    const req = http.get(IPV6_GOOGLE, { family: 6 }, (res) => {
      // Consume response body to free resources
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(DNS_TIMEOUT, () => {
      req.destroy();
      resolve(false);
    });
  });
}

/**
 * Determine if the bridge is needed.
 *
 * The bridge is needed when:
 * 1. IPv6 is available, AND
 * 2. IPv4 servers are NOT reachable via the ISP's NAT64 gateway
 *
 * @returns {Promise<boolean>} true if bridge is needed
 */
async function needsBridge() {
  const hasV6 = await hasIPv6();
  if (!hasV6) {
    // No IPv6 means we're on IPv4 or a broken network.
    // Either way, the bridge can't help.
    return false;
  }

  try {
    const ipv6 = await resolveIPv6(IPV4_GOOGLE);
    if (!ipv6 || ipv6.length === 0) {
      return true;
    }

    // Try connecting to the synthesized IPv6 address.
    // If this works, the ISP has a working NAT64 gateway.
    return new Promise((resolve) => {
      const req = http.get(`http://[${ipv6[0]}]`, { family: 6 }, (res) => {
        res.resume();
        resolve(res.statusCode !== 200);
      });
      req.on('error', () => resolve(true));
      req.setTimeout(DNS_TIMEOUT, () => {
        req.destroy();
        resolve(true);
      });
    });
  } catch {
    return true;
  }
}

module.exports = { hasIPv6, needsBridge };
