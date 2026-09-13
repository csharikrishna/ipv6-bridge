process.env.LOG_LEVEL = 'silent';

const { test, describe, before, after } = require('node:test');
const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { closeServer } = require('./helpers');

const bridge = require('../src/index');

// Self-signed certificate for localhost/127.0.0.1, valid until 2126.
// Test fixture only — never used outside this suite.
const FIXTURES = path.join(__dirname, 'fixtures');
const TLS_OPTIONS = {
  key: fs.readFileSync(path.join(FIXTURES, 'localhost-key.pem')),
  cert: fs.readFileSync(path.join(FIXTURES, 'localhost-cert.pem')),
};
const CA = [TLS_OPTIONS.cert];

function startHttpServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, host: req.headers.host }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function startHttpsServer() {
  return new Promise((resolve) => {
    const server = https.createServer(TLS_OPTIONS, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: req.url, secure: true }));
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(lib, options) {
  return new Promise((resolve, reject) => {
    const req = lib.get(options, (res) => {
      const socket = res.socket;
      const info = {
        status: res.statusCode,
        authorized: socket.authorized,
        remote: socket.remoteAddress,
      };
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ ...info, body }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

describe('public API surface', () => {
  test('exports the embeddable primitives', () => {
    for (const name of [
      'start', 'stop',
      'createAgent', 'createHttpsAgent', 'createAgents',
      'createLookup', 'createConnector',
      'resolve', 'getStats', 'discoverPrefix',
    ]) {
      assert.strictEqual(typeof bridge[name], 'function', `${name} should be exported`);
    }
  });
});

describe('createAgent (HTTP)', () => {
  let server;

  before(async () => { server = await startHttpServer(); });
  after(async () => { await closeServer(server); });

  test('completes a request end to end', async () => {
    const agent = bridge.createAgent();
    try {
      const res = await request(http, {
        host: '127.0.0.1', port: server.address().port, path: '/hello', agent,
      });
      assert.strictEqual(res.status, 200);
      assert.match(res.body, /"url":"\/hello"/);
    } finally {
      agent.destroy();
    }
  });

  test('reuses pooled sockets across requests', async () => {
    const agent = bridge.createAgent();
    try {
      const port = server.address().port;
      await request(http, { host: '127.0.0.1', port, path: '/one', agent });
      await request(http, { host: '127.0.0.1', port, path: '/two', agent });

      const sockets = Object.values(agent.freeSockets).flat();
      assert.ok(sockets.length > 0, 'a socket should be kept alive for reuse');
    } finally {
      agent.destroy();
    }
  });

  test('surfaces a connection error rather than hanging', async () => {
    const agent = bridge.createAgent();
    try {
      await assert.rejects(
        () => request(http, { host: '127.0.0.1', port: 1, path: '/', agent }),
        (err) => err.code === 'EHOSTUNREACH' || err.code === 'ECONNREFUSED'
      );
    } finally {
      agent.destroy();
    }
  });
});

describe('createHttpsAgent', () => {
  let server;

  before(async () => { server = await startHttpsServer(); });
  after(async () => { await closeServer(server); });

  test('completes a TLS request end to end', async () => {
    const agent = bridge.createHttpsAgent();
    try {
      const res = await request(https, {
        host: '127.0.0.1', port: server.address().port, path: '/secure', agent, ca: CA,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.authorized, true, 'certificate must be validated');
      assert.match(res.body, /"secure":true/);
    } finally {
      agent.destroy();
    }
  });

  test('validates the certificate against the requested host, not the dialled address', async () => {
    // The fixture certificate covers localhost and 127.0.0.1 only. Requesting a
    // name it does not cover must fail, proving identity is actually checked.
    const agent = bridge.createHttpsAgent();
    try {
      await assert.rejects(
        () => request(https, {
          host: '127.0.0.1',
          port: server.address().port,
          path: '/',
          servername: 'not-in-this-certificate.test',
          agent,
          ca: CA,
        }),
        (err) => {
          assert.ok(
            /ALTNAME|altname|Hostname\/IP does not match/i.test(err.message + err.code),
            `expected a certificate identity error, got: ${err.code} ${err.message}`
          );
          return true;
        }
      );
    } finally {
      agent.destroy();
    }
  });

  test('reports a malformed TLS option as a request error, never as an uncaught exception', async () => {
    // tls.connect() throws synchronously while building its SecureContext for
    // an invalid secureProtocol. Left unguarded, that throw escapes as an
    // unhandled exception and crashes the host process on the very first
    // request — this must surface as a normal request error instead.
    const agent = bridge.createHttpsAgent({ secureProtocol: 'not_a_real_protocol_xyz' });
    try {
      await assert.rejects(
        () => request(https, {
          host: '127.0.0.1', port: server.address().port, path: '/', agent, ca: CA,
        }),
        (err) => {
          assert.match(err.message, /Unknown method|secureProtocol/i);
          return true;
        }
      );
    } finally {
      agent.destroy();
    }
  });

  test('rejects an untrusted certificate by default', async () => {
    const agent = bridge.createHttpsAgent();
    try {
      await assert.rejects(
        // No `ca`, so the self-signed fixture is untrusted.
        () => request(https, { host: '127.0.0.1', port: server.address().port, path: '/', agent }),
        (err) => /self[- ]signed|unable to verify/i.test(err.message)
      );
    } finally {
      agent.destroy();
    }
  });
});

describe('createAgents', () => {
  test('returns an agent for each protocol', () => {
    const agents = bridge.createAgents();
    assert.ok(agents.http instanceof http.Agent);
    assert.ok(agents.https instanceof https.Agent);
    agents.http.destroy();
    agents.https.destroy();
  });
});

describe('createLookup', () => {
  test('matches the dns.lookup callback signature', async () => {
    const lookup = bridge.createLookup();
    const result = await new Promise((resolve, reject) => {
      lookup('localhost', {}, (err, address, family) => {
        if (err) reject(err); else resolve({ address, family });
      });
    });

    assert.strictEqual(typeof result.address, 'string');
    assert.ok([4, 6].includes(result.family));
  });

  test('supports the 2-argument form (options omitted)', async () => {
    const lookup = bridge.createLookup();
    const result = await new Promise((resolve, reject) => {
      lookup('localhost', (err, address, family) => {
        if (err) reject(err); else resolve({ address, family });
      });
    });
    assert.strictEqual(typeof result.address, 'string');
  });

  test('supports the all option', async () => {
    const lookup = bridge.createLookup();
    const all = await new Promise((resolve, reject) => {
      lookup('localhost', { all: true }, (err, addresses) => {
        if (err) reject(err); else resolve(addresses);
      });
    });

    assert.ok(Array.isArray(all) && all.length > 0);
    assert.ok(all.every((a) => typeof a.address === 'string' && [4, 6].includes(a.family)));
  });

  test('honours a requested family (object form)', async () => {
    const lookup = bridge.createLookup();
    const all = await new Promise((resolve, reject) => {
      lookup('8.8.8.8', { all: true, family: 4 }, (err, addresses) => {
        if (err) reject(err); else resolve(addresses);
      });
    });
    assert.ok(all.every((a) => a.family === 4), 'should return only IPv4 when asked');
  });

  test('honours the documented integer-shorthand form: dns.lookup(host, family, cb)', async () => {
    // Node's dns.lookup accepts `options` as a bare integer meaning family.
    // A previous version of this shim silently ignored that form, since
    // `(4).family` is undefined, and returned an unfiltered result.
    const lookup = bridge.createLookup();
    const result = await new Promise((resolve, reject) => {
      lookup('8.8.8.8', 4, (err, address, family) => {
        if (err) reject(err); else resolve({ address, family });
      });
    });
    assert.strictEqual(result.family, 4);
    assert.strictEqual(result.address, '8.8.8.8');
  });

  test('errors when the integer-shorthand family cannot be satisfied', async () => {
    const lookup = bridge.createLookup();
    const err = await new Promise((resolve) => {
      // 127.0.0.1 is IPv4-only and non-global, so it has no family-6 route.
      lookup('127.0.0.1', 6, (error) => resolve(error));
    });
    assert.ok(err, 'requesting an unsatisfiable family should error, not silently return another family');
    assert.strictEqual(err.code, 'EAI_ADDRFAMILY');
  });

  test('accepts null options', async () => {
    const lookup = bridge.createLookup();
    const result = await new Promise((resolve, reject) => {
      lookup('localhost', null, (err, address, family) => {
        if (err) reject(err); else resolve({ address, family });
      });
    });
    assert.strictEqual(typeof result.address, 'string');
  });

  test('works as a drop-in for net.connect', async () => {
    const server = await startHttpServer();
    try {
      const socket = await new Promise((resolve, reject) => {
        const s = net.connect({
          host: '127.0.0.1',
          port: server.address().port,
          lookup: bridge.createLookup(),
        }, () => resolve(s));
        s.on('error', reject);
      });
      assert.ok(socket.remoteAddress);
      socket.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('reports resolution failure through the callback', async () => {
    const lookup = bridge.createLookup();
    const err = await new Promise((resolve) => {
      lookup('this-host-does-not-exist.invalid', {}, (error) => resolve(error));
    });
    assert.ok(err, 'an unresolvable name should produce an error');
  });
});

describe('createConnector', () => {
  test('opens a plain connection for http targets', async () => {
    const server = await startHttpServer();
    const connector = bridge.createConnector();
    try {
      const socket = await new Promise((resolve, reject) => {
        connector({
          hostname: '127.0.0.1',
          port: server.address().port,
          protocol: 'http:',
        }, (err, s) => (err ? reject(err) : resolve(s)));
      });
      assert.ok(socket.writable);
      socket.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('performs the TLS handshake for https targets', async () => {
    const server = await startHttpsServer();
    const connector = bridge.createConnector();
    try {
      const socket = await new Promise((resolve, reject) => {
        connector({
          hostname: '127.0.0.1',
          port: server.address().port,
          protocol: 'https:',
          ca: CA,
        }, (err, s) => (err ? reject(err) : resolve(s)));
      });
      assert.strictEqual(socket.authorized, true, 'TLS should be established and verified');
      socket.destroy();
    } finally {
      await closeServer(server);
    }
  });

  test('reports connection failure through the callback', async () => {
    const connector = bridge.createConnector();
    const err = await new Promise((resolve) => {
      connector({ hostname: '127.0.0.1', port: 1, protocol: 'http:' }, (error) => resolve(error));
    });
    assert.ok(err, 'a refused connection should produce an error');
  });

  test('reports a malformed TLS option through the callback, not as an uncaught exception', async () => {
    const server = await startHttpsServer();
    const connector = bridge.createConnector();
    try {
      const err = await new Promise((resolve) => {
        connector({
          hostname: '127.0.0.1',
          port: server.address().port,
          protocol: 'https:',
          secureProtocol: 'not_a_real_protocol_xyz',
        }, (error) => resolve(error));
      });
      assert.ok(err, 'a bad TLS option must surface as an error, not crash the process');
      assert.match(err.message, /Unknown method|secureProtocol/i);
    } finally {
      await closeServer(server);
    }
  });
});

describe('resolve and getStats', () => {
  test('resolve reports the candidate routes', async () => {
    const candidates = await bridge.resolve('8.8.8.8');
    assert.strictEqual(candidates[0].mode, 'nat64');
    assert.strictEqual(candidates[0].host, '64:ff9b::808:808');
  });

  test('resolve never synthesizes a non-global address', async () => {
    const candidates = await bridge.resolve('127.0.0.1');
    assert.ok(!candidates.some((c) => c.mode === 'nat64'));
  });

  test('getStats reports routes, cache and prefix', () => {
    const stats = bridge.getStats();
    assert.ok('routes' in stats);
    assert.ok('counters' in stats);
    assert.ok('dnsCache' in stats);
    assert.match(stats.nat64Prefix, /^[0-9a-f:]+\/\d+$/);
    assert.ok('translationRate' in stats);
  });
});
