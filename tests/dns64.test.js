const { test, describe } = require('node:test');
const assert = require('assert');
const { ipv4ToIPv6, detectIPVersion, resolveIPv6 } = require('../src/dns64');

describe('detectIPVersion', () => {
  test('returns null for empty input', () => {
    assert.strictEqual(detectIPVersion(null), null);
    assert.strictEqual(detectIPVersion(undefined), null);
    assert.strictEqual(detectIPVersion(''), null);
  });

  test('detects IPv4 addresses', () => {
    assert.strictEqual(detectIPVersion('192.168.1.1'), 'ipv4');
    assert.strictEqual(detectIPVersion('0.0.0.0'), 'ipv4');
    assert.strictEqual(detectIPVersion('255.255.255.255'), 'ipv4');
    assert.strictEqual(detectIPVersion('127.0.0.1'), 'ipv4');
  });

  test('rejects invalid IPv4 addresses', () => {
    // Out of range octets — the regex matches but validation fails
    assert.strictEqual(detectIPVersion('999.999.999.999'), 'hostname');
    assert.strictEqual(detectIPVersion('256.0.0.1'), 'hostname');
  });

  test('detects IPv6 addresses', () => {
    assert.strictEqual(detectIPVersion('::1'), 'ipv6');
    assert.strictEqual(detectIPVersion('2001:db8::1'), 'ipv6');
    assert.strictEqual(detectIPVersion('64:ff9b::c000:0201'), 'ipv6');
    assert.strictEqual(detectIPVersion('fe80::1'), 'ipv6');
  });

  test('detects hostnames', () => {
    assert.strictEqual(detectIPVersion('google.com'), 'hostname');
    assert.strictEqual(detectIPVersion('example.org'), 'hostname');
    assert.strictEqual(detectIPVersion('my-server.local'), 'hostname');
    assert.strictEqual(detectIPVersion('localhost'), 'hostname');
  });
});

describe('ipv4ToIPv6', () => {
  test('converts standard addresses correctly', () => {
    // 192.0.2.1 → c0=192, 00=0, 02=2, 01=1 → c000:0201
    assert.strictEqual(ipv4ToIPv6('192.0.2.1'), '64:ff9b::c000:0201');
  });

  test('converts 0.0.0.0', () => {
    assert.strictEqual(ipv4ToIPv6('0.0.0.0'), '64:ff9b::0000:0000');
  });

  test('converts 255.255.255.255', () => {
    assert.strictEqual(ipv4ToIPv6('255.255.255.255'), '64:ff9b::ffff:ffff');
  });

  test('converts 8.8.8.8 (Google DNS)', () => {
    // 8.8 → 0808, 8.8 → 0808
    assert.strictEqual(ipv4ToIPv6('8.8.8.8'), '64:ff9b::0808:0808');
  });

  test('converts 1.1.1.1 (Cloudflare DNS)', () => {
    assert.strictEqual(ipv4ToIPv6('1.1.1.1'), '64:ff9b::0101:0101');
  });

  test('throws on invalid input', () => {
    assert.throws(() => ipv4ToIPv6(null), /must be a non-empty string/);
    assert.throws(() => ipv4ToIPv6(''), /must be a non-empty string/);
    assert.throws(() => ipv4ToIPv6('not.an.ip'), /invalid IPv4 address/);
    assert.throws(() => ipv4ToIPv6('256.0.0.1'), /invalid IPv4 address/);
    assert.throws(() => ipv4ToIPv6('1.2.3'), /invalid IPv4 address/);
  });
});
