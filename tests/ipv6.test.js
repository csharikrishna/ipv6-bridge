process.env.LOG_LEVEL = 'silent';

const { test, describe } = require('node:test');
const assert = require('assert');
const {
  parseIPv6,
  formatIPv6,
  parseIPv4,
  parsePrefix,
  embedIPv4,
  extractIPv4,
  embeddedPositions,
} = require('../src/ipv6');

const sameAddress = (a, b) => parseIPv6(a).equals(parseIPv6(b));

describe('parseIPv6 / formatIPv6', () => {
  test('round-trips common forms', () => {
    const cases = [
      ['::1', '::1'],
      ['::', '::'],
      ['64:ff9b::', '64:ff9b::'],
      ['2001:db8::1', '2001:db8::1'],
      ['fe80::1', 'fe80::1'],
      ['2001:0db8:0000:0000:0000:ff00:0042:8329', '2001:db8::ff00:42:8329'],
      // RFC 5952 4.2.3: with equal-length zero runs, the first is compressed.
      ['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(formatIPv6(parseIPv6(input)), expected, `${input} formatted wrongly`);
    }
  });

  test('suppresses leading zeros per RFC 5952 4.1', () => {
    assert.strictEqual(formatIPv6(parseIPv6('64:ff9b::0808:0808')), '64:ff9b::808:808');
  });

  test('compresses only the longest zero run per RFC 5952 4.2', () => {
    // The second run (three groups) is longer than the first (two groups).
    assert.strictEqual(formatIPv6(parseIPv6('2001:0:0:1:0:0:0:1')), '2001:0:0:1::1');
  });

  test('handles embedded IPv4 notation', () => {
    assert.ok(sameAddress('::ffff:192.0.2.1', '::ffff:c000:201'));
    assert.ok(sameAddress('64:ff9b::192.0.2.33', '64:ff9b::c000:221'));
  });

  test('rejects invalid input', () => {
    for (const bad of ['not-an-address', '', null, '1.2.3.4', '::1::2', 'gggg::1']) {
      assert.strictEqual(parseIPv6(bad), null, `${bad} should not parse`);
    }
  });

  test('formatIPv6 rejects wrong-sized buffers', () => {
    assert.throws(() => formatIPv6(Buffer.alloc(4)), /16-byte buffer/);
  });
});

describe('parseIPv4', () => {
  test('parses valid addresses', () => {
    assert.deepStrictEqual([...parseIPv4('192.0.2.1')], [192, 0, 2, 1]);
    assert.deepStrictEqual([...parseIPv4('255.255.255.255')], [255, 255, 255, 255]);
  });

  test('rejects invalid addresses', () => {
    for (const bad of ['256.0.0.1', '1.2.3', 'abc', '::1']) {
      assert.strictEqual(parseIPv4(bad), null);
    }
  });
});

describe('parsePrefix', () => {
  test('defaults to /96 when no length is given', () => {
    const prefix = parsePrefix('64:ff9b::');
    assert.strictEqual(prefix.length, 96);
    assert.strictEqual(prefix.prefix, '64:ff9b::');
  });

  test('accepts every RFC 6052 prefix length', () => {
    for (const length of [32, 40, 48, 56, 64, 96]) {
      const prefix = parsePrefix(`2001:db8::/${length}`);
      assert.strictEqual(prefix.length, length);
    }
  });

  test('rejects lengths RFC 6052 does not define', () => {
    for (const length of [0, 16, 33, 80, 97, 128]) {
      assert.throws(() => parsePrefix(`2001:db8::/${length}`), /prefix length/);
    }
  });

  test('rejects the well-known prefix at a length other than /96', () => {
    assert.throws(() => parsePrefix('64:ff9b::/32'), /only defined as \/96/);
    assert.throws(() => parsePrefix('64:ff9b::/64'), /only defined as \/96/);
  });

  test('rejects prefixes with bits set past the prefix length', () => {
    assert.throws(() => parsePrefix('2001:db8::1/32'), /must be zero/);
  });

  test('rejects malformed input', () => {
    assert.throws(() => parsePrefix('garbage/96'), /not a valid IPv6 address/);
    assert.throws(() => parsePrefix(''), /non-empty string/);
  });
});

describe('embedIPv4 / extractIPv4 (RFC 6052 section 2.4 vectors)', () => {
  // The official examples from RFC 6052 section 2.4.
  const VECTORS = [
    ['2001:db8::/32', '192.0.2.33', '2001:db8:c000:221::'],
    ['2001:db8:100::/40', '192.0.2.33', '2001:db8:1c0:2:21::'],
    ['2001:db8:122::/48', '192.0.2.33', '2001:db8:122:c000:2:2100::'],
    ['2001:db8:122:300::/56', '192.0.2.33', '2001:db8:122:3c0:0:221::'],
    ['2001:db8:122:344::/64', '192.0.2.33', '2001:db8:122:344:c0:2:2100::'],
    ['2001:db8:122:344::/96', '192.0.2.33', '2001:db8:122:344::192.0.2.33'],
  ];

  for (const [spec, ipv4, expected] of VECTORS) {
    test(`embeds ${ipv4} into ${spec}`, () => {
      const embedded = embedIPv4(ipv4, parsePrefix(spec));
      assert.ok(sameAddress(embedded, expected),
        `expected ${expected}, got ${embedded}`);
    });

    test(`extracts ${ipv4} back out of ${spec}`, () => {
      const prefix = parsePrefix(spec);
      assert.strictEqual(extractIPv4(embedIPv4(ipv4, prefix), prefix.length), ipv4);
    });
  }

  test('skips the reserved u octet at bits 64-71', () => {
    // Byte 8 must never hold part of the embedded address.
    for (const length of [32, 40, 48, 56, 64, 96]) {
      assert.ok(!embeddedPositions(length).includes(8),
        `/${length} must not place IPv4 bytes in the reserved octet`);
    }
  });

  test('leaves the u octet zero in synthesized addresses', () => {
    for (const spec of ['2001:db8::/32', '2001:db8:122::/48', '2001:db8:122:344::/64']) {
      const embedded = embedIPv4('192.0.2.33', parsePrefix(spec));
      assert.strictEqual(parseIPv6(embedded)[8], 0, `${spec} left a non-zero u octet`);
    }
  });

  test('rejects invalid IPv4 input', () => {
    assert.throws(() => embedIPv4('256.0.0.1', parsePrefix('64:ff9b::')), /invalid IPv4/);
  });

  test('extractIPv4 returns null for invalid input', () => {
    assert.strictEqual(extractIPv4('not-an-address', 96), null);
    assert.strictEqual(extractIPv4('64:ff9b::c000:221', 97), null);
  });
});
