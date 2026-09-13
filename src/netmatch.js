/**
 * IPv6 Bridge - Address and hostname matching
 *
 * Shared matching logic for the client allowlist and the bypass list.
 * Supports IPv4/IPv6 CIDR ranges, bare addresses, and hostname wildcards.
 *
 * @module netmatch
 */

const net = require('net');
const { parseIPv6, parseIPv4 } = require('./ipv6');

/**
 * Normalize an address into bytes. IPv4-mapped IPv6 addresses ("::ffff:1.2.3.4",
 * which is how a dual-stack listener reports IPv4 peers) are reduced to IPv4.
 *
 * @param {string} address - IP address
 * @returns {{bytes: Buffer, family: number}|null} Normalized address
 */
function toBytes(address) {
  if (typeof address !== 'string') return null;

  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  const candidate = mapped ? mapped[1] : address;

  const version = net.isIP(candidate);
  if (version === 4) return { bytes: parseIPv4(candidate), family: 4 };
  if (version === 6) {
    const bytes = parseIPv6(candidate);
    return bytes ? { bytes, family: 6 } : null;
  }
  return null;
}

/**
 * Parse a CIDR rule such as "192.168.0.0/16", "10.0.0.1" or "2001:db8::/32".
 *
 * @param {string} rule - CIDR or bare address
 * @returns {{bytes: Buffer, family: number, bits: number}|null} Parsed rule
 */
function parseCidr(rule) {
  const [address, lengthText] = String(rule).trim().split('/');
  const parsed = toBytes(address);
  if (!parsed) return null;

  const maxBits = parsed.family === 4 ? 32 : 128;
  const bits = lengthText === undefined ? maxBits : Number(lengthText);
  if (!Number.isInteger(bits) || bits < 0 || bits > maxBits) return null;

  return { ...parsed, bits };
}

/**
 * Test whether an address falls inside a parsed CIDR rule.
 *
 * @param {string} address - IP address to test
 * @param {{bytes: Buffer, family: number, bits: number}} rule - Parsed rule
 * @returns {boolean} true if the address matches
 */
function matchesCidr(address, rule) {
  const parsed = toBytes(address);
  if (!parsed || !rule || parsed.family !== rule.family) return false;

  const wholeBytes = Math.floor(rule.bits / 8);
  const remainingBits = rule.bits % 8;

  for (let i = 0; i < wholeBytes; i++) {
    if (parsed.bytes[i] !== rule.bytes[i]) return false;
  }

  if (remainingBits === 0) return true;

  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (parsed.bytes[wholeBytes] & mask) === (rule.bytes[wholeBytes] & mask);
}

/**
 * Compile a comma-separated rule list into a matcher.
 *
 * Each rule is either a CIDR/address or a hostname pattern, where a leading
 * "*." matches any subdomain and the bare domain itself.
 *
 * @param {string} spec - Comma-separated rules
 * @returns {{isEmpty: boolean, rules: string[], matches: (value: string) => boolean}} Matcher
 */
function compile(spec) {
  const rules = String(spec || '')
    .split(',')
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);

  const cidrs = [];
  const hostPatterns = [];

  for (const rule of rules) {
    const cidr = parseCidr(rule);
    if (cidr) cidrs.push(cidr);
    else hostPatterns.push(rule);
  }

  function matches(value) {
    if (!value) return false;
    const target = String(value).toLowerCase();

    if (net.isIP(target) !== 0 || /^::ffff:/i.test(target)) {
      if (cidrs.some((rule) => matchesCidr(target, rule))) return true;
    }

    return hostPatterns.some((pattern) => {
      if (pattern === '*') return true;
      if (pattern.startsWith('*.')) {
        const domain = pattern.slice(2);
        return target === domain || target.endsWith('.' + domain);
      }
      return target === pattern;
    });
  }

  return { isEmpty: rules.length === 0, rules, matches };
}

module.exports = { compile, parseCidr, matchesCidr, toBytes };
