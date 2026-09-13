/**
 * Shared test helpers.
 *
 * Tests must not depend on network connectivity, so everything here runs
 * against local servers on ephemeral ports.
 */

process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';

const http = require('http');
const net = require('net');
const path = require('path');

/** Start an HTTP server that echoes the request it received. */
function startEchoServer(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        }));
      });
    });
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  });
}

/** Start a TCP server that echoes back whatever it receives, prefixed. */
function startTcpEchoServer(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.on('data', (d) => socket.write('ECHO:' + d.toString()));
    });
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  });
}

/** Send a raw request to the proxy and collect the response. */
function rawRequest(port, payload, { host = '127.0.0.1', waitMs = 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => socket.write(payload));
    let buffer = '';
    socket.on('data', (d) => { buffer += d.toString(); });
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(buffer);
    }, waitMs);
  });
}

/** Split a raw HTTP response into its status line, headers and body. */
function parseResponse(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const lines = head.split('\r\n');
  return {
    status: lines[0] || '',
    statusCode: Number((lines[0] || '').split(' ')[1]),
    headers: lines.slice(1).join('\n'),
    body: rest.join('\r\n\r\n'),
  };
}

/** Extract a JSON body from a chunked HTTP response. */
function parseChunkedJson(body) {
  const match = body.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : null;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Reload every source module so environment changes take effect.
 *
 * Config is captured at module load, so a partial reload leaves some modules
 * holding a stale config object — clear them all.
 */
function reloadModules() {
  const srcDir = path.resolve(__dirname, '..', 'src');
  for (const id of Object.keys(require.cache)) {
    if (id.startsWith(srcDir + path.sep)) delete require.cache[id];
  }
}

/** Check whether IPv6 loopback is usable in this environment. */
async function hasIPv6Loopback() {
  try {
    const server = await startTcpEchoServer('::1');
    await closeServer(server);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  startEchoServer,
  startTcpEchoServer,
  rawRequest,
  parseResponse,
  parseChunkedJson,
  closeServer,
  reloadModules,
  hasIPv6Loopback,
};
