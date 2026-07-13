/**
 * IPv6 Bridge — Basic Usage Example
 *
 * Demonstrates how to integrate IPv6 Bridge into a Node.js application.
 *
 * Run:
 *   node examples/basic-usage.js
 */

const { start, stop } = require('../src/index');

async function main() {
  try {
    console.log('Starting IPv6 Bridge...\n');
    const server = await start(8080);

    if (server) {
      const addr = server.address();
      console.log(`Bridge started on port ${addr.port}`);
      console.log(`Configure your browser/system proxy to localhost:${addr.port}\n`);
      console.log('Press Ctrl+C to stop.\n');

      process.on('SIGINT', async () => {
        console.log('\nShutting down...');
        await stop();
        process.exit(0);
      });
    } else {
      console.log('Bridge not needed — you have IPv4 connectivity or working NAT64.');
      process.exit(0);
    }
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
