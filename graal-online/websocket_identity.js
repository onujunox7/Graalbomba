'use strict';

// Browsers cannot set Cookie on a WebSocket. Credentials stay in handshake
// headers, never in URLs; the server still validates the signed session itself.
const WEB_PROTOCOL = 'aetheria.v3';
const PREFIX = 'aetheria.';

function readWebSocketCredential(req, name) {
  if (name !== 'gsid' && name !== 'ggid') return '';
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket') return null;
  const header = req.headers['sec-websocket-protocol'];
  if (typeof header !== 'string') return null;
  if (header.length > 2048) return '';
  const protocols = header.split(',').map(value => value.trim());
  if (!protocols.includes(WEB_PROTOCOL)) return null;
  const prefix = PREFIX + name + '.', matches = protocols.filter(value => value.startsWith(prefix));
  if (matches.length !== 1) return '';
  const value = matches[0].slice(prefix.length);
  if (name === 'ggid') return /^g[a-f0-9]{32}$/.test(value) ? value : '';
  return value.length <= 512 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ? value : '';
}

function selectWebSocketProtocol(protocols) {
  if (protocols.has(WEB_PROTOCOL)) return WEB_PROTOCOL;
  // Preserve non-Aetheria protocol negotiation, without echoing credentials.
  return [...protocols].find(value => !value.startsWith(PREFIX + 'gsid.') && !value.startsWith(PREFIX + 'ggid.')) || false;
}

module.exports = { WEB_PROTOCOL, readWebSocketCredential, selectWebSocketProtocol };
