process.env.LOG_LEVEL = 'silent';

const { test, describe, afterEach } = require('node:test');
const assert = require('assert');
const http = require('http');
const net = require('net');
const { closeServer, reloadModules, startTcpEchoServer } = require('./helpers');

const originalEnv = { ...process.env };

/**
 * Point detection at local endpoints so start()/stop() never touch the network.
 * `ipv4Reachable: false` makes detection report that the bridge is needed.
 */
function loadBridge({ ipv4Url = 'http://127.0.0.1:1', ipv6Url = 'http://127.0.0.1:1' } = {}) {
  process.env.IPV4_TEST_URL = ipv4Url;
  process.env.IPV6_TEST_URL = ipv6Url;
  reloadModules();
  return require('../src/index');
}

describe('index (start/stop)', () => {
  afterEach(async () => {
    try {
      await require('../src/index').stop();
    } catch { /* module may have been reloaded */ }
    process.env = { ...originalEnv };
    reloadModules();
  });

  test('exports start and stop functions', () => {
    const bridge = loadBridge();
    assert.strictEqual(typeof bridge.start, 'function');
    assert.strictEqual(typeof bridge.stop, 'function');
  });

  test('stop() is safe to call when not running', async () => {
    const { stop } = loadBridge();
    await stop();
  });

  test('returns null when the bridge is not needed', async () => {
    const reachable = await new Promise((resolve) => {
      const server = http.createServer((req, res) => res.end('ok'));
      server.listen(0, '127.0.0.1', () => resolve(server));
    });

    try {
      const { start } = loadBridge({ ipv4Url: `http://127.0.0.1:${reachable.address().port}` });
      const server = await start(0);
      assert.strictEqual(server, null, 'IPv4 works, so the bridge should stay out of the way');
    } finally {
      await closeServer(reachable);
    }
  });

  test('starts when forced even if detection says otherwise', async () => {
    const { start, stop } = loadBridge();
    const server = await start(0, { force: true });
    assert.ok(server, 'forced start should return a server');
    assert.ok(server.address().port > 0);
    await stop();
  });

  test('binds to loopback by default', async () => {
    const { start, stop } = loadBridge();
    const server = await start(0, { force: true });
    assert.strictEqual(server.address().address, '127.0.0.1');
    await stop();
  });

  test('concurrent start() calls never leave an untracked server running', async () => {
    const { start, stop } = loadBridge();

    const results = await Promise.allSettled([
      start(0, { force: true }),
      start(0, { force: true }),
    ]);

    const started = results.filter((r) => r.status === 'fulfilled' && r.value);
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.strictEqual(started.length, 1, 'exactly one server should start');
    assert.strictEqual(rejected.length, 1, 'the second call should be rejected');
    assert.match(rejected[0].reason.message, /already running/);

    await stop();
    assert.ok(started[0].value.address() === null || !started[0].value.listening,
      'the started server should be closed by stop()');
  });

  test('rejects a second start() while one is running', async () => {
    const { start, stop } = loadBridge();
    await start(0, { force: true });
    await assert.rejects(() => start(0, { force: true }), /already running/);
    await stop();
  });

  test('start() can be called again after stop()', async () => {
    const { start, stop } = loadBridge();
    const first = await start(0, { force: true });
    assert.ok(first);
    await stop();

    const second = await start(0, { force: true });
    assert.ok(second, 'the bridge should be restartable');
    await stop();
  });

  test('stop() completes with an open CONNECT tunnel', async () => {
    const { start, stop } = loadBridge();
    const server = await start(0, { force: true });
    const target = await startTcpEchoServer('127.0.0.1');

    const client = net.connect(server.address().port, '127.0.0.1', () => {
      client.write(`CONNECT 127.0.0.1:${target.address().port} HTTP/1.1\r\nHost: x\r\n\r\n`);
    });
    await new Promise((resolve) => client.once('data', resolve));

    const outcome = await Promise.race([
      stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 3000)),
    ]);

    assert.strictEqual(outcome, 'stopped', 'stop() must not hang on open tunnels');

    client.destroy();
    await closeServer(target);
  });
});
