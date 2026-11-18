'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const createFootball = require('./football');
const { FIELD } = createFootball;

function fixture(count = 2,blocksMove = () => false) {
  let time = 1000;
  const players = new Map();
  const messages = new Map();
  for (let id = 1; id <= count; id++) {
    players.set(id, { id, ws: { readyState: 1, id }, x: 6704 + id, y: 17104,
      nm: 'Player ' + id, an: 'Idle_Down', hp: 60, hm: 60, ok: 1, allowed: true });
    messages.set(id, []);
  }
  const football = createFootball({
    players, now: () => time, authorized: p => p.allowed,blocksMove,
    viewPlayer: p => ({ id: p.id, nm: p.nm, x: p.x, y: p.y, an: p.an }),
    send: (ws, data) => messages.get(ws.id).push(structuredClone(data))
  });
  const choices = new Map();
  const request = (id, op, data = {}) => {
    const positions = ['attacker', 'attacker', 'midfielder', 'midfielder', 'keeper'];
    const choice = choices.get(id) || { team: (id - 1) % 2, position: positions[Math.floor((id - 1) / 2) % 5] };
    football.handle(players.get(id), { op, ...(op === 'join' && data.version === 1 ? choice : {}), ...data });
  };
  const advance = ms => { time += ms; football.tick(); };
  const latest = (id = 1, op = 'state') => messages.get(id).findLast(m => m.op === op);
  function start(ids = [...players.keys()]) {
    for (const id of ids) request(id, 'join', { version: 1 });
    advance(ids.length >= 10 ? 50 : 10000);
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
  return { football, players, messages, request, advance, latest, start, move, choices };
}

test('fila autenticada inicia dois times e limita cada time a cinco jogadores', () => {
  const f = fixture(10);
  f.start();
  const state = f.latest();
  assert.equal(state.players.length, 10);
  assert.equal(state.players.filter(p => p.team === 0).length, 5);
  assert.equal(state.players.filter(p => p.team === 1).length, 5);
  assert.equal(state.remaining, 300000);
  for (let id = 1; id <= 10; id++) assert.deepEqual(f.latest(id), state);
});

test('movimento respeita obstáculo dinâmico e desliza no eixo livre',()=>{
  let wall=Infinity;
  const f=fixture(2,(_p,from,to)=>to.x>from.x&&to.x>wall);f.start();
  const p=f.players.get(1),start={x:p.x,y:p.y};wall=p.x+12;
  f.move(1,1,0,10);assert.ok(p.x<=wall+0.001);
  f.move(1,0,1,3);assert.ok(p.y>start.y);
  const blocked=p.x;f.move(1,-1,0,3);assert.ok(p.x<blocked);
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
  const f = fixture(20);
  for (let id = 1; id <= 10; id++) f.request(id, 'join', { version: 1 });
  f.advance(50);
  for (let id = 11; id <= 20; id++) f.request(id, 'join', { version: 1 });
  f.advance(50);
  assert.notEqual(f.players.get(1).football, f.players.get(11).football);
  assert.equal(f.latest(1).players.length, 10);
  assert.equal(f.latest(11).players.length, 10);
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


test('dez jogadores têm posições únicas, finitas e dentro do campo em cada time', () => {
  const f = fixture(10);
  f.start();
  const state = f.latest();
  assert.equal(new Set(state.players.map(p => p.x + ',' + p.y)).size, 10);
  for (const p of state.players) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(p.x >= FIELD.x + 8 && p.x <= FIELD.x + FIELD.w - 8);
    assert.ok(p.y >= FIELD.y + 8 && p.y <= FIELD.y + FIELD.h - 8);
  }
  assert.ok(FIELD.goal >= 5 * 24, 'gol acomoda cinco jogadores de 24 unidades');
});

test('gol ampliado aceita chute além da abertura antiga e fundo rebate fora da nova abertura', () => {
  for (const offset of [60, 110]) {
    const f = fixture();
    f.start();
    f.move(2, 0, 1, 20);
    f.move(1, 1, 0, 12);
    const target = {x: FIELD.x + FIELD.w + 10, y: FIELD.y + FIELD.h / 2 + offset};
    const ball = f.latest().ball;
    const distance = Math.hypot(target.x - ball.x, target.y - ball.y);
    f.request(1, 'kick', {dx: (target.x-ball.x)/distance, dy: (target.y-ball.y)/distance});
    let bounced = false;
    for(let i=0; i<70; i++) {
      f.advance(50);
      if(f.latest().bv.x < 0) bounced = true;
    }
    assert.deepEqual(f.latest().score, offset === 60 ? [1,0] : [0,0]);
    if(offset === 110) assert.ok(bounced, 'bola rebate no fundo fora do gol');
  }
});

test('condução reta com contato fora do centro mantém a linha da bola', () => {
  const f = fixture();
  f.start();
  f.move(2, 0, 1, 20);
  const line = f.latest().ball.y;
  f.move(1, 0, 1, 1);
  f.move(1, 1, 0, 35);
  assert.ok(Math.abs(f.latest().ball.y - line) < 1, 'desvio lateral na condução: ' + (f.latest().ball.y - line));
  assert.ok(f.latest().ball.x > FIELD.x + FIELD.w / 2 + 50, 'a bola precisa seguir sendo conduzida');
});

test('condução mantém a linha nos dois lados e com aproximação acima ou abaixo da bola', () => {
  for (const runner of [1, 2]) {
    for (const offset of [-1, 1]) {
      const f = fixture();
      f.start();
      f.move(runner === 1 ? 2 : 1, 0, 1, 20);
      const line = f.latest().ball.y;
      f.move(runner, 0, offset, 1);
      f.move(runner, runner === 1 ? 1 : -1, 0, 35);
      assert.ok(Math.abs(f.latest().ball.y - line) < 1, 'condução desvia de sua linha');
    }
  }
});

test('condução mantém bola próxima ao virar para cima, baixo, diagonal ou voltar', () => {
  for (const [dx, dy] of [[0, 1], [0, -1], [-1, 0], [Math.SQRT1_2, Math.SQRT1_2]]) {
    const f = fixture();
    f.start();
    f.move(2, 0, 1, 20);
    f.move(1, 1, 0, 20);
    f.move(1, dx, dy, 10);
    const p = f.players.get(1);
    const b = f.latest().ball;
    assert.ok(Math.hypot(b.x-p.x, b.y-p.y) <= 22, 'perdeu bola ao virar ' + [dx,dy] + ', distância=' + Math.hypot(b.x-p.x,b.y-p.y));
    assert.ok((b.x-p.x)*dx+(b.y-p.y)*dy > 0, 'bola precisa terminar à frente na nova direção');
  }
});

test('trocas repetidas de direção mantêm controle e uma liberação curta do dpad permite virar', () => {
  const f = fixture();
  f.start();
  f.move(2, 0, 1, 20);
  f.move(1, 1, 0, 20);
  f.advance(50);
  for (let lap=0; lap<3; lap++) {
    for (const [dx,dy] of [[0,-1],[-1,0],[0,1],[1,0]]) {
      f.move(1,dx,dy,7);
      const p=f.players.get(1);
      const b=f.latest().ball;
      assert.ok(Math.hypot(b.x-p.x,b.y-p.y)<=22, 'bola escapou em trocas consecutivas');
    }
  }
});

test('chute solta a condução e virar depois não puxa a bola chutada', () => {
  const f=fixture();
  f.start();
  f.move(2,0,1,20);
  f.move(1,1,0,20);
  f.request(1,'kick',{dx:1,dy:0});
  f.move(1,0,-1,10);
  const p=f.players.get(1);
  const b=f.latest().ball;
  assert.ok(Math.hypot(b.x-p.x,b.y-p.y)>50, 'controle continua preso após chute');
  assert.ok(f.latest().bv.x>200, 'virada alterou velocidade do chute');
});

test('bola solta depois de sair do alcance não volta ao jogador quando ele vira', () => {
  const f=fixture();
  f.start();
  f.move(2,0,1,20);
  f.move(1,1,0,20);
  for(let step=0;step<20;step++) f.advance(50);
  f.move(1,0,-1,10);
  const p=f.players.get(1);
  const b=f.latest().ball;
  assert.ok(Math.hypot(b.x-p.x,b.y-p.y)>70, 'bola distante voltou ao jogador');
});

test('trocas rápidas integradas no comando de 50 ms conservam condução e movimento contínuo', () => {
  const f=fixture();
  f.start();
  f.move(2,0,1,20);
  f.move(1,1,0,20);
  const directions=[[1/6,-1/6],[-1/6,-1/6],[-1/6,1/6],[1/6,1/6],[0,0]];
  let previous=f.latest().ball;
  for(let index=0;index<100;index++) {
    const [dx,dy]=directions[index%directions.length];
    const state=f.latest();
    f.request(1,'move',{match:state.match,round:state.round,seq:index+1,dx,dy});
    f.advance(50);
    const current=f.latest();
    const p=f.players.get(1);
    const gap=Math.hypot(current.ball.x-p.x,current.ball.y-p.y);
    assert.ok(gap<=22, 'bola disparou na troca rápida '+index+', distância='+gap);
    assert.ok(Math.hypot(current.ball.x-previous.x,current.ball.y-previous.y)<=18, 'bola saltou entre estados');
    assert.ok(Math.hypot(current.bv.x,current.bv.y)<=187.5, 'troca rápida gerou velocidade de chute');
    previous=current.ball;
  }
});

test('cancelamento de movimentos opostos conserva intenção de condução no mesmo comando', () => {
  const f=fixture();
  f.start();
  f.move(2,0,1,20);
  f.move(1,1,0,20);
  const directions=[[1,0],[0,-1],[-1,0],[0,1]];
  for(let index=0;index<40;index++) {
    const [x,y]=directions[index%directions.length];
    const state=f.latest();
    f.request(1,'move',{match:state.match,round:state.round,seq:index+1,dx:0,dy:0,facing:{x,y}});
    f.advance(50);
    const p=f.players.get(1);
    const b=f.latest().ball;
    assert.ok(Math.hypot(b.x-p.x,b.y-p.y)<=22, 'bola escapou com comandos opostos cancelados, passo '+index);
  }
});

test('direção final inválida não consome sequência e comandos anteriores continuam aceitos', () => {
  const f=fixture();
  f.start();
  const state=f.latest();
  const base={match:state.match,round:state.round,seq:1,dx:1,dy:0};
  const before=f.players.get(1).x;
  for(const facing of [null, [], 'right', {x:Infinity,y:0}, {x:'1',y:0}, {x:1}, {x:99,y:0}]) f.request(1,'move',{...base,facing});
  f.advance(50);
  assert.equal(f.players.get(1).x,before);
  f.request(1,'get');
  assert.equal(f.latest().players[0].ack,0);
  f.request(1,'move',{...base,facing:{x:1,y:0}});
  f.advance(50);
  f.request(1,'move',{...base,seq:2});
  f.advance(50);
  assert.equal(f.players.get(1).x,before+12.5);
  assert.equal(f.latest().players[0].ack,2);
});

test('duzentos comandos de trocas rápidas com médias de seis quadros mantêm a bola próxima', () => {
  const f=fixture();
  f.start();
  f.move(2,0,1,20);
  f.move(1,1,0,20);
  let seed=4271;
  const directions=[[1,0],[0,1],[-1,0],[0,-1]];
  let previous=f.latest().ball;
  for(let index=0;index<200;index++) {
    let dx=0,dy=0,x=0,y=0;
    for(let frame=0;frame<6;frame++) {
      seed=(Math.imul(seed,1664525)+1013904223)>>>0;
      [x,y]=directions[(seed>>>16)%4];
      dx+=x/6;dy+=y/6;
    }
    const state=f.latest();
    f.request(1,'move',{match:state.match,round:state.round,seq:index+1,dx,dy,facing:{x,y}});
    f.advance(50);
    const current=f.latest();
    const p=f.players.get(1);
    assert.ok(Math.hypot(current.ball.x-p.x,current.ball.y-p.y)<=22,'perdeu bola no comando '+index);
    assert.ok(Math.hypot(current.ball.x-previous.x,current.ball.y-previous.y)<=18,'salto no comando '+index);
    assert.ok(Math.hypot(current.bv.x,current.bv.y)<=187.5,'impulso de chute no comando '+index);
    previous=current.ball;
  }
});

function keeperRole(f,id,enabled) {
  const state=f.latest(id);
  f.request(id,'position',{match:state.match,round:state.round,position:enabled?'keeper':'attacker'});
}

function keeperSave(count=2,inside=true) {
  const f=fixture(count);
  f.start();
  keeperRole(f,1,true);
  f.move(1,-1,0,inside?25:16);
  f.move(2,-1,0,12);
  f.request(2,'kick',{dx:-1,dy:0});
  for(let i=0;i<45 && !f.latest().holder;i++) f.advance(50);
  return f;
}

function throwBall(f,id=1,extra={}) {
  const state=f.latest(id);
  f.request(id,'kick',{match:state.match,round:state.round,hold:state.hold,dx:1,dy:0,...extra});
}

test('cada time tem um goleiro escolhido pelo próprio jogador', () => {
  const f=fixture(4);
  f.start();
  assert.equal(f.latest().holder,0);
  keeperRole(f,1,true);
  keeperRole(f,3,true);
  keeperRole(f,2,true);
  assert.equal(f.latest().players.filter(p=>p.team===0&&p.keeper).length,1);
  assert.equal(f.latest().players.filter(p=>p.team===1&&p.keeper).length,1);
  assert.equal(f.latest(3,'error').op,'error');
  keeperRole(f,1,false);
  keeperRole(f,3,true);
  assert.equal(f.latest().players.find(p=>p.id===3).keeper,true);
});

test('goleiro segura contato na própria área e posse fica protegida contra todos os jogadores', () => {
  const f=keeperSave(4);
  assert.equal(f.latest().holder,1);
  const hold=f.latest().hold;
  f.move(2,-1,0,38);
  f.move(3,-1,0,24);
  f.move(3,0,1,10);
  for(const id of [2,3,4]) {
    throwBall(f,id);
    f.advance(50);
    assert.equal(f.latest().holder,1);
    assert.equal(f.latest().hold,hold);
  }
  assert.deepEqual(f.latest().bv,{x:0,y:0});
  assert.deepEqual(f.latest().score,[0,0]);
  keeperRole(f,1,false);
  assert.equal(f.latest().players.find(p=>p.id===1).keeper,true);
});

test('captura exige goleiro dentro da área e chute antigo não solta posse protegida', () => {
  const outside=keeperSave(2,false);
  assert.equal(outside.latest().holder,0);
  const f=keeperSave();
  assert.equal(f.latest().holder,1);
  f.request(1,'kick',{dx:1,dy:0});
  assert.equal(f.latest().holder,1);
  throwBall(f,1,{hold:0});
  assert.equal(f.latest().holder,1);
  throwBall(f);
  assert.equal(f.latest().holder,0);
  assert.ok(f.latest().bv.x>260);
});

test('goleiro pode andar com bola dentro da área e lançamento libera a movimentação', () => {
  const f=keeperSave();
  assert.equal(f.latest().holder,1);
  f.move(1,1,1,60);
  assert.ok(f.players.get(1).x<=FIELD.x+56-8);
  assert.ok(f.players.get(1).y<=FIELD.y+FIELD.h/2+FIELD.goal/2+34-8);
  assert.equal(f.latest().ball.x,f.players.get(1).x);
  assert.equal(f.latest().ball.y,f.players.get(1).y-12);
  throwBall(f);
  assert.equal(f.latest().holder,0);
  f.move(1,1,0,10);
  assert.ok(f.players.get(1).x>FIELD.x+56);
});

test('saída de goleiro com posse libera a bola e a vaga do time', () => {
  const f=keeperSave(4);
  assert.equal(f.latest().holder,1);
  f.football.disconnect(1);
  assert.equal(f.latest(3).holder,0);
  keeperRole(f,3,true);
  assert.equal(f.latest(3).players.find(p=>p.id===3).keeper,true);
});


test('nova defesa invalida lançamento atrasado de uma posse anterior', () => {
  const f=keeperSave();
  f.move(2,-1,0,38);
  const oldHold=f.latest().hold;
  throwBall(f);
  assert.equal(f.latest().holder,0);
  f.advance(50);
  f.advance(50);
  assert.equal(f.latest().holder,1);
  assert.ok(f.latest().hold>oldHold);
  throwBall(f,1,{hold:oldHold});
  assert.equal(f.latest().holder,1);
  throwBall(f);
  assert.equal(f.latest().holder,0);
});

test('lançamento sequenciado espera movimento e só o dono atual pode soltar a bola', () => {
  const f=keeperSave();
  const state=f.latest();
  f.request(2,'kick',{match:state.match,round:state.round,after:0,hold:state.hold,dx:1,dy:0});
  f.request(1,'move',{match:state.match,round:state.round,seq:1,dx:0,dy:0});
  f.request(1,'kick',{match:state.match,round:state.round,after:1,hold:state.hold,dx:1,dy:0});
  assert.equal(f.latest().holder,1);
  f.advance(50);
  assert.equal(f.latest().holder,0);
  assert.ok(f.latest().bv.x>260);
  assert.equal(f.latest().players.find(p=>p.id===1).ack,1);
});

test('goleiro fora da própria área não captura a bola na área adversária', () => {
  const f=fixture();
  f.start();
  keeperRole(f,1,true);
  f.move(1,0,-1,20);
  f.move(1,1,0,54);
  f.move(1,0,1,20);
  f.move(2,0,-1,20);
  f.move(2,-1,0,29);
  f.move(2,0,1,20);
  f.move(2,1,0,12);
  f.request(2,'kick',{dx:1,dy:0});
  for(let i=0;i<45;i++) f.advance(50);
  assert.equal(f.latest().holder,0);
  assert.deepEqual(f.latest().score,[0,0]);
});

test('atribuição de posição valida partida, rodada e papel e identifica a própria sessão', () => {
  const f=fixture(4);
  f.start();
  const state=f.latest();
  for(const extra of [{position:1},{position:'invalid'},{match:'other'},{round:state.round-1}]) {
    f.request(1,'position',{match:state.match,round:state.round,position:'keeper',...extra});
  }
  assert.equal(f.latest().players.filter(p=>p.keeper).length,0);
  f.request(1,'position',{match:state.match,round:state.round,position:'keeper',id:2,team:1});
  assert.equal(f.latest().players.find(p=>p.id===1).keeper,true);
  assert.equal(f.latest().players.find(p=>p.id===2).keeper,false);
});

test('lançamento de posse inexistente não vira um chute comum', () => {
  const f=fixture();
  f.start();
  f.move(2,0,1,20);
  f.move(1,1,0,12);
  throwBall(f,1,{hold:123});
  assert.deepEqual(f.latest().bv,{x:0,y:0});
  f.request(1,'kick',{dx:1,dy:0});
  assert.ok(f.latest().bv.x>260);
});

test('gol reinicia posse e coloca goleiro na sua área mantendo a função', () => {
  const f=fixture();
  f.start();
  keeperRole(f,1,true);
  f.move(1,0,-1,20);
  f.move(2,-1,0,12);
  f.request(2,'kick',{dx:-1,dy:0});
  for(let i=0;i<55;i++) f.advance(50);
  assert.deepEqual(f.latest().score,[0,1]);
  assert.equal(f.latest().holder,0);
  assert.equal(f.latest().hold,0);
  assert.equal(f.latest().players.find(p=>p.id===1).keeper,true);
  assert.equal(f.players.get(1).x,FIELD.x+24);
});

test('entrar na fila exige time e posição explícitos e rejeita valores inválidos', () => {
  const f=fixture();
  for(const choice of [{},{team:0},{position:'attacker'},{team:2,position:'attacker'},
    {team:'0',position:'attacker'},{team:0,position:'defender'},{team:0,position:'__proto__'}]) {
    f.football.handle(f.players.get(1),{op:'join',version:1,...choice});
    assert.equal(f.football.has(f.players.get(1)),false);
  }
  f.request(1,'get');
  assert.equal(f.latest(1,'queue').selection,1);
  assert.equal(f.latest(1,'queue').count,0);
});

test('time e posição escolhidos são preservados na partida e na formação', () => {
  const f=fixture(4);
  const choices=[{team:1,position:'midfielder'},{team:0,position:'keeper'},
    {team:1,position:'attacker'},{team:0,position:'midfielder'}];
  for(let i=0;i<choices.length;i++)f.request(i+1,'join',{version:1,...choices[i]});
  f.advance(10000);
  const state=f.latest();
  for(let i=0;i<choices.length;i++) {
    const p=state.players.find(p=>p.id===i+1);
    assert.equal(p.team,choices[i].team);
    assert.equal(p.position,choices[i].position);
    assert.equal(p.keeper,choices[i].position==='keeper');
  }
  assert.equal(state.players.find(p=>p.id===2).x,FIELD.x+24);
  assert.ok(state.players.find(p=>p.id===1).x>state.players.find(p=>p.id===3).x);
});

test('dez vagas completam dois atacantes, dois meias e um goleiro por time e iniciam imediatamente', () => {
  const f=fixture(10);
  const positions=['attacker','attacker','midfielder','midfielder','keeper'];
  for(let id=1;id<=10;id++) f.request(id,'join',{version:1,team:id<=5?0:1,position:positions[(id-1)%5]});
  f.advance(50);
  const state=f.latest();
  assert.equal(state.phase,'kickoff');
  assert.equal(state.players.length,10);
  for(const team of [0,1]) {
    assert.equal(state.players.filter(p=>p.team===team&&p.position==='attacker').length,2);
    assert.equal(state.players.filter(p=>p.team===team&&p.position==='midfielder').length,2);
    assert.equal(state.players.filter(p=>p.team===team&&p.position==='keeper').length,1);
  }
  assert.equal(new Set(state.players.map(p=>p.x+','+p.y)).size,10);
});

test('só um time na fila espera adversário e equipes menores começam após dez segundos', () => {
  const f=fixture(3);
  f.request(1,'join',{version:1,team:0,position:'attacker'});
  f.request(2,'join',{version:1,team:0,position:'midfielder'});
  f.advance(20000);
  assert.equal(f.latest(),undefined);
  assert.equal(f.latest(2,'queue').starts,0);
  f.request(3,'join',{version:1,team:1,position:'keeper'});
  f.advance(9999);
  assert.equal(f.latest(),undefined);
  f.advance(1);
  assert.equal(f.latest().phase,'kickoff');
  assert.equal(f.latest().players.length,3);
});

test('vaga concorrida é reservada uma vez e troca inválida conserva a escolha anterior', () => {
  const f=fixture(3);
  f.request(1,'join',{version:1,team:0,position:'attacker'});
  f.request(2,'join',{version:1,team:0,position:'attacker'});
  f.request(3,'join',{version:1,team:1,position:'keeper'});
  f.request(3,'join',{version:1,team:0,position:'attacker'});
  f.request(3,'get');
  let state=f.latest(3,'queue');
  assert.equal(state.joined,true);
  assert.equal(state.team,1);
  assert.equal(state.position,'keeper');
  assert.equal(state.teams[0].attacker,2);
  assert.equal(state.teams[1].keeper,1);
  f.request(1,'leave');
  f.request(3,'join',{version:1,team:0,position:'attacker'});
  state=f.latest(3,'queue');
  assert.equal(state.team,0);
  assert.equal(state.position,'attacker');
  assert.equal(state.teams[1].keeper,0);
  assert.equal(state.starts,0);
});

test('trocar posição durante a partida respeita vagas e mantém o time escolhido', () => {
  const f=fixture(6);
  const positions=['attacker','attacker','midfielder','midfielder','keeper'];
  for(let id=1;id<=5;id++) f.request(id,'join',{version:1,team:0,position:positions[id-1]});
  f.request(6,'join',{version:1,team:1,position:'attacker'});
  f.advance(10000);f.advance(3000);
  let state=f.latest();
  f.request(5,'position',{match:state.match,round:state.round,position:'attacker',team:1});
  assert.equal(f.latest().players.find(p=>p.id===5).position,'keeper');
  f.request(2,'leave');
  state=f.latest();
  f.request(5,'position',{match:state.match,round:state.round,position:'attacker',team:1});
  assert.equal(f.latest().players.find(p=>p.id===5).team,0);
  assert.equal(f.latest().players.find(p=>p.id===5).position,'attacker');
  state=f.latest();
  f.request(3,'position',{match:state.match,round:state.round,position:'keeper'});
  assert.equal(f.latest().players.find(p=>p.id===3).keeper,true);
});

test('fila reserva exatamente duas vagas de atacante, duas de meia e uma de goleiro por time', () => {
  const f=fixture(6);
  const positions=['attacker','attacker','midfielder','midfielder','keeper'];
  for(let id=1;id<=5;id++) f.request(id,'join',{version:1,team:0,position:positions[id-1]});
  for(const position of ['attacker','midfielder','keeper']) {
    f.request(6,'join',{version:1,team:0,position});
    assert.equal(f.football.has(f.players.get(6)),false);
  }
  f.request(6,'get');
  assert.deepEqual(f.latest(6,'queue').teams[0],{attacker:2,midfielder:2,keeper:1});
  f.request(6,'join',{version:1,team:1,position:'keeper'});
  assert.equal(f.football.has(f.players.get(6)),true);
  assert.equal(f.latest(6,'queue').teams[1].keeper,1);
});

test('a camisa escolhida reserva a vaga exata e publica o ocupante da escalação', () => {
  const f=fixture(3);
  f.request(1,'join',{version:1,team:0,position:'attacker',slot:1});
  assert.equal(f.latest(1,'queue').slot,1);
  assert.equal(f.latest(1,'queue').formation,1);
  assert.equal(f.latest(1,'queue').lineups[0][0].id,1);
  assert.equal(f.latest(1,'queue').lineups[0][0].nm,'Player 1');
  f.request(2,'join',{version:1,team:0,position:'attacker',slot:1});
  assert.equal(f.football.has(f.players.get(2)),false);
  f.request(2,'join',{version:1,team:0,position:'attacker',slot:0});
  f.request(3,'join',{version:1,team:1,position:'keeper',slot:0});
  f.advance(10000);
  assert.equal(f.latest().players.find(p=>p.id===1).slot,1);
  assert.equal(f.latest().players.find(p=>p.id===1).y,FIELD.y+FIELD.h/2-64);
  assert.equal(f.latest().players.find(p=>p.id===2).slot,0);
});

test('vagas inválidas ou ocupadas preservam a reserva e clientes por função continuam aceitos', () => {
  const f=fixture(3);
  f.request(1,'join',{version:1,team:0,position:'midfielder',slot:1});
  f.request(2,'join',{version:1,team:0,position:'midfielder',slot:0});
  for(const slot of [-1,2,1.5,'1',null,true]) f.request(1,'join',{version:1,team:0,position:'midfielder',slot});
  f.request(1,'join',{version:1,team:0,position:'midfielder',slot:0});
  f.request(1,'get');
  assert.equal(f.latest(1,'queue').slot,1);
  f.request(1,'join',{version:1,team:0,position:'midfielder'});
  assert.equal(f.latest(1,'queue').slot,1);
  f.request(3,'join',{version:1,team:1,position:'keeper'});
  assert.equal(f.latest(3,'queue').slot,0);
});

test('troca de camisa durante a partida respeita a vaga e preserva o time', () => {
  const f=fixture();
  f.start();
  let state=f.latest();
  const before=f.players.get(1).x;
  f.request(1,'position',{match:state.match,round:state.round,position:'attacker',slot:1,team:1});
  state=f.latest();
  assert.equal(state.players.find(p=>p.id===1).slot,1);
  assert.equal(state.players.find(p=>p.id===1).team,0);
  assert.equal(f.players.get(1).x,before);
  f.request(1,'position',{match:state.match,round:state.round,position:'keeper',slot:1});
  assert.equal(f.latest().players.find(p=>p.id===1).position,'attacker');
});
