process.env.LOG_LEVEL = 'silent';

const { test, describe, afterEach } = require('node:test');
const assert = require('assert');
const { reloadModules } = require('./helpers');

const originalEnv = { ...process.env };

function loadConfig(env = {}) {
  for (const key of ['NAT64_PREFIX', 'IPV6_BRIDGE_PORT', 'IPV6_BRIDGE_HOST', 'IPV6_DNS_TIMEOUT', 'IPV6_CONN_TIMEOUT']) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  reloadModules();
  return require('../src/config');
}

describe('config', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
    reloadModules();
  });

  test('exports required constants', () => {
    const config = loadConfig();
    assert.ok(config.NAT64_PREFIX, 'NAT64_PREFIX should be defined');
    assert.ok(config.DEFAULT_PORT, 'DEFAULT_PORT should be defined');
    assert.ok(config.BIND_HOST, 'BIND_HOST should be defined');
    assert.ok(config.IPV6_TEST_URL, 'IPV6_TEST_URL should be defined');
    assert.ok(config.IPV4_TEST_URL, 'IPV4_TEST_URL should be defined');
    assert.ok(config.NAT64_TEST_HOST, 'NAT64_TEST_HOST should be defined');
  });

  test('NAT64_PREFIX defaults to the RFC 6052 well-known prefix', () => {
    const config = loadConfig();
    assert.strictEqual(config.NAT64_PREFIX, '64:ff9b::');
    assert.strictEqual(config.NAT64_PREFIX, config.WELL_KNOWN_PREFIX);
  });

  test('DEFAULT_PORT is 8080', () => {
    assert.strictEqual(loadConfig().DEFAULT_PORT, 8080);
  });

  test('binds to loopback by default so the proxy is not an open relay', () => {
    assert.strictEqual(loadConfig().BIND_HOST, '127.0.0.1');
  });

  test('accepts a valid network-specific prefix', () => {
    assert.strictEqual(loadConfig({ NAT64_PREFIX: '2001:db8:122:344::' }).NAT64_PREFIX,
      '2001:db8:122:344::');
  });

  test('rejects a NAT64 prefix that cannot form a valid address', () => {
    for (const prefix of ['garbage', 'not a prefix', '64:ff9b:']) {
      assert.throws(() => loadConfig({ NAT64_PREFIX: prefix }), /Invalid NAT64_PREFIX/,
        `"${prefix}" should be rejected`);
    }
  });

  test('rejects non-numeric and out-of-range ports', () => {
    assert.throws(() => loadConfig({ IPV6_BRIDGE_PORT: 'abc' }), /must be a positive integer/);
    assert.throws(() => loadConfig({ IPV6_BRIDGE_PORT: '8080abc' }), /must be a positive integer/);
    assert.throws(() => loadConfig({ IPV6_BRIDGE_PORT: '99999' }), /between 1 and 65535/);
    assert.throws(() => loadConfig({ IPV6_BRIDGE_PORT: '0' }), /between 1 and 65535/);
  });

  test('accepts a valid port override', () => {
    assert.strictEqual(loadConfig({ IPV6_BRIDGE_PORT: '9090' }).DEFAULT_PORT, 9090);
  });

  test('rejects invalid timeouts', () => {
    assert.throws(() => loadConfig({ IPV6_DNS_TIMEOUT: 'soon' }), /must be a positive integer/);
    assert.throws(() => loadConfig({ IPV6_CONN_TIMEOUT: '-5' }), /must be a positive integer/);
  });
});
