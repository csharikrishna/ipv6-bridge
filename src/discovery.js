/**
 * IPv6 Bridge - NAT64 prefix discovery (RFC 7050)
 *
 * Networks that provide NAT64 rarely use the well-known prefix; most operators
 * assign their own. RFC 7050 defines how to find it: resolve AAAA records for
 * the special name "ipv4only.arpa", whose only real records are the two IPv4
 * addresses below. A DNS64 resolver synthesizes AAAA records for that name, so
 * whatever wraps those known IPv4 addresses is the network's NAT64 prefix.
 *
 * @module discovery
 */

const { lookupAll } = require('./dns64');
const { parseIPv6, formatIPv6, extractIPv4, VALID_PREFIX_LENGTHS } = require('./ipv6');
const config = require('./config');
const log = require('./logger');

/** The well-known name and its fixed IPv4 addresses (RFC 7050 section 3). */
const DISCOVERY_NAME = 'ipv4only.arpa';
const WELL_KNOWN_IPV4 = ['192.0.0.170', '192.0.0.171'];

/**
 * Derive the NAT64 prefix from a synthesized IPv4-embedded address.
 *
 * @param {string} address - Synthesized IPv6 address
 * @returns {{prefix: string, length: number, bytes: Buffer}|null} Prefix, or null if no match
 */
function prefixFromSynthesized(address) {
  for (const length of VALID_PREFIX_LENGTHS) {
    const embedded = extractIPv4(address, length);
    if (!embedded || !WELL_KNOWN_IPV4.includes(embedded)) continue;

    const bytes = parseIPv6(address);
    if (!bytes) continue;

    // Zero everything after the prefix to get the prefix itself.
    const prefixBytes = Buffer.from(bytes);
    for (let bit = length; bit < 128; bit++) {
      const index = Math.floor(bit / 8);
      prefixBytes[index] &= ~(1 << (7 - (bit % 8))) & 0xff;
    }

    return { prefix: formatIPv6(prefixBytes), length, bytes: prefixBytes };
  }

  return null;
}

/**
 * Discover the NAT64 prefix this network uses.
 *
 * @param {object} [options] - Options
 * @param {number} [options.timeout] - DNS timeout in milliseconds
 * @returns {Promise<{prefix: string, length: number, bytes: Buffer, source: string}|null>}
 *   The discovered prefix, or null if the network provides no DNS64 resolver
 */
async function discoverPrefix({ timeout = config.DNS_TIMEOUT } = {}) {
  let records;
  try {
    records = await lookupAll(DISCOVERY_NAME, timeout);
  } catch (err) {
    log.debug(`NAT64 prefix discovery: ${DISCOVERY_NAME} did not resolve (${err.code || err.message})`);
    return null;
  }

  const synthesized = records.filter((r) => r.family === 6).map((r) => r.address);
  if (synthesized.length === 0) {
    log.debug('NAT64 prefix discovery: no AAAA records, so this resolver does not provide DNS64');
    return null;
  }

  for (const address of synthesized) {
    const found = prefixFromSynthesized(address);
    if (found) {
      return { ...found, source: address };
    }
  }

  log.debug(
    `NAT64 prefix discovery: ${DISCOVERY_NAME} returned ${synthesized.join(', ')}, ` +
    `but no RFC 6052 prefix length embeds ${WELL_KNOWN_IPV4.join(' or ')}`
  );
  return null;
}

/**
 * Discover the prefix and adopt it if it differs from the configured one.
 *
 * @returns {Promise<{prefix: string, length: number}|null>} The adopted prefix, if any
 */
async function discoverAndApply() {
  const discovered = await discoverPrefix();
  if (!discovered) return null;

  const current = config.getPrefix();
  const spec = `${discovered.prefix}/${discovered.length}`;

  if (current.prefix === discovered.prefix && current.length === discovered.length) {
    log.debug(`NAT64 prefix discovery confirmed the configured prefix ${spec}`);
    return discovered;
  }

  if (process.env.NAT64_PREFIX) {
    log.warn(
      `This network advertises NAT64 prefix ${spec}, but NAT64_PREFIX is set to ` +
      `${current.prefix}/${current.length}. Keeping the configured value.`
    );
    return null;
  }

  log.info(`Discovered NAT64 prefix ${spec} via ${DISCOVERY_NAME} (RFC 7050)`);
  config.setPrefix(discovered);
  return discovered;
}

module.exports = {
  DISCOVERY_NAME,
  WELL_KNOWN_IPV4,
  discoverPrefix,
  discoverAndApply,
  prefixFromSynthesized,
};
