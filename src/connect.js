/**
 * IPv6 Bridge - Outbound connection handling
 *
 * Establishes upstream connections with failover across the candidate
 * addresses produced by DNS64, and provides a pooling HTTP agent so repeated
 * requests to the same host reuse sockets.
 *
 * @module connect
 */

const http = require('http');
const net = require('net');
const { resolveCandidates } = require('./dns64');
const config = require('./config');
const stats = require('./stats');
const log = require('./logger');

/**
 * Open a TCP connection to one candidate address.
 *
 * @param {{host: string, family: number}} candidate - Address to try
 * @param {number} port - Destination port
 * @param {number} timeout - Per-attempt timeout in milliseconds
 * @returns {Promise<net.Socket>} Connected socket
 */
function attempt(candidate, port, timeout) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({
      host: candidate.host,
      port,
      family: candidate.family,
    });

    const fail = (err) => {
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeout, () => {
      fail(Object.assign(new Error(
        `Connection to ${candidate.host}:${port} timed out after ${timeout}ms`
      ), { code: 'ETIMEDOUT' }));
    });

    socket.once('error', fail);

    socket.once('connect', () => {
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      resolve(socket);
    });
  });
}

/**
 * Connect to a host, trying each candidate address in preference order.
 *
 * A single unreachable address is the normal case on a partially broken
 * network, so failing on the first attempt would make the bridge far less
 * reliable than the stack it replaces.
 *
 * @param {string} hostname - Target hostname or IP literal
 * @param {number} port - Destination port
 * @param {object} [options] - Options
 * @param {boolean} [options.bypass] - Connect directly, skipping NAT64
 * @returns {Promise<{socket: net.Socket, candidate: object}>} Connected socket and the candidate used
 */
async function connectWithFallback(hostname, port, { bypass = false } = {}) {
  const candidates = bypass
    ? [{ host: hostname, family: 0, mode: 'bypassed' }]
    : await resolveCandidates(hostname);

  const attemptTimeout = Math.min(
    config.CONNECT_ATTEMPT_TIMEOUT,
    config.CONNECTION_TIMEOUT
  );

  const failures = [];

  for (const candidate of candidates) {
    try {
      const socket = await attempt(candidate, port, attemptTimeout);

      if (failures.length > 0) {
        log.debug(
          `Connected to ${hostname}:${port} via ${candidate.host} (${candidate.mode}) ` +
          `after ${failures.length} failed candidate(s)`
        );
      }

      if (candidate.mode === 'direct-ipv4' && candidates.some((c) => c.mode === 'nat64')) {
        log.warn(
          `NAT64 route to ${hostname} failed; connected directly over IPv4 instead. ` +
          `This request is NOT being translated.`
        );
        stats.recordRoute('direct-ipv4-fallback');
      } else {
        stats.recordRoute(candidate.mode);
      }

      return { socket, candidate };
    } catch (err) {
      failures.push(`${candidate.host} (${err.code || err.message})`);
    }
  }

  const error = new Error(
    `Unable to connect to ${hostname}:${port}; tried ${failures.join(', ')}`
  );
  error.code = 'EHOSTUNREACH';
  throw error;
}

/**
 * HTTP agent that resolves through DNS64 and pools the resulting sockets.
 *
 * Sockets are keyed by the original hostname, so pooling survives the fact
 * that the address the bridge dials is synthesized rather than literal.
 */
class BridgeAgent extends http.Agent {
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
    const hostname = options.host;
    const port = Number(options.port) || 80;
    const bypass = !config.BYPASS.isEmpty && config.BYPASS.matches(hostname);

    connectWithFallback(hostname, port, { bypass })
      .then(({ socket }) => callback(null, socket))
      .catch((err) => callback(err));
  }
}

module.exports = { connectWithFallback, BridgeAgent, attempt };
