/**
 * IPv6 Bridge - Main Entry Point
 *
 * Coordinates bridge startup and shutdown:
 *
 * 1. Detection (detect.js): Checks if the bridge is needed.
 * 2. Discovery (discovery.js): Finds the network's NAT64 prefix (RFC 7050).
 * 3. DNS64 Resolver (dns64.js): Synthesizes IPv6 addresses from IPv4.
 * 4. Proxy (proxy.js): HTTP/HTTPS proxy with NAT64 routing.
 * 5. SOCKS5 (socks5.js): Optional listener for non-HTTP protocols.
 *
 * @module ipv6-bridge
 */

const { createProxy } = require('./proxy');
const { createSocksServer } = require('./socks5');
const { needsBridge } = require('./detect');
const { discoverAndApply, discoverPrefix } = require('./discovery');
const agent = require('./agent');
const { dnsCache } = require('./dns64');
const stats = require('./stats');
const config = require('./config');
const log = require('./logger');

let activeServer = null;
let activeSocksServer = null;
let pendingStart = null;

/**
 * Start the IPv6 bridge.
 *
 * @param {number} [port] - Port to listen on
 * @param {object} [options] - Startup options
 * @param {string} [options.host] - Interface to bind to (defaults to loopback)
 * @param {boolean} [options.force] - Start even if detection says it isn't needed
 * @param {boolean} [options.discoverPrefix] - Run RFC 7050 prefix discovery
 * @param {number|null} [options.socksPort] - Also start a SOCKS5 listener
 * @returns {Promise<http.Server|null>} Server instance if started, null if not needed
 * @throws {Error} If already running or startup fails
 */
function start(port = config.DEFAULT_PORT, options = {}) {
  // Assigned synchronously so concurrent callers cannot both pass the guard
  // and leave a second, untracked server running.
  if (activeServer || pendingStart) {
    return Promise.reject(new Error('IPv6 Bridge is already running'));
  }

  const {
    host = config.BIND_HOST,
    force = Boolean(process.env.FORCE_BRIDGE),
    discoverPrefix = config.PREFIX_DISCOVERY,
    socksPort = config.SOCKS_PORT,
  } = options;

  pendingStart = (async () => {
    const needed = await needsBridge();

    if (!needed && !force) {
      log.info('IPv6 bridge not needed — IPv4 is reachable or NAT64 already works.');
      return null;
    }
    if (!needed) {
      log.info('IPv6 bridge not needed, but a forced start was requested.');
    }

    if (discoverPrefix) {
      // Best effort: a network without DNS64 simply keeps the configured prefix.
      await discoverAndApply().catch((err) => {
        log.debug(`NAT64 prefix discovery failed: ${err.message}`);
      });
    }

    const server = await createProxy(port, host);

    if (socksPort) {
      try {
        activeSocksServer = await createSocksServer(socksPort, host);
      } catch (err) {
        await new Promise((resolve) => server.close(resolve));
        throw err;
      }
    }

    return server;
  })();

  return pendingStart
    .then((server) => {
      activeServer = server;
      return server;
    })
    .finally(() => {
      pendingStart = null;
    });
}

/**
 * Stop the IPv6 bridge.
 *
 * Live connections are torn down; CONNECT tunnels would otherwise keep the
 * server open indefinitely.
 *
 * @returns {Promise<void>} Resolves once everything has closed
 */
async function stop() {
  const server = activeServer;
  const socks = activeSocksServer;
  activeServer = null;
  activeSocksServer = null;

  const closers = [];
  if (server) {
    closers.push(typeof server.closeGracefully === 'function'
      ? server.closeGracefully()
      : new Promise((resolve) => server.close(resolve)));
  }
  if (socks) {
    closers.push(socks.closeGracefully());
  }

  await Promise.all(closers);
}

/**
 * Snapshot what the bridge has done so far.
 *
 * Applications embedding the agents can use this to confirm translation is
 * actually happening rather than silently falling back.
 *
 * @returns {object} Counters, routing modes, DNS cache stats and active prefix
 */
function getStats() {
  const prefix = config.getPrefix();
  return stats.snapshot({
    dnsCache: dnsCache.stats(),
    nat64Prefix: `${prefix.prefix}/${prefix.length}`,
  });
}

module.exports = {
  // Proxy lifecycle
  start,
  stop,

  // Embeddable primitives — use the bridge from inside an application,
  // with no proxy and no system configuration.
  createAgent: agent.createAgent,
  createHttpsAgent: agent.createHttpsAgent,
  createAgents: agent.createAgents,
  createLookup: agent.createLookup,
  createConnector: agent.createConnector,

  // Introspection
  resolve: agent.resolve,
  getStats,
  discoverPrefix,
};
