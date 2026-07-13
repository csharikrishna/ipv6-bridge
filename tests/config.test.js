const { test, describe } = require('node:test');
const assert = require('assert');

describe('config', () => {
  test('exports required constants', () => {
    const config = require('../src/config');
    assert.ok(config.NAT64_PREFIX, 'NAT64_PREFIX should be defined');
    assert.ok(config.DEFAULT_PORT, 'DEFAULT_PORT should be defined');
    assert.ok(config.IPV6_GOOGLE, 'IPV6_GOOGLE should be defined');
    assert.ok(config.IPV4_GOOGLE, 'IPV4_GOOGLE should be defined');
  });

  test('NAT64_PREFIX defaults to RFC 6052 well-known prefix', () => {
    // Clear any env override for this test
    const originalPrefix = process.env.NAT64_PREFIX;
    delete process.env.NAT64_PREFIX;

    // Re-require to pick up the change
    delete require.cache[require.resolve('../src/config')];
    const config = require('../src/config');

    assert.strictEqual(config.NAT64_PREFIX, '64:ff9b::');

    // Restore
    if (originalPrefix !== undefined) {
      process.env.NAT64_PREFIX = originalPrefix;
    }
    delete require.cache[require.resolve('../src/config')];
  });

  test('DEFAULT_PORT is 8080', () => {
    const config = require('../src/config');
    assert.strictEqual(config.DEFAULT_PORT, 8080);
  });
});
