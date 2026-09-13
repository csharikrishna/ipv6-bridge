/**
 * IPv6 Bridge - Embeddable connection primitives
 *
 * Everything here lets an application use DNS64/NAT64 translation directly,
 * without running a proxy or changing any system configuration. Outbound
 * connections are made over native IPv6 where possible, through a synthesized
 * NAT64 address where translation is needed, and over IPv4 as a last resort.
 *
 * None of this can manufacture connectivity the host does not have. It makes
 * the host reach everything it *can* reach, regardless of address family.
 *
 * @module agent
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const { connectWithFallback } = require('./connect');
const { resolveCandidates } = require('./dns64');
const config = require('./config');

function shouldBypass(hostname) {
  return !config.BYPASS.isEmpty && config.BYPASS.matches(hostname);
}

/**
 * Open a bridged TCP connection for an agent.
 *
 * @param {object} options - Connection options from the agent
 * @param {number} defaultPort - Port to use when none is given
 * @returns {Promise<net.Socket>} Connected socket
 */
function openSocket(options, defaultPort) {
  const hostname = options.host;
  const port = Number(options.port) || defaultPort;
  return connectWithFallback(hostname, port, { bypass: shouldBypass(hostname) })
    .then(({ socket }) => socket);
}

/**
 * HTTP agent that resolves through DNS64 and pools the resulting sockets.
 *
 * Sockets are keyed by the original hostname, so pooling is unaffected by the
 * fact that the address actually dialled may be synthesized.
 */
class BridgeHttpAgent extends http.Agent {
  constructor(options = {}) {
    super({
      keepAlive: true,
      keepAliveMsecs: config.KEEP_ALIVE_MS,
      maxSockets: config.MAX_SOCKETS_PER_HOST,
      timeout: config.CONNECTION_TIMEOUT,
      ...options,
    });
  }

  createConnection(options, callback) {
    openSocket(options, 80).then(
      (socket) => callback(null, socket),
      (err) => callback(err)
    );
  }
}

/**
 * HTTPS agent that performs the TLS handshake over a bridged socket.
 *
 * The certificate is validated against the original hostname, never against
 * the synthesized address it was reached through — otherwise validation could
 * never succeed and users would be pushed into disabling it.
 */
class BridgeHttpsAgent extends https.Agent {
  constructor(options = {}) {
    super({
      keepAlive: true,
      keepAliveMsecs: config.KEEP_ALIVE_MS,
      maxSockets: config.MAX_SOCKETS_PER_HOST,
      timeout: config.CONNECTION_TIMEOUT,
      ...options,
    });
    this.tlsOptions = options;
  }

  createConnection(options, callback) {
    const hostname = options.host;

    openSocket(options, 443).then((socket) => {
      const secure = tls.connect({
        ...this.tlsOptions,
        ...options,
        socket,
        // SNI and certificate identity must use the real hostname.
        host: hostname,
        servername: options.servername || (tls.checkServerIdentity && hostname),
      });

      const onError = (err) => {
        socket.destroy();
        callback(err);
      };

      secure.once('error', onError);
      secure.once('secureConnect', () => {
        secure.removeListener('error', onError);
        callback(null, secure);
      });
    }, (err) => callback(err));
  }
}

/**
 * Create an HTTP agent backed by the bridge.
 *
 * @param {object} [options] - http.Agent options
 * @returns {http.Agent} Agent for use with http.request / axios / got
 */
function createAgent(options) {
  return new BridgeHttpAgent(options);
}

/**
 * Create an HTTPS agent backed by the bridge.
 *
 * @param {object} [options] - https.Agent options
 * @returns {https.Agent} Agent for use with https.request / axios / got
 */
function createHttpsAgent(options) {
  return new BridgeHttpsAgent(options);
}

/**
 * Create agents for both protocols.
 *
 * @param {object} [options] - Agent options applied to both
 * @returns {{http: http.Agent, https: https.Agent}} Agents by protocol
 */
function createAgents(options) {
  return {
    http: createAgent(options),
    https: createHttpsAgent(options),
  };
}

/**
 * Create a dns.lookup-compatible function that applies DNS64 synthesis.
 *
 * Anything accepting a `lookup` option — net.connect, http.request, most
 * client libraries — can use this without further changes.
 *
 * @returns {Function} Function with the dns.lookup signature
 */
function createLookup() {
  return function bridgeLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    resolveCandidates(hostname).then((candidates) => {
      const matching = options.family
        ? candidates.filter((c) => c.family === options.family)
        : candidates;

      const selected = matching.length > 0 ? matching : candidates;

      if (options.all) {
        callback(null, selected.map((c) => ({ address: c.host, family: c.family })));
      } else {
        callback(null, selected[0].host, selected[0].family);
      }
    }, (err) => callback(err));
  };
}

/**
 * Create a connector for undici (and therefore Node's global fetch).
 *
 * undici is not a dependency of this package. Applications that already use it
 * can wire the bridge in:
 *
 *   const { Agent, setGlobalDispatcher } = require('undici');
 *   const { createConnector } = require('ipv6-bridge');
 *   setGlobalDispatcher(new Agent({ connect: createConnector() }));
 *
 * @returns {Function} Function matching undici's `connect` option
 */
function createConnector() {
  return function bridgeConnect(options, callback) {
    const { hostname, port, protocol, servername } = options;
    const isSecure = protocol === 'https:';
    const targetPort = Number(port) || (isSecure ? 443 : 80);

    connectWithFallback(hostname, targetPort, { bypass: shouldBypass(hostname) })
      .then(({ socket }) => {
        if (!isSecure) return callback(null, socket);

        const secure = tls.connect({
          ...options,
          socket,
          host: hostname,
          servername: servername || hostname,
        });

        const onError = (err) => {
          socket.destroy();
          callback(err);
        };

        secure.once('error', onError);
        secure.once('secureConnect', () => {
          secure.removeListener('error', onError);
          callback(null, secure);
        });
      })
      .catch((err) => callback(err));
  };
}

/**
 * Resolve a hostname the way the bridge would, without connecting.
 *
 * Useful for logging or asserting in tests which route would be taken.
 *
 * @param {string} hostname - Hostname or IP literal
 * @returns {Promise<Array<{host: string, family: number, mode: string}>>} Candidates
 */
function resolve(hostname) {
  return resolveCandidates(hostname);
}

module.exports = {
  createAgent,
  createHttpsAgent,
  createAgents,
  createLookup,
  createConnector,
  resolve,
  BridgeHttpAgent,
  BridgeHttpsAgent,
};
