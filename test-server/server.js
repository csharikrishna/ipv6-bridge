#!/usr/bin/env node

/**
 * IPv6 Bridge - Dual-Stack Test Server
 * 
 * This server provides IPv4-only and IPv6-only endpoints to test the IPv6 Bridge.
 * 
 * Features:
 * - IPv4 endpoint: listens on 127.0.0.1:randomPort
 * - IPv6 endpoint: listens on ::1:randomPort
 * - Real-time access logs showing IP addresses and timestamps
 * - Interactive web interface with action buttons
 * - Automatic port randomization (range: 9000-9999)
 * 
 * Purpose:
 * - Verify IPv6 Bridge is correctly translating traffic
 * - See real client IP addresses in logs
 * - Test DNS64/NAT64 translation with buttons
 * - Demonstrate dual-stack networking concepts
 * 
 * Usage:
 *   node server.js                    # Start with random ports
 *   PORT_BASE=3000 node server.js     # Start with custom base port
 */

const http = require('http');
const path = require('path');
const fs = require('fs');

// Configuration
const PORT_BASE = parseInt(process.env.PORT_BASE || 9000);
const getRandomPort = () => PORT_BASE + Math.floor(Math.random() * 1000);
const IPV4_PORT = getRandomPort();
const IPV6_PORT = getRandomPort();

// Access logs storage
const accessLogs = [];
const MAX_LOGS = 100;

/**
 * Add an access log entry
 * @param {string} ipVersion - 'IPv4' or 'IPv6'
 * @param {string} clientIP - Client IP address
 * @param {string} action - Action performed
 * @param {number} timestamp - Unix timestamp
 */
function addLog(ipVersion, clientIP, action, timestamp) {
  const entry = {
    timestamp: new Date(timestamp).toISOString(),
    ipVersion,
    clientIP,
    action,
    unixTime: timestamp
  };
  
  accessLogs.unshift(entry);
  
  // Keep only last MAX_LOGS entries
  if (accessLogs.length > MAX_LOGS) {
    accessLogs.pop();
  }
  
  console.log(`[${new Date(timestamp).toISOString()}] ${ipVersion} | ${clientIP} | ${action}`);
}

/**
 * Serve static files (HTML, CSS)
 */
function serveStaticFile(filePath, contentType, response) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    response.writeHead(200, { 'Content-Type': contentType });
    response.end(content);
  } catch (error) {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('File not found');
  }
}

/**
 * Create request handler for a specific IP version
 */
function createHandler(ipVersion) {
  return (req, res) => {
    // Extract client IP
    const clientIP = req.socket.remoteAddress || 'unknown';
    const cleanIP = clientIP === '::ffff:127.0.0.1' ? '127.0.0.1' : clientIP;
    
    // CORS headers for bridge testing
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Content-Type', 'application/json');
    
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    const urlParts = req.url.split('?')[0];
    
    // Routes
    if (req.method === 'GET' && urlParts === '/') {
      serveStaticFile(
        path.join(__dirname, 'public', 'index.html'),
        'text/html',
        res
      );
      addLog(ipVersion, cleanIP, 'Page load', Date.now());
    } 
    else if (req.method === 'GET' && urlParts === '/style.css') {
      serveStaticFile(
        path.join(__dirname, 'public', 'style.css'),
        'text/css',
        res
      );
    }
    else if (req.method === 'GET' && urlParts === '/api/info') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ipVersion,
        serverPort: ipVersion === 'IPv4' ? IPV4_PORT : IPV6_PORT,
        clientIP: cleanIP,
        timestamp: new Date().toISOString()
      }));
      addLog(ipVersion, cleanIP, 'Fetched server info', Date.now());
    }
    else if (req.method === 'GET' && urlParts === '/api/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ logs: accessLogs }));
    }
    else if (req.method === 'POST' && urlParts === '/api/action') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const action = data.action || 'unknown';
          addLog(ipVersion, cleanIP, `Action: ${action}`, Date.now());
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            message: `Action '${action}' recorded on ${ipVersion}`,
            ipVersion,
            clientIP: cleanIP,
            timestamp: new Date().toISOString()
          }));
        } catch (error) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid JSON' }));
        }
      });
    }
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  };
}

/**
 * Start IPv4 server
 */
function startIPv4() {
  const server = http.createServer(createHandler('IPv4'));
  server.listen(IPV4_PORT, '127.0.0.1', () => {
    console.log(`\n✓ IPv4 Server running on http://127.0.0.1:${IPV4_PORT}`);
  });
  
  server.on('error', (error) => {
    console.error(`✗ IPv4 Server error: ${error.message}`);
  });
  
  return server;
}

/**
 * Start IPv6 server
 */
function startIPv6() {
  const server = http.createServer(createHandler('IPv6'));
  server.listen(IPV6_PORT, '::1', () => {
    console.log(`✓ IPv6 Server running on http://[::1]:${IPV6_PORT}`);
  });
  
  server.on('error', (error) => {
    if (error.code === 'EAFNOSUPPORT') {
      console.warn(`⚠ IPv6 Server: IPv6 not available on this system`);
    } else {
      console.error(`✗ IPv6 Server error: ${error.message}`);
    }
  });
  
  return server;
}

/**
 * Main startup
 */
function start() {
  console.log(`
╔════════════════════════════════════════════════╗
║  IPv6 Bridge - Dual-Stack Test Server          ║
╚════════════════════════════════════════════════╝
`);
  
  console.log('Starting servers...\n');
  
  const ipv4Server = startIPv4();
  const ipv6Server = startIPv6();
  
  console.log(`\n📊 Access Log Server: http://localhost:${IPV4_PORT} (for logging)`);
  console.log(`\n💡 Testing Instructions:`);
  console.log(`
  1. Start IPv6 Bridge:
     npm start (from main directory)
  
  2. Configure Bridge Proxy:
     Set system/browser proxy to: localhost:8080
  
  3. Access via IPv4:
     http://127.0.0.1:${IPV4_PORT}
  
  4. Access via IPv6:
     http://[::1]:${IPV6_PORT}
  
  5. Access via Bridge:
     Configure proxy to localhost:8080, then access:
     http://127.0.0.1:${IPV4_PORT} (will be translated to IPv6 by bridge)
  
  6. Watch the logs:
     View real-time access logs showing which IP accessed what
`);
  
  console.log(`\nPress Ctrl+C to stop servers\n`);
  
  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nShutting down servers...');
    ipv4Server.close();
    ipv6Server.close();
    process.exit(0);
  });
}

start();
