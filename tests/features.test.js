process.env.LOG_LEVEL = 'silent';

const { test, describe, afterEach } = require('node:test');
const assert = require('assert');
const net = require('net');
const {
  startEchoServer,
  startTcpEchoServer,
  rawRequest,
  parseResponse,
  closeServer,
  reloadModules,
} = require('./helpers');

const originalEnv = { ...process.env };

function reloadWith(env = {}) {
  for (const key of ['IPV6_BRIDGE_AUTH', 'IPV6_BRIDGE_ALLOW', 'IPV6_BRIDGE_BYPASS', 'IPV6_BRIDGE_CONTROL']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  reloadModules();
  return require('../src/proxy');
}

afterEach(() => {
  process.env = { ...originalEnv };
  reloadWith();
});

describe('control endpoints', () => {
  test('serves health, status, metrics and PAC', async () => {
    const { createProxy } = reloadWith();
    const proxy = await createProxy(0);
    const port = proxy.address().port;

    try {
      const health = parseResponse(await rawRequest(port,
        'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      assert.strictEqual(health.statusCode, 200);
      assert.match(health.body, /"status"\s*:\s*"ok"/);

      const status = parseResponse(await rawRequest(port,
        'GET /status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      assert.strictEqual(status.statusCode, 200);
      assert.match(status.body, /uptimeSeconds/);
      assert.match(status.body, /nat64Prefix/);

      const metrics = parseResponse(await rawRequest(port,
        'GET /metrics HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      assert.strictEqual(metrics.statusCode, 200);
      assert.match(metrics.body, /ipv6_bridge_uptime_seconds/);

      const pac = parseResponse(await rawRequest(port,
        'GET /proxy.pac HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      assert.strictEqual(pac.statusCode, 200);
      assert.match(pac.body, /FindProxyForURL/);
    } finally {
      await proxy.closeGracefully();
    }
  });

  test('can be disabled', async () => {
    const { createProxy } = reloadWith({ IPV6_BRIDGE_CONTROL: 'off' });
    const proxy = await createProxy(0);
    try {
      const res = parseResponse(await rawRequest(proxy.address().port,
        'GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:1\r\nConnection: close\r\n\r\n'));
      // Falls through to proxying, which fails against a dead port.
      assert.notStrictEqual(res.statusCode, 200);
    } finally {
      await proxy.closeGracefully();
    }
  });

  test('reports the translation rate in status output', async () => {
    const { createProxy } = reloadWith();
    const proxy = await createProxy(0);
    try {
      const status = parseResponse(await rawRequest(proxy.address().port,
        'GET /status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      const body = JSON.parse(status.body.replace(/^[0-9a-f]+\r\n/, '').replace(/\r\n0\r\n\r\n$/, ''));
      assert.ok('translationRate' in body);
      assert.ok('routes' in body);
    } finally {
      await proxy.closeGracefully();
    }
  });
});

describe('authentication', () => {
  test('rejects requests without credentials', async () => {
    const { createProxy } = reloadWith({ IPV6_BRIDGE_AUTH: 'user:secret' });
    const proxy = await createProxy(0);
    const origin = await startEchoServer('127.0.0.1');

    try {
      const res = parseResponse(await rawRequest(proxy.address().port,
        `GET http://127.0.0.1:${origin.address().port}/ HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\nConnection: close\r\n\r\n`));

      assert.strictEqual(res.statusCode, 407);
      assert.match(res.headers, /Proxy-Authenticate: Basic/i);
    } finally {
      await proxy.closeGracefully();
      await closeServer(origin);
    }
  });

  test('accepts correct credentials', async () => {
    const { createProxy } = reloadWith({ IPV6_BRIDGE_AUTH: 'user:secret' });
    const proxy = await createProxy(0);
    const origin = await startEchoServer('127.0.0.1');
    const credentials = Buffer.from('user:secret').toString('base64');

    try {
      const res = parseResponse(await rawRequest(proxy.address().port,
        `GET http://127.0.0.1:${origin.address().port}/ok HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\nProxy-Authorization: Basic ${credentials}\r\n` +
        `Connection: close\r\n\r\n`));

      assert.strictEqual(res.statusCode, 200);
    } finally {
      await proxy.closeGracefully();
      await closeServer(origin);
    }
  });

  test('rejects wrong credentials', async () => {
    const { createProxy } = reloadWith({ IPV6_BRIDGE_AUTH: 'user:secret' });
    const proxy = await createProxy(0);
    const wrong = Buffer.from('user:wrong').toString('base64');

    try {
      const res = parseResponse(await rawRequest(proxy.address().port,
        `GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n` +
        `Proxy-Authorization: Basic ${wrong}\r\nConnection: close\r\n\r\n`));
      assert.strictEqual(res.statusCode, 407);
    } finally {
      await proxy.closeGracefully();
    }
  });

  test('leaves /healthz reachable so load balancers still work', async () => {
    const { createProxy } = reloadWith({ IPV6_BRIDGE_AUTH: 'user:secret' });
    const proxy = await createProxy(0);
    try {
      const res = parseResponse(await rawRequest(proxy.address().port,
        'GET /healthz HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
      assert.strictEqual(res.statusCode, 200);
    } finally {
      await proxy.closeGracefully();
    }
  });

  test('requires credentials on CONNECT too', async () => {
    const { createProxy } = reloadWith({ IPV6_BRIDGE_AUTH: 'user:secret' });
    const proxy = await createProxy(0);
    try {
      const raw = await rawRequest(proxy.address().port,
        'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      assert.ok(raw.startsWith('HTTP/1.1 407'), `got: ${raw.slice(0, 40)}`);
    } finally {
      await proxy.closeGracefully();
    }
  });
});

describe('client allowlist', () => {
  test('rejects clients outside the allowlist', async () => {
    const { createProxy } = reloadWith({ IPV6_BRIDGE_ALLOW: '10.0.0.0/8' });
    const proxy = await createProxy(0);
    try {
      const res = parseResponse(await rawRequest(proxy.address().port,
        'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n'));
      assert.strictEqual(res.statusCode, 403, 'loopback client is not in 10.0.0.0/8');
    } finally {
      await proxy.closeGracefully();
    }
  });

  test('admits clients inside the allowlist', async () => {
    const { createProxy } = reloadWith({ IPV6_BRIDGE_ALLOW: '127.0.0.0/8' });
    const proxy = await createProxy(0);
    const origin = await startEchoServer('127.0.0.1');
    try {
      const res = parseResponse(await rawRequest(proxy.address().port,
        `GET http://127.0.0.1:${origin.address().port}/ok HTTP/1.1\r\n` +
        `Host: 127.0.0.1\r\nConnection: close\r\n\r\n`));
      assert.strictEqual(res.statusCode, 200);
    } finally {
      await proxy.closeGracefully();
      await closeServer(origin);
    }
  });
});

describe('connection failover', () => {
  test('falls back to a working candidate when the first is unreachable', async () => {
    const { connectWithFallback } = require('../src/connect');
    const server = await startTcpEchoServer('127.0.0.1');
    const port = server.address().port;

    try {
      // "localhost" typically resolves to both ::1 and 127.0.0.1. Whichever is
      // unreachable, the other must still be tried.
      const { socket } = await connectWithFallback('localhost', port);
      assert.ok(socket, 'a connection should have been established');
      socket.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('reports every attempted address when all candidates fail', async () => {
    const { connectWithFallback } = require('../src/connect');
    await assert.rejects(
      () => connectWithFallback('127.0.0.1', 1),
      (err) => {
        assert.strictEqual(err.code, 'EHOSTUNREACH');
        assert.match(err.message, /tried/);
        return true;
      }
    );
  });

  test('bypass connects directly without synthesizing', async () => {
    const { connectWithFallback } = require('../src/connect');
    const server = await startTcpEchoServer('127.0.0.1');
    try {
      const { socket, candidate } = await connectWithFallback(
        '127.0.0.1', server.address().port, { bypass: true }
      );
      assert.strictEqual(candidate.mode, 'bypassed');
      socket.destroy();
    } finally {
      await closeServer(server);
    }
  });
});

describe('DNS caching', () => {
  test('serves repeat lookups from cache', async () => {
    reloadWith();
    const { resolveCandidates, dnsCache } = require('../src/dns64');
    dnsCache.clear();

    await resolveCandidates('localhost');
    const afterFirst = dnsCache.stats();
    await resolveCandidates('localhost');
    const afterSecond = dnsCache.stats();

    assert.strictEqual(afterSecond.hits, afterFirst.hits + 1, 'second lookup should hit the cache');
  });

  test('does not cache IP literals', async () => {
    reloadWith();
    const { resolveCandidates, dnsCache } = require('../src/dns64');
    dnsCache.clear();

    await resolveCandidates('8.8.8.8');
    assert.strictEqual(dnsCache.stats().size, 0, 'literals need no DNS lookup to cache');
  });
});

describe('SOCKS5', () => {
  const VERSION = 0x05;

  /** Drive a SOCKS5 CONNECT handshake and return the reply plus echoed data. */
  function socksConnect(proxyPort, host, targetPort, { credentials = null, payload = 'PING' } = {}) {
    return new Promise((resolve) => {
      const socket = net.connect(proxyPort, '127.0.0.1');
      const chunks = [];
      let stage = 'greeting';

      socket.on('connect', () => {
        socket.write(Buffer.from(credentials ? [VERSION, 1, 0x02] : [VERSION, 1, 0x00]));
      });

      socket.on('data', (data) => {
        chunks.push(data);

        if (stage === 'greeting') {
          if (credentials) {
            stage = 'auth';
            const [user, pass] = credentials;
            socket.write(Buffer.concat([
              Buffer.from([0x01, user.length]), Buffer.from(user),
              Buffer.from([pass.length]), Buffer.from(pass),
            ]));
            return;
          }
          stage = 'request';
          sendRequest();
          return;
        }

        if (stage === 'auth') {
          if (data[1] !== 0x00) {
            socket.destroy();
            return resolve({ authFailed: true, chunks });
          }
          stage = 'request';
          sendRequest();
          return;
        }

        if (stage === 'request') {
          stage = 'tunnel';
          const reply = data;
          if (reply[1] !== 0x00) {
            socket.destroy();
            return resolve({ replyCode: reply[1], chunks });
          }
          socket.write(payload);
          return;
        }

        resolve({ replyCode: 0, echoed: data.toString(), chunks });
        socket.destroy();
      });

      function sendRequest() {
        const hostBuffer = Buffer.from(host);
        const message = Buffer.concat([
          Buffer.from([VERSION, 0x01, 0x00, 0x03, hostBuffer.length]),
          hostBuffer,
          (() => { const p = Buffer.alloc(2); p.writeUInt16BE(targetPort); return p; })(),
        ]);
        socket.write(message);
      }

      socket.on('error', () => resolve({ error: true, chunks }));
      setTimeout(() => { socket.destroy(); resolve({ timedOut: true, chunks }); }, 4000);
    });
  }

  test('tunnels arbitrary TCP through CONNECT', async () => {
    reloadWith();
    const { createSocksServer } = require('../src/socks5');
    const socks = await createSocksServer(0, '127.0.0.1');
    const target = await startTcpEchoServer('127.0.0.1');

    try {
      const result = await socksConnect(
        socks.address().port, '127.0.0.1', target.address().port
      );
      assert.strictEqual(result.replyCode, 0, 'handshake should succeed');
      assert.strictEqual(result.echoed, 'ECHO:PING', 'data should flow through the tunnel');
    } finally {
      await socks.closeGracefully();
      await closeServer(target);
    }
  });

  test('reports host-unreachable when the target refuses', async () => {
    reloadWith();
    const { createSocksServer } = require('../src/socks5');
    const socks = await createSocksServer(0, '127.0.0.1');

    try {
      const result = await socksConnect(socks.address().port, '127.0.0.1', 1);
      assert.ok(result.replyCode !== 0, 'should report a failure reply code');
    } finally {
      await socks.closeGracefully();
    }
  });

  test('enforces username/password authentication', async () => {
    reloadWith({ IPV6_BRIDGE_AUTH: 'user:secret' });
    const { createSocksServer } = require('../src/socks5');
    const socks = await createSocksServer(0, '127.0.0.1');
    const target = await startTcpEchoServer('127.0.0.1');

    try {
      const good = await socksConnect(socks.address().port, '127.0.0.1', target.address().port,
        { credentials: ['user', 'secret'] });
      assert.strictEqual(good.replyCode, 0, 'correct credentials should be accepted');

      const bad = await socksConnect(socks.address().port, '127.0.0.1', target.address().port,
        { credentials: ['user', 'wrong'] });
      assert.ok(bad.authFailed, 'wrong credentials should be rejected');
    } finally {
      await socks.closeGracefully();
      await closeServer(target);
    }
  });
});
