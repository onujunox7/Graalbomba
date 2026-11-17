'use strict';

// Real WebSockets and the production message handler, with isolated authenticated
// sessions replacing account/database setup. No production services are contacted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const createFootball = require('./football');

async function fixture() {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf("  ws.on('message', d => {");
  const end = source.indexOf("  ws.on('close',", start);
  assert.ok(start >= 0 && end > start, 'production WebSocket handler not found');
  const handler = source.slice(start, end);
  const helperStart = source.indexOf('const AN_DIR =');
  const helperEnd = source.indexOf('setInterval(', helperStart);
  const { pstate, normAn } = vm.runInNewContext(source.slice(helperStart, helperEnd) + '\n({pstate,normAn});');
  const players = new Map();
  const contexts = new Map();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const latency = Math.max(0, Number(process.env.FOOTBALL_TEST_LATENCY_MS) || 0);
  const send = (ws, data) => {
    const bytes = typeof data === 'string' ? data : JSON.stringify(data);
    const deliver = () => { if (ws.readyState === 1) ws.send(bytes); };
    if (latency) setTimeout(deliver, latency);
    else deliver();
  };
  const football = createFootball({ players, send, viewPlayer: pstate, authorized: p => p.allowed });
  const sameLine = source.split('\n').find(line => line.startsWith('const othersSame ='));
  let nextId = 1;
  server.on('connection', ws => {
    const id = nextId++;
    ws.pid = id;
    const p = { id, ws, x: 6704 + id, y: 17104, nm: 'Player ' + id, an: 'Idle_Down',
      hp: 60, hm: 60, ok: 1, allowed: true, uh: 'isolated-test-session', economyClient: true, al: 1 };
    players.set(id, p);
    const context = vm.createContext({ ws, p, id, football, sendTo: send, normAn,
      P: players, wss: server, pstate, Date, console, SPAR_QUEUE: [], PFC: new Map(),
      others: (sender, data) => { for (const q of players.values()) if (q.id !== sender) send(q.ws, data); },
      num: (v, lo, hi) => Math.max(lo, Math.min(hi, +v || 0)),
      economicSession: () => false, electHost() {},
      requestSpar() { throw new Error('football client reached Spar handler'); },
      parties: { handle() {} }
    });
    vm.runInContext(sameLine + '\n' + handler, context);
    contexts.set(id, context);
    ws.on('close', () => { football.disconnect(id); players.delete(id); contexts.delete(id); });
    send(ws, { t: 'id', id, v: 3, economy: 1 });
  });
  const timer = setInterval(() => football.tick(), 50);
  const clients = [];
  async function connect() {
    const ws = new WebSocket('ws://127.0.0.1:' + server.address().port);
    const messages = [];
    ws.on('message', bytes => messages.push(JSON.parse(bytes)));
    clients.push(ws);
    await once(ws, 'open');
    await waitFor(() => messages.find(m => m.t === 'id'));
    const id = messages.find(m => m.t === 'id').id;
    return { ws, messages, id, send: data => ws.send(JSON.stringify(data)),
      last: op => messages.findLast(m => m.t === 'football' && m.op === op) };
  }
  return { players, football, contexts, port: server.address().port, connect,
    async close() {
      clearInterval(timer);
      for (const ws of clients) ws.terminate();
      for (const ws of server.clients) ws.terminate();
      await new Promise(resolve => server.close(resolve));
    }
  };
}

async function waitFor(predicate, timeout = 18000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for multiplayer state');
}

if (require.main === module && process.argv.includes('--serve')) {
  fixture().then(async f => {
    const bot = await f.connect();
    bot.send({ t: 'football', op: 'join', version: 1 });
    fs.writeFileSync(process.env.FOOTBALL_PORT_FILE, String(f.port));
    console.log('FOOTBALL_SOCKET_FIXTURE_READY');
    process.on('SIGTERM', async () => { await f.close(); process.exit(0); });
  }).catch(error => { console.error(error); process.exit(1); });
} else {
  test('production routing and two real WebSocket clients share ball, score and return state', { timeout: 25000 }, async t => {
    const f = await fixture();
    t.after(() => f.close());
    const blue = await f.connect();
    const red = await f.connect();
    const outsider = await f.connect();
    for (const client of [blue, red]) client.send({ t: 'football', op: 'join', version: 1 });
    await waitFor(() => blue.last('state')?.phase === 'playing');
    assert.equal(red.last('state').match, blue.last('state').match);
    const before = f.players.get(blue.id).x;
    blue.send({ t: 'u', x: -999999, y: -999999 });
    blue.send({ t: 'football', op: 'goal', score: [999, 0] });
    blue.send({ t: 'eco', op: 'consume', rid: 'test' });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(f.players.get(blue.id).x, before, 'legacy position packet bypassed football authority');
    assert.deepEqual(blue.last('state').score, [0, 0]);
    assert.ok(blue.messages.some(m => m.t === 'eco' && m.ok === false));
    assert.equal(outsider.last('state'), undefined, 'outsider received private match snapshots');
    f.contexts.get(outsider.id).SPAR_QUEUE.push(outsider.id);
    outsider.send({ t: 'football', op: 'join', version: 1 });
    await waitFor(() => outsider.last('error'), 1000);
    assert.equal(f.football.has(f.players.get(outsider.id)), false, 'Spar queue player entered football');
    // O adversário sai da linha do chute: com colisão real, um jogador parado bloqueia a bola.
    for (let i = 0; i < 12; i++) {
      red.send({ t: 'football', op: 'move', dx: 0, dy: 1 });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    red.send({ t: 'football', op: 'move', dx: 0, dy: 0 });
    for (let i = 0; i < 12; i++) {
      blue.send({ t: 'football', op: 'move', dx: 1, dy: 0 });
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    blue.send({ t: 'football', op: 'move', dx: 0, dy: 0 });
    blue.send({ t: 'football', op: 'kick', dx: 1, dy: 0 });
    await waitFor(() => blue.last('state')?.score[0] === 1, 5000);
    await waitFor(() => red.last('state')?.score[0] === 1, 1000);
    assert.deepEqual(red.last('state').score, blue.last('state').score);
    blue.send({ t: 'football', op: 'leave' });
    await waitFor(() => blue.last('end'));
    assert.equal(blue.last('end').x, 6705);
    await waitFor(() => red.last('state')?.phase === 'finished');
    assert.equal(red.last('state').winner, 1);
  });
}
