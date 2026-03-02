/**
 * SealVera HTTP client — sends log entries to the SealVera server
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

let _config = null;

function setConfig(config) {
  _config = config;
}

function getConfig() {
  return _config;
}

/**
 * Send a log entry to the SealVera ingest endpoint
 */
async function sendLog(entry) {
  if (!_config) {
    throw new Error('[SealVera] Not initialized — call SealVera.init() first');
  }

  const { endpoint, apiKey } = _config;
  const url = new URL('/api/ingest', endpoint);

  const payload = JSON.stringify(entry);

  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-SealVera-Key': apiKey
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); } catch (_) { resolve({}); }
          } else {
            reject(new Error(`SealVera server returned ${res.statusCode}: ${data}`));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

module.exports = { sendLog, setConfig, getConfig };
