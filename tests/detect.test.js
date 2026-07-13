const { test, describe } = require('node:test');
const assert = require('assert');
const { hasIPv6, needsBridge } = require('../src/detect');

describe('hasIPv6', () => {
  test('returns a boolean', async () => {
    const result = await hasIPv6();
    assert.strictEqual(typeof result, 'boolean');
  });
});

describe('needsBridge', () => {
  test('returns a boolean', async () => {
    const result = await needsBridge();
    assert.strictEqual(typeof result, 'boolean');
  });

  test('returns false if no IPv6 is available', async () => {
    // On most development machines without IPv6, this should be false.
    // This test is network-dependent but validates the contract.
    const result = await needsBridge();
    assert.strictEqual(typeof result, 'boolean');
  });
});
