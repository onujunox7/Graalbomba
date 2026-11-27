'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const http = require('node:http'), crypto = require('node:crypto');
const { WEB_PROTOCOL, readWebSocketCredential, selectWebSocketProtocol } = require('./websocket_identity');

// Exercise the production validators rather than a second implementation of them.
const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const start = source.indexOf('const sign = '), end = source.indexOf('const ensureGuest = ', start);
assert.ok(start >= 0 && end > start);
const secret = crypto.randomBytes(32).toString('hex');
const account = 'discord-fixture', guest = 'g' + '1'.repeat(32);
const auth = vm.runInNewContext(source.slice(start, end) + '\n({mkSession, sessionOf, guestOf})', {
  crypto, Buffer, URL, AUTH_ON: true, ACC: { [account]: { id: account } },
  SES_SECRET: secret, SES_DAYS: 30, PUBLIC_URL: '', GID_RE: /^g[a-f0-9]{32}$/,
  readWebSocketCredential
});
const session = auth.mkSession(account);
const protocols = value => [WEB_PROTOCOL, 'aetheria.ggid.' + guest, 'aetheria.gsid.' + value];
const request = (value = session, upgrade = 'websocket') => ({
  url: '/', headers: { upgrade, 'sec-websocket-protocol': protocols(value).join(', ') }
});
function signed(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return data + '.' + crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

test('browser WebSocket handshake authenticates without a Cookie header', { timeout: 6000 }, async () => {
  const server = http.createServer(), sockets = new Set();
  let resolveRequest;
  const received = new Promise(resolve => { resolveRequest = resolve; });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.on('error', () => {});
    resolveRequest({ cookiePresent: !!req.headers.cookie, account: auth.sessionOf(req), guest: auth.guestOf(req), url: req.url });
    // Authentication is the seam under test; do not start a game/session simulation.
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const browserSocket = new WebSocket('ws://127.0.0.1:' + server.address().port + '/', protocols(session));
    browserSocket.addEventListener('error', () => {});
    const result = await received;
    assert.equal(result.cookiePresent, false);
    assert.equal(result.account, account);
    assert.equal(result.guest, guest);
    assert.equal(result.url, '/');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
});

test('native clients keep Cookie authentication', () => {
  const req = { url: '/', headers: { upgrade: 'websocket', cookie: 'gsid=' + encodeURIComponent(session) + '; ggid=' + guest } };
  assert.equal(auth.sessionOf(req), account);
  assert.equal(auth.guestOf(req), guest);
});

test('explicit browser identity and logout cannot be overridden by site cookies', () => {
  const req = request();
  req.headers.cookie = 'gsid=invalid.signature; ggid=g' + '2'.repeat(32);
  assert.equal(auth.sessionOf(req), account);
  assert.equal(auth.guestOf(req), guest);
  req.headers['sec-websocket-protocol'] = WEB_PROTOCOL + ', aetheria.ggid.' + guest;
  req.headers.cookie = 'gsid=' + session;
  assert.equal(auth.sessionOf(req), null);
  req.headers['sec-websocket-protocol'] += ', aetheria.gsid.invalid.signature';
  assert.equal(auth.sessionOf(req), null);
});

test('signature, expiry and account existence are still checked', () => {
  assert.equal(auth.sessionOf(request(session.slice(0, -1) + (session.endsWith('a') ? 'b' : 'a'))), null);
  assert.equal(auth.sessionOf(request(signed({ id: account, exp: Date.now() - 1000 }))), null);
  assert.equal(auth.sessionOf(request(signed({ id: 'unknown', exp: Date.now() + 60000 }))), null);
});

test('HTTP requests and query strings cannot supply WebSocket credentials', () => {
  assert.equal(auth.sessionOf(request(session, '')), null);
  assert.equal(auth.sessionOf({ url: '/?gsid=' + session, headers: { upgrade: 'websocket' } }), null);
  assert.equal(auth.guestOf({ url: '/?ggid=' + guest, headers: { upgrade: 'websocket' } }), null);
});

test('malformed, duplicate or unversioned credentials are rejected', () => {
  const req = request();
  req.headers['sec-websocket-protocol'] += ', aetheria.gsid.' + session;
  assert.equal(readWebSocketCredential(req, 'gsid'), '');
  req.headers['sec-websocket-protocol'] = 'aetheria.gsid.' + session;
  assert.equal(readWebSocketCredential(req, 'gsid'), null);
  req.headers['sec-websocket-protocol'] = WEB_PROTOCOL + ', aetheria.ggid.discord-account';
  assert.equal(readWebSocketCredential(req, 'ggid'), '');
});

test('the negotiated protocol never echoes a session or guest credential', () => {
  assert.equal(selectWebSocketProtocol(new Set(protocols(session))), WEB_PROTOCOL);
  assert.equal(selectWebSocketProtocol(new Set(['aetheria.gsid.' + session])), false);
  assert.equal(selectWebSocketProtocol(new Set()), false);
  assert.equal(selectWebSocketProtocol(new Set(['legacy'])), 'legacy');
  assert.ok(/handleProtocols:\s*selectWebSocketProtocol/.test(source), 'production WebSocket server must negotiate the public protocol');
});
