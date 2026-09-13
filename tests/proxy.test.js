process.env.LOG_LEVEL = 'silent';

const { test, describe, before, after } = require('node:test');
const assert = require('assert');
const net = require('net');
const {
  startEchoServer,
  startTcpEchoServer,
  rawRequest,
  parseResponse,
  parseChunkedJson,
  closeServer,
  hasIPv6Loopback,
} = require('./helpers');
const {
  createProxy,
  sanitizeHeaders,
  parseRequestTarget,
  parseAuthority,
  checkAccess,
  buildPacFile,
  cidrToMask,
} = require('../src/proxy');
const { resolveCandidates } = require('../src/dns64');

describe('parseRequestTarget', () => {
  test('parses absolute-form targets sent by proxy clients', () => {
    const url = parseRequestTarget({
      url: 'http://example.com/path?q=1',
      headers: { host: 'example.com' },
    });
    assert.strictEqual(url.hostname, 'example.com');
    assert.strictEqual(url.pathname, '/path');
    assert.strictEqual(url.search, '?q=1');
  });

  test('falls back to origin-form using the Host header', () => {
    const url = parseRequestTarget({ url: '/path', headers: { host: 'example.com:8080' } });
    assert.strictEqual(url.hostname, 'example.com');
    assert.strictEqual(url.port, '8080');
  });

  test('returns null when the target cannot be determined', () => {
    assert.strictEqual(parseRequestTarget({ url: '/path', headers: {} }), null);
    assert.strictEqual(parseRequestTarget({ url: 'http://[bad', headers: { host: 'x' } }), null);
  });
});

describe('parseAuthority', () => {
  test('parses host:port', () => {
    assert.deepStrictEqual(parseAuthority('example.com:443'), { hostname: 'example.com', port: 443 });
    assert.deepStrictEqual(parseAuthority('example.com:8443'), { hostname: 'example.com', port: 8443 });
  });

  test('parses bracketed IPv6 literals', () => {
    assert.deepStrictEqual(parseAuthority('[::1]:443'), { hostname: '::1', port: 443 });
    assert.deepStrictEqual(parseAuthority('[2001:db8::1]:8443'), { hostname: '2001:db8::1', port: 8443 });
    assert.deepStrictEqual(parseAuthority('[::1]'), { hostname: '::1', port: 443 });
  });

  test('parses a bare IPv6 literal without mangling it', () => {
    assert.deepStrictEqual(parseAuthority('2001:db8::1'), { hostname: '2001:db8::1', port: 443 });
  });

  test('defaults to port 443 when omitted', () => {
    assert.deepStrictEqual(parseAuthority('example.com'), { hostname: 'example.com', port: 443 });
  });

  test('rejects malformed authorities', () => {
    assert.strictEqual(parseAuthority('example.com:notaport'), null);
    assert.strictEqual(parseAuthority(''), null);
  });
});

describe('sanitizeHeaders', () => {
  test('removes hop-by-hop headers', () => {
    const result = sanitizeHeaders({
      host: 'example.com',
      connection: 'keep-alive',
      'proxy-connection': 'keep-alive',
      'proxy-authorization': 'Basic secret',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      'x-keep': 'yes',
    });
    assert.deepStrictEqual(result, { host: 'example.com', 'x-keep': 'yes' });
  });

  test('never forwards proxy credentials to the origin', () => {
    const result = sanitizeHeaders({ 'proxy-authorization': 'Basic c2VjcmV0' });
    assert.strictEqual(result['proxy-authorization'], undefined);
  });

  test('removes headers named by the Connection header', () => {
    const result = sanitizeHeaders({
      connection: 'keep-alive, X-Custom-Hop',
      'x-custom-hop': 'drop me',
      'x-keep': 'yes',
    });
    assert.strictEqual(result['x-custom-hop'], undefined);
    assert.strictEqual(result['x-keep'], 'yes');
  });
});

describe('resolveCandidates', () => {
  test('passes IPv6 literals through untouched', async () => {
    assert.deepStrictEqual(await resolveCandidates('2001:db8::1'), [
      { host: '2001:db8::1', family: 6, mode: 'ipv6-literal' },
    ]);
  });

  test('synthesizes global IPv4 literals through NAT64, with a direct fallback', async () => {
    const candidates = await resolveCandidates('8.8.8.8');
    assert.strictEqual(candidates[0].mode, 'nat64');
    assert.strictEqual(candidates[0].family, 6);
    assert.strictEqual(candidates[0].host, '64:ff9b::808:808');
    assert.strictEqual(candidates[1].mode, 'direct-ipv4');
  });

  test('does not synthesize non-global IPv4 with the well-known prefix (RFC 6052 3.1)', async () => {
    for (const address of ['127.0.0.1', '192.168.1.1', '10.0.0.5', '169.254.1.1']) {
      const candidates = await resolveCandidates(address);
      assert.strictEqual(candidates.length, 1, `${address} should have exactly one route`);
      assert.strictEqual(candidates[0].host, address);
      assert.strictEqual(candidates[0].family, 4);
      assert.strictEqual(candidates[0].mode, 'direct-ipv4');
    }
  });

  test('orders native IPv6 ahead of synthesized addresses', async () => {
    const candidates = await resolveCandidates('localhost');
    const modes = candidates.map((c) => c.mode);
    if (modes.includes('native-ipv6')) {
      assert.strictEqual(modes[0], 'native-ipv6', 'native IPv6 must be preferred');
    }
    assert.ok(candidates.length > 0);
  });
});

describe('checkAccess', () => {
  test('allows any client when no auth or allowlist is configured', () => {
    assert.deepStrictEqual(checkAccess('192.168.1.50', {}), { allowed: true });
  });
});

describe('PAC generation', () => {
  test('produces a PAC file pointing at the proxy', () => {
    const pac = buildPacFile('127.0.0.1', 8080);
    assert.match(pac, /function FindProxyForURL/);
    assert.match(pac, /PROXY 127\.0\.0\.1:8080/);
    assert.match(pac, /return "DIRECT"/);
  });

  test('rewrites a wildcard bind to a reachable address', () => {
    assert.match(buildPacFile('::', 8080), /PROXY 127\.0\.0\.1:8080/);
  });

  test('converts CIDR lengths to dotted masks', () => {
    assert.strictEqual(cidrToMask(24), '255.255.255.0');
    assert.strictEqual(cidrToMask(8), '255.0.0.0');
    assert.strictEqual(cidrToMask(32), '255.255.255.255');
    assert.strictEqual(cidrToMask(0), '0.0.0.0');
  });
});

describe('proxy server', () => {
  let origin;
  let proxy;

  before(async () => {
    origin = await startEchoServer('127.0.0.1');
    proxy = await createProxy(0);
  });

  after(async () => {
    await proxy.closeGracefully();
    await closeServer(origin);
  });

  test('binds to loopback by default', () => {
    assert.strictEqual(proxy.address().address, '127.0.0.1');
  });

  test('proxies an absolute-form GET request end to end', async () => {
    const originPort = origin.address().port;
    const raw = await rawRequest(proxy.address().port,
      `GET http://127.0.0.1:${originPort}/hello?q=1 HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);

    const res = parseResponse(raw);
    assert.strictEqual(res.statusCode, 200, `expected 200, got: ${res.status}`);

    const echoed = parseChunkedJson(res.body);
    assert.strictEqual(echoed.url, '/hello?q=1');
    assert.strictEqual(echoed.method, 'GET');
  });

  test('proxies an origin-form GET request', async () => {
    const originPort = origin.address().port;
    const raw = await rawRequest(proxy.address().port,
      `GET /origin-form HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\nConnection: close\r\n\r\n`);

    const res = parseResponse(raw);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(parseChunkedJson(res.body).url, '/origin-form');
  });

  test('forwards a request body', async () => {
    const originPort = origin.address().port;
    const raw = await rawRequest(proxy.address().port,
      `POST http://127.0.0.1:${originPort}/submit HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${originPort}\r\nContent-Type: text/plain\r\n` +
      `Content-Length: 11\r\nConnection: close\r\n\r\nhello world`);

    const res = parseResponse(raw);
    assert.strictEqual(res.statusCode, 200);
    const echoed = parseChunkedJson(res.body);
    assert.strictEqual(echoed.body, 'hello world');
    assert.strictEqual(echoed.method, 'POST');
  });

  test('strips hop-by-hop headers before reaching the origin', async () => {
    const originPort = origin.address().port;
    const raw = await rawRequest(proxy.address().port,
      `GET http://127.0.0.1:${originPort}/headers HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${originPort}\r\nProxy-Authorization: Basic c2VjcmV0\r\n` +
      `Proxy-Connection: keep-alive\r\nX-Keep: yes\r\nConnection: close\r\n\r\n`);

    const echoed = parseChunkedJson(parseResponse(raw).body);
    assert.strictEqual(echoed.headers['proxy-authorization'], undefined,
      'proxy credentials must never reach the origin server');
    assert.strictEqual(echoed.headers['proxy-connection'], undefined);
    assert.strictEqual(echoed.headers['x-keep'], 'yes');
  });

  test('returns 400 for an unparseable request target', async () => {
    const raw = await rawRequest(proxy.address().port,
      `GET http://[bad HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.strictEqual(parseResponse(raw).statusCode, 400);
  });

  test('returns 502 when the upstream is unreachable', async () => {
    // Port 1 on loopback has nothing listening.
    const raw = await rawRequest(proxy.address().port,
      `GET http://127.0.0.1:1/nope HTTP/1.1\r\nHost: 127.0.0.1:1\r\nConnection: close\r\n\r\n`);
    assert.strictEqual(parseResponse(raw).statusCode, 502);
  });
});

describe('CONNECT tunnelling', () => {
  let proxy;
  let tcpServer;

  before(async () => {
    proxy = await createProxy(0);
    tcpServer = await startTcpEchoServer('127.0.0.1');
  });

  after(async () => {
    await proxy.closeGracefully();
    await closeServer(tcpServer);
  });

  test('establishes a tunnel to an IPv4 target and relays data', async () => {
    const port = tcpServer.address().port;
    const raw = await rawRequest(proxy.address().port,
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\nPING`);

    assert.ok(raw.startsWith('HTTP/1.1 200 Connection Established'), `got: ${raw.slice(0, 60)}`);
    assert.ok(raw.includes('ECHO:PING'), 'tunnel should relay payload bytes');
  });

  test('establishes a tunnel to a bracketed IPv6 literal', async (t) => {
    if (!await hasIPv6Loopback()) return t.skip('IPv6 loopback unavailable');

    const server = await startTcpEchoServer('::1');
    try {
      const port = server.address().port;
      const raw = await rawRequest(proxy.address().port,
        `CONNECT [::1]:${port} HTTP/1.1\r\nHost: [::1]:${port}\r\n\r\nPING6`);

      assert.ok(raw.startsWith('HTTP/1.1 200 Connection Established'), `got: ${raw.slice(0, 60)}`);
      assert.ok(raw.includes('ECHO:PING6'));
    } finally {
      await closeServer(server);
    }
  });

  test('returns 400 for a malformed CONNECT target', async () => {
    const raw = await rawRequest(proxy.address().port,
      `CONNECT not:a:port HTTP/1.1\r\nHost: x\r\n\r\n`);
    assert.ok(raw.startsWith('HTTP/1.1 400'), `got: ${raw.slice(0, 40)}`);
  });

  test('returns 502 instead of hanging when the target refuses', async () => {
    const raw = await rawRequest(proxy.address().port,
      `CONNECT 127.0.0.1:1 HTTP/1.1\r\nHost: 127.0.0.1:1\r\n\r\n`);
    assert.ok(raw.startsWith('HTTP/1.1 502'), `got: ${raw.slice(0, 40) || '(silent hang)'}`);
  });
});

describe('lifecycle', () => {
  test('rejects when the port is already in use', async () => {
    const first = await createProxy(0);
    const port = first.address().port;

    await assert.rejects(
      () => createProxy(port),
      (err) => err.message.includes('Failed to start proxy')
    );

    await first.closeGracefully();
  });

  test('closeGracefully resolves even with an open CONNECT tunnel', async () => {
    const proxy = await createProxy(0);
    const tcpServer = await startTcpEchoServer('127.0.0.1');
    const targetPort = tcpServer.address().port;

    const client = net.connect(proxy.address().port, '127.0.0.1', () => {
      client.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nHost: x\r\n\r\n`);
    });
    await new Promise((resolve) => client.once('data', resolve));

    const closed = await Promise.race([
      proxy.closeGracefully().then(() => 'closed'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 3000)),
    ]);

    assert.strictEqual(closed, 'closed', 'close must not wait forever on tunnels');

    client.destroy();
    await closeServer(tcpServer);
  });
});
