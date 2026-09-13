const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const { resolveHost, detectIPVersion } = require('../src/dns64');

const PORT = Number(process.env.DEMO_PORT) || 3000;
const HOST = process.env.DEMO_HOST || '127.0.0.1';
const BRIDGE_PORT = Number(process.env.IPV6_BRIDGE_PORT) || 8080;
const BRIDGE_HOST = process.env.IPV6_BRIDGE_HOST || '127.0.0.1';
const PUBLIC_DIR = path.resolve(__dirname, 'public');

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
};

// Helper to get network interfaces
function getNetworkInterfaces() {
  const interfaces = os.networkInterfaces();
  const info = {
    ipv4: [],
    ipv6: []
  };
  
  for (const [name, addresses] of Object.entries(interfaces)) {
    addresses.forEach(addr => {
      if (addr.family === 'IPv4' && !addr.internal) {
        info.ipv4.push({ interface: name, address: addr.address });
      } else if (addr.family === 'IPv6' && !addr.internal) {
        info.ipv6.push({ interface: name, address: addr.address });
      }
    });
  }
  
  return info;
}

const server = http.createServer((req, res) => {
  // Enable CORS for all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API: System diagnostics
  if (req.url.startsWith('/api/diagnostics')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      timestamp: new Date().toISOString(),
      platform: os.platform(),
      architecture: os.arch(),
      nodeVersion: process.version,
      uptime: os.uptime(),
      networkInterfaces: getNetworkInterfaces(),
      dnsServers: dns.getServers && dns.getServers() || []
    }));
    return;
  }

  // API: Bridge status check
  //
  // Checks whether the bridge is actually accepting connections on its port.
  // Probing a remote site instead would report "running" whenever the internet
  // works, regardless of whether the bridge is up.
  if (req.url.startsWith('/api/bridge-status')) {
    const isBridgeListening = () => new Promise((resolve) => {
      const socket = net.connect({ port: BRIDGE_PORT, host: BRIDGE_HOST }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
      socket.setTimeout(2000, () => {
        socket.destroy();
        resolve(false);
      });
    });

    isBridgeListening().then((bridgeRunning) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        bridgeHost: BRIDGE_HOST,
        bridgePort: BRIDGE_PORT,
        bridgeRunning,
        ipv6Available: getNetworkInterfaces().ipv6.length > 0
      }));
    });
    return;
  }

  // API: DNS resolution test (IPv4 and IPv6)
  if (req.url.startsWith('/api/dns-resolve')) {
    const query = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    let testHost = query.get('host') || req.headers['x-test-host'] || 'google.com';

    // Strip protocol and any trailing path
    testHost = testHost.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');

    // Strip a trailing :port, but leave bare IPv6 literals intact (they are
    // full of colons) and unwrap bracketed ones.
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(testHost);
    if (bracketed) {
      testHost = bracketed[1];
    } else if (detectIPVersion(testHost) !== 'ipv6') {
      testHost = testHost.replace(/:\d+$/, '');
    }

    const ipVersion = detectIPVersion(testHost);

    if (ipVersion === 'ipv4' || ipVersion === 'ipv6') {
      // Already an IP address, no DNS lookup needed
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        host: testHost,
        ipv4: ipVersion === 'ipv4' ? [testHost] : { error: 'Not an IPv4 address' },
        ipv6: ipVersion === 'ipv6' ? [testHost] : { error: 'Not an IPv6 address' },
        isDirectAddress: true,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // dns.lookup goes through the system resolver, so results match what the
    // bridge itself will see. dns.resolve* is reported alongside it because a
    // mismatch between the two is a common cause of bridge failures.
    Promise.all([
      dns.lookup(testHost, { all: true, family: 4 }).then(r => r.map(a => a.address))
        .catch(e => ({ error: e.message })),
      dns.lookup(testHost, { all: true, family: 6 }).then(r => r.map(a => a.address))
        .catch(e => ({ error: e.message })),
      resolveHost(testHost).catch(e => ({ error: e.message })),
    ]).then(([ipv4, ipv6, bridgeResult]) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        host: testHost,
        ipv4,
        ipv6,
        bridgeWouldUse: bridgeResult.error
          ? { error: bridgeResult.error }
          : { addresses: bridgeResult.addresses, mode: bridgeResult.mode },
        timestamp: new Date().toISOString()
      }));
    });
    return;
  }

  // API: Echo endpoint
  if (req.url.startsWith('/api/echo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      remoteAddress: req.socket.remoteAddress,
      remoteFamily: req.socket.remoteFamily,
      method: req.method,
      url: req.url,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  // Serve static files, confined to the public directory.
  // path.join resolves "..", so containment must be checked after resolving.
  const requestPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.resolve(PUBLIC_DIR, '.' + (requestPath === '/' ? '/index.html' : requestPath));

  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  const extname = path.extname(filePath);
  const contentType = mimeTypes[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404 Not Found');
      } else {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Server error: ' + error.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`\nIPv6 Bridge Demo Application`);
  console.log(`============================\n`);
  console.log(`Server running at: http://${HOST}:${PORT}`);
  console.log(`Watching for the bridge at: ${BRIDGE_HOST}:${BRIDGE_PORT}`);
  console.log(`\nSetup Instructions:`);
  console.log(`1. Start the IPv6 Bridge: npx ipv6-bridge start`);
  console.log(`2. Open http://${HOST}:${PORT} in your browser`);
  console.log(`3. Use the demo to test bidirectional bridging\n`);
});
