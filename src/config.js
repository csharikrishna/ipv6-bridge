/**
 * IPv6 Bridge - Configuration
 *
 * RFC 6052 Well-Known NAT64 Prefix and network test constants.
 * All values can be overridden via environment variables.
 *
 * @module config
 */

module.exports = {
  /**
   * NAT64 Prefix (RFC 6052)
   *
   * The well-known prefix used to synthesize IPv6 addresses from IPv4.
   * Override with the NAT64_PREFIX environment variable if your ISP
   * uses a non-standard prefix.
   *
   * Example: 192.0.2.1 → 64:ff9b::c000:0201
   *
   * @see https://tools.ietf.org/html/rfc6052#section-2.1
   */
  NAT64_PREFIX: process.env.NAT64_PREFIX || '64:ff9b::',

  /**
   * Default port for the proxy server.
   * Override with the IPV6_BRIDGE_PORT environment variable.
   */
  DEFAULT_PORT: 8080,

  /**
   * Test URL for IPv6 connectivity detection.
   * Must be a server with IPv6 support.
   */
  IPV6_GOOGLE: 'http://ipv6.google.com',

  /**
   * Hostname for NAT64 availability testing.
   * An IPv4-only hostname that should be reachable via NAT64
   * if the ISP gateway is properly configured.
   */
  IPV4_GOOGLE: 'ipv4.google.com',
};
