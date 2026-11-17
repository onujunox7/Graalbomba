'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createFootball = require('./football');
const { FIELD } = createFootball;

function fixture(count = 2) {
  let time = 1000;
  const players = new Map();
  const messages = new Map();
  for (let id = 1; id <= count; id++) {
    players.set(id, { id, ws: { readyState: 1, id }, x: 6704 + id, y: 17104,
      nm: 'Player ' + id, an: 'Idle_Down', hp: 60, hm: 60, ok: 1, allowed: true });
    messages.set(id, []);
  }
  const football = createFootball({
    players, now: () => time, authorized: p => p.allowed,
    viewPlayer: p => ({ id: p.id, nm: p.nm, x: p.x, y: p.y, an: p.an }),
    send: (ws, data) => messages.get(ws.id).push(structuredClone(data))
  });
  const request = (id, op, data = {}) => football.handle(players.get(id), { op, ...data });
  const advance = ms => { time += ms; football.tick(); };
  const latest = (id = 1, op = 'state') => messages.get(id).findLast(m => m.op === op);
  function start(ids = [...players.keys()]) {
    for (const id of ids) request(id, 'join', { version: 1 });
    advance(ids.length >= 6 ? 50 : 10000);
    assert.equal(latest(ids[0]).phase, 'kickoff');
    advance(3000);
    assert.equal(latest(ids[0]).phase, 'playing');
  }
  function move(id, dx, dy, steps) {
    for (let i = 0; i < steps; i++) {
      request(id, 'move', { dx, dy });
      advance(50);
    }
    request(id, 'move', { dx: 0, dy: 0 });
  }
  return { football, players, messages, request, advance, latest, start, move };
}

test('fila autenticada inicia dois times e limita cada time a três jogadores', () => {
  const f = fixture(6);
  f.start();
  const state = f.latest();
  assert.equal(state.players.length, 6);
  assert.equal(state.players.filter(p => p.team === 0).length, 3);
  assert.equal(state.players.filter(p => p.team === 1).length, 3);
  assert.equal(state.remaining, 300000);
  for (let id = 1; id <= 6; id++) assert.deepEqual(f.latest(id), state);
});

test('um jogador espera, entrada repetida não duplica e saída cancela fila', () => {
  const f = fixture();
  f.request(1, 'join', { version: 1 });
  f.request(1, 'join', { version: 1 });
  assert.equal(f.latest(1, 'queue').count, 1);
  f.advance(20000);
  assert.equal(f.latest(), undefined);
  f.request(1, 'leave');
  assert.equal(f.football.has(f.players.get(1)), false);
});

test('sessões inválidas, antigas e em outros modos não entram', () => {
  for (const overrides of [{ allowed: false }, { ok: 0 }, { in: 1 }, { spar: '1' },
    { sparPending: '1' }, { hid: 1 }, { mt: 1 }, { cy: 1 }, { hp: 0 }, { x: NaN }]) {
    const f = fixture();
    Object.assign(f.players.get(1), overrides);
    f.request(1, 'join', { version: 1 });
    assert.equal(f.football.has(f.players.get(1)), false);
  }
  const f = fixture();
  f.request(1, 'join');
  assert.equal(f.latest(1, 'error').op, 'error');
});

test('fila descarta quem entrou no interior enquanto esperava', () => {
  const f = fixture();
  f.request(1, 'join', { version: 1 });
  f.players.get(1).in = 1;
  f.advance(50);
  assert.equal(f.football.has(f.players.get(1)), false);
});

test('movimento é simulado no servidor, limitado ao campo e expira sem novos comandos', () => {
  const f = fixture();
  f.start();
  const before = f.players.get(1).x;
  f.request(1, 'move', { dx: 1, dy: 0, x: -999999, speed: 99999 });
  f.advance(50);
  assert.equal(f.players.get(1).x, before + 6.25);
  for (let i = 0; i < 20; i++) f.advance(50);
  const stopped = f.players.get(1).x;
  f.advance(100);
  assert.equal(f.players.get(1).x, stopped);
  f.move(1, -Math.SQRT1_2 * 1.2, -Math.SQRT1_2 * 1.2, 100);
  assert.equal(f.players.get(1).x, FIELD.x + 8);
  assert.equal(f.players.get(1).y, FIELD.y + 8);
});

test('comandos não finitos e velocidades forjadas são recusados', () => {
  const f = fixture();
  f.start();
  const before = f.players.get(1).x;
  for (const dx of [Infinity, NaN, 2, '1']) f.request(1, 'move', { dx, dy: 0 });
  f.advance(100);
  assert.equal(f.players.get(1).x, before);
  f.request(1, 'goal', { team: 0, score: [9999, 0] });
  f.request(1, 'state', { ball: { x: 1000000, y: 0 }, score: [9999, 0] });
  assert.deepEqual(f.latest().score, [0, 0]);
});

test('chute exige proximidade e gol é contado uma vez, igual nos dois clientes', () => {
  const f = fixture();
  f.start();
  f.move(2, 0, 1, 12); // o adversário sai da linha do chute: agora ele bloqueia a bola
  const centered = f.latest().ball;
  f.request(1, 'kick', { dx: 1, dy: 0 });
  f.advance(100);
  assert.deepEqual(f.latest().ball, centered);
  f.move(1, 1, 0, 12);
  f.request(1, 'kick', { dx: 1, dy: 0 });
  for (let i = 0; i < 50; i++) f.advance(50);
  assert.deepEqual(f.latest().score, [1, 0]);
  assert.deepEqual(f.latest(2).score, [1, 0]);
  assert.deepEqual(f.latest().ball, { x: FIELD.x + FIELD.w / 2, y: FIELD.y + FIELD.h / 2 });
  f.advance(2500);
  assert.equal(f.latest().phase, 'playing');
  assert.deepEqual(f.latest().score, [1, 0]);
});

test('gol no outro lado conta para o time vermelho', () => {
  const f = fixture();
  f.start();
  f.move(1, 0, 1, 12); // o adversário sai da linha do chute
  f.move(2, -1, 0, 12);
  f.request(2, 'kick', { dx: -1, dy: 0 });
  for (let i = 0; i < 50; i++) f.advance(50);
  assert.deepEqual(f.latest().score, [0, 1]);
});

test('laterais refletem a bola, sem atravessar os limites ou gerar gols', () => {
  const f = fixture();
  f.start();
  f.move(1, 1, 0, 12);
  f.request(1, 'kick', { dx: 0, dy: -1 });
  for (let i = 0; i < 60; i++) {
    f.advance(50);
    const state = f.latest();
    assert.ok(state.ball.y >= FIELD.y + 4 && state.ball.y <= FIELD.y + FIELD.h - 4);
    assert.deepEqual(state.score, [0, 0]);
  }
});

test('contagem inicial bloqueia movimento e chutes', () => {
  const f = fixture();
  f.request(1, 'join', { version: 1 });
  f.request(2, 'join', { version: 1 });
  f.advance(10000);
  const before = f.players.get(1).x;
  f.request(1, 'move', { dx: 1, dy: 0 });
  f.request(1, 'kick', { dx: 1, dy: 0 });
  f.advance(1000);
  assert.equal(f.players.get(1).x, before);
  assert.deepEqual(f.latest().score, [0, 0]);
});

test('fim por tempo publica empate e devolve as posições originais', () => {
  const f = fixture();
  f.start();
  f.advance(300000);
  assert.equal(f.latest().phase, 'finished');
  assert.equal(f.latest().winner, -1);
  f.advance(4000);
  assert.equal(f.latest(1, 'end').reason, 'time');
  assert.equal(f.players.get(1).x, 6705);
  assert.equal(f.players.get(2).x, 6706);
  assert.equal(f.players.get(1).football, undefined);
});

test('desconexão restaura posição e time vazio perde por abandono', () => {
  const f = fixture();
  f.start();
  f.football.disconnect(1);
  assert.equal(f.players.get(1).x, 6705);
  assert.equal(f.latest(2).phase, 'finished');
  assert.equal(f.latest(2).winner, 1);
  f.advance(4000);
  assert.equal(f.football.has(f.players.get(2)), false);
});

test('jogador desconectado ou sessão revogada não fica preso na partida', () => {
  const f = fixture(6);
  f.start();
  f.players.delete(1);
  f.players.delete(2);
  f.players.get(3).allowed = false;
  f.advance(50);
  assert.equal(f.players.get(3).football, undefined);
  assert.equal(f.latest(4).players.length, 3);
});

test('partidas simultâneas ficam isoladas e reconectar exige nova entrada', () => {
  const f = fixture(12);
  for (let id = 1; id <= 12; id++) f.request(id, 'join', { version: 1 });
  f.advance(50);
  f.advance(50);
  assert.notEqual(f.players.get(1).football, f.players.get(7).football);
  assert.equal(f.latest(1).players.length, 6);
  assert.equal(f.latest(7).players.length, 6);
  f.football.disconnect(1);
  assert.equal(f.football.has(f.players.get(1)), false);
  f.request(1, 'get');
  assert.equal(f.latest(1, 'queue').joined, false);
});

test('rajadas de pedidos não multiplicam participantes nem movimento', () => {
  const f = fixture();
  for (let i = 0; i < 1000; i++) f.request(1, 'join', { version: 1 });
  assert.equal(f.latest(1, 'queue').count, 1);
  assert.ok(f.messages.get(1).length <= 50);
});

test('atualizar o estado de um jogador não inunda os outros clientes', () => {
  const f = fixture();
  f.start();
  const before = f.messages.get(2).length;
  for (let i = 0; i < 45; i++) f.request(1, 'get');
  assert.equal(f.messages.get(2).length, before);
  f.advance(100);
  assert.ok(f.messages.get(2).length > before);
});

test('chute tem cooldown e ocultação do jogador encerra sua participação', () => {
  const f = fixture();
  f.start();
  f.move(1, 1, 0, 12);
  f.request(1, 'kick', { dx: 1, dy: 0 });
  const before = f.messages.get(2).length;
  f.request(1, 'kick', { dx: -1, dy: 0 });
  assert.equal(f.messages.get(2).length, before);
  f.players.get(1).hid = 1;
  f.advance(50);
  assert.equal(f.players.get(1).football, undefined);
});

function command(f, seq, dx = 1, dy = 0) {
  const state = f.latest();
  return { seq, dx, dy, match: state.match, round: state.round };
}

test('servidor anuncia movimento com confirmação e aceita clientes anteriores', () => {
  const f = fixture();
  f.start();
  assert.equal(f.latest().movement, 2);
  assert.equal(f.latest().round, 1);
  assert.equal(f.latest().players[0].ack, 0);
  f.move(1, 1, 0, 2);
  assert.equal(f.players.get(1).x, FIELD.x + FIELD.w / 2 - 92 + 12.5);
});

test('confirma só comandos simulados e nunca executa o mesmo comando duas vezes', () => {
  const f = fixture();
  f.start();
  const before = f.players.get(1).x;
  f.request(1, 'move', command(f, 1));
  f.request(1, 'move', command(f, 1));
  f.request(1, 'get');
  assert.equal(f.latest().players[0].ack, 0);
  f.advance(50);
  f.request(1, 'get');
  assert.equal(f.latest().players[0].ack, 1);
  assert.equal(f.players.get(1).x, before + 6.25);
  for (let i = 0; i < 10; i++) f.advance(50);
  assert.equal(f.players.get(1).x, before + 6.25);
});

test('direções e sequência precisam ser válidas e pertencer à partida e rodada atuais', () => {
  const f = fixture();
  f.start();
  const before = f.players.get(1).x;
  for (const seq of [0, -1, 2, 1.5, Infinity, '1', null]) f.request(1, 'move', command(f, seq));
  f.request(1, 'move', { ...command(f, 1), match: 'other-match' });
  f.request(1, 'move', { ...command(f, 1), round: 0 });
  f.request(1, 'move', { seq: 1, dx: 1, dy: 0 });
  f.request(1, 'move', command(f, 1, 100));
  f.advance(100);
  assert.equal(f.players.get(1).x, before);
  f.request(1, 'move', command(f, 1));
  f.advance(50);
  assert.equal(f.players.get(1).x, before + 6.25);
});

test('rajada de comandos respeita passo fixo, fila limitada e repetição após fila cheia', () => {
  const f = fixture();
  f.start();
  const before = f.players.get(1).x;
  for (let seq = 1; seq <= 21; seq++) f.request(1, 'move', command(f, seq));
  f.advance(50);
  assert.equal(f.players.get(1).x, before + 6.25);
  f.request(1, 'move', command(f, 21));
  f.advance(50);
  f.request(1, 'get');
  assert.equal(f.latest().players[0].ack, 2);
  for (let i = 0; i < 19; i++) f.advance(50);
  f.request(1, 'get');
  assert.equal(f.latest().players[0].ack, 21);
  assert.equal(f.players.get(1).x, before + 21 * 6.25);
});

test('cliente com confirmação não ganha movimento extra por pacotes legados', () => {
  const f = fixture();
  f.start();
  const before = f.players.get(1).x;
  f.request(1, 'move', command(f, 1));
  f.request(1, 'move', { dx: -1, dy: 0 });
  for (let i = 0; i < 10; i++) f.advance(50);
  assert.equal(f.players.get(1).x, before + 6.25);
});

test('gol invalida comandos e chutes atrasados da rodada anterior', () => {
  const f = fixture();
  f.start();
  f.move(2, 0, 1, 12); // o adversário sai da linha do chute
  const old = command(f, 1);
  f.move(1, 1, 0, 12);
  f.request(1, 'kick', { dx: 1, dy: 0 });
  for (let i = 0; i < 50; i++) f.advance(50);
  assert.equal(f.latest().round, old.round + 1);
  f.advance(2500);
  const before = f.players.get(1).x;
  f.request(1, 'move', old);
  f.request(1, 'kick', { ...old, after: 0 });
  f.advance(100);
  assert.equal(f.players.get(1).x, before);
  assert.deepEqual(f.latest().score, [1, 0]);
});

test('chute aguarda a simulação dos movimentos anteriores antes de validar proximidade', () => {
  const f = fixture();
  f.start();
  f.move(2, 0, 1, 12); // o adversário sai da linha do chute
  for (let seq = 1; seq <= 12; seq++) f.request(1, 'move', command(f, seq));
  f.request(1, 'kick', { ...command(f, 0), after: 12 });
  for (let i = 0; i < 60; i++) f.advance(50);
  assert.deepEqual(f.latest().score, [1, 0]);
});

test('a bola colide com o corpo de um jogador parado e rebate sem atravessá-lo', () => {
  const f = fixture();
  f.start();
  f.move(1, 1, 0, 12);
  f.request(1, 'kick', { dx: 1, dy: 0 });
  const blocker = f.players.get(2).x;
  let rebounded = false;
  for (let i = 0; i < 40; i++) {
    f.advance(50);
    const state = f.latest();
    assert.ok(state.ball.x < blocker, 'a bola não pode passar do corpo do jogador');
    if (state.bv.x < 0) rebounded = true;
  }
  assert.ok(rebounded);
  assert.deepEqual(f.latest().score, [0, 0]);
});

test('jogador correndo empurra a bola para frente e não fica sobreposto a ela', () => {
  const f = fixture();
  f.start();
  f.move(2, 0, 1, 12); // o adversário sai da frente
  const center = f.latest().ball.x;
  f.move(1, 1, 0, 20);
  f.advance(50);
  const state = f.latest();
  const runner = f.players.get(1).x;
  assert.ok(state.ball.x > center + 20, 'a bola precisa ter sido empurrada');
  assert.ok(state.ball.x >= runner + 10.9, 'a bola não pode ficar dentro do jogador');
});

test('estado publica a velocidade da bola em campo separado e o atrito a leva ao repouso', () => {
  const f = fixture();
  f.start();
  assert.deepEqual(Object.keys(f.latest().ball), ['x', 'y']);
  f.move(1, 1, 0, 12);
  f.request(1, 'kick', { dx: 0, dy: -1 });
  const launched = f.latest().bv;
  const speed = Math.hypot(launched.x, launched.y);
  assert.ok(speed >= 260 && speed <= 330, 'potência do chute dentro dos limites: ' + speed);
  for (let i = 0; i < 400; i++) f.advance(50);
  const rest = f.latest().bv;
  assert.equal(Math.hypot(rest.x, rest.y), 0);
  assert.deepEqual(f.latest().score, [0, 0]);
});
