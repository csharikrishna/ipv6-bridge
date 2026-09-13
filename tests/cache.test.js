process.env.LOG_LEVEL = 'silent';

const { test, describe } = require('node:test');
const assert = require('assert');
const { TtlCache } = require('../src/cache');
const { compile, parseCidr, matchesCidr } = require('../src/netmatch');

describe('TtlCache', () => {
  test('stores and returns values', () => {
    const cache = new TtlCache();
    cache.set('a', 1);
    assert.strictEqual(cache.get('a'), 1);
  });

  test('returns undefined for unknown keys', () => {
    assert.strictEqual(new TtlCache().get('missing'), undefined);
  });

  test('expires entries after their TTL', async () => {
    const cache = new TtlCache({ ttl: 20 });
    cache.set('a', 1);
    assert.strictEqual(cache.get('a'), 1);

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.strictEqual(cache.get('a'), undefined, 'entry should have expired');
  });

  test('evicts the least recently used entry when full', () => {
    const cache = new TtlCache({ max: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');       // 'a' becomes most recent, so 'b' is next out
    cache.set('c', 3);

    assert.strictEqual(cache.get('b'), undefined, 'b should have been evicted');
    assert.strictEqual(cache.get('a'), 1);
    assert.strictEqual(cache.get('c'), 3);
  });

  test('never grows past its maximum', () => {
    const cache = new TtlCache({ max: 10 });
    for (let i = 0; i < 500; i++) cache.set(`key-${i}`, i);
    assert.strictEqual(cache.stats().size, 10);
  });

  test('tracks hit and miss statistics', () => {
    const cache = new TtlCache();
    cache.set('a', 1);
    cache.get('a');
    cache.get('a');
    cache.get('b');

    const stats = cache.stats();
    assert.strictEqual(stats.hits, 2);
    assert.strictEqual(stats.misses, 1);
    assert.ok(Math.abs(stats.hitRate - 0.6667) < 0.001);
  });

  test('prune drops expired entries eagerly', async () => {
    const cache = new TtlCache({ ttl: 10 });
    cache.set('a', 1);
    cache.set('b', 2);
    await new Promise((resolve) => setTimeout(resolve, 30));

    cache.prune();
    assert.strictEqual(cache.stats().size, 0);
  });

  test('clear empties the cache', () => {
    const cache = new TtlCache();
    cache.set('a', 1);
    cache.clear();
    assert.strictEqual(cache.stats().size, 0);
  });
});

describe('netmatch CIDR handling', () => {
  test('matches IPv4 CIDR ranges', () => {
    const rule = parseCidr('192.168.1.0/24');
    assert.ok(matchesCidr('192.168.1.1', rule));
    assert.ok(matchesCidr('192.168.1.255', rule));
    assert.ok(!matchesCidr('192.168.2.1', rule));
  });

  test('matches IPv6 CIDR ranges', () => {
    const rule = parseCidr('2001:db8::/32');
    assert.ok(matchesCidr('2001:db8::1', rule));
    assert.ok(matchesCidr('2001:db8:ffff::1', rule));
    assert.ok(!matchesCidr('2001:db9::1', rule));
  });

  test('treats a bare address as a single-host rule', () => {
    const rule = parseCidr('10.0.0.5');
    assert.ok(matchesCidr('10.0.0.5', rule));
    assert.ok(!matchesCidr('10.0.0.6', rule));
  });

  test('normalizes IPv4-mapped IPv6 peers', () => {
    // A dual-stack listener reports IPv4 clients in this form.
    const rule = parseCidr('127.0.0.0/8');
    assert.ok(matchesCidr('::ffff:127.0.0.1', rule));
  });

  test('handles non-byte-aligned prefix lengths', () => {
    const rule = parseCidr('10.0.0.0/12');
    assert.ok(matchesCidr('10.1.2.3', rule));
    assert.ok(matchesCidr('10.15.255.255', rule));
    assert.ok(!matchesCidr('10.16.0.1', rule));
  });

  test('rejects malformed rules', () => {
    assert.strictEqual(parseCidr('not-an-ip/24'), null);
    assert.strictEqual(parseCidr('192.168.1.0/33'), null);
  });
});

describe('netmatch rule lists', () => {
  test('an empty spec matches nothing and reports itself empty', () => {
    const matcher = compile('');
    assert.strictEqual(matcher.isEmpty, true);
    assert.strictEqual(matcher.matches('example.com'), false);
  });

  test('matches exact hostnames', () => {
    const matcher = compile('example.com, other.org');
    assert.ok(matcher.matches('example.com'));
    assert.ok(matcher.matches('EXAMPLE.COM'), 'matching should be case-insensitive');
    assert.ok(!matcher.matches('sub.example.com'));
  });

  test('wildcards match subdomains and the bare domain', () => {
    const matcher = compile('*.internal.company.com');
    assert.ok(matcher.matches('api.internal.company.com'));
    assert.ok(matcher.matches('deep.nested.internal.company.com'));
    assert.ok(matcher.matches('internal.company.com'));
    assert.ok(!matcher.matches('internal.company.com.evil.test'));
  });

  test('combines hostname and CIDR rules', () => {
    const matcher = compile('*.internal.test, 10.0.0.0/8');
    assert.ok(matcher.matches('svc.internal.test'));
    assert.ok(matcher.matches('10.1.2.3'));
    assert.ok(!matcher.matches('11.1.2.3'));
    assert.ok(!matcher.matches('example.com'));
  });

  test('a lone wildcard matches everything', () => {
    assert.ok(compile('*').matches('anything.example'));
  });
});
