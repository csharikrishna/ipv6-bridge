# IPv6 Bridge - Test Server

A comprehensive dual-stack testing tool for the IPv6 Bridge. This server provides separate IPv4-only and IPv6-only endpoints with real-time access logging to demonstrate and test DNS64/NAT64 translation.

## Features

- **Dual-Stack Endpoints**: Separate IPv4 and IPv6 servers running on random ports
- **Real-Time Access Logs**: See which IP addresses access the server and what actions they perform
- **Interactive Web Interface**: 5 action buttons + log viewer + server info display
- **Automatic Port Randomization**: Runs on random ports in the 9000-9999 range (configurable)
- **CORS Enabled**: Works seamlessly with the bridge proxy
- **Live Updates**: Logs and server info refresh automatically
- **Responsive Design**: Works on desktop and mobile devices

## Quick Start

### 1. Start the IPv6 Bridge

From the main project directory:

```bash
npm start
```

The bridge will start on `localhost:8080` (or not start if bridge not needed).

### 2. Start the Test Server

In a new terminal:

```bash
cd test-server
node server.js
```

You'll see output like:

```
✓ IPv4 Server running on http://127.0.0.1:9234
✓ IPv6 Server running on http://[::1]:9567
```

### 3. Access the Test Server

Open your browser and visit one of:

- **IPv4 Direct**: `http://127.0.0.1:9234`
- **IPv6 Direct**: `http://[::1]:9567`

## How to Test the Bridge

### Test 1: Direct IPv4 Access (No Bridge)

```bash
# In browser
http://127.0.0.1:9234
```

**Expected Result:**
- Server Info shows: `IPv4`
- You can click action buttons
- Logs show your direct IPv4 access

### Test 2: Direct IPv6 Access (No Bridge)

```bash
# In browser
http://[::1]:9567
```

**Expected Result:**
- Server Info shows: `IPv6`
- You can click action buttons
- Logs show your direct IPv6 access

### Test 3: Access Through Bridge (IPv4→IPv6 Translation)

```bash
# Prerequisites
# 1. Bridge must be running on localhost:8080
# 2. Configure your browser/system proxy to: localhost:8080

# Then access
http://127.0.0.1:9234
```

**Expected Result:**
- The bridge intercepts your IPv4 request
- Bridge uses DNS64 to translate the address to IPv6
- Request reaches the test server via IPv6
- Server Info shows: `IPv4` (the endpoint type, not the access method)
- Logs show the connection came through the bridge
- This demonstrates DNS64/NAT64 working in practice

### Test 4: Multiple Action Buttons

Click the action buttons to generate different types of logs:

- **HTTP Request**: Test basic connectivity
- **Database Query**: Test data operations
- **File Download**: Test file operations
- **Authentication**: Test security operations
- **Error Test**: Test error handling
- **Clear Logs**: Reset the log display

Each action is timestamped and includes the client IP address.

## Configuration

### Custom Port Range

By default, servers run on ports 9000-9999. To use a custom range:

```bash
PORT_BASE=3000 node server.js
```

This will use ports 3000-3999.

### Custom IPv4 Port

The IPv4 and IPv6 ports are randomized independently. To use fixed ports, you can modify `server.js`:

```javascript
const IPV4_PORT = 9000;  // Change from getRandomPort()
const IPV6_PORT = 9001;
```

## API Endpoints

The test server provides these API endpoints:

### `GET /`
Returns the HTML test interface.

### `GET /api/info`
Returns server and client information:
```json
{
  "ipVersion": "IPv4",
  "serverPort": 9234,
  "clientIP": "127.0.0.1",
  "timestamp": "2026-01-31T10:30:45.123Z"
}
```

### `GET /api/logs`
Returns all access logs:
```json
{
  "logs": [
    {
      "timestamp": "2026-01-31T10:30:45.123Z",
      "ipVersion": "IPv4",
      "clientIP": "127.0.0.1",
      "action": "Page load"
    }
  ]
}
```

### `POST /api/action`
Records a custom action:
```bash
curl -X POST http://127.0.0.1:9234/api/action \
  -H "Content-Type: application/json" \
  -d '{"action": "Custom Action"}'
```

## Understanding the Logs

Each log entry shows:

| Field | Meaning |
|-------|---------|
| **Timestamp** | Exact time of the access (ISO 8601) |
| **IP Version** | Whether accessed via IPv4 or IPv6 |
| **Client IP** | The IP address that made the request |
| **Action** | What action was performed |

### Example Log Entries

```
2026-01-31T10:30:45.123Z | IPv4 | 127.0.0.1 | Page load
2026-01-31T10:30:46.456Z | IPv4 | 127.0.0.1 | Action: HTTP Request
2026-01-31T10:30:47.789Z | IPv6 | ::1 | Page load
2026-01-31T10:30:48.012Z | IPv6 | ::1 | Action: Database Query
```

## Testing with Bridge

To truly test the bridge's DNS64/NAT64 functionality:

1. **Start Bridge**: `npm start` (main directory)
2. **Start Test Server**: `cd test-server && node server.js`
3. **Configure Proxy**: Set your system/browser proxy to `localhost:8080`
4. **Access IPv4 Server**: Visit `http://127.0.0.1:9234`
5. **Watch Logs**: The logs show the bridge translating IPv4→IPv6

## Troubleshooting

### IPv6 Server Won't Start

IPv6 may not be available on your system. The test server will warn but continue with IPv4. This is normal on some systems.

### Can't Access Server

- Ensure firewall allows `localhost` connections
- Try `127.0.0.1` instead of `localhost`
- Check that ports aren't already in use

### Bridge Not Working

- Verify bridge started: `npm start` shows output
- Ensure proxy is configured correctly (localhost:8080)
- Check bridge logs for errors

### Logs Not Updating

- Browser auto-refreshes logs every 2 seconds
- Try refreshing manually (F5)
- Check browser console for JavaScript errors

## Files Structure

```
test-server/
├── server.js              # Main server with logging
├── public/
│   ├── index.html         # Web interface
│   └── style.css          # Styling
└── README.md              # This file
```

## How It Works Internally

### Server Architecture

```
Client Request
    ↓
Test Server (IPv4 or IPv6)
    ↓
Request Handler
    ├─ Extract Client IP
    ├─ Route Request
    │  ├─ Static files (HTML, CSS)
    │  ├─ /api/info (Server info)
    │  ├─ /api/logs (Log retrieval)
    │  └─ /api/action (Log recording)
    └─ Add Log Entry
        ├─ Timestamp
        ├─ IP Version
        ├─ Client IP
        └─ Action
```

### Access Log Flow

```
1. Request arrives at server
2. Extract client IP from request
3. Determine if IPv4 or IPv6 endpoint
4. Process the request
5. Record in access log
6. Frontend auto-refreshes logs every 2 seconds
7. Display in real-time on web interface
```

## Real-World Testing Scenarios

### Scenario 1: IPv6-Only Network Testing

If you have access to an IPv6-only network:

1. Start test server
2. Access IPv4 endpoint through bridge
3. Logs show IPv4 endpoint accessed via IPv6 network
4. Demonstrates bridge working in IPv6-only environment

### Scenario 2: Dual-Stack Network Testing

On a normal dual-stack network:

1. Access IPv4 endpoint directly
2. Access IPv6 endpoint directly
3. Access IPv4 endpoint through bridge (proxied as IPv6)
4. Compare logs to understand the difference

### Scenario 3: Bridge Performance

Use action buttons to generate multiple log entries:

1. Click buttons repeatedly
2. Watch logs update in real-time
3. Monitor performance of bridge translation
4. Verify no data loss or corruption

## Educational Value

This test server helps understand:

- **DNS64**: How IPv4 addresses become IPv6 addresses
- **NAT64**: How requests are translated at the application level
- **Dual-Stack Networking**: Coexistence of IPv4 and IPv6
- **Proxy Architecture**: How bridges intercept and route traffic
- **IP Address Spoofing**: What client IP the server sees
- **Request Logging**: Tracking network activity

## Notes

- The test server uses `http` (not `https`) for simplicity
- Logs are stored in memory; they're cleared when the server restarts
- Maximum 100 log entries are kept; older entries are discarded
- All timestamps use ISO 8601 format with millisecond precision

## See Also

- [ARCHITECTURE.md](../ARCHITECTURE.md) - Deep technical details on DNS64/NAT64
- [README.md](../README.md) - Main project documentation
- [DOCUMENTATION.md](../DOCUMENTATION.md) - Complete feature documentation

## Support

For issues with the test server or bridge:

1. Check the console output of both services
2. Verify network connectivity
3. See DOCUMENTATION.md for troubleshooting
4. Check ARCHITECTURE.md for technical details
