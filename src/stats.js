/**
 * IPv6 Bridge - Runtime counters
 *
 * Tracks what the bridge actually did, so operators can confirm that traffic is
 * being translated rather than quietly falling back to direct connections.
 *
 * @module stats
 */

const startedAt = Date.now();

const counters = {
  httpRequests: 0,
  connectRequests: 0,
  socksRequests: 0,
  responses2xx: 0,
  responses4xx: 0,
  responses5xx: 0,
  proxyErrors: 0,
  timeouts: 0,
  authFailures: 0,
  bytesToClient: 0,
  bytesToUpstream: 0,
};

/**
 * How each request was routed. "nat64" means the bridge did its job; a rising
 * "directIpv4Fallback" means DNS64 is failing and nothing is being translated.
 */
const routes = {
  nat64: 0,
  nativeIpv6: 0,
  ipv6Literal: 0,
  directIpv4: 0,
  directIpv4Fallback: 0,
  bypassed: 0,
};

function increment(group, key, amount = 1) {
  if (Object.prototype.hasOwnProperty.call(group, key)) {
    group[key] += amount;
  }
}

/** Record a routing decision by its mode name. */
function recordRoute(mode) {
  const key = {
    'nat64': 'nat64',
    'native-ipv6': 'nativeIpv6',
    'ipv6-literal': 'ipv6Literal',
    'direct-ipv4': 'directIpv4',
    'direct-ipv4-fallback': 'directIpv4Fallback',
    'bypassed': 'bypassed',
  }[mode];
  if (key) routes[key] += 1;
}

/** Record an upstream response status code. */
function recordStatus(statusCode) {
  if (statusCode >= 200 && statusCode < 400) counters.responses2xx += 1;
  else if (statusCode >= 400 && statusCode < 500) counters.responses4xx += 1;
  else if (statusCode >= 500) counters.responses5xx += 1;
}

/**
 * Snapshot every counter.
 *
 * @param {object} [extra] - Additional sections to include (cache stats, config)
 * @returns {object} Snapshot
 */
function snapshot(extra = {}) {
  const uptimeMs = Date.now() - startedAt;
  const translated = routes.nat64;
  const untranslated = routes.directIpv4 + routes.directIpv4Fallback;

  return {
    uptimeSeconds: Math.floor(uptimeMs / 1000),
    startedAt: new Date(startedAt).toISOString(),
    counters: { ...counters },
    routes: { ...routes },
    // The headline number: is the bridge actually bridging?
    translationRate: translated + untranslated === 0
      ? null
      : Number((translated / (translated + untranslated)).toFixed(4)),
    ...extra,
  };
}

/** Render the snapshot in Prometheus text exposition format. */
function toPrometheus(extra = {}) {
  const data = snapshot(extra);
  const lines = [];

  const emit = (name, value, help, type = 'counter') => {
    if (value === null || value === undefined) return;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name} ${value}`);
  };

  emit('ipv6_bridge_uptime_seconds', data.uptimeSeconds, 'Seconds since the bridge started', 'gauge');

  for (const [key, value] of Object.entries(data.counters)) {
    const name = `ipv6_bridge_${key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())}`;
    emit(name, value, `Total ${key}`);
  }

  for (const [key, value] of Object.entries(data.routes)) {
    const mode = key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
    lines.push(`ipv6_bridge_route_total{mode="${mode}"} ${value}`);
  }

  emit('ipv6_bridge_translation_rate', data.translationRate,
    'Share of resolved requests routed through NAT64', 'gauge');

  if (data.dnsCache) {
    emit('ipv6_bridge_dns_cache_size', data.dnsCache.size, 'DNS cache entries', 'gauge');
    emit('ipv6_bridge_dns_cache_hits', data.dnsCache.hits, 'DNS cache hits');
    emit('ipv6_bridge_dns_cache_misses', data.dnsCache.misses, 'DNS cache misses');
  }

  return lines.join('\n') + '\n';
}

/** Reset every counter. Intended for tests. */
function reset() {
  for (const key of Object.keys(counters)) counters[key] = 0;
  for (const key of Object.keys(routes)) routes[key] = 0;
}

module.exports = {
  counters,
  routes,
  increment,
  recordRoute,
  recordStatus,
  snapshot,
  toPrometheus,
  reset,
};
