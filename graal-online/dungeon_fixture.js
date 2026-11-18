'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const createDungeon = require('./dungeon');
const { MAP, center } = createDungeon;

async function waitFor(predicate, timeout = 8000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Dungeon fixture timeout');
}

async function createFixture() {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const start = source.indexOf("  ws.on('message', d => {");
  const end = source.indexOf("  ws.on('close',", start);
  const helperStart = source.indexOf('const AN_DIR =');
  const helperEnd = source.indexOf('setInterval(', helperStart);
  if ([start, end, helperStart, helperEnd].some(index => index < 0)) throw new Error('Production handler missing');
  const { pstate, normAn } = vm.runInNewContext(source.slice(helperStart, helperEnd) + '\n({pstate,normAn});');
  // Movement and dungeon packets run through the production message handler.
  const header = "ws.on('message', d => {";
  const handler = source.slice(start, end).replace(header, header +
    "let fixturePacket;try{fixturePacket=JSON.parse(d.toString());}catch{return;}if(!['u','dungeon'].includes(fixturePacket.t))return;");
  const players = new Map(), clients = [];
  const send = (ws, data) => { if (ws.readyState === 1) ws.send(typeof data === 'string' ? data : JSON.stringify(data)); };
  const dungeon = createDungeon({ players, send, authorized: p => p.allowed, getCombatState: () => ({ lvl: 1, up: 0, shots: [] }) });
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(wss, 'listening');
  const sameLine = source.split('\n').find(line => line.startsWith('const othersSame ='));
  let nextId = 0;
  wss.on('connection', ws => {
    const id = ++nextId;
    ws.pid = id;
    const p = { id, ws, acc: 'dungeon-test-' + id, role: 0, ok: 1, allowed: true,
      x: 6704, y: 17104, hp: 300, hm: 300, nm: 'Explorador', al: 1, uh: 'isolated-dungeon', economyClient: true };
    players.set(id, p);
    const context = vm.createContext({ ws, p, id, dungeon, sendTo: send, normAn, P: players, wss, pstate, Date,
      num: (value, min, max) => Math.max(min, Math.min(max, +value || 0)),
      economicSession: () => false, electHost() {}, football: { has: () => false },
      others() {}, console });
    vm.runInContext(sameLine + '\n' + handler, context);
    ws.on('close', () => players.delete(id));
    send(ws, { t: 'id', id, v: 3, economy: 1 });
    send(ws, { t: 'role', r: 0 });
    send(ws, { t: 'st', p: [...players.values()].filter(other => other.id !== id).map(pstate) });
  });
  const timer = setInterval(() => dungeon.tick(), 100);
  async function connect() {
    const ws = new WebSocket('ws://127.0.0.1:' + wss.address().port);
    const messages = [];
    clients.push(ws);
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    await once(ws, 'open');
    const packet = await waitFor(() => messages.find(message => message.t === 'id'));
    const sendPacket = data => ws.send(JSON.stringify({ t: 'dungeon', ...data }));
    const update = (x, y) => sendPacket({ t: 'u', x: 6704, y: 17104, in: 1, ix: MAP.origin[0] + x, iy: MAP.origin[1] + y,
      nm: 'Explorador', an: 'Idle_Down', ia: 'Idle_Down', lv: 1, hp: 300, hm: 300, s: 0.6 });
    return { id: packet.id, ws, messages, send: sendPacket, update,
      state: () => messages.findLast(message => message.t === 'dungeon' && message.op === 'state'),
      enter() { const spawn = center(MAP.spawn); update(spawn.x, spawn.y); } };
  }
  return { players, dungeon, connect, port: wss.address().port,
    async close() {
      clearInterval(timer);
      for (const ws of [...clients, ...wss.clients]) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
    }
  };
}

module.exports = { createFixture, waitFor };
if (require.main === module && process.argv.includes('--serve')) {
  createFixture().then(async fixture => {
    const peer = await fixture.connect();
    peer.enter();
    const reported = new Set();
    peer.ws.on('message', () => {
      const state = peer.state();
      for (const [key, condition] of [['damage', state?.enemies.some(enemy => enemy.hp < enemy.max)], ['key', state?.key],
        ['puzzle', state?.solved], ['gate', state?.gate], ['relic', state?.relic]]) {
        if (condition && !reported.has(key)) { reported.add(key); console.log('DUNGEON_PEER_' + key.toUpperCase()); }
      }
    });
    fs.writeFileSync(process.env.DUNGEON_PORT_FILE, String(fixture.port));
    console.log('DUNGEON_FIXTURE_READY');
    process.on('message', async message => { if (message === 'stop') { await fixture.close(); process.exit(0); } });
    setTimeout(async () => { await fixture.close(); process.exit(0); }, 150000).unref();
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
