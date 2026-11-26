'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const createDungeon = require('./dungeon');
const { MAP, center } = createDungeon;

function fixture(blocksMove) {
  let time = 1000;
  const players = new Map(), messages = new Map(), stats = new Map();
  for (let id = 1; id <= 2; id++) {
    players.set(id, { id, acc: 'account-' + id, role: 0, ok: true, in: true, x: 6704, y: 17104,
      ix: MAP.origin[0] + center(MAP.spawn).x, iy: MAP.origin[1] + center(MAP.spawn).y,
      hp: 1000, hm: 1000, allowed: true, ws: { id, readyState: 1 } });
    messages.set(id, []); stats.set(id, { lvl: 1, up: 0, shots: [] });
  }
  const dungeon = createDungeon({ players, authorized: p => p.allowed, getCombatState: p => stats.get(p.id),
    send: (ws, data) => messages.get(ws.id).push(structuredClone(data)), now: () => time, blocksMove });
  const state = (id = 1) => dungeon.state(players.get(id));
  const command = (op, data = {}, id = 1) => dungeon.handle(players.get(id), { op, ...data });
  const move = (id, x, y) => { const p = players.get(id); p.ix = MAP.origin[0] + x; p.iy = MAP.origin[1] + y; };
  const atObject = (name, id = 1) => { const point = center(MAP.objects.find(o => o.id === name).cell); move(id, point.x, point.y + 16); };
  const advance = ms => { time += ms; dungeon.tick(); };
  function defeat(id) {
    for (let hit = 0; hit < 25; hit++) {
      const enemy = state().enemies.find(e => e.id === id);
      if (enemy.hp <= 0) return;
      move(1, enemy.x, enemy.y + 14);
      command('hit', { enemy: id, weapon: 'sword' });
      advance(1000);
    }
    throw new Error('Enemy survived normal sword attacks');
  }
  function unlockBoss() {
    defeat('guard_w'); defeat('guard_e');
    atObject('key'); command('interact', { id: 'key' });
    for (const id of ['east', 'north', 'west']) { atObject(id); command('interact', { id }); advance(200); }
    atObject('boss_gate'); command('interact', { id: 'boss_gate' });
  }
  return { dungeon, players, messages, stats, state, command, move, atObject, advance, defeat, unlockBoss, now: () => time };
}

test('catálogo tem sete salas, chegada livre e paredes sólidas', () => {
  const f = fixture();
  assert.equal(MAP.rooms.length, 7);
  const spawn = center(MAP.spawn);
  assert.equal(f.dungeon.blocked(spawn.x, spawn.y), false);
  assert.equal(f.dungeon.blocked(0, 0), true);
  for (const enemy of MAP.enemies) {
    const at = center(enemy.cell);
    assert.equal(f.dungeon.blocked(at.x, at.y, enemy.scale), false);
  }
  assert.equal(f.state().enemies.length, 3);
  assert.equal(f.state().gates.boss_gate, false);
});

test('visitante aguardando presença recebe estado booleano completo', () => {
  const f = fixture(), p = f.players.get(1);
  delete p.ok;
  f.command('get');
  const message = JSON.parse(JSON.stringify(f.messages.get(1).at(-1)));
  assert.equal(message.inside, false);
  assert.equal(message.complete, false);
  assert.deepEqual(message.enemies, []);
});

test('combate e chave são compartilhados entre jogadores', () => {
  const f = fixture();
  f.atObject('boss_gate'); f.command('interact', { id: 'boss_gate' });
  assert.equal(f.state().gate, false);
  f.atObject('key'); f.command('interact', { id: 'key' });
  assert.equal(f.state().key, false);
  f.defeat('guard_w'); f.defeat('guard_e');
  assert(f.state(2).gates.guards_gate);
  f.atObject('key'); f.command('interact', { id: 'key' });
  assert(f.state(2).key);
  assert.equal(f.state(2).enemies[0].hp, 0);
});

test('inscrição exige a sequência e toque repetido na chama acesa é idempotente', () => {
  const f = fixture();
  f.atObject('north'); f.command('interact', { id: 'north' });
  assert.deepEqual(f.state().flames, []);
  for (const id of ['east', 'north', 'west']) {
    f.atObject(id); f.command('interact', { id }); f.command('interact', { id }); f.advance(200);
  }
  assert(f.state(2).solved);
  assert.deepEqual(f.state(2).flames, ['east', 'north', 'west']);
  f.atObject('boss_gate'); f.command('interact', { id: 'boss_gate' });
  assert.equal(f.state().gate, false);
});

test('trajeto completo abre o baú e confirma a relíquia para cada jogador', () => {
  const f = fixture();
  f.unlockBoss();
  assert(f.state().gate);
  f.atObject('relic'); f.command('interact', { id: 'relic' });
  assert.equal(f.state().relic, false);
  f.defeat('warden');
  assert(f.state(2).gates.relic_gate);
  for (const id of [1, 2]) { f.atObject('relic', id); f.command('interact', { id: 'relic' }, id); }
  assert(f.state(1).complete && f.state(2).complete);
  f.command('interact', { id: 'relic' });
  assert.equal(f.messages.get(1).filter(m => m.op === 'complete').length, 1);
});

test('pedidos distantes, sessões revogadas e dano forjado são recusados', () => {
  const f = fixture();
  f.command('interact', { id: 'key' });
  assert.equal(f.state().key, false);
  const enemy = f.state().enemies[0];
  f.move(1, enemy.x, enemy.y + 14);
  f.command('hit', { enemy: enemy.id, weapon: 'sword', damage: 999999 });
  const hp = f.state().enemies[0].hp;
  assert(hp > 0 && hp < enemy.hp);
  f.command('hit', { enemy: enemy.id, weapon: 'sword' });
  assert.equal(f.state().enemies[0].hp, hp);
  f.advance(400); f.players.get(1).allowed = false;
  f.command('hit', { enemy: enemy.id, weapon: 'sword', role: 2 });
  assert.equal(f.state(2).enemies[0].hp, hp);
  f.players.get(1).allowed = true; f.players.get(1).in = false;
  f.command('hit', { enemy: enemy.id, weapon: 'sword' });
  assert.equal(f.dungeon.state(f.players.get(1)).enemies.length, 0);
});

test('flecha precisa de munição consumida no interior e atinge apenas um alvo', () => {
  const f = fixture();
  const enemy = f.state().enemies[0];
  f.command('hit', { enemy: enemy.id, weapon: 'a' });
  assert.equal(f.state().enemies[0].hp, enemy.hp);
  f.stats.get(1).shots.push({ id: 'a'.repeat(32), kind: 'a', x: MAP.origin[0] + enemy.x, y: MAP.origin[1] + enemy.y + 12, until: f.now() + 4000, inside: true });
  f.command('hit', { enemy: enemy.id, weapon: 'a' });
  assert(f.state().enemies[0].hp < enemy.hp);
  const other = f.state().enemies[1].hp;
  f.command('hit', { enemy: 'guard_e', weapon: 'a' });
  assert.equal(f.state().enemies[1].hp, other);
});

test('paredes e portas fechadas impedem correção de posição através delas', () => {
  const f = fixture(), p = f.players.get(1);
  f.dungeon.correct(p);
  const before = { x: p.ix, y: p.iy };
  f.move(1, 4, 4); f.dungeon.correct(p);
  assert.deepEqual({ x: p.ix, y: p.iy }, before);
  f.advance(1000);
  const spawn = center(MAP.spawn);
  f.move(1, spawn.x, spawn.y - 24); f.dungeon.correct(p);
  assert.equal(p.iy, MAP.origin[1] + spawn.y - 24);
});

test('inimigos anunciam o golpe e respeitam obstáculos adicionais', () => {
  const f = fixture(() => true);
  const enemy = f.state().enemies[0];
  f.move(1, enemy.x + 40, enemy.y); f.advance(500);
  assert.equal(f.state().enemies[0].x, enemy.x);
  f.move(1, enemy.x, enemy.y + 10); f.advance(100);
  assert.equal(f.state().enemies[0].phase, 'windup');
  const hp = f.players.get(1).hp;
  f.advance(500);
  assert(f.players.get(1).hp < hp);
  assert(f.messages.get(1).some(m => m.op === 'hurt'));
});

test('montaria mantém movimento diagonal e admin pode usar teleporte', () => {
  const f = fixture(), p = f.players.get(1);
  p.mt = 1;
  f.dungeon.correct(p);
  const route = [[314, 498], [288, 472], [314, 446], [340, 472], [366, 498], [392, 524], [366, 498], [340, 524]];
  for (let loop = 0; loop < 4; loop++) for (const [x, y] of route) {
    f.advance(100); f.move(1, x, y); f.dungeon.correct(p);
    assert.equal(p.ix, MAP.origin[0] + x);
    assert.equal(p.iy, MAP.origin[1] + y);
  }
  p.role = 1;
  f.move(1, 100, 100); f.dungeon.correct(p);
  assert.equal(p.ix, MAP.origin[0] + 100);
});

test('dungeon só reinicia após permanecer vazia e libera progresso para outra visita', () => {
  const f = fixture(); f.unlockBoss();
  const generation = f.state().generation;
  f.players.get(1).in = false; f.players.get(2).in = false;
  f.advance(100); f.advance(29000);
  assert.equal(f.state().generation, generation);
  f.advance(1100);
  assert.notEqual(f.state().generation, generation);
  f.players.get(1).in = true;
  assert.equal(f.state().key, false);
});

test('consumo registra a posição do interior e mantém compatibilidade com tiros externos', async () => {
  const { Economy } = require('./economy');
  for (const inside of [false, true]) {
    const state = { a: 2, shots: [] }, economy = Object.create(Economy.prototype);
    economy.transact = async (_acc, _rid, _digest, action) => action(state);
    const p = { acc: 'a', ok: true, hp: 60, hm: 60, in: inside, x: 100, y: 200, ix: 100000, iy: 80000 };
    await economy.consume(p, { kind: 'a', rid: 'a'.repeat(32) }, () => true);
    assert.equal(state.shots[0].inside, inside);
    assert.equal(state.shots[0].x, inside ? p.ix : p.x);
    assert.equal(state.a, 1);
  }
});

test('combate externo recusa o uso de um projétil que nasceu no interior', async () => {
  const { CombatRewards } = require('./combat-rewards');
  const state = { shots: [{ id: 'x', kind: 'a', inside: true, x: 100, y: 100, until: Date.now() + 1000, targets: [] }] };
  const economy = { transact: async (_acc, _rid, _digest, action) => action(state, {}) };
  const combat = new CombatRewards(economy);
  await assert.rejects(combat.hit({ acc: 'a', hp: 60, ok: true, x: 100, y: 100 }, { sid: 1, weapon: 'a' }, [{ id: 1, k: 'blue', x: 100, y: 100 }], () => true), e => e.code === 'invalid_source');
});

test('a dungeon enemy is protected for one second across different attackers', () => {
 const f=fixture(),enemy=f.state().enemies[0];
 for(const id of [1,2])f.move(id,enemy.x,enemy.y+14);
 f.command('hit',{enemy:enemy.id,weapon:'sword'});const hp=f.state().enemies[0].hp;
 f.command('hit',{enemy:enemy.id,weapon:'sword'},2);assert.equal(f.state().enemies[0].hp,hp);
 f.advance(999);f.command('hit',{enemy:enemy.id,weapon:'sword'},2);assert.equal(f.state().enemies[0].hp,hp);
 f.advance(1);f.command('hit',{enemy:enemy.id,weapon:'sword'},2);assert(f.state().enemies[0].hp<hp);
});

test('dungeon damage events for one player are at least two seconds apart', () => {
 const f=fixture(),enemy=f.state().enemies[0];f.move(1,enemy.x,enemy.y+8);
 for(let i=0;i<200;i++){
  const current=f.state().enemies[0];f.move(1,current.x,current.y+8);f.advance(50);
  const events=f.messages.get(1).filter(m=>m.op==='hurt');
  if(events.length && events.at(-1)._test_at===undefined)events.at(-1)._test_at=f.now();
 }
 const events=f.messages.get(1).filter(m=>m.op==='hurt');assert(events.length>=2);
 for(let i=1;i<events.length;i++)assert(events[i]._test_at-events[i-1]._test_at>=2000);
});

test('dungeon hits push the enemy a short distance and respect blocked geometry',()=>{
 for(const blocked of [false,true]){
  const f=fixture(()=>blocked),enemy=f.state().enemies[0];f.move(1,enemy.x-16,enemy.y);
  f.command('hit',{enemy:enemy.id,weapon:'sword'});const next=f.state().enemies[0];
  assert(next.hp<enemy.hp);
  if(blocked){assert.equal(next.x,enemy.x);assert.equal(next.y,enemy.y);}else{assert(next.x-enemy.x>=12&&next.x-enemy.x<=18);assert.equal(next.y,enemy.y);}
 }
});
