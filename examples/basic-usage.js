/**
 * IPv6 Bridge — Basic Usage Example
 *
 * Demonstrates how to integrate IPv6 Bridge into a Node.js application.
 *
 * Run:
 *   node examples/basic-usage.js
 *
 * The bridge only starts if this machine actually needs it. To try it on a
 * dual-stack network, force it:
 *   FORCE_BRIDGE=1 node examples/basic-usage.js
 */

const { start, stop } = require('../src/index');

async function main() {
  console.log('Starting IPv6 Bridge...\n');

  const server = await start(8080);

  if (!server) {
    console.log('Bridge not needed — IPv4 is reachable, or NAT64 already works.');
    console.log('Run with FORCE_BRIDGE=1 to start it anyway.');
    return;
  }

  const { port } = server.address();
  console.log(`Bridge started on port ${port}`);
  console.log(`Configure your browser/system proxy to 127.0.0.1:${port}`);
  console.log(`Check what it is doing: http://127.0.0.1:${port}/status\n`);
  console.log('Press Ctrl+C to stop.\n');

  const shutdown = async () => {
    console.log('\nShutting down...');
    await stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
