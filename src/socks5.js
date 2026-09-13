/**
 * IPv6 Bridge - SOCKS5 server (RFC 1928, RFC 1929)
 *
 * An HTTP proxy can only carry HTTP. SOCKS5 carries any TCP protocol, so this
 * listener lets ssh, git, database clients and anything else reach IPv4-only
 * servers through the same DNS64/NAT64 translation.
 *
 * Only the CONNECT command is implemented; BIND and UDP ASSOCIATE require
 * inbound reachability that a user-space bridge cannot provide.
 *
 * @module socks5
 */

const net = require('net');
const { connectWithFallback } = require('./connect');
const config = require('./config');
const stats = require('./stats');
const log = require('./logger');

const VERSION = 0x05;

const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const AUTH_UNACCEPTABLE = 0xff;

const CMD_CONNECT = 0x01;

const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;

const REPLY = {
  SUCCESS: 0x00,
  GENERAL_FAILURE: 0x01,
  NOT_ALLOWED: 0x02,
  HOST_UNREACHABLE: 0x04,
  TTL_EXPIRED: 0x06,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_TYPE_NOT_SUPPORTED: 0x08,
};

/**
 * Read an exact number of bytes from a socket.
 *
 * @param {net.Socket} socket - Socket to read from
 * @param {number} length - Byte count
 * @param {number} timeout - Milliseconds to wait
 * @returns {Promise<Buffer>} The bytes read
 */
function readBytes(socket, length, timeout) {
  return new Promise((resolve, reject) => {
    if (length === 0) return resolve(Buffer.alloc(0));

    let buffer = socket.read(length);
    if (buffer) return resolve(buffer);

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('SOCKS5 handshake timed out'));
    }, timeout);

    function onReadable() {
      buffer = socket.read(length);
      if (buffer) {
        cleanup();
        resolve(buffer);
      }
    }
    function onEnd() {
      cleanup();
      reject(new Error('SOCKS5 client closed the connection during the handshake'));
    }
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('readable', onReadable);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onEnd);
    }

    socket.on('readable', onReadable);
    socket.once('end', onEnd);
    socket.once('error', onEnd);
  });
}

/**
 * Build a SOCKS5 reply message.
 *
 * @param {number} code - Reply code
 * @param {object} [bound] - Bound address to report
 * @returns {Buffer} Encoded reply
 */
function reply(code, bound = null) {
  // Clients ignore the bound address for CONNECT, so report the unspecified
  // IPv4 address unless a real one is available.
  if (!bound || net.isIP(bound.address) !== 4) {
    return Buffer.from([VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]);
  }

  const octets = bound.address.split('.').map(Number);
  const message = Buffer.alloc(10);
  message[0] = VERSION;
  message[1] = code;
  message[2] = 0x00;
  message[3] = ATYP_IPV4;
  Buffer.from(octets).copy(message, 4);
  message.writeUInt16BE(bound.port || 0, 8);
  return message;
}

/**
 * Negotiate the authentication method (RFC 1928 section 3, RFC 1929).
 *
 * @param {net.Socket} socket - Client socket
 * @param {number} timeout - Handshake timeout
 * @returns {Promise<boolean>} true if the client is authenticated
 */
async function negotiateAuth(socket, timeout) {
  const greeting = await readBytes(socket, 2, timeout);
  if (greeting[0] !== VERSION) throw new Error(`Unsupported SOCKS version ${greeting[0]}`);

  const methods = await readBytes(socket, greeting[1], timeout);
  const required = config.AUTH ? AUTH_USERPASS : AUTH_NONE;

  if (!methods.includes(required)) {
    socket.end(Buffer.from([VERSION, AUTH_UNACCEPTABLE]));
    return false;
  }

  socket.write(Buffer.from([VERSION, required]));
  if (!config.AUTH) return true;

  // RFC 1929 username/password sub-negotiation
  const header = await readBytes(socket, 2, timeout);
  if (header[0] !== 0x01) throw new Error('Unsupported SOCKS5 auth sub-negotiation version');

  const username = (await readBytes(socket, header[1], timeout)).toString();
  const passwordLength = (await readBytes(socket, 1, timeout))[0];
  const password = (await readBytes(socket, passwordLength, timeout)).toString();

  const ok = username === config.AUTH.username && password === config.AUTH.password;
  socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));

  if (!ok) {
    stats.counters.authFailures += 1;
    socket.end();
    return false;
  }
  return true;
}

/**
 * Read the CONNECT request and resolve its target.
 *
 * @param {net.Socket} socket - Client socket
 * @param {number} timeout - Handshake timeout
 * @returns {Promise<{hostname: string, port: number}>} Requested destination
 */
async function readRequest(socket, timeout) {
  const header = await readBytes(socket, 4, timeout);
  if (header[0] !== VERSION) throw new Error(`Unsupported SOCKS version ${header[0]}`);

  const command = header[1];
  const addressType = header[3];

  if (command !== CMD_CONNECT) {
    const err = new Error(`Unsupported SOCKS5 command ${command}`);
    err.replyCode = REPLY.COMMAND_NOT_SUPPORTED;
    throw err;
  }

  let hostname;
  if (addressType === ATYP_IPV4) {
    hostname = Array.from(await readBytes(socket, 4, timeout)).join('.');
  } else if (addressType === ATYP_IPV6) {
    const bytes = await readBytes(socket, 16, timeout);
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
    hostname = groups.join(':');
  } else if (addressType === ATYP_DOMAIN) {
    const length = (await readBytes(socket, 1, timeout))[0];
    hostname = (await readBytes(socket, length, timeout)).toString();
  } else {
    const err = new Error(`Unsupported SOCKS5 address type ${addressType}`);
    err.replyCode = REPLY.ADDRESS_TYPE_NOT_SUPPORTED;
    throw err;
  }

  const port = (await readBytes(socket, 2, timeout)).readUInt16BE(0);
  return { hostname, port };
}

async function handleConnection(socket) {
  const timeout = config.CONNECTION_TIMEOUT;
  socket.pause();

  try {
    if (!config.ALLOW_FROM.isEmpty && !config.ALLOW_FROM.matches(socket.remoteAddress)) {
      stats.counters.authFailures += 1;
      log.warn(`Rejected SOCKS5 connection from ${socket.remoteAddress}: not in the allowlist`);
      socket.end();
      return;
    }

    if (!await negotiateAuth(socket, timeout)) return;

    const target = await readRequest(socket, timeout);
    stats.counters.socksRequests += 1;

    const bypass = !config.BYPASS.isEmpty && config.BYPASS.matches(target.hostname);

    let upstream;
    try {
      ({ socket: upstream } = await connectWithFallback(target.hostname, target.port, { bypass }));
    } catch (err) {
      stats.counters.proxyErrors += 1;
      log.warn(`SOCKS5 connect to ${target.hostname}:${target.port} failed: ${err.message}`);
      socket.end(reply(err.code === 'ETIMEDOUT' ? REPLY.TTL_EXPIRED : REPLY.HOST_UNREACHABLE));
      return;
    }

    if (socket.destroyed) {
      upstream.destroy();
      return;
    }

    log.debug(`SOCKS5 ${target.hostname}:${target.port} connected`);
    socket.write(reply(REPLY.SUCCESS, upstream.address()));

    upstream.on('data', (chunk) => { stats.counters.bytesToClient += chunk.length; });
    socket.on('data', (chunk) => { stats.counters.bytesToUpstream += chunk.length; });

    socket.resume();
    upstream.pipe(socket);
    socket.pipe(upstream);

    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  } catch (err) {
    log.debug(`SOCKS5 handshake failed: ${err.message}`);
    if (!socket.destroyed) {
      socket.end(reply(err.replyCode || REPLY.GENERAL_FAILURE));
    }
  }
}

/**
 * Create and start a SOCKS5 server.
 *
 * @param {number} port - Port to listen on
 * @param {string} [host] - Interface to bind to
 * @returns {Promise<net.Server>} Resolves with the server once it's listening
 */
function createSocksServer(port, host = config.BIND_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer(handleConnection);
    const sockets = new Set();

    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

    server.closeGracefully = () => new Promise((done) => {
      server.close(() => done());
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    });

    server.once('error', (err) => {
      reject(new Error(`Failed to start SOCKS5 server: ${err.message}`));
    });

    server.listen(port, host, () => {
      const bound = server.address();
      log.info(`SOCKS5 listening on ${bound.address}:${bound.port}`);
      resolve(server);
    });
  });
}

module.exports = { createSocksServer, REPLY };
