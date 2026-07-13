/**
 * IPv6 Bridge - Main Entry Point
 *
 * Coordinates bridge startup and shutdown. The bridge consists of:
 *
 * 1. Detection (detect.js): Checks if the bridge is needed.
 * 2. DNS64 Resolver (dns64.js): Synthesizes IPv6 addresses from IPv4.
 * 3. Proxy (proxy.js): HTTP/HTTPS proxy with NAT64 routing.
 *
 * @module ipv6-bridge
 */

const { createProxy } = require('./proxy');
const { needsBridge } = require('./detect');

let activeServer = null;

/**
 * Start the IPv6 bridge.
 *
 * @param {number} [port=8080] - Port to listen on
 * @returns {Promise<http.Server|null>} Server instance if started, null if not needed
 * @throws {Error} If already running or startup fails
 */
async function start(port = 8080) {
  if (activeServer) {
    throw new Error('IPv6 Bridge is already running');
  }

  // Step 1: Detect if bridge is needed
  const needed = await needsBridge();
  if (!needed && !process.env.FORCE_BRIDGE) {
    console.log('IPv6 bridge not needed — you have dual-stack or working NAT64.');
    return null;
  }

  if (!needed) {
    console.log('IPv6 bridge not needed, but FORCE_BRIDGE is set — starting anyway.');
  }

  // Step 2: Start the proxy server
  activeServer = await createProxy(port);
  return activeServer;
}

/**
 * Stop the IPv6 bridge.
 *
 * @returns {Promise<void>} Resolves when the server has closed
 */
function stop() {
  if (!activeServer) return Promise.resolve();

  return new Promise((resolve) => {
    activeServer.close(() => {
      activeServer = null;
      resolve();
    });
  });
}

module.exports = { start, stop };
