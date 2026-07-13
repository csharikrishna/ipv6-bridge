#!/usr/bin/env node

/**
 * IPv6 Bridge - Command-Line Interface
 *
 * Usage:
 *   npx ipv6-bridge start          Start the bridge (auto-detects if needed)
 *   npx ipv6-bridge --help         Show this help message
 *   npx ipv6-bridge --version      Show version
 *
 * Environment variables:
 *   IPV6_BRIDGE_PORT=<port>        Port to listen on (default: 8080)
 *   FORCE_BRIDGE=1                 Start even if bridge is not needed
 *   NAT64_PREFIX=<prefix>          Custom NAT64 prefix (default: 64:ff9b::)
 *
 * Stop the bridge with Ctrl+C or SIGTERM.
 *
 * @file CLI entry point for IPv6 Bridge
 */

const { start, stop } = require('./index');
const { DEFAULT_PORT } = require('./config');
const { version } = require('../package.json');

const HELP_TEXT = `
IPv6 Bridge v${version}
Local DNS64/NAT64 proxy for IPv6-only networks.

Usage:
  ipv6-bridge start           Start the bridge proxy
  ipv6-bridge --help, -h      Show this help message
  ipv6-bridge --version, -v   Show version number

Environment variables:
  IPV6_BRIDGE_PORT             Port to listen on (default: ${DEFAULT_PORT})
  FORCE_BRIDGE                 Set to any value to force start
  NAT64_PREFIX                 Custom NAT64 prefix (default: 64:ff9b::)

Stop the bridge with Ctrl+C or by sending SIGTERM.
`.trim();

const command = process.argv[2];
const port = process.env.IPV6_BRIDGE_PORT
  ? parseInt(process.env.IPV6_BRIDGE_PORT, 10)
  : DEFAULT_PORT;

if (command === '--help' || command === '-h' || !command) {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log(version);
  process.exit(0);
}

if (command === 'start') {
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`Error: Invalid port "${process.env.IPV6_BRIDGE_PORT}". Must be 1-65535.`);
    process.exit(1);
  }

  start(port)
    .then((server) => {
      if (!server) {
        process.exit(0);
      }
      console.log(`\nIPv6 Bridge running on http://localhost:${port}`);
      console.log(`Configure your browser/system proxy to localhost:${port}\n`);
    })
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });

  // Graceful shutdown on SIGINT (Ctrl+C) and SIGTERM (container/daemon stop)
  function shutdown() {
    console.log('\nStopping IPv6 Bridge...');
    stop().then(() => process.exit(0));
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Catch unhandled errors to prevent silent crashes
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err.message);
    stop().then(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    stop().then(() => process.exit(1));
  });
} else {
  console.error(`Unknown command: "${command}"\n`);
  console.log(HELP_TEXT);
  process.exit(1);
}
