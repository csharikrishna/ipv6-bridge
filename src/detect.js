/**
 * IPv6 Bridge - Network Detection
 *
 * Decides whether the bridge is needed. The bridge only helps a host that has
 * IPv6 but cannot reach IPv4-only servers, so detection has to establish both
 * facts before reporting that it is needed.
 *
 * @module detect
 */

const http = require('http');
const { resolveIPv6 } = require('./dns64');
const config = require('./config');
const log = require('./logger');

const {
  IPV6_TEST_URL,
  IPV4_TEST_URL,
  NAT64_TEST_HOST,
  DNS_TIMEOUT,
} = config;

/**
 * Probe a URL over a specific IP family.
 *
 * Any 2xx or 3xx response counts as reachable; requiring exactly 200 would
 * misreport a network as broken the moment the endpoint starts redirecting.
 *
 * @param {string} url - URL to request
 * @param {number} family - IP family (4 or 6)
 * @returns {Promise<boolean>} true if the endpoint responded
 */
function probe(url, family) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = http.get(url, { family }, (res) => {
      res.resume();
      finish(res.statusCode >= 200 && res.statusCode < 400);
    });

    req.on('error', () => finish(false));
    req.setTimeout(DNS_TIMEOUT, () => {
      req.destroy();
      finish(false);
    });
  });
}

/**
 * Test whether the network has working IPv6 connectivity.
 *
 * @returns {Promise<boolean>} true if IPv6 is available
 */
function hasIPv6() {
  return probe(IPV6_TEST_URL, 6);
}

/**
 * Test whether the network has working IPv4 connectivity.
 *
 * @returns {Promise<boolean>} true if IPv4 is available
 */
function hasIPv4() {
  return probe(IPV4_TEST_URL, 4);
}

/**
 * Test whether an upstream NAT64 gateway is already translating traffic.
 *
 * @returns {Promise<boolean>} true if NAT64 works without the bridge
 */
async function hasWorkingNAT64() {
  try {
    const addresses = await resolveIPv6(NAT64_TEST_HOST);
    if (!addresses || addresses.length === 0) return false;
    return await probe(`http://[${addresses[0]}]`, 6);
  } catch {
    return false;
  }
}

/**
 * Determine whether the bridge is needed.
 *
 * The bridge is needed only when IPv4 is unreachable, IPv6 works, and the
 * network provides no NAT64 gateway of its own.
 *
 * @returns {Promise<boolean>} true if the bridge is needed
 */
async function needsBridge() {
  if (await hasIPv4()) {
    log.debug('IPv4 connectivity works; bridge is not needed');
    return false;
  }

  if (!await hasIPv6()) {
    log.debug('Neither IPv4 nor IPv6 connectivity works; the bridge cannot help');
    return false;
  }

  if (await hasWorkingNAT64()) {
    log.debug('Upstream NAT64 gateway is already working; bridge is not needed');
    return false;
  }

  log.debug('IPv6-only network with no working NAT64; bridge is needed');
  return true;
}

module.exports = { hasIPv6, hasIPv4, hasWorkingNAT64, needsBridge };
