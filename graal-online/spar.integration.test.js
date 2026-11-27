'use strict';

// Production Spar helpers and message handler, real local WebSockets, no database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for local Spar messages');
}

async function fixture() {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const slice = (start, end) => {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, 'production code section not found');
    return source.slice(a, b);
  };
  const players = new Map(), timers = new Map();
  let time = Date.now(), nextTimer = 1, nextId = 1, purchases = 0;
  const send = (ws, message) => { if (ws.readyState === 1) ws.send(typeof message === 'string' ? message : JSON.stringify(message)); };
  const others = (id, message) => { for (const p of players.values()) if (p.id !== id) send(p.ws, message); };
  const economy = { purchase: async () => { purchases++; return { effect: 'heal' }; },
    consume: async () => { purchases++; return { effect: 'hp:30' }; },
    pickup: async () => { purchases++; return { effect: 'hp:10' }; } };
  const common = { P: players, sendTo: send, others, require,
    Date: { now: () => time },
    setTimeout: fn => { const id = nextTimer++; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
    economicSession: () => true, economy, NP: { a: [] }, console };
  const context = vm.createContext(common);
  const helpers = vm.runInContext(slice('const SPAR_QUEUE =', 'function requestSpar(') + '\n' +
    slice('async function economicRequest(', 'function applySv(') +
    '\n({startSpar,finishSpar,SPAR_MATCHES,SPAR_PENDING,SPAR_HP,SPAR_HIT_DAMAGE,PLAYER_HIT_INV_MS,economicRequest});', context);
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const { normAn, pstate } = vm.runInNewContext(slice('const AN_DIR =', 'setInterval(') + '\n({normAn,pstate});');
  const handler = slice("  ws.on('message', d => {", "  ws.on('close',");
  const clients = [];
  server.on('connection', ws => {
    const id = nextId++;
    ws.pid = id;
    const p = { id, ws, acc: 'local-spar-' + id, economyClient: true, groundDrops: true,
      ok: 1, hp: id === 1 ? 60 : 9800, hm: id === 1 ? 60 : 9800,
      lv: id === 1 ? 1 : 999, x: 600, y: 600, nm: 'Player ' + id, an: 'Idle_Down', pi: { spo: 0 } };
    players.set(id, p);
    const local = vm.createContext({ ...common, ...helpers, ws, p, id, normAn, pstate,
      football: {}, dungeon: { correct() {} }, electHost() {},
      othersSame: (sender, message) => others(sender.id, message),
      num: (v, lo, hi) => Math.max(lo, Math.min(hi, +v || 0)) });
    vm.runInContext(handler, local);
    send(ws, { t: 'id', id });
  });
  return { players, helpers, advance: ms => { time += ms; }, purchases: () => purchases,
    start(a, b) {
      helpers.startSpar(players.get(a), players.get(b), null);
      for (const [id, callback] of timers) { timers.delete(id); callback(); }
    },
    async connect() {
      const ws = new WebSocket('ws://127.0.0.1:' + server.address().port), messages = [];
      clients.push(ws);
      ws.on('message', bytes => messages.push(JSON.parse(bytes)));
      await once(ws, 'open');
      await waitFor(() => messages.some(m => m.t === 'id'));
      return { id: messages.find(m => m.t === 'id').id, messages,
        send: m => ws.send(JSON.stringify(m)),
        async flush() {
          const count = messages.filter(m => m.t === 'lag').length;
          ws.send(JSON.stringify({ t: 'lag' }));
          await waitFor(() => messages.filter(m => m.t === 'lag').length > count);
        } };
    },
    async close() {
      for (const ws of clients) ws.terminate();
      for (const ws of server.clients) ws.terminate();
      await new Promise(resolve => server.close(resolve));
    } };
}

test('Spar: six confirmed hits regardless of level, client damage, health claims or healing', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const low = await f.connect(), high = await f.connect(), outsider = await f.connect();
    for (const [attacker, victim] of [[low, high], [high, low]]) {
      attacker.messages.length = victim.messages.length = 0;
      f.start(low.id, high.id);
      const a = f.players.get(attacker.id), v = f.players.get(victim.id);
      assert.equal(a.hp, 180); assert.equal(a.hm, 180);
      assert.equal(v.hp, 180); assert.equal(v.hm, 180);
      // Move to a legal sword distance using the real update handler.
      for (const client of [low, high]) {
        client.send({ t: 'u', x: 600, y: 600, lv: client === low ? 1 : 999, hp: 99999, hm: 99999 });
        await client.flush();
      }
      assert.equal(v.hp, 180); assert.equal(v.hm, 180);
      outsider.send({ t: 'ph', to: victim.id, d: 2000 });
      await outsider.flush();
      assert.equal(v.hp, 180);
      victim.send({ t: 'pk', by: attacker.id });
      await victim.flush();
      assert.ok(v.spar, 'a forged defeat ended the match before six hits');
      for (let hit = 1; hit <= 6; hit++) {
        attacker.send({ t: 'ph', to: victim.id, d: hit % 2 ? 2000 : 0 });
        await attacker.flush();
        await waitFor(() => victim.messages.filter(m => m.t === 'ph').length === hit);
        assert.equal(victim.messages.filter(m => m.t === 'ph').at(-1).d, 30);
        if (hit === 6) break;
        assert.equal(v.hp, 180 - 30 * hit);
        assert.ok(a.spar && v.spar, 'match ended before six hits');
        // Repeated damage, full-heal reports, zero-health reports and potions cannot change server HP.
        attacker.send({ t: 'ph', to: victim.id, d: 2000 });
        victim.send({ t: 'u', x: 600, y: 600, lv: 999, hp: 99999, hm: 99999 });
        victim.send({ t: 'u', x: 600, y: 600, lv: 1, hp: 0, hm: 1 });
        for (const op of ['consume', 'buy', 'pickup']) victim.send({ t: 'eco', rid: 'a'.repeat(32), op, kind: 'pot' });
        await attacker.flush(); await victim.flush();
        assert.equal(v.hp, 180 - 30 * hit); assert.equal(v.hm, 180);
        assert.equal(f.purchases(), 0, 'healing inventory changed during the match');
        f.advance(2000);
      }
      await waitFor(() => victim.messages.some(m => m.t === 'spm' && m.s === 'end'));
      assert.equal(victim.messages.filter(m => m.t === 'ph').length, 6);
      assert.equal(attacker.messages.filter(m => m.t === 'pk').length, 1);
      assert.equal(victim.messages.findLast(m => m.t === 'spm').w, false);
      assert.equal(attacker.messages.findLast(m => m.t === 'spm').w, true);
      assert.equal(f.players.get(low.id).hm, 60);
      assert.equal(f.players.get(high.id).hm, 9800);
      assert.equal(a.spar, null); assert.equal(v.spar, null);
      f.advance(2000);
    }
    for (const reason of ['cancelled', 'disconnect', 'connection']) {
      f.start(low.id, high.id);
      f.helpers.finishSpar(f.players.get(low.id).spar, 0, reason);
      assert.equal(f.players.get(low.id).hm, 60);
      assert.equal(f.players.get(high.id).hm, 9800);
    }
    low.send({ t: 'eco', rid: 'b'.repeat(32), op: 'consume', kind: 'pot' });
    await low.flush();
    assert.equal(f.purchases(), 1, 'healing stayed blocked outside Spar');
  } finally { await f.close(); }
});
