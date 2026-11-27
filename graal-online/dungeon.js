'use strict';
const crypto = require('node:crypto');
const {PLAYER_HIT_INV_MS,MONSTER_HIT_INV_MS}=require('./combat-timing');
const MAP = require('./dungeon_ruins.json');
const CELL = 8;
const ORDER = ['east', 'north', 'west'];
const center = cell => ({ x: (cell[0] + 0.5) * CELL, y: (cell[1] + 0.5) * CELL });
const overlap = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const rect = values => ({ x: values[0] * CELL, y: values[1] * CELL, w: values[2] * CELL, h: values[3] * CELL });
const within = (p, r) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.w && p.y < r.y + r.h;
const inMap = (p, map = MAP) => !!p?.in && !p.football && !p.spar && Number.isFinite(p.ix) && Number.isFinite(p.iy) &&
  within({ x: p.ix - map.origin[0], y: p.iy - map.origin[1] }, { x: 0, y: 0, w: map.w * CELL, h: map.h * CELL });

module.exports = function createDungeon({ players, send, authorized, getCombatState = () => ({}), blocksMove = () => false, now = Date.now, map = MAP }) {
  const MAP = map, SOLID = Buffer.from(MAP.s, 'base64');
  const positions = new Map(), rates = new Map(), attacks = new Map(), shots = new Map(), hurtUntil = new Map();
  let enemies, generation, key, gate, flames, solved, relic, completed, visited, emptyAt;
  let lastStep = now(), lastBroadcast = 0;
  const live = p => !!p && players.get(p.id) === p && p.ws.readyState === 1 && authorized(p);
  const member = p => !!(live(p) && p.ok && inMap(p, MAP));
  const point = p => ({ x: p.ix - MAP.origin[0], y: p.iy - MAP.origin[1] });
  const emit = (p, data) => { if (live(p)) send(p.ws, { t: 'dungeon', map: MAP.id, generation, ...data }); };
  const guardsCleared = () => enemies.filter(e => e.room === 'guards').every(e => e.hp <= 0);
  const bossCleared = () => enemies.find(e => e.id === 'warden').hp <= 0;

  function reset() {
    generation = crypto.randomBytes(8).toString('hex');
    enemies = MAP.enemies.map(e => ({ ...e, ...center(e.cell), max: e.hp, phase: 'idle', until: 0, next: 0, hitUntil: 0, recoilUntil: 0, face: 'Down', walking: false }));
    key = false; gate = false; flames = []; solved = false; relic = false;
    completed = new Set(); visited = false; emptyAt = null;
    positions.clear(); attacks.clear(); shots.clear(); hurtUntil.clear();
  }
  reset();

  function openGates() {
    return { guards_gate: guardsCleared(), boss_gate: gate, relic_gate: bossCleared() };
  }

  function blocked(x, y, scale = 1) {
    const body = { x: x - 4.5 * scale, y: y - 3 * scale, w: 9 * scale, h: 5 * scale };
    for (const px of [body.x, body.x + body.w - 0.01]) for (const py of [body.y, body.y + body.h - 0.01]) {
      const tx = Math.floor(px / CELL), ty = Math.floor(py / CELL);
      if (tx < 0 || ty < 0 || tx >= MAP.w || ty >= MAP.h || SOLID[ty * MAP.w + tx]) return true;
    }
    const open = openGates();
    if (MAP.gates.some(g => !open[g.id] && overlap(body, rect(g.rect)))) return true;
    return MAP.objects.some(o => ['chest', 'relic', 'plaque', 'torch'].includes(o.kind) &&
      overlap(body, { x: center(o.cell).x - 6, y: center(o.cell).y - 4, w: 12, h: 6 }));
  }

  function state(p) {
    const inside = member(p);
    return { op: 'state', version: 1, layout: MAP.layout, generation, inside, key, gate, flames, solved, relic,
      complete: inside && completed.has(p.acc || p.id), gates: openGates(),
      enemies: inside ? enemies.map(e => ({ id: e.id, x: e.x, y: e.y, hp: e.hp, max: e.max,
        face: e.face, walking: e.walking, phase: e.phase })) : [] };
  }

  function broadcast() {
    for (const p of players.values()) if (member(p)) emit(p, state(p));
    lastBroadcast = now();
  }

  function clearPath(from, to, scale = 1) {
    const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 2));
    for (let i = 1; i <= steps; i++) {
      if (blocked(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps, scale)) return false;
    }
    return true;
  }

  function correct(p) {
    if (!member(p)) { positions.delete(p.id); return; }
    if (p.role >= 1) { positions.delete(p.id); return; }
    const target = point(p), spawn = center(MAP.spawn);
    let previous = positions.get(p.id);
    if (!previous) previous = { ...spawn, at: now(), credit: 80 };
    const elapsed = Math.max(0, now() - previous.at) / 1000;
    const credit = Math.min(240, previous.credit + elapsed * (p.mt ? 400 : 320));
    const distance = Math.hypot(target.x - previous.x, target.y - previous.y);
    let cost = distance;
    let valid = distance <= credit + 0.01 && clearPath(previous, target);
    if (!valid) {
      cost = Math.abs(target.x - previous.x) + Math.abs(target.y - previous.y);
      if (cost <= credit + 0.01) {
        const horizontal = { x: target.x, y: previous.y }, vertical = { x: previous.x, y: target.y };
        valid = clearPath(previous, horizontal) && clearPath(horizontal, target) || clearPath(previous, vertical) && clearPath(vertical, target);
      }
    }
    const result = valid ? target : previous;
    positions.set(p.id, { x: result.x, y: result.y, at: now(), credit: valid ? credit - cost : credit });
    if (!valid) {
      p.ix = Math.round(MAP.origin[0] + result.x); p.iy = Math.round(MAP.origin[1] + result.y);
      if (p.il) { p.il.x = p.ix; p.il.y = p.iy; }
      emit(p, { op: 'position', x: result.x, y: result.y });
    }
  }

  function note(p, text) { emit(p, { op: 'note', message: text }); }

  function hit(p, message) {
    const enemy = enemies.find(e => e.id === message.enemy);
    if (!enemy || enemy.hp <= 0 || enemy.hitUntil > now() || enemy.room === 'boss' && !gate) return;
    const hero = point(p), stats = getCombatState(p) || {};
    const weapon = message.weapon || 'sword';
    let multiplier = 1, source = hero;
    if (weapon === 'a' || weapon === 'b') {
      const shot = (stats.shots || []).find(s => s.kind === weapon && s.inside === true && s.until > now() &&
        within({ x: s.x - MAP.origin[0], y: s.y - MAP.origin[1] }, { x: 0, y: 0, w: MAP.w * CELL, h: MAP.h * CELL }) &&
        Math.hypot(s.x - MAP.origin[0] - enemy.x, s.y - MAP.origin[1] - enemy.y) < (weapon === 'a' ? 430 : 180));
      if (!shot || typeof shot.id !== 'string') return;
      if (weapon === 'a' && !clearPath({ x: shot.x - MAP.origin[0], y: shot.y - MAP.origin[1] }, enemy, 0.2)) return;
      const id = String(p.acc || p.id) + ':' + shot.id;
      const used = shots.get(id) || { until: shot.until, targets: new Set() };
      if (used.targets.has(enemy.id) || weapon === 'a' && used.targets.size) return;
      used.targets.add(enemy.id); shots.set(id, used);
      source = { x: shot.x - MAP.origin[0], y: shot.y - MAP.origin[1] };
      multiplier = weapon === 'b' ? 2.2 : 0.9;
    } else {
      if (weapon !== 'sword' || Math.hypot(hero.x - enemy.x, hero.y - enemy.y) > 55 || (attacks.get(p.id) || 0) > now()) return;
      attacks.set(p.id, now() + 350);
    }
    const damage = Math.max(3, Math.round(((stats.lvl || 1) * 5 + 30 + (stats.up || 0) * 8 + crypto.randomInt(1, 20)) * multiplier) - enemy.def);
    enemy.hp = Math.max(0, enemy.hp - damage);
    enemy.hitUntil = now() + MONSTER_HIT_INV_MS;
    const dx = enemy.x - source.x, dy = enemy.y - source.y, length = Math.hypot(dx, dy);
    const kx = length > 0.001 ? dx / length : 0, ky = length > 0.001 ? dy / length : 1;
    for (let step = 0; step < 16; step++) stepEnemy(enemy, kx, ky);
    enemy.recoilUntil = now() + 150;
    enemy.walking = false;
    if (!enemy.hp) { enemy.walking = false; enemy.phase = 'dead'; }
    broadcast();
  }

  function interact(p, id) {
    const object = MAP.objects.find(o => o.id === id);
    if (!object || Math.hypot(point(p).x - center(object.cell).x, point(p).y - center(object.cell).y) > 30) return;
    if (id === 'key') {
      if (!guardsCleared()) return note(p, 'Os vigias ainda protegem a chave.');
      if (!key) { key = true; note(p, 'A Chave do Eco foi encontrada.'); }
    } else if (ORDER.includes(id)) {
      if (solved || flames.includes(id)) return;
      if (id === ORDER[flames.length]) flames.push(id);
      else { flames = []; note(p, 'As chamas se apagaram. Confira a inscrição.'); }
      if (flames.length === ORDER.length) { solved = true; note(p, 'As três chamas despertaram o selo.'); }
    } else if (id === 'boss_gate') {
      if (!key) return note(p, 'Encontre a chave na ala dos vigias.');
      if (!solved) return note(p, 'O selo aguarda as três chamas.');
      gate = true;
    } else if (id === 'relic') {
      if (!bossCleared()) return note(p, 'O Guardião protege o relicário.');
      const account = p.acc || p.id;
      if (completed.has(account)) return;
      completed.add(account); relic = true;
      emit(p, { op: 'complete', name: MAP.relic });
    } else return;
    broadcast();
  }

  function handle(p, message) {
    if (!live(p) || !message || typeof message.op !== 'string') return;
    const rate = rates.get(p.id) || { at: now(), count: 0 };
    if (now() - rate.at >= 1000) { rate.at = now(); rate.count = 0; }
    rates.set(p.id, rate);
    if (++rate.count > 20) return;
    if (message.op === 'get') return emit(p, state(p));
    if (!member(p) || p.hp <= 0 || p.hid) return;
    if (message.op === 'hit') hit(p, message);
    if (message.op === 'interact') interact(p, message.id);
  }

  function moveEnemy(enemy, target, delta) {
    const dx = target.x - enemy.x, dy = target.y - enemy.y, distance = Math.hypot(dx, dy);
    const step = Math.min(distance, enemy.speed * delta);
    enemy.walking = distance > 2;
    if (!enemy.walking) return;
    enemy.face = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'Right' : 'Left') : (dy > 0 ? 'Down' : 'Up');
    stepEnemy(enemy, dx / distance * step, dy / distance * step);
  }

  function stepEnemy(enemy, dx, dy) {
    const x = enemy.x + dx, y = enemy.y + dy;
    const room = rect(MAP.rooms.find(r => r.id === enemy.room).rect);
    const context = { in: true, football: '', spar: '' };
    const global = (px, py) => ({ x: MAP.origin[0] + px, y: MAP.origin[1] + py });
    if (within({ x, y: enemy.y }, room) && !blocked(x, enemy.y, enemy.scale) && !blocksMove(context, global(enemy.x, enemy.y), global(x, enemy.y))) enemy.x = x;
    if (within({ x: enemy.x, y }, room) && !blocked(enemy.x, y, enemy.scale) && !blocksMove(context, global(enemy.x, enemy.y), global(enemy.x, y))) enemy.y = y;
  }

  function tick() {
    const stamp = now(), delta = Math.min(0.2, Math.max(0, stamp - lastStep) / 1000);
    lastStep = stamp;
    const members = [...players.values()].filter(member);
    if (!members.length) {
      if (visited && emptyAt === null) emptyAt = stamp;
      if (visited && stamp - emptyAt >= 30000) reset();
    } else {
      visited = true; emptyAt = null;
      for (const enemy of enemies) {
        if (enemy.hp <= 0 || enemy.room === 'boss' && !gate) continue;
        if (enemy.recoilUntil > stamp) { enemy.walking = false; continue; }
        const room = rect(MAP.rooms.find(r => r.id === enemy.room).rect);
        const targets = members.filter(p => p.hp > 0 && !p.hid && within(point(p), room));
        const target = targets.sort((a, b) => Math.hypot(point(a).x - enemy.x, point(a).y - enemy.y) - Math.hypot(point(b).x - enemy.x, point(b).y - enemy.y))[0];
        if (enemy.phase === 'windup') {
          enemy.walking = false;
          if (stamp >= enemy.until) {
            for (const hero of targets) if (Math.hypot(point(hero).x - enemy.x, point(hero).y - enemy.y) <= enemy.reach + 6 && (hurtUntil.get(hero.id) || 0) <= stamp) {
              hero.hp = Math.max(0, hero.hp - enemy.damage);
              hurtUntil.set(hero.id, stamp + PLAYER_HIT_INV_MS);
              emit(hero, { op: 'hurt', damage: enemy.damage, x: enemy.x, y: enemy.y });
            }
            enemy.phase = 'idle'; enemy.next = stamp + enemy.cooldown;
          }
          continue;
        }
        const destination = target ? point(target) : center(enemy.cell);
        if (target && Math.hypot(destination.x - enemy.x, destination.y - enemy.y) <= enemy.reach && stamp >= enemy.next) {
          enemy.phase = 'windup'; enemy.until = stamp + enemy.windup;
        } else moveEnemy(enemy, destination, delta);
      }
      if (stamp - lastBroadcast >= 200) broadcast();
    }
    for (const table of [positions, rates, attacks, hurtUntil]) for (const id of table.keys()) if (!players.has(id)) table.delete(id);
    for (const [id, shot] of shots) if (shot.until <= stamp) shots.delete(id);
  }

  return { handle, tick, correct, state, blocked, contains: p => inMap(p, MAP) };
};
Object.assign(module.exports, { MAP, center, inMap });
