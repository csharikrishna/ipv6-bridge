const { test, describe } = require('node:test');
const assert = require('assert');

describe('index (start/stop)', () => {
  test('exports start and stop functions', () => {
    const bridge = require('../src/index');
    assert.strictEqual(typeof bridge.start, 'function');
    assert.strictEqual(typeof bridge.stop, 'function');
  });

  test('stop() is safe to call when not running', async () => {
    const { stop } = require('../src/index');
    // Should not throw
    await stop();
  });
});
