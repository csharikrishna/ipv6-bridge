/**
 * IPv6 Bridge - DNS64 Resolver
 *
 * Implements DNS64 (RFC 6147) using the IPv4-embedded IPv6 address format
 * defined by RFC 6052.
 *
 * Name resolution goes through dns.lookup (the operating system resolver)
 * rather than dns.resolve*. dns.resolve* speaks directly to DNS servers over
 * port 53 and ignores the hosts file, mDNS, DNS-over-HTTPS and any other
 * system resolver configuration — on a DoH-only or split-DNS host it fails
 * outright even though normal name resolution works fine.
 *
 * @module dns64
 */

const dns = require('dns');
const net = require('net');
const { embedIPv4, extractIPv4 } = require('./ipv6');
const { TtlCache } = require('./cache');
const config = require('./config');

/**
 * IPv4 ranges that are not globally reachable (RFC 6890).
 * Stored as [network, prefixLength] pairs.
 */
const NON_GLOBAL_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const dnsCache = new TtlCache({
  max: config.DNS_CACHE_MAX,
  ttl: config.DNS_CACHE_TTL,
});

/**
 * Detect the IP version of an address string.
 *
 * @param {string} addr - Address or hostname to check
 * @returns {'ipv4'|'ipv6'|'hostname'|null} Address type
 */
function detectIPVersion(addr) {
  if (!addr || typeof addr !== 'string') return null;

  const result = net.isIP(addr);
  if (result === 4) return 'ipv4';
  if (result === 6) return 'ipv6';

  // net.isIP returns 0 for non-IP strings (i.e. hostnames)
  return 'hostname';
}

function ipv4ToInt(ipv4) {
  return ipv4.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0);
}

/**
 * Check whether an IPv4 address is globally reachable.
 *
 * RFC 6052 section 3.1 forbids representing non-global IPv4 addresses with the
 * well-known prefix, so these must not be handed to a NAT64 gateway.
 *
 * @param {string} ipv4 - IPv4 address
 * @returns {boolean} true if the address is globally routable
 */
function isGlobalIPv4(ipv4) {
  if (net.isIP(ipv4) !== 4) return false;

  const addr = ipv4ToInt(ipv4);
  return !NON_GLOBAL_IPV4_RANGES.some(([network, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((addr & mask) >>> 0) === ((ipv4ToInt(network) & mask) >>> 0);
  });
}

/**
 * Whether an IPv4 address may be synthesized with the configured prefix.
 *
 * An operator-assigned network-specific prefix may carry non-global addresses;
 * the well-known prefix may not.
 *
 * @param {string} ipv4 - IPv4 address
 * @returns {boolean} true if synthesis is permitted
 */
function canSynthesize(ipv4) {
  if (net.isIP(ipv4) !== 4) return false;
  return !config.usingWellKnownPrefix() || isGlobalIPv4(ipv4);
}

/**
 * Convert an IPv4 address to IPv6 using the configured NAT64 prefix (RFC 6052).
 *
 * This is a pure format conversion; it does not enforce RFC 6052 section 3.1.
 * Use canSynthesize() to decide whether conversion is appropriate.
 *
 * @param {string} ipv4 - IPv4 address (e.g., '192.0.2.1')
 * @returns {string} IPv4-embedded IPv6 address
 * @throws {Error} If the input is not a valid IPv4 address
 */
function ipv4ToIPv6(ipv4) {
  if (!ipv4 || typeof ipv4 !== 'string') {
    throw new Error('ipv4ToIPv6: address must be a non-empty string');
  }
  if (net.isIP(ipv4) !== 4) {
    throw new Error(`ipv4ToIPv6: invalid IPv4 address "${ipv4}"`);
  }
  return embedIPv4(ipv4, config.getPrefix());
}

/**
 * Recover the IPv4 address embedded in a synthesized IPv6 address.
 *
 * @param {string} address - IPv4-embedded IPv6 address
 * @returns {string|null} The IPv4 address, or null if not embedded
 */
function ipv6ToIPv4(address) {
  return extractIPv4(address, config.getPrefix().length);
}

/**
 * Look up every address for a hostname via the system resolver, with a timeout.
 *
 * @param {string} hostname - Hostname to look up
 * @param {number} [timeoutMs] - Timeout in milliseconds
 * @returns {Promise<Array<{address: string, family: number}>>} Resolved records
 */
function lookupAll(hostname, timeoutMs = config.DNS_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      const err = new Error(`DNS lookup for "${hostname}" timed out after ${timeoutMs}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, timeoutMs);

    dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(addresses);
    });
  });
}

/** Rotate an array so repeated lookups spread across available records. */
function rotate(items) {
  if (items.length < 2) return items;
  const offset = Math.floor(Math.random() * items.length);
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/**
 * Resolve a hostname into an ordered list of connection candidates.
 *
 * Candidates are ordered most- to least-preferred, so a caller can fail over
 * rather than giving up on the first unreachable address:
 *
 *   1. native IPv6 (the host is already reachable without translation)
 *   2. NAT64-synthesized IPv6 (what this bridge exists to provide)
 *   3. direct IPv4 (last resort; not translated)
 *
 * @param {string} hostname - Hostname or IP literal
 * @returns {Promise<Array<{host: string, family: number, mode: string}>>} Candidates
 */
async function resolveCandidates(hostname) {
  const ipVersion = detectIPVersion(hostname);

  if (ipVersion === 'ipv6') {
    return [{ host: hostname, family: 6, mode: 'ipv6-literal' }];
  }

  if (ipVersion === 'ipv4') {
    if (canSynthesize(hostname)) {
      return [
        { host: ipv4ToIPv6(hostname), family: 6, mode: 'nat64' },
        { host: hostname, family: 4, mode: 'direct-ipv4' },
      ];
    }
    // RFC 6052 section 3.1: non-global IPv4 cannot use the well-known prefix.
    return [{ host: hostname, family: 4, mode: 'direct-ipv4' }];
  }

  const cached = dnsCache.get(hostname);
  if (cached) return cached;

  const records = await lookupAll(hostname);

  const ipv6 = rotate(records.filter((r) => r.family === 6).map((r) => r.address));
  const ipv4 = rotate(records.filter((r) => r.family === 4).map((r) => r.address));

  if (ipv6.length === 0 && ipv4.length === 0) {
    throw new Error(`No A or AAAA records found for ${hostname}`);
  }

  const candidates = [
    ...ipv6.map((host) => ({ host, family: 6, mode: 'native-ipv6' })),
    ...ipv4.filter(canSynthesize).map((address) => ({
      host: ipv4ToIPv6(address), family: 6, mode: 'nat64',
    })),
    ...ipv4.map((host) => ({ host, family: 4, mode: 'direct-ipv4' })),
  ];

  dnsCache.set(hostname, candidates);
  return candidates;
}

/**
 * Resolve a hostname, reporting how it would be reached.
 *
 * @param {string} hostname - Domain name to resolve
 * @returns {Promise<{addresses: string[], mode: string}>} Addresses and routing mode
 * @throws {Error} If the hostname cannot be resolved at all
 */
async function resolveHost(hostname) {
  const candidates = await resolveCandidates(hostname);
  const primary = candidates[0].mode;
  return {
    addresses: candidates.filter((c) => c.mode === primary).map((c) => c.host),
    mode: primary,
  };
}

/**
 * Resolve a hostname to IPv6 addresses using DNS64.
 *
 * @param {string} hostname - Domain name to resolve
 * @returns {Promise<string[]>} Array of IPv6 addresses
 * @throws {Error} If no IPv6 address can be produced
 */
async function resolveIPv6(hostname) {
  const candidates = await resolveCandidates(hostname);
  const ipv6 = candidates.filter((c) => c.family === 6).map((c) => c.host);

  if (ipv6.length === 0) {
    throw new Error(
      `Cannot produce an IPv6 address for ${hostname}: it resolves only to ` +
      `non-global IPv4 addresses, which RFC 6052 section 3.1 forbids ` +
      `representing with the well-known prefix`
    );
  }

  return ipv6;
}

module.exports = {
  ipv4ToIPv6,
  ipv6ToIPv4,
  resolveIPv6,
  resolveHost,
  resolveCandidates,
  detectIPVersion,
  isGlobalIPv4,
  canSynthesize,
  lookupAll,
  dnsCache,
};
