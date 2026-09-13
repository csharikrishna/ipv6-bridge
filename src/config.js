/**
 * IPv6 Bridge - Configuration
 *
 * All values can be overridden via environment variables. Invalid values throw
 * at load time rather than surfacing later as unexplainable connection failures.
 *
 * @module config
 */

const { parsePrefix, WELL_KNOWN_PREFIX_ADDRESS } = require('./ipv6');
const netmatch = require('./netmatch');

/** The RFC 6052 section 3.1 well-known prefix. */
const WELL_KNOWN_PREFIX = WELL_KNOWN_PREFIX_ADDRESS;

function intFromEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;

  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }

  const value = Number(trimmed);
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

function boolFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/**
 * The active NAT64 prefix. Held in a mutable slot because RFC 7050 discovery
 * can replace the configured default with the one the network actually uses.
 */
let activePrefix;
try {
  activePrefix = parsePrefix(process.env.NAT64_PREFIX || `${WELL_KNOWN_PREFIX}/96`);
} catch (err) {
  throw new Error(`Invalid NAT64_PREFIX: ${err.message}`);
}

const configuredPrefix = activePrefix;

/** @returns {{prefix: string, length: number, bytes: Buffer}} The active prefix */
function getPrefix() {
  return activePrefix;
}

/**
 * Replace the active NAT64 prefix (used by RFC 7050 discovery).
 *
 * @param {{prefix: string, length: number, bytes: Buffer}} prefix - Parsed prefix
 */
function setPrefix(prefix) {
  activePrefix = prefix;
}

/** Restore the prefix that was configured at startup. */
function resetPrefix() {
  activePrefix = configuredPrefix;
}

/** @returns {boolean} true if the active prefix is the well-known one */
function usingWellKnownPrefix() {
  return activePrefix.prefix === WELL_KNOWN_PREFIX;
}

function parseAuth() {
  const raw = process.env.IPV6_BRIDGE_AUTH;
  if (!raw || raw.trim() === '') return null;

  const separator = raw.indexOf(':');
  if (separator < 1 || separator === raw.length - 1) {
    throw new Error('IPV6_BRIDGE_AUTH must be in "user:password" form');
  }

  return {
    username: raw.slice(0, separator),
    password: raw.slice(separator + 1),
    header: 'Basic ' + Buffer.from(raw).toString('base64'),
  };
}

const BIND_HOST = process.env.IPV6_BRIDGE_HOST || '127.0.0.1';
const AUTH = parseAuth();
const ALLOW_FROM = netmatch.compile(process.env.IPV6_BRIDGE_ALLOW);
const BYPASS = netmatch.compile(process.env.IPV6_BRIDGE_BYPASS);

function isLoopbackBind(host = BIND_HOST) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

module.exports = {
  WELL_KNOWN_PREFIX,
  getPrefix,
  setPrefix,
  resetPrefix,
  usingWellKnownPrefix,
  isLoopbackBind,

  /** Configured NAT64 prefix as written by the user. */
  NAT64_PREFIX: configuredPrefix.prefix,
  NAT64_PREFIX_LENGTH: configuredPrefix.length,

  /** Default proxy listen port. */
  DEFAULT_PORT: intFromEnv('IPV6_BRIDGE_PORT', 8080, { max: 65535 }),

  /**
   * Interface the proxy binds to. Defaults to loopback: without authentication
   * a routable bind turns the host into an open relay.
   */
  BIND_HOST,

  /** Optional SOCKS5 listener port; disabled when unset. */
  SOCKS_PORT: process.env.IPV6_BRIDGE_SOCKS_PORT
    ? intFromEnv('IPV6_BRIDGE_SOCKS_PORT', 1080, { max: 65535 })
    : null,

  /** Optional Basic credentials required from proxy clients. */
  AUTH,

  /** Client addresses permitted to use the proxy (empty means "any"). */
  ALLOW_FROM,

  /** Hosts that should bypass NAT64 and be reached directly. */
  BYPASS,

  /** Whether to serve /healthz, /status, /metrics and /proxy.pac. */
  CONTROL_ENDPOINTS: boolFromEnv('IPV6_BRIDGE_CONTROL', true),

  /** Whether to attempt RFC 7050 NAT64 prefix discovery at startup. */
  PREFIX_DISCOVERY: boolFromEnv('IPV6_BRIDGE_DISCOVER_PREFIX', true),

  /** DNS resolution timeout in milliseconds. */
  DNS_TIMEOUT: intFromEnv('IPV6_DNS_TIMEOUT', 5000),

  /** Lifetime of a cached DNS result, in milliseconds. */
  DNS_CACHE_TTL: intFromEnv('IPV6_DNS_CACHE_TTL', 30000),

  /** Maximum number of cached DNS results. */
  DNS_CACHE_MAX: intFromEnv('IPV6_DNS_CACHE_MAX', 1000),

  /** Proxy connection timeout in milliseconds. */
  CONNECTION_TIMEOUT: intFromEnv('IPV6_CONN_TIMEOUT', 10000),

  /** How long to wait for one candidate address before trying the next. */
  CONNECT_ATTEMPT_TIMEOUT: intFromEnv('IPV6_CONNECT_ATTEMPT_TIMEOUT', 3000),

  /** Idle keep-alive socket lifetime for pooled upstream connections. */
  KEEP_ALIVE_MS: intFromEnv('IPV6_KEEP_ALIVE_MS', 15000),

  /** Maximum pooled sockets per upstream host. */
  MAX_SOCKETS_PER_HOST: intFromEnv('IPV6_MAX_SOCKETS_PER_HOST', 64),

  /**
   * Endpoint used to test native IPv6 connectivity. Overridable so detection
   * still works where the default host is unreachable or blocked.
   */
  IPV6_TEST_URL: process.env.IPV6_TEST_URL || 'http://ipv6.google.com',

  /** Endpoint used to test whether plain IPv4 connectivity already works. */
  IPV4_TEST_URL: process.env.IPV4_TEST_URL || 'http://ipv4.google.com',

  /**
   * IPv4-only hostname used to probe for an upstream NAT64 gateway. Resolved
   * via DNS64 and connected to over IPv6; success means the ISP already
   * provides NAT64 and the bridge is unnecessary.
   */
  NAT64_TEST_HOST: process.env.NAT64_TEST_HOST || 'ipv4.google.com',
};
