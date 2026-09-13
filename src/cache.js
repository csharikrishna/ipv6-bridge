/**
 * IPv6 Bridge - Bounded TTL cache
 *
 * A small LRU cache with per-entry expiry, used to avoid a DNS lookup on every
 * single request.
 *
 * Note on TTLs: entries expire after a fixed, configurable interval rather than
 * the record's own DNS TTL. The bridge resolves through dns.lookup (the system
 * resolver), which does not expose TTLs — that is a deliberate trade, because
 * the alternative, dns.resolve*, ignores the hosts file and DoH configuration
 * and fails outright on many modern hosts.
 *
 * @module cache
 */

class TtlCache {
  /**
   * @param {object} [options] - Cache options
   * @param {number} [options.max=1000] - Maximum number of entries
   * @param {number} [options.ttl=30000] - Entry lifetime in milliseconds
   */
  constructor({ max = 1000, ttl = 30000 } = {}) {
    this.max = max;
    this.ttl = ttl;
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.expirations = 0;
  }

  /**
   * Read a live entry.
   *
   * @param {string} key - Cache key
   * @returns {*} The stored value, or undefined if absent or expired
   */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }

    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      this.expirations += 1;
      this.misses += 1;
      return undefined;
    }

    // Refresh recency for LRU eviction.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  /**
   * Store an entry, evicting the least recently used if the cache is full.
   *
   * @param {string} key - Cache key
   * @param {*} value - Value to store
   * @param {number} [ttl] - Override lifetime for this entry
   */
  set(key, value, ttl = this.ttl) {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttl });

    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
  }

  /** Remove every entry. */
  clear() {
    this.entries.clear();
  }

  /** Drop expired entries without waiting for them to be read. */
  prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.expirations += 1;
      }
    }
  }

  /**
   * @returns {{size: number, max: number, ttl: number, hits: number, misses: number, hitRate: number, expirations: number}}
   */
  stats() {
    const lookups = this.hits + this.misses;
    return {
      size: this.entries.size,
      max: this.max,
      ttl: this.ttl,
      hits: this.hits,
      misses: this.misses,
      hitRate: lookups === 0 ? 0 : Number((this.hits / lookups).toFixed(4)),
      expirations: this.expirations,
    };
  }
}

module.exports = { TtlCache };
