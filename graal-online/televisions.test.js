'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createTelevisions = require('./televisions');

function fixture() {
  let clock = 1000;
  let hold;
  let serial = 0;
  const stopped = [];
  const sessions = new Map();
  const saved = [];
  const messages = [];
  const players = new Map([1, 2, 3].map(id => [id, {
    id, ws: { readyState: 1 }, role: id === 1 ? 1 : 0, allowed: true, ok: true, x: 100, y: 100
  }]));
  const media = {
    async open() {
      if (hold) await hold;
      const key = String(++serial).padStart(32, '0');
      const value = { key, title: 'Vídeo de teste', live: true, error: '', finished: false,
        segments: [0, 1, 2].map(index => ({ index, start: index * 4, end: index * 4 + 4, bytes: 123 })) };
      sessions.set(key, value);
      return value;
    },
    poll: key => sessions.get(key),
    stop(key) { stopped.push(key); sessions.delete(key); },
    file() { return null; }
  };
  const tvs = createTelevisions({ players, media, send: (ws, data) => messages.push(data),
    authorized: p => p.allowed, now: () => clock, save: data => saved.push(data) });
  const command = (op, values = {}, id = 1) => tvs.handle(players.get(id), { op, ...values });
  const state = (id = 1) => tvs.state(players.get(id));
  return { tvs, players, command, state, stopped, sessions, saved, messages,
    advance(ms) { clock += ms; tvs.tick(); },
    block(promise) { hold = promise; },
    async place() { await command('place', { x: 999999 }); return state().screens.at(-1).id; }
  };
}

test('TV usa posição real, controla tamanho e volume e recusa usuários comuns', async () => {
  const f = fixture();
  const id = await f.place();
  assert.equal(f.state().screens[0].x, 100);
  await f.command('size', { id, scale: 2.5 });
  await f.command('volume', { id, volume: 42 });
  assert.equal(f.state(2).screens[0].scale, 2.5);
  assert.equal(f.state(2).screens[0].volume, 42);
  await f.command('size', { id, scale: 100 });
  await f.command('size', { id, scale: 1, role: 2 }, 2);
  await f.command('remove', { id }, 2);
  assert.equal(f.state().screens[0].scale, 2.5);
  assert(f.messages.some(m => m.op === 'error'));
});

test('buffer inicial, relógio e segmentos são iguais para jogadores próximos', async () => {
  const f = fixture();
  const id = await f.place();
  await f.command('play', { id, url: 'https://youtu.be/jNQXAC9IVRw' });
  assert(f.state().screens[0].loading);
  f.advance(500);
  assert(f.state().screens[0].playing);
  assert.equal(f.state().screens[0].offset, -2);
  f.advance(3000);
  assert.equal(f.state(2).screens[0].offset, 1);
  assert.deepEqual(f.state().screens[0].segments, f.state(2).screens[0].segments);
  f.players.get(3).x = 10000;
  assert.equal(f.state(3).screens.length, 0);
  f.players.get(2).in = true;
  assert.equal(f.state(2).screens.length, 0);
  assert.equal(f.state().screens[0].source, 'https://www.youtube.com/watch?v=jNQXAC9IVRw');
});

test('parar ou remover durante preparo cancela e descarta resultado atrasado', async () => {
  const f = fixture();
  const id = await f.place();
  let release;
  f.block(new Promise(resolve => { release = resolve; }));
  const pending = f.command('play', { id, url: 'https://twitch.tv/monstercat' });
  await f.command('stop', { id });
  release();
  await pending;
  assert.equal(f.state().screens[0].playing, false);
  assert.equal(f.state().screens[0].loading, false);
  assert.equal(f.stopped.length, 1);
  await f.command('remove', { id });
  assert.equal(f.state().screens.length, 0);
});

test('revogar cargo durante preparo impede início e desconectar depois preserva transmissão', async () => {
  const f = fixture();
  const id = await f.place();
  let release;
  f.block(new Promise(resolve => { release = resolve; }));
  const pending = f.command('play', { id, url: 'https://kick.com/channel' });
  f.players.get(1).role = 0;
  release();
  await pending;
  assert.equal(f.state().screens[0].loading, false);
  assert.equal(f.stopped.length, 1);
  f.players.get(1).role = 1;
  await f.command('play', { id, url: 'https://youtu.be/jNQXAC9IVRw' });
  f.advance(500);
  f.players.delete(1);
  f.advance(1000);
  assert(f.state(2).screens[0].playing);
});

test('persistência guarda configuração e restaura desligada, isolando salas encerradas', async () => {
  const f = fixture();
  const id = await f.place();
  await f.command('size', { id, scale: 3 });
  const dump = f.tvs.dump();
  const g = fixture();
  g.tvs.restore(dump);
  assert.equal(g.state().screens[0].scale, 3);
  assert.equal(g.state().screens[0].playing, false);
  f.players.get(1).football = 'match';
  await f.command('move', { id });
  assert.equal(f.tvs.dump().screens.length, 0);
  f.players.get(1).football = '';
  f.advance(1000);
  assert.equal(f.state().screens.length, 0);
});

test('colisão acompanha tamanho e permite sair de sobreposição', async () => {
  const f = fixture();
  const id = await f.place();
  const p = f.players.get(1);
  assert(f.tvs.blocksMove(p, { x: 50, y: 96 }, { x: 58, y: 96 }));
  assert(!f.tvs.blocksMove(p, { x: 100, y: 96 }, { x: 104, y: 96 }));
  assert(!f.tvs.blocksMove(p, { x: 10, y: 96 }, { x: 20, y: 96 }));
  await f.command('size', { id, scale: 2 });
  assert(f.tvs.blocksMove(p, { x: 10, y: 96 }, { x: 20, y: 96 }));
  p.in = true;
  assert(!f.tvs.blocksMove(p, { x: 10, y: 96 }, { x: 20, y: 96 }));
});

test('TV de 1000% sincroniza, mantém colisão e é restaurada com o tamanho escolhido', async () => {
  const f = fixture();
  const id = await f.place();
  await f.command('size', { id, scale: 10 });
  assert.equal(f.state(2).screens[0].scale, 10);
  assert(f.tvs.blocksMove(f.players.get(1), { x: -310, y: 96 }, { x: -300, y: 96 }));
  const g = fixture();
  g.tvs.restore(f.tvs.dump());
  assert.equal(g.state().screens[0].scale, 10);
  await f.command('size', { id, scale: 10.1 });
  assert.equal(f.state().screens[0].scale, 10);
});

test('erro ou fim do vídeo libera conversor e publica estado desligado', async () => {
  const f = fixture();
  const id = await f.place();
  await f.command('play', { id, url: 'https://youtu.be/jNQXAC9IVRw' });
  f.advance(500);
  f.sessions.values().next().value.finished = true;
  f.advance(15000);
  assert.equal(f.state().screens[0].playing, false);
  assert.equal(f.stopped.length, 1);
});

test('tocar outra TV encerra a anterior e mantém apenas uma transmissão', async () => {
  const f = fixture();
  const first = await f.place();
  const second = await f.place();
  await f.command('play', { id: first, url: 'https://twitch.tv/alanzoka' });
  f.advance(500);
  assert(f.state().screens.find(tv => tv.id === first).playing);
  await f.command('play', { id: second, url: 'https://twitch.tv/alanzoka' });
  f.advance(500);
  assert.equal(f.state().screens.filter(tv => tv.playing).length, 1);
  assert(f.state().screens.find(tv => tv.id === second).playing);
  assert.equal(f.state().screens.find(tv => tv.id === first).playing, false);
  assert.equal(f.stopped.length, 1);
});
