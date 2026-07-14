/**
 * IPv6 Bridge - HTTP/HTTPS Proxy
 *
 * DNS64-aware application-layer proxy that intercepts HTTP/HTTPS requests,
 * resolves hostnames via DNS64 synthesis, and routes traffic through IPv6.
 * Relies on the ISP's upstream NAT64 gateway for actual IPv4 translation.
 *
 * @module proxy
 */

const http = require('http');
const net = require('net');
const { resolveIPv6, ipv4ToIPv6, detectIPVersion } = require('./dns64');
const { DEFAULT_PORT, CONNECTION_TIMEOUT } = require('./config');
const log = require('./logger');

/**
 * Resolve a target host to an IPv6 address if needed.
 *
 * - IPv6 addresses pass through directly.
 * - IPv4 literals are synthesized using the NAT64 prefix (no DNS lookup).
 * - Hostnames go through DNS64 resolution.
 *
 * @param {string} hostname - The hostname or IP to resolve
 * @returns {Promise<{host: string, family: number}>} Resolved host and IP family
 */
async function resolveTarget(hostname) {
  const ipVersion = detectIPVersion(hostname);

  if (ipVersion === 'ipv6') {
    return { host: hostname, family: 6 };
  }

  // IPv4 literal: synthesize directly, no DNS needed
  if (ipVersion === 'ipv4') {
    try {
      const synthesized = ipv4ToIPv6(hostname);
      log.debug(`Synthesized ${hostname} → ${synthesized}`);
      return { host: synthesized, family: 6 };
    } catch {
      return { host: hostname, family: 4 };
    }
  }

  // Hostname: resolve via DNS64
  try {
    const ipv6Addresses = await resolveIPv6(hostname);
    if (ipv6Addresses && ipv6Addresses.length > 0) {
      // Select a random address for basic load distribution (RFC 3484)
      const selected = ipv6Addresses[Math.floor(Math.random() * ipv6Addresses.length)];
      log.debug(`Resolved ${hostname} → ${selected} (${ipv6Addresses.length} records)`);
      return { host: selected, family: 6 };
    }
  } catch {
    // Fall through to direct connection
  }

  return { host: hostname, family: 4 };
}

/**
 * Create an HTTP/HTTPS proxy server with DNS64 support.
 *
 * @param {number} port - Port to listen on (default: 8080)
 * @returns {Promise<http.Server>} Resolves with the server once it's listening
 */
function createProxy(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(`http://${req.headers.host}${req.url}`);
        const hostname = url.hostname;
        const { host: targetHost, family: ipFamily } = await resolveTarget(hostname);

        const options = {
          hostname: targetHost,
          port: url.port || 80,
          path: url.pathname + url.search,
          method: req.method,
          headers: req.headers,
          family: ipFamily,
          timeout: CONNECTION_TIMEOUT,
        };

        const proxy = http.request(options, (proxyRes) => {
          res.writeHead(proxyRes.statusCode, proxyRes.headers);
          proxyRes.pipe(res);
          proxyRes.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(502).end('Bad Gateway');
            }
          });
        });

        proxy.on('error', (err) => {
          log.warn(`Proxy error for ${hostname}: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(502).end('Bad Gateway');
          }
        });

        proxy.on('timeout', () => {
          proxy.destroy();
          if (!res.headersSent) {
            res.writeHead(504).end('Gateway Timeout');
          }
        });

        req.pipe(proxy);
        req.on('error', () => proxy.destroy());
      } catch (err) {
        log.error(`Request handler error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500).end('Internal Server Error');
        }
      }
    });

    // HTTPS CONNECT tunnel handler
    server.on('connect', async (req, socket, head) => {
      try {
        const [hostname, rawPort] = req.url.split(':');
        const targetPort = parseInt(rawPort, 10) || 443;

        if (targetPort < 1 || targetPort > 65535) {
          socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }

        const { host: targetHost, family: ipFamily } = await resolveTarget(hostname);

        const conn = net.connect(
          { port: targetPort, host: targetHost, family: ipFamily },
          () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            conn.write(head);
            conn.pipe(socket).pipe(conn);
          }
        );

        conn.on('error', () => socket.end());
        socket.on('error', () => conn.end());
        conn.setTimeout(CONNECTION_TIMEOUT, () => {
          conn.destroy();
          socket.end();
        });
      } catch {
        socket.end();
      }
    });

    server.on('error', (err) => {
      reject(new Error(`Failed to start proxy: ${err.message}`));
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

module.exports = { createProxy };

