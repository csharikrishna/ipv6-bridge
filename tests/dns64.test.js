process.env.LOG_LEVEL = 'silent';

const { test, describe } = require('node:test');
const assert = require('assert');
const {
  ipv4ToIPv6,
  detectIPVersion,
  isGlobalIPv4,
  canSynthesize,
  resolveHost,
  lookupAll,
} = require('../src/dns64');

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
  const { parseIPv6 } = require('../src/ipv6');
  const sameAddress = (a, b) => parseIPv6(a).equals(parseIPv6(b));

  test('converts standard addresses correctly', () => {
    // 192.0.2.1 -> c0=192, 00=0, 02=2, 01=1 -> c000:201
    assert.strictEqual(ipv4ToIPv6('192.0.2.1'), '64:ff9b::c000:201');
    assert.ok(sameAddress(ipv4ToIPv6('192.0.2.1'), '64:ff9b::c000:0201'));
  });

  test('emits RFC 5952 canonical form (leading zeros suppressed)', () => {
    assert.strictEqual(ipv4ToIPv6('8.8.8.8'), '64:ff9b::808:808');
    assert.ok(sameAddress(ipv4ToIPv6('8.8.8.8'), '64:ff9b::0808:0808'));
    assert.strictEqual(ipv4ToIPv6('1.1.1.1'), '64:ff9b::101:101');
  });

  test('converts 0.0.0.0', () => {
    assert.ok(sameAddress(ipv4ToIPv6('0.0.0.0'), '64:ff9b::0000:0000'));
  });

  test('converts 255.255.255.255', () => {
    assert.strictEqual(ipv4ToIPv6('255.255.255.255'), '64:ff9b::ffff:ffff');
  });

  test('always produces a valid IPv6 address', () => {
    const net = require('net');
    for (const address of ['8.8.8.8', '1.2.3.4', '203.0.113.9', '0.0.0.0']) {
      assert.strictEqual(net.isIP(ipv4ToIPv6(address)), 6, `${address} produced an invalid address`);
    }
  });

  test('round-trips through ipv6ToIPv4', () => {
    const { ipv6ToIPv4 } = require('../src/dns64');
    for (const address of ['8.8.8.8', '1.2.3.4', '203.0.113.9', '192.0.2.33']) {
      assert.strictEqual(ipv6ToIPv4(ipv4ToIPv6(address)), address);
    }
  });

  test('throws on invalid input', () => {
    assert.throws(() => ipv4ToIPv6(null), /must be a non-empty string/);
    assert.throws(() => ipv4ToIPv6(''), /must be a non-empty string/);
    assert.throws(() => ipv4ToIPv6('not.an.ip'), /invalid IPv4 address/);
    assert.throws(() => ipv4ToIPv6('256.0.0.1'), /invalid IPv4 address/);
    assert.throws(() => ipv4ToIPv6('1.2.3'), /invalid IPv4 address/);
  });
});

describe('isGlobalIPv4', () => {
  test('accepts globally routable addresses', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '142.251.32.14', '93.184.216.34']) {
      assert.strictEqual(isGlobalIPv4(address), true, `${address} should be global`);
    }
  });

  test('rejects private and special-purpose ranges (RFC 6890)', () => {
    const nonGlobal = [
      '0.0.0.0',          // "this network"
      '10.0.0.1',         // private
      '100.64.0.1',       // carrier-grade NAT
      '127.0.0.1',        // loopback
      '169.254.1.1',      // link-local
      '172.16.0.1',       // private
      '172.31.255.255',   // private (upper bound)
      '192.0.2.1',        // TEST-NET-1
      '192.168.1.1',      // private
      '198.18.0.1',       // benchmarking
      '198.51.100.1',     // TEST-NET-2
      '203.0.113.1',      // TEST-NET-3
      '224.0.0.1',        // multicast
      '255.255.255.255',  // broadcast
    ];
    for (const address of nonGlobal) {
      assert.strictEqual(isGlobalIPv4(address), false, `${address} should not be global`);
    }
  });

  test('treats addresses just outside private ranges as global', () => {
    assert.strictEqual(isGlobalIPv4('172.32.0.1'), true);
    assert.strictEqual(isGlobalIPv4('11.0.0.1'), true);
    assert.strictEqual(isGlobalIPv4('9.255.255.255'), true);
  });

  test('rejects non-IPv4 input', () => {
    assert.strictEqual(isGlobalIPv4('::1'), false);
    assert.strictEqual(isGlobalIPv4('not-an-ip'), false);
  });
});

describe('canSynthesize', () => {
  test('refuses non-global addresses under the well-known prefix (RFC 6052 3.1)', () => {
    assert.strictEqual(canSynthesize('127.0.0.1'), false);
    assert.strictEqual(canSynthesize('192.168.1.1'), false);
  });

  test('allows global addresses', () => {
    assert.strictEqual(canSynthesize('8.8.8.8'), true);
  });
});

describe('lookupAll', () => {
  test('resolves localhost without touching the network', async () => {
    const records = await lookupAll('localhost');
    assert.ok(Array.isArray(records) && records.length > 0);
    assert.ok(records.every((r) => typeof r.address === 'string'));
  });

  test('rejects with a clear error for an unresolvable name', async () => {
    await assert.rejects(() => lookupAll('this-host-does-not-exist.invalid'));
  });

  test('times out rather than hanging', async () => {
    await assert.rejects(
      () => lookupAll('this-host-does-not-exist.invalid', 1),
      (err) => err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND'
    );
  });

  test('does not leave a pending timer behind', async () => {
    const before = process._getActiveHandles().length;
    await lookupAll('localhost');
    // A leaked timeout would keep the event loop alive past the resolution.
    await new Promise((resolve) => setImmediate(resolve));
    const after = process._getActiveHandles().length;
    assert.ok(after <= before + 1, `handle count grew from ${before} to ${after}`);
  });
});

describe('resolveHost', () => {
  test('reports native IPv6 or direct IPv4 for loopback', async () => {
    const { addresses, mode } = await resolveHost('localhost');
    assert.ok(addresses.length > 0);
    // localhost is non-global either way, so it must never be synthesized.
    assert.ok(['native-ipv6', 'direct-ipv4'].includes(mode), `unexpected mode: ${mode}`);
    assert.ok(!addresses.some((a) => a.startsWith('64:ff9b::')),
      'loopback must not be synthesized with the well-known prefix');
  });

  test('throws for an unresolvable hostname', async () => {
    await assert.rejects(() => resolveHost('this-host-does-not-exist.invalid'));
  });
});
