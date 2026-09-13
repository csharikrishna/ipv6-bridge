// IPv6 Bridge Demo Application
// Comprehensive diagnostics and testing interface

// State management
const state = {
  totalTests: 0,
  successTests: 0,
  totalLatency: 0,
  logs: [],
  maxLogs: 100
};

// Escape values before interpolating them into innerHTML. Hostnames and error
// strings are user-controlled and would otherwise execute as markup.
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  addLog('Application initialized', 'info');
  refreshDiagnostics();
  setInterval(refreshDiagnostics, 10000); // Refresh every 10 seconds
});

// Add log entry
function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = `[${timestamp}] ${message}`;
  
  state.logs.unshift({ message: logEntry, type });
  if (state.logs.length > state.maxLogs) {
    state.logs.pop();
  }
  
  renderLogs();
}

// Render logs to UI
function renderLogs() {
  const container = document.getElementById('logContainer');
  container.innerHTML = '';
  
  state.logs.forEach(log => {
    const entry = document.createElement('div');
    entry.className = `log-entry ${log.type}`;
    entry.textContent = log.message;
    container.appendChild(entry);
  });
}

// Clear logs
function clearLogs() {
  state.logs = [];
  renderLogs();
  addLog('Logs cleared', 'info');
}

// Switch between tabs
function switchTab(tabName) {
  // Hide all tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  
  // Deactivate all buttons
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Show selected tab
  document.getElementById(tabName).classList.add('active');
  
  // Activate button
  event.target.classList.add('active');
}

// Refresh system diagnostics
async function refreshDiagnostics() {
  try {
    // Check bridge status
    const response = await fetch('/api/bridge-status');
    const bridgeData = await response.json();
    
    let statusHTML = '';
    if (bridgeData.bridgeRunning) {
      statusHTML = '<div class="status-badge active">Bridge is running (localhost:8080)</div>';
    } else {
      statusHTML = '<div class="status-badge inactive">Bridge not detected. Start it with: npx ipv6-bridge start</div>';
    }
    
    if (bridgeData.ipv6Available) {
      statusHTML += '<div class="status-badge active">IPv6 interfaces detected</div>';
    } else {
      statusHTML += '<div class="status-badge inactive">No IPv6 interfaces</div>';
    }
    
    document.getElementById('bridgeStatusContainer').innerHTML = statusHTML;
    
  } catch (error) {
    document.getElementById('bridgeStatusContainer').innerHTML = 
      '<div class="status-badge inactive">Unable to check bridge status</div>';
  }
  
  // Load network interfaces
  loadNetworkInfo();
}

// Load network interface information
async function loadNetworkInfo() {
  try {
    const response = await fetch('/api/diagnostics');
    const data = await response.json();
    
    let html = '<table class="info-table"><tr><th>Interface</th><th>Address</th><th>Type</th></tr>';
    
    if (data.networkInterfaces.ipv4.length > 0) {
      data.networkInterfaces.ipv4.forEach(iface => {
        html += `<tr><td>${iface.interface}</td><td>${iface.address}</td><td>IPv4</td></tr>`;
      });
    }
    
    if (data.networkInterfaces.ipv6.length > 0) {
      data.networkInterfaces.ipv6.forEach(iface => {
        html += `<tr><td>${iface.interface}</td><td>${iface.address}</td><td>IPv6</td></tr>`;
      });
    }
    
    if (data.networkInterfaces.ipv4.length === 0 && data.networkInterfaces.ipv6.length === 0) {
      html += '<tr><td colspan="3" style="text-align: center; color: #6b7280;">No network interfaces detected</td></tr>';
    }
    
    html += '</table>';
    document.getElementById('networkStatus').innerHTML = html;
    
  } catch (error) {
    document.getElementById('networkStatus').innerHTML = '<p style="color: #ef4444;">Error loading network info: ' + error.message + '</p>';
  }
}

// Test DNS resolution
async function testDNS() {
  const host = document.getElementById('dnsHost').value || 'google.com';
  
  if (!host.trim()) {
    addLog('Please enter a hostname or IP address', 'warning');
    return;
  }
  
  addLog(`Resolving DNS for: ${host}`, 'info');
  
  try {
    const response = await fetch(`/api/dns-resolve?host=${encodeURIComponent(host)}`, {
      headers: { 'x-test-host': host }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const result = await response.json();
    
    const renderRecords = (records) => {
      if (Array.isArray(records)) {
        return records.length
          ? escapeHtml(records.join(', ')) + '<br>'
          : '<em>none</em><br>';
      }
      const message = (records && records.error) || 'Unknown error';
      return `<span style="color: #ef4444;">Error: ${escapeHtml(message)}</span><br>`;
    };

    let resultHTML = '<div class="result-box">';
    resultHTML += `<strong>Hostname/IP:</strong> ${escapeHtml(result.host)}<br>`;

    if (result.isDirectAddress) {
      resultHTML += `<em>(Direct IP address, no DNS lookup needed)</em><br><br>`;
    }

    resultHTML += `<strong>IPv4 Records:</strong><br>`;
    resultHTML += renderRecords(result.ipv4);

    resultHTML += `<br><strong>IPv6 Records:</strong><br>`;
    resultHTML += renderRecords(result.ipv6);

    if (result.bridgeWouldUse) {
      resultHTML += `<br><strong>Bridge would connect via:</strong><br>`;
      if (result.bridgeWouldUse.error) {
        resultHTML += `<span style="color: #ef4444;">Error: ${escapeHtml(result.bridgeWouldUse.error)}</span><br>`;
      } else {
        resultHTML += `${escapeHtml(result.bridgeWouldUse.addresses.join(', '))} `;
        resultHTML += `<em>(${escapeHtml(result.bridgeWouldUse.mode)})</em><br>`;
      }
    }

    resultHTML += `<br><strong>Timestamp:</strong> ${escapeHtml(result.timestamp)}`;
    resultHTML += '</div>';
    
    document.getElementById('dnsResult').innerHTML = resultHTML;
    addLog(`DNS resolution for ${host} completed successfully`, 'success');
    
  } catch (error) {
    addLog(`DNS resolution failed: ${error.message}`, 'error');
    document.getElementById('dnsResult').innerHTML = `<div class="result-box" style="color: #ef4444;"><strong>Error:</strong> ${error.message}<br><br><em>Tip: Try entering a hostname like 'google.com' or an IP like '127.0.0.1'</em></div>`;
  }
}

// Test connectivity
async function testConnectivity() {
  const url = document.getElementById('testUrl').value || 'example.com';
  
  if (!url.trim()) {
    addLog('Please enter a URL', 'warning');
    return;
  }
  
  addLog(`Testing connectivity to: ${url}`, 'info');
  state.totalTests++;
  
  const startTime = performance.now();
  
  try {
    const response = await fetch(`http://${url}`, {
      method: 'HEAD',
      mode: 'no-cors',
      timeout: 5000
    });
    
    const latency = Math.round(performance.now() - startTime);
    state.totalLatency += latency;
    state.successTests++;
    
    updateStats();
    addLog(`Connection successful to ${url} (${latency}ms)`, 'success');
    
  } catch (error) {
    const latency = Math.round(performance.now() - startTime);
    state.totalLatency += latency;
    
    addLog(`Connection failed to ${url}: ${error.message}`, 'error');
  }
}

// Convert IPv4 to IPv6
function convertIPv4() {
  const ipv4 = document.getElementById('ipv4Input').value || '192.0.2.1';
  
  if (!ipv4.match(/^(\d{1,3}\.){3}\d{1,3}$/)) {
    addLog('Invalid IPv4 address format', 'warning');
    document.getElementById('conversionResult').innerHTML = 
      '<div class="result-box" style="color: #ef4444;">Invalid IPv4 address. Use format: 192.0.2.1</div>';
    return;
  }
  
  // Convert IPv4 to IPv6 using NAT64 prefix
  const parts = ipv4.split('.');
  const hex1 = (parseInt(parts[0]) << 8 | parseInt(parts[1])).toString(16).padStart(4, '0');
  const hex2 = (parseInt(parts[2]) << 8 | parseInt(parts[3])).toString(16).padStart(4, '0');
  
  const ipv6 = `64:ff9b::${hex1}:${hex2}`;
  
  let resultHTML = '<div class="result-box">';
  resultHTML += `Original IPv4: ${ipv4}\n`;
  resultHTML += `NAT64 Prefix: 64:ff9b::\n`;
  resultHTML += `Converted IPv6: ${ipv6}\n\n`;
  resultHTML += `This IPv6 address can be used to reach the IPv4 address\n`;
  resultHTML += `through the NAT64 translation layer when running on\n`;
  resultHTML += `an IPv6-only network.`;
  resultHTML += '</div>';
  
  document.getElementById('conversionResult').innerHTML = resultHTML;
  addLog(`Converted ${ipv4} to ${ipv6}`, 'success');
}

// Load system information
async function loadSystemInfo() {
  try {
    const response = await fetch('/api/diagnostics');
    const data = await response.json();
    
    let html = '<table class="info-table">';
    html += '<tr><th>Property</th><th>Value</th></tr>';
    html += `<tr><td>Platform</td><td>${data.platform}</td></tr>`;
    html += `<tr><td>Architecture</td><td>${data.architecture}</td></tr>`;
    html += `<tr><td>Node.js Version</td><td>${data.nodeVersion}</td></tr>`;
    html += `<tr><td>System Uptime</td><td>${Math.round(data.uptime)} seconds</td></tr>`;
    html += `<tr><td>DNS Servers</td><td>${data.dnsServers.join(', ')}</td></tr>`;
    html += '</table>';
    
    document.getElementById('systemInfo').innerHTML = html;
    addLog('System information loaded', 'success');
    
  } catch (error) {
    document.getElementById('systemInfo').innerHTML = 
      `<div style="color: #ef4444;">Error loading system info: ${error.message}</div>`;
    addLog(`Error loading system info: ${error.message}`, 'error');
  }
}

// Update statistics
function updateStats() {
  const successRate = state.totalTests > 0 ? 
    Math.round((state.successTests / state.totalTests) * 100) : 0;
  const avgLatency = state.totalTests > 0 ? 
    Math.round(state.totalLatency / state.totalTests) : 0;
  
  document.getElementById('testCount').textContent = state.totalTests;
  document.getElementById('successRate').textContent = `${successRate}%`;
  document.getElementById('avgLatency').textContent = `${avgLatency}ms`;
}

// Clear results
function clearResults() {
  state.totalTests = 0;
  state.successTests = 0;
  state.totalLatency = 0;
  updateStats();
  document.getElementById('dnsResult').innerHTML = '';
  document.getElementById('conversionResult').innerHTML = '';
  addLog('Test results cleared', 'info');
}
