/**
 * IPv6 Bridge - Diagnostics
 *
 * Answers the question a user actually has when their IPv6-only network is
 * misbehaving: what is broken, and what should I do about it?
 *
 * Every check reports what it observed and, on failure, what that implies.
 *
 * @module doctor
 */

const os = require('os');
const dns = require('dns');
const dnsPromises = require('dns').promises;
const { lookupAll } = require('./dns64');
const { discoverPrefix } = require('./discovery');
const { hasIPv4, hasIPv6, hasWorkingNAT64 } = require('./detect');
const config = require('./config');

const PASS = 'pass';
const FAIL = 'fail';
const WARN = 'warn';
const INFO = 'info';

function interfaces() {
  const result = { ipv4: [], ipv6: [] };
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.internal) continue;
      const family = address.family === 'IPv4' || address.family === 4 ? 'ipv4' : 'ipv6';
      result[family].push(`${name}: ${address.address}`);
    }
  }
  return result;
}

/**
 * Compare the system resolver against direct DNS queries.
 *
 * These disagree more often than people expect: dns.resolve* bypasses the
 * hosts file and any DNS-over-HTTPS configuration, so it can fail completely
 * on a host where normal name resolution works.
 */
async function checkResolvers() {
  const checks = [];
  const probe = 'example.com';

  let systemOk = false;
  try {
    const records = await lookupAll(probe);
    systemOk = records.length > 0;
    checks.push({
      name: 'System resolver (dns.lookup)',
      status: PASS,
      detail: `${probe} -> ${records.map((r) => r.address).join(', ')}`,
    });
  } catch (err) {
    checks.push({
      name: 'System resolver (dns.lookup)',
      status: FAIL,
      detail: `${probe} did not resolve (${err.code || err.message})`,
      advice: 'Name resolution is broken for every program on this machine, not just the bridge. Check your DNS settings or VPN.',
    });
  }

  try {
    await dnsPromises.resolve4(probe);
    checks.push({
      name: 'Direct DNS queries (dns.resolve)',
      status: PASS,
      detail: `servers: ${dns.getServers().join(', ')}`,
    });
  } catch (err) {
    checks.push({
      name: 'Direct DNS queries (dns.resolve)',
      status: systemOk ? INFO : WARN,
      detail: `failed (${err.code || err.message}); configured servers: ${dns.getServers().join(', ')}`,
      advice: systemOk
        ? 'Harmless: the bridge resolves through the system resolver, which works. Tools that query port 53 directly will fail on this host.'
        : 'Both resolution paths are failing. Check DNS configuration.',
    });
  }

  return checks;
}

async function checkConnectivity() {
  const checks = [];

  const ipv4 = await hasIPv4();
  checks.push({
    name: 'IPv4 connectivity',
    status: ipv4 ? PASS : INFO,
    detail: ipv4 ? `reached ${config.IPV4_TEST_URL}` : `could not reach ${config.IPV4_TEST_URL}`,
    advice: ipv4 ? 'IPv4 works, so the bridge is not required on this network.' : undefined,
  });

  const ipv6 = await hasIPv6();
  checks.push({
    name: 'IPv6 connectivity',
    status: ipv6 ? PASS : (ipv4 ? INFO : FAIL),
    detail: ipv6 ? `reached ${config.IPV6_TEST_URL}` : `could not reach ${config.IPV6_TEST_URL}`,
    advice: !ipv6 && !ipv4
      ? 'Neither protocol works. The bridge cannot help until basic connectivity is restored.'
      : undefined,
  });

  if (ipv6) {
    const nat64 = await hasWorkingNAT64();
    checks.push({
      name: 'Upstream NAT64 gateway',
      status: nat64 ? PASS : INFO,
      detail: nat64
        ? `reached ${config.NAT64_TEST_HOST} over a synthesized address`
        : `could not reach ${config.NAT64_TEST_HOST} over a synthesized address`,
      advice: nat64
        ? 'Your network already translates IPv4 traffic; the bridge is optional here.'
        : 'No NAT64 gateway responded. If this is an IPv6-only network, the bridge is needed — but it can only work if your ISP operates a NAT64 gateway.',
    });
  }

  return checks;
}

async function checkPrefix() {
  const current = config.getPrefix();
  const checks = [{
    name: 'Configured NAT64 prefix',
    status: INFO,
    detail: `${current.prefix}/${current.length}${process.env.NAT64_PREFIX ? ' (from NAT64_PREFIX)' : ' (default)'}`,
  }];

  const discovered = await discoverPrefix().catch(() => null);

  if (!discovered) {
    checks.push({
      name: 'NAT64 prefix discovery (RFC 7050)',
      status: INFO,
      detail: 'ipv4only.arpa returned no synthesized AAAA records',
      advice: 'This resolver does not provide DNS64. On an IPv6-only network that usually means you must point at a DNS64 resolver, or set NAT64_PREFIX manually.',
    });
    return checks;
  }

  const matches = discovered.prefix === current.prefix && discovered.length === current.length;
  checks.push({
    name: 'NAT64 prefix discovery (RFC 7050)',
    status: matches ? PASS : WARN,
    detail: `network advertises ${discovered.prefix}/${discovered.length}`,
    advice: matches
      ? undefined
      : `This differs from the prefix in use. Set NAT64_PREFIX=${discovered.prefix}/${discovered.length} or let discovery apply it automatically.`,
  });

  return checks;
}

function checkSecurity() {
  const checks = [];
  const loopback = config.isLoopbackBind();
  const guarded = Boolean(config.AUTH) || !config.ALLOW_FROM.isEmpty;

  checks.push({
    name: 'Listener exposure',
    status: loopback || guarded ? PASS : WARN,
    detail: loopback
      ? `bound to ${config.BIND_HOST} (loopback only)`
      : `bound to ${config.BIND_HOST}${guarded ? ' with access control' : ' with no access control'}`,
    advice: loopback || guarded
      ? undefined
      : 'Anyone who can reach this host can relay traffic through it. Set IPV6_BRIDGE_AUTH or IPV6_BRIDGE_ALLOW, or bind to 127.0.0.1.',
  });

  return checks;
}

/**
 * Run every diagnostic check.
 *
 * @returns {Promise<{checks: object[], summary: {pass: number, warn: number, fail: number}, interfaces: object}>}
 */
async function diagnose() {
  const checks = [
    ...await checkResolvers(),
    ...await checkConnectivity(),
    ...await checkPrefix(),
    ...checkSecurity(),
  ];

  const summary = { pass: 0, warn: 0, fail: 0, info: 0 };
  for (const check of checks) summary[check.status] += 1;

  return { checks, summary, interfaces: interfaces() };
}

/**
 * Render diagnostics as human-readable text.
 *
 * @param {object} report - Result of diagnose()
 * @returns {string} Formatted report
 */
function format(report) {
  const symbols = { pass: '  OK  ', fail: ' FAIL ', warn: ' WARN ', info: ' INFO ' };
  const lines = ['', 'IPv6 Bridge diagnostics', '======================='];

  lines.push('', 'Network interfaces:');
  lines.push(`  IPv4: ${report.interfaces.ipv4.join(', ') || 'none'}`);
  lines.push(`  IPv6: ${report.interfaces.ipv6.join(', ') || 'none'}`);
  lines.push('');

  for (const check of report.checks) {
    lines.push(`[${symbols[check.status]}] ${check.name}`);
    lines.push(`          ${check.detail}`);
    if (check.advice) lines.push(`          -> ${check.advice}`);
  }

  const { pass, warn, fail } = report.summary;
  lines.push('', `${pass} passed, ${warn} warning(s), ${fail} failure(s)`, '');
  return lines.join('\n');
}

module.exports = { diagnose, format };
