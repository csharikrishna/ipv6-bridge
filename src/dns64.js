/**
 * IPv6 Bridge - DNS64 Resolver
 *
 * Implements DNS64 (RFC 6052) for synthesizing IPv6 addresses from IPv4.
 *
 * @module dns64
 */

const dns = require('dns').promises;
const net = require('net');
const { NAT64_PREFIX, DNS_TIMEOUT } = require('./config');

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

/**
 * Convert an IPv4 address to IPv6 using the NAT64 prefix (RFC 6052).
 *
 * The IPv4 address is embedded in the lower 32 bits of the IPv6 address:
 *   192.0.2.1 → 64:ff9b::c000:0201
 *
 * @param {string} ipv4 - IPv4 address (e.g., '192.0.2.1')
 * @returns {string} IPv6 address with NAT64 prefix
 * @throws {Error} If the input is not a valid IPv4 address
 */
function ipv4ToIPv6(ipv4) {
  if (!ipv4 || typeof ipv4 !== 'string') {
    throw new Error('ipv4ToIPv6: address must be a non-empty string');
  }

  const parts = ipv4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`ipv4ToIPv6: invalid IPv4 address "${ipv4}"`);
  }

  const hex1 = ((parts[0] << 8) | parts[1]).toString(16).padStart(4, '0');
  const hex2 = ((parts[2] << 8) | parts[3]).toString(16).padStart(4, '0');
  return `${NAT64_PREFIX}${hex1}:${hex2}`;
}

/**
 * Resolve a hostname to IPv6 addresses using DNS64 (RFC 6052).
 *
 * 1. Try native AAAA resolution first.
 * 2. Fall back to A resolution and synthesize IPv6 via NAT64 prefix.
 *
 * @param {string} hostname - Domain name to resolve
 * @returns {Promise<string[]>} Array of IPv6 addresses
 * @throws {Error} If DNS resolution fails completely
 */
async function resolveIPv6(hostname) {
  try {
    const resolver = dns.resolve6(hostname);
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('DNS timeout')), DNS_TIMEOUT)
    );
    return await Promise.race([resolver, timeout]);
  } catch {
    try {
      const ipv4 = await dns.resolve4(hostname);
      return ipv4.map(ipv4ToIPv6);
    } catch (err) {
      throw new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
    }
  }
}

module.exports = { ipv4ToIPv6, resolveIPv6, detectIPVersion };
