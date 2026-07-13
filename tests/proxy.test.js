const { test, describe } = require('node:test');
const assert = require('assert');
const { createProxy } = require('../src/proxy');

describe('createProxy', () => {
  test('starts and stops on a given port', async () => {
    const server = await createProxy(0); // port 0 = OS assigns a free port
    const addr = server.address();

    assert.ok(server, 'Server should be created');
    assert.ok(addr, 'Server should have an address');
    assert.ok(addr.port > 0, 'Server should be listening on a port');

    await new Promise((resolve) => server.close(resolve));
  });

  test('rejects when port is already in use', async () => {
    const server1 = await createProxy(0);
    const port = server1.address().port;

    await assert.rejects(
      () => createProxy(port),
      (err) => {
        assert.ok(err.message.includes('Failed to start proxy'));
        return true;
      }
    );

    await new Promise((resolve) => server1.close(resolve));
  });

  test('returns an http.Server instance', async () => {
    const server = await createProxy(0);
    assert.strictEqual(typeof server.listen, 'function');
    assert.strictEqual(typeof server.close, 'function');
    await new Promise((resolve) => server.close(resolve));
  });
});
