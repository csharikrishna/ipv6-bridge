const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dns = require('dns').promises;

const PORT = 3000;

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
  if (req.url.startsWith('/api/bridge-status')) {
    const checkBridge = async () => {
      try {
        const https = require('https');
        return new Promise((resolve) => {
          const request = https.request('https://ipv6.google.com', {
            method: 'HEAD',
            timeout: 3000
          }, (res) => {
            resolve({ connected: true, statusCode: res.statusCode });
          });
          
          request.on('error', () => resolve({ connected: false }));
          request.on('timeout', () => {
            request.destroy();
            resolve({ connected: false });
          });
          request.end();
        });
      } catch (error) {
        return { connected: false, error: error.message };
      }
    };

    checkBridge().then(bridgeStatus => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        bridgePort: 8080,
        bridgeRunning: bridgeStatus.connected,
        ipv6Available: getNetworkInterfaces().ipv6.length > 0
      }));
    });
    return;
  }

  // API: DNS resolution test (IPv4 and IPv6)
  if (req.url.startsWith('/api/dns-resolve')) {
    let testHost = req.headers['x-test-host'] || 'google.com';
    
    // Strip port number if present (e.g., "127.0.0.1:9627" -> "127.0.0.1")
    testHost = testHost.split(':')[0];
    
    // Strip protocol if present (e.g., "http://example.com" -> "example.com")
    testHost = testHost.replace(/^(https?:\/\/)/, '');
    testHost = testHost.replace(/\/$/, ''); // Remove trailing slash
    
    // Check if input is already an IP address
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$/;
    
    const isIPv4 = ipv4Regex.test(testHost);
    const isIPv6 = ipv6Regex.test(testHost);
    
    if (isIPv4 || isIPv6) {
      // If it's already an IP address, just return it without DNS lookup
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        host: testHost,
        ipv4: isIPv4 ? [testHost] : { error: 'Not an IPv4 address' },
        ipv6: isIPv6 ? [testHost] : { error: 'Not an IPv6 address' },
        isDirectAddress: true,
        timestamp: new Date().toISOString()
      }));
      return;
    }
    
    Promise.all([
      dns.resolve4(testHost).catch(e => ({ error: e.message })),
      dns.resolve6(testHost).catch(e => ({ error: e.message }))
    ]).then(([ipv4, ipv6]) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        host: testHost,
        ipv4: Array.isArray(ipv4) ? ipv4 : ipv4,
        ipv6: Array.isArray(ipv6) ? ipv6 : ipv6,
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

  // Serve static files
  let filePath = req.url === '/' ? '/public/index.html' : req.url;
  if (!filePath.startsWith('/public/') && req.url !== '/') {
    filePath = '/public' + req.url;
  }
  filePath = path.join(__dirname, filePath);
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

server.listen(PORT, () => {
  console.log(`\nIPv6 Bridge Demo Application`);
  console.log(`============================\n`);
  console.log(`Server running at: http://localhost:${PORT}`);
  console.log(`\nSetup Instructions:`);
  console.log(`1. Start the IPv6 Bridge: npx ipv6-bridge start`);
  console.log(`2. Open http://localhost:${PORT} in your browser`);
  console.log(`3. Use the demo to test bidirectional bridging\n`);
});
