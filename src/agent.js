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
 * Layer TLS onto an already-connected plaintext socket, reporting success or
 * failure through a Node-style callback.
 *
 * tls.connect() can throw synchronously — a caller-supplied option such as an
 * invalid secureProtocol or cipher list fails while it builds the security
 * context, before any socket event fires. Left uncaught, that throw would
 * escape as an uncaught exception and crash the embedding host application on
 * its very first request, which is a much worse outcome than the one failed
 * connection a caught error produces.
 *
 * @param {net.Socket} socket - Connected plaintext socket to upgrade
 * @param {object} tlsOptions - Options for tls.connect
 * @param {string} hostname - Hostname to validate the certificate against
 * @param {(err: Error|null, socket?: tls.TLSSocket) => void} callback - Result callback
 */
function upgradeToTls(socket, tlsOptions, hostname, callback) {
  let secure;
  try {
    secure = tls.connect({
      ...tlsOptions,
      socket,
      // SNI and certificate identity must use the real hostname, never the
      // synthesized address the plaintext socket was dialled through.
      host: hostname,
      servername: tlsOptions.servername || hostname,
    });
  } catch (err) {
    socket.destroy();
    callback(err);
    return;
  }

  const onError = (err) => {
    socket.destroy();
    callback(err);
  };

  secure.once('error', onError);
  secure.once('secureConnect', () => {
    secure.removeListener('error', onError);
    callback(null, secure);
  });
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

    openSocket(options, 443).then(
      (socket) => upgradeToTls(socket, { ...this.tlsOptions, ...options }, hostname, callback),
      (err) => callback(err)
    );
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
 * client libraries — can use this without further changes. Matches the real
 * dns.lookup contract: `options` may be omitted, a plain object, or (per
 * Node's documented shorthand) an integer meaning the requested address
 * family.
 *
 * @returns {Function} Function with the dns.lookup signature
 */
function createLookup() {
  return function bridgeLookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    } else if (typeof options === 'number') {
      options = { family: options };
    } else {
      options = options || {};
    }

    resolveCandidates(hostname).then((candidates) => {
      const matching = options.family
        ? candidates.filter((c) => c.family === options.family)
        : candidates;

      if (options.family && matching.length === 0) {
        const err = new Error(
          `No family ${options.family} address available for ${hostname}`
        );
        err.code = 'EAI_ADDRFAMILY';
        callback(err);
        return;
      }

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
    const { hostname, port, protocol } = options;
    const isSecure = protocol === 'https:';
    const targetPort = Number(port) || (isSecure ? 443 : 80);

    connectWithFallback(hostname, targetPort, { bypass: shouldBypass(hostname) }).then(
      ({ socket }) => {
        if (!isSecure) {
          callback(null, socket);
          return;
        }
        upgradeToTls(socket, options, hostname, callback);
      },
      (err) => callback(err)
    );
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
