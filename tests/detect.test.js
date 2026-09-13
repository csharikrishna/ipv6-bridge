process.env.LOG_LEVEL = 'silent';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const http = require('http');
const { closeServer, reloadModules } = require('./helpers');

/**
 * Detection is exercised against local servers only. The endpoints are
 * configurable precisely so these tests never need network access.
 */
function startServer(statusCode, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      res.writeHead(statusCode, statusCode >= 300 && statusCode < 400
        ? { Location: 'https://example.com/' }
        : {});
      res.end();
    });
    server.once('error', reject);
    server.listen(0, host, () => resolve(server));
  });
}

const originalEnv = { ...process.env };

function loadDetect(env) {
  for (const key of ['IPV4_TEST_URL', 'IPV6_TEST_URL', 'NAT64_TEST_HOST', 'IPV6_DNS_TIMEOUT']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  reloadModules();
  return require('../src/detect');
}

describe('detection probes', () => {
  let servers = [];

  beforeEach(() => { servers = []; });

  afterEach(async () => {
    for (const server of servers) await closeServer(server);
    process.env = { ...originalEnv };
    reloadModules();
  });

  test('hasIPv4 reports true when the endpoint responds', async () => {
    const server = await startServer(200);
    servers.push(server);
    const { hasIPv4 } = loadDetect({
      IPV4_TEST_URL: `http://127.0.0.1:${server.address().port}`,
    });
    assert.strictEqual(await hasIPv4(), true);
  });

  test('hasIPv4 tolerates redirects rather than reporting failure', async () => {
    const server = await startServer(302);
    servers.push(server);
    const { hasIPv4 } = loadDetect({
      IPV4_TEST_URL: `http://127.0.0.1:${server.address().port}`,
    });
    assert.strictEqual(await hasIPv4(), true, 'a 302 means the endpoint is reachable');
  });

  test('hasIPv4 reports false when nothing is listening', async () => {
    const { hasIPv4 } = loadDetect({ IPV4_TEST_URL: 'http://127.0.0.1:1' });
    assert.strictEqual(await hasIPv4(), false);
  });

  test('hasIPv4 reports false on a server error', async () => {
    const server = await startServer(500);
    servers.push(server);
    const { hasIPv4 } = loadDetect({
      IPV4_TEST_URL: `http://127.0.0.1:${server.address().port}`,
    });
    assert.strictEqual(await hasIPv4(), false);
  });
});

describe('needsBridge', () => {
  const servers = [];

  afterEach(async () => {
    while (servers.length) await closeServer(servers.pop());
    process.env = { ...originalEnv };
    reloadModules();
  });

  test('returns false when IPv4 already works (dual-stack)', async () => {
    const server = await startServer(200);
    servers.push(server);
    const { needsBridge } = loadDetect({
      IPV4_TEST_URL: `http://127.0.0.1:${server.address().port}`,
      IPV6_TEST_URL: 'http://127.0.0.1:1',
    });
    assert.strictEqual(await needsBridge(), false,
      'the bridge must not activate on a network where IPv4 works');
  });

  test('returns false when neither IPv4 nor IPv6 works', async () => {
    const { needsBridge } = loadDetect({
      IPV4_TEST_URL: 'http://127.0.0.1:1',
      IPV6_TEST_URL: 'http://127.0.0.1:1',
    });
    assert.strictEqual(await needsBridge(), false,
      'the bridge cannot help without IPv6');
  });

  test('returns true on IPv6-only with no working NAT64', async (t) => {
    let server;
    try {
      server = await startServer(200, '::1');
    } catch {
      return t.skip('IPv6 loopback unavailable');
    }
    servers.push(server);

    const { needsBridge } = loadDetect({
      IPV4_TEST_URL: 'http://127.0.0.1:1',
      IPV6_TEST_URL: `http://[::1]:${server.address().port}`,
      NAT64_TEST_HOST: 'this-host-does-not-exist.invalid',
    });
    assert.strictEqual(await needsBridge(), true);
  });

  test('returns a boolean', async () => {
    const { needsBridge } = loadDetect({
      IPV4_TEST_URL: 'http://127.0.0.1:1',
      IPV6_TEST_URL: 'http://127.0.0.1:1',
    });
    assert.strictEqual(typeof await needsBridge(), 'boolean');
  });
});
