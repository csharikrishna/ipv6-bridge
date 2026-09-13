/**
 * IPv6 Bridge - HTTP/HTTPS Proxy
 *
 * DNS64-aware forward proxy. It accepts HTTP requests and CONNECT tunnels,
 * resolves the target through DNS64, and routes traffic over IPv6 so an
 * upstream NAT64 gateway can reach IPv4-only servers.
 *
 * @module proxy
 */

const http = require('http');
const { detectIPVersion, dnsCache } = require('./dns64');
const { connectWithFallback, BridgeAgent } = require('./connect');
const config = require('./config');
const stats = require('./stats');
const log = require('./logger');

/**
 * Headers that apply to a single transport hop and must not be forwarded
 * (RFC 7230 section 6.1). Proxy-Authorization is credentials for this proxy;
 * forwarding it leaks them to every origin server.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'proxy-connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const CONTROL_PATHS = new Set(['/healthz', '/status', '/metrics', '/proxy.pac']);

/**
 * Remove hop-by-hop headers, including any listed in the Connection header.
 *
 * @param {object} headers - Incoming headers
 * @returns {object} Headers safe to forward
 */
function sanitizeHeaders(headers) {
  const connectionTokens = new Set();
  const connection = headers.connection || headers.Connection;
  if (connection) {
    for (const token of String(connection).split(',')) {
      connectionTokens.add(token.trim().toLowerCase());
    }
  }

  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    result[name] = value;
  }
  return result;
}

/**
 * Strip brackets from an IPv6 literal host ("[::1]" -> "::1").
 *
 * @param {string} host - Host which may be a bracketed IPv6 literal
 * @returns {string} Bare host
 */
function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isAbsoluteForm(target) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target);
}

/**
 * Parse the request target of a proxied HTTP request.
 *
 * Clients configured to use a forward proxy send absolute-form targets
 * ("GET http://example.com/path HTTP/1.1", RFC 7230 section 5.3.2).
 * Origin-form is accepted as a fallback for direct/gateway-style use.
 *
 * @param {http.IncomingMessage} req - Incoming request
 * @returns {URL|null} Parsed target, or null if it cannot be determined
 */
function parseRequestTarget(req) {
  try {
    if (isAbsoluteForm(req.url)) return new URL(req.url);
    if (!req.headers.host) return null;
    return new URL(`http://${req.headers.host}${req.url}`);
  } catch {
    return null;
  }
}

/**
 * Parse a CONNECT authority ("example.com:443", "[::1]:443", "10.0.0.1:8443").
 *
 * @param {string} authority - The CONNECT request target
 * @returns {{hostname: string, port: number}|null} Parsed target, or null if malformed
 */
function parseAuthority(authority) {
  if (!authority) return null;

  if (detectIPVersion(authority) === 'ipv6') return { hostname: authority, port: 443 };

  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority);
  if (bracketed) {
    return { hostname: bracketed[1], port: bracketed[2] ? Number(bracketed[2]) : 443 };
  }

  const separator = authority.lastIndexOf(':');
  if (separator === -1) return { hostname: authority, port: 443 };

  const port = authority.slice(separator + 1);
  if (!/^\d+$/.test(port)) return null;

  return { hostname: authority.slice(0, separator), port: Number(port) };
}

/**
 * Constant-time-ish comparison for credentials.
 *
 * @param {string} a - First value
 * @param {string} b - Second value
 * @returns {boolean} true if equal
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Decide whether a client may use the proxy.
 *
 * @param {string} remoteAddress - Client address
 * @param {object} headers - Request headers
 * @returns {{allowed: boolean, status?: number, reason?: string}} Access decision
 */
function checkAccess(remoteAddress, headers) {
  if (!config.ALLOW_FROM.isEmpty && !config.ALLOW_FROM.matches(remoteAddress)) {
    return { allowed: false, status: 403, reason: `client ${remoteAddress} is not in the allowlist` };
  }

  if (config.AUTH) {
    const provided = headers['proxy-authorization'];
    if (!provided || !safeEqual(provided.trim(), config.AUTH.header)) {
      return { allowed: false, status: 407, reason: 'missing or invalid proxy credentials' };
    }
  }

  return { allowed: true };
}

function shouldBypass(hostname) {
  return !config.BYPASS.isEmpty && config.BYPASS.matches(hostname);
}

/**
 * Build the PAC file describing how clients should route through the bridge.
 *
 * @param {string} host - Proxy host as clients should reach it
 * @param {number} port - Proxy port
 * @returns {string} PAC script
 */
function buildPacFile(host, port) {
  const proxyHost = host === '::' || host === '0.0.0.0' ? '127.0.0.1' : host;
  const bypassRules = config.BYPASS.rules;

  const bypassChecks = bypassRules.map((rule) => {
    if (rule.startsWith('*.')) {
      return `  if (dnsDomainIs(host, ${JSON.stringify(rule.slice(1))})) return "DIRECT";`;
    }
    if (rule.includes('/')) {
      const [network, bits] = rule.split('/');
      return `  if (isInNet(host, ${JSON.stringify(network)}, ${JSON.stringify(cidrToMask(Number(bits)))})) return "DIRECT";`;
    }
    return `  if (host === ${JSON.stringify(rule)}) return "DIRECT";`;
  }).join('\n');

  return `function FindProxyForURL(url, host) {
  // Loopback and local names never need the bridge.
  if (isPlainHostName(host) ||
      shExpMatch(host, "localhost") ||
      isInNet(host, "127.0.0.0", "255.0.0.0")) {
    return "DIRECT";
  }
${bypassChecks ? bypassChecks + '\n' : ''}
  return "PROXY ${proxyHost}:${port}";
}
`;
}

function cidrToMask(bits) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return '255.255.255.255';
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return [24, 16, 8, 0].map((shift) => (mask >>> shift) & 0xff).join('.');
}

/**
 * Serve an operational endpoint (health, status, metrics, PAC).
 *
 * @param {string} path - Request path
 * @param {http.ServerResponse} res - Response to write to
 * @param {{host: string, port: number}} address - Proxy listen address
 */
function serveControl(path, res, address) {
  const extra = () => ({
    dnsCache: dnsCache.stats(),
    nat64Prefix: `${config.getPrefix().prefix}/${config.getPrefix().length}`,
  });

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (path === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats.snapshot(extra()), null, 2));
    return;
  }

  if (path === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(stats.toPrometheus(extra()));
    return;
  }

  if (path === '/proxy.pac') {
    res.writeHead(200, { 'Content-Type': 'application/x-ns-proxy-autoconfig' });
    res.end(buildPacFile(address.host, address.port));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not Found');
}

function createRequestHandler(agent, address) {
  return function handleRequest(req, res) {
    const path = isAbsoluteForm(req.url) ? null : req.url.split('?')[0];
    const isControlRequest = config.CONTROL_ENDPOINTS && path && CONTROL_PATHS.has(path);

    // Health checks must work without credentials so load balancers can use them.
    if (isControlRequest && path === '/healthz') {
      serveControl(path, res, address);
      return;
    }

    const access = checkAccess(req.socket.remoteAddress, req.headers);
    if (!access.allowed) {
      stats.counters.authFailures += 1;
      log.warn(`Rejected request from ${req.socket.remoteAddress}: ${access.reason}`);
      const headers = { 'Content-Type': 'text/plain' };
      if (access.status === 407) {
        headers['Proxy-Authenticate'] = 'Basic realm="ipv6-bridge"';
      }
      res.writeHead(access.status, headers).end(
        access.status === 407 ? 'Proxy Authentication Required' : 'Forbidden'
      );
      return;
    }

    if (isControlRequest) {
      serveControl(path, res, address);
      return;
    }

    stats.counters.httpRequests += 1;

    const url = parseRequestTarget(req);
    if (!url) {
      log.warn(`Rejecting request with unparseable target: ${req.method} ${req.url}`);
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad Request');
      return;
    }

    const hostname = stripBrackets(url.hostname);
    const headers = sanitizeHeaders(req.headers);
    headers.via = `1.1 ipv6-bridge${req.headers.via ? ', ' + req.headers.via : ''}`;

    if (shouldBypass(hostname)) stats.recordRoute('bypassed');

    const proxyReq = http.request({
      host: hostname,
      port: Number(url.port) || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers,
      agent,
      timeout: config.CONNECTION_TIMEOUT,
    }, (proxyRes) => {
      stats.recordStatus(proxyRes.statusCode);

      const responseHeaders = sanitizeHeaders(proxyRes.headers);
      responseHeaders.via = `1.1 ipv6-bridge${proxyRes.headers.via ? ', ' + proxyRes.headers.via : ''}`;

      res.writeHead(proxyRes.statusCode, responseHeaders);
      proxyRes.on('data', (chunk) => { stats.counters.bytesToClient += chunk.length; });
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
    });

    proxyReq.on('error', (err) => {
      stats.counters.proxyErrors += 1;
      log.warn(`Upstream error for ${hostname}: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' }).end('Bad Gateway');
      } else {
        res.destroy();
      }
    });

    proxyReq.on('timeout', () => {
      stats.counters.timeouts += 1;
      log.warn(`Upstream timeout for ${hostname} after ${config.CONNECTION_TIMEOUT}ms`);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'text/plain' }).end('Gateway Timeout');
      } else {
        res.destroy();
      }
    });

    req.on('data', (chunk) => { stats.counters.bytesToUpstream += chunk.length; });
    req.pipe(proxyReq);
    req.on('error', () => proxyReq.destroy());
    res.on('close', () => proxyReq.destroy());
  };
}

function handleConnect(req, clientSocket, head) {
  const access = checkAccess(clientSocket.remoteAddress, req.headers);
  if (!access.allowed) {
    stats.counters.authFailures += 1;
    log.warn(`Rejected CONNECT from ${clientSocket.remoteAddress}: ${access.reason}`);
    clientSocket.end(access.status === 407
      ? 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="ipv6-bridge"\r\n\r\n'
      : 'HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }

  const target = parseAuthority(req.url);
  if (!target || target.port < 1 || target.port > 65535) {
    log.warn(`Rejecting malformed CONNECT target: ${req.url}`);
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }

  stats.counters.connectRequests += 1;

  connectWithFallback(target.hostname, target.port, { bypass: shouldBypass(target.hostname) })
    .then(({ socket: upstream, candidate }) => {
      if (clientSocket.destroyed) {
        upstream.destroy();
        return;
      }

      log.debug(`CONNECT ${req.url} -> ${candidate.host}:${target.port} via ${candidate.mode}`);

      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) upstream.write(head);

      upstream.on('data', (chunk) => { stats.counters.bytesToClient += chunk.length; });
      clientSocket.on('data', (chunk) => { stats.counters.bytesToUpstream += chunk.length; });

      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);

      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
      clientSocket.on('close', () => upstream.destroy());
    })
    .catch((err) => {
      stats.counters.proxyErrors += 1;
      log.warn(`CONNECT to ${target.hostname}:${target.port} failed: ${err.message}`);
      if (!clientSocket.destroyed) {
        clientSocket.end(err.code === 'ETIMEDOUT'
          ? 'HTTP/1.1 504 Gateway Timeout\r\n\r\n'
          : 'HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    });
}

/**
 * Create and start an HTTP/HTTPS proxy server with DNS64 support.
 *
 * @param {number} [port] - Port to listen on
 * @param {string} [host] - Interface to bind to (defaults to loopback)
 * @returns {Promise<http.Server>} Resolves with the server once it's listening
 */
function createProxy(port = config.DEFAULT_PORT, host = config.BIND_HOST) {
  return new Promise((resolve, reject) => {
    const agent = new BridgeAgent();
    const address = { host, port };
    const server = http.createServer(createRequestHandler(agent, address));
    const sockets = new Set();

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    server.on('connect', handleConnect);

    server.on('clientError', (err, socket) => {
      if (!socket.writable) return;
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });

    /**
     * Close the server and tear down live connections.
     *
     * server.close() alone waits for every connection to end, and CONNECT
     * tunnels are long-lived, so it would otherwise never resolve.
     */
    server.closeGracefully = () => new Promise((done) => {
      server.close(() => done());
      agent.destroy();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    });

    server.once('error', (err) => {
      reject(new Error(`Failed to start proxy: ${err.message}`));
    });

    server.listen(port, host, () => {
      const bound = server.address();
      address.port = bound.port;
      log.info(`Proxy listening on ${bound.address}:${bound.port}`);

      if (!config.isLoopbackBind(host)) {
        if (config.AUTH || !config.ALLOW_FROM.isEmpty) {
          log.info(`Proxy is reachable beyond loopback; access control is enabled.`);
        } else {
          log.warn(
            `Proxy is bound to ${bound.address} with no authentication or allowlist. ` +
            `Anyone who can reach this host can relay traffic through it. ` +
            `Set IPV6_BRIDGE_AUTH or IPV6_BRIDGE_ALLOW.`
          );
        }
      }
      resolve(server);
    });
  });
}

module.exports = {
  createProxy,
  sanitizeHeaders,
  parseRequestTarget,
  parseAuthority,
  checkAccess,
  buildPacFile,
  cidrToMask,
};
