# IPv6 Bridge Demo Application

Interactive diagnostics and testing tool for IPv6 Bridge functionality.

## Quick Start

```bash
npm install
npm start
```

Access the demo at: `http://localhost:3000`

## Features

- System status and network interface monitoring
- DNS resolution testing (IPv4 and IPv6)
- Connectivity testing through the bridge
- IPv4 to IPv6 address conversion using NAT64 prefix
- Activity logging and diagnostics
- Real-time performance metrics

## Usage

### 1. Start the IPv6 Bridge

In a terminal:
```bash
npx ipv6-bridge start
```

### 2. Run the Demo App

In another terminal:
```bash
cd demo-app
npm install
npm start
```

### 3. Test in Browser

Open `http://localhost:3000` and use the tools to:

- Monitor bridge status and network interfaces
- Test DNS resolution for any hostname
- Test connectivity to IPv4 and IPv6 addresses
- Convert IPv4 addresses to IPv6 using NAT64 prefix
- View real-time activity logs and test results

## API Endpoints

The demo app server provides the following endpoints:

- `GET /api/bridge-status` - Check bridge connectivity
- `GET /api/diagnostics` - Get system diagnostics
- `GET /api/dns-resolve` - Resolve hostname to IPv4/IPv6
- `GET /api/echo` - Echo request information

## Bridge Configuration

- Address: `localhost:8080`
- NAT64 Prefix: `64:ff9b::`
- Protocols: HTTP and HTTPS

## Architecture

- **Frontend**: Vanilla JavaScript with no dependencies
- **Backend**: Node.js HTTP server
- **Bridge**: IPv6 Bridge proxy (separate process)
- **Testing**: Built-in diagnostics and metrics
