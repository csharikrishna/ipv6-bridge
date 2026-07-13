/**
 * IPv6 Bridge - HTTP/HTTPS Proxy
 *
 * Implements application-level NAT64 (RFC 6146) by intercepting HTTP/HTTPS
 * requests, resolving hostnames via DNS64, and routing through IPv6.
 *
 * @module proxy
 */

const http = require('http');
const net = require('net');
const { resolveIPv6, detectIPVersion } = require('./dns64');
const { DEFAULT_PORT } = require('./config');

/**
 * Resolve a target host to an IPv6 address if needed.
 *
 * @param {string} hostname - The hostname or IP to resolve
 * @returns {Promise<{host: string, family: number}>} Resolved host and IP family
 */
async function resolveTarget(hostname) {
  const ipVersion = detectIPVersion(hostname);

  if (ipVersion === 'ipv6') {
    return { host: hostname, family: 6 };
  }

  // For both IPv4 addresses and hostnames, use DNS64 resolution
  // to get an IPv6 address with the NAT64 prefix.
  try {
    const ipv6Addresses = await resolveIPv6(hostname);
    if (ipv6Addresses && ipv6Addresses.length > 0) {
      return { host: ipv6Addresses[0], family: 6 };
    }
  } catch {
    // Fall through to direct connection
  }

  return { host: hostname, family: 4 };
}

/**
 * Create an HTTP/HTTPS proxy server with NAT64 support.
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
          timeout: 10000,
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

        proxy.on('error', () => {
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
      } catch {
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
        conn.setTimeout(10000, () => {
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
