/**
 * IPv6 Bridge - IPv6 address primitives
 *
 * Parsing, formatting, and the IPv4-embedded address format of RFC 6052.
 * Node exposes no inet_pton/inet_ntop equivalent, so these are implemented
 * here to keep the package dependency-free.
 *
 * @module ipv6
 */

const net = require('net');

/** Prefix lengths permitted by RFC 6052 section 2.2. */
const VALID_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96];

/** The RFC 6052 section 3.1 well-known prefix, in canonical form. */
const WELL_KNOWN_PREFIX_ADDRESS = '64:ff9b::';

/**
 * Parse an IPv6 address into its 16 bytes.
 *
 * @param {string} address - IPv6 address, optionally with an embedded IPv4 tail
 * @returns {Buffer|null} 16-byte buffer, or null if the address is invalid
 */
function parseIPv6(address) {
  if (typeof address !== 'string' || net.isIP(address) !== 6) return null;

  let text = address;

  // A trailing dotted-quad ("::ffff:192.0.2.1") is converted to hex groups.
  const embedded = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (embedded) {
    const octets = embedded[1].split('.').map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    text = text.slice(0, embedded.index) + `${high}:${low}`;
  }

  const [head, tail, ...extra] = text.split('::');
  if (extra.length > 0) return null;

  const parseGroups = (part) => (part ? part.split(':').filter((g) => g !== '') : []);
  const headGroups = parseGroups(head);
  const tailGroups = tail === undefined ? [] : parseGroups(tail);

  const total = headGroups.length + tailGroups.length;
  if (total > 8) return null;
  if (tail === undefined && total !== 8) return null;

  const groups = [
    ...headGroups,
    ...Array(8 - total).fill('0'),
    ...tailGroups,
  ];

  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const value = parseInt(groups[i], 16);
    if (Number.isNaN(value) || value < 0 || value > 0xffff) return null;
    bytes.writeUInt16BE(value, i * 2);
  }
  return bytes;
}

/**
 * Format 16 bytes as a canonical IPv6 address (RFC 5952): lowercase, with the
 * longest run of zero groups compressed to "::".
 *
 * @param {Buffer} bytes - 16-byte buffer
 * @returns {string} Canonical IPv6 address
 */
function formatIPv6(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) {
    throw new Error('formatIPv6: expected a 16-byte buffer');
  }

  const groups = [];
  for (let i = 0; i < 8; i++) groups.push(bytes.readUInt16BE(i * 2));

  // Find the longest run of two or more zero groups.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i <= 8; i++) {
    if (i < 8 && groups[i] === 0) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      const length = i - runStart;
      if (length > bestLength) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestLength < 2) return hex.join(':');

  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLength).join(':');
  return `${head}::${tail}`;
}

/**
 * Parse an IPv4 address into its 4 bytes.
 *
 * @param {string} address - IPv4 address
 * @returns {Buffer|null} 4-byte buffer, or null if invalid
 */
function parseIPv4(address) {
  if (typeof address !== 'string' || net.isIP(address) !== 4) return null;
  return Buffer.from(address.split('.').map(Number));
}

/**
 * Parse a NAT64 prefix specification such as "64:ff9b::/96" or "64:ff9b::".
 *
 * @param {string} spec - Prefix, with an optional "/length" suffix
 * @returns {{prefix: string, length: number, bytes: Buffer}} Parsed prefix
 * @throws {Error} If the prefix or length is invalid
 */
function parsePrefix(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') {
    throw new Error('NAT64 prefix must be a non-empty string');
  }

  const [address, lengthText] = spec.trim().split('/');
  const length = lengthText === undefined ? 96 : Number(lengthText);

  if (!VALID_PREFIX_LENGTHS.includes(length)) {
    throw new Error(
      `Invalid NAT64 prefix length /${lengthText}: RFC 6052 permits only ` +
      `${VALID_PREFIX_LENGTHS.map((l) => `/${l}`).join(', ')}`
    );
  }

  const bytes = parseIPv6(address);
  if (!bytes) {
    throw new Error(`Invalid NAT64 prefix "${address}": not a valid IPv6 address`);
  }

  // Everything past the prefix length must be zero.
  for (let bit = length; bit < 128; bit++) {
    const byte = bytes[Math.floor(bit / 8)];
    if ((byte >> (7 - (bit % 8))) & 1) {
      throw new Error(
        `Invalid NAT64 prefix "${spec}": bits after /${length} must be zero`
      );
    }
  }

  const formatted = formatIPv6(bytes);

  // RFC 6052 section 3.1 defines the well-known prefix only at /96.
  if (formatted === WELL_KNOWN_PREFIX_ADDRESS && length !== 96) {
    throw new Error(
      `Invalid NAT64 prefix "${spec}": the well-known prefix ${WELL_KNOWN_PREFIX_ADDRESS} ` +
      `is only defined as /96 (RFC 6052 section 3.1)`
    );
  }

  return { prefix: formatted, length, bytes };
}

/**
 * Byte positions an embedded IPv4 address occupies for a given prefix length.
 *
 * RFC 6052 section 2.2 reserves bits 64-71 (byte 8) as the "u" octet, which
 * must be zero, so the address skips over it.
 *
 * @param {number} prefixLength - Prefix length in bits
 * @returns {number[]} Four byte indices
 */
function embeddedPositions(prefixLength) {
  const positions = [];
  let index = prefixLength / 8;
  while (positions.length < 4) {
    if (index === 8) index = 9; // skip the reserved u octet
    positions.push(index);
    index += 1;
  }
  return positions;
}

/**
 * Embed an IPv4 address into a NAT64 prefix (RFC 6052 section 2.2).
 *
 * @param {string} ipv4 - IPv4 address
 * @param {{bytes: Buffer, length: number}} prefix - Parsed prefix
 * @returns {string} IPv4-embedded IPv6 address
 * @throws {Error} If the IPv4 address is invalid
 */
function embedIPv4(ipv4, prefix) {
  const octets = parseIPv4(ipv4);
  if (!octets) throw new Error(`embedIPv4: invalid IPv4 address "${ipv4}"`);

  const bytes = Buffer.alloc(16);
  prefix.bytes.copy(bytes, 0, 0, prefix.length / 8);

  embeddedPositions(prefix.length).forEach((position, i) => {
    bytes[position] = octets[i];
  });

  return formatIPv6(bytes);
}

/**
 * Extract an IPv4 address embedded in an IPv6 address (RFC 6052 section 2.2).
 *
 * @param {string} address - IPv4-embedded IPv6 address
 * @param {number} prefixLength - Prefix length in bits
 * @returns {string|null} Extracted IPv4 address, or null if the input is invalid
 */
function extractIPv4(address, prefixLength) {
  const bytes = parseIPv6(address);
  if (!bytes || !VALID_PREFIX_LENGTHS.includes(prefixLength)) return null;

  return embeddedPositions(prefixLength).map((position) => bytes[position]).join('.');
}

module.exports = {
  VALID_PREFIX_LENGTHS,
  WELL_KNOWN_PREFIX_ADDRESS,
  parseIPv6,
  formatIPv6,
  parseIPv4,
  parsePrefix,
  embedIPv4,
  extractIPv4,
  embeddedPositions,
};
