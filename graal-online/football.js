'use strict';

const FIELD = Object.freeze({ x: 512, y: 1024, w: 384, h: 224, goal: 64 });
const STEP = 50;
const DURATION = 300000;
const RADIUS = 4;
const SPEED = 125;

module.exports = function createFootball({ players, send, authorized, viewPlayer, now = Date.now }) {
  const queue = new Set();
  const matches = new Map();
  const members = new Map();
  const rates = new Map();
  let nextId = 1;
  let queueUntil = 0;

  const live = p => !!p && players.get(p.id) === p && p.ws.readyState === 1 && authorized(p);
  const eligible = p => live(p) && p.ok && !p.hid && !p.in && !p.spar && !p.sparPending &&
    !p.mt && !p.cy && p.hp > 0 && Number.isFinite(p.x) && Number.isFinite(p.y);
  const emit = (p, data) => { if (p && p.ws.readyState === 1) send(p.ws, { t: 'football', ...data }); };
  const error = (p, message) => emit(p, { op: 'error', message });

  function queueState() {
    if (queue.size < 2) queueUntil = 0;
    else if (!queueUntil) queueUntil = now() + 10000;
    for (const id of queue) emit(players.get(id), {
      op: 'queue', count: queue.size, starts: Math.max(0, queueUntil - now()), joined: true
    });
  }

  function roster(match) {
    return [...match.entries.values()].filter(entry => players.has(entry.id)).map(entry => {
      const p = players.get(entry.id);
      return { ...viewPlayer(p), x: entry.x, y: entry.y, team: entry.team, ack: entry.ack };
    });
  }

  function state(match) {
    const time = now();
    return {
      op: 'state', match: match.id, movement: 2, round: match.round,
      phase: match.phase, field: FIELD, score: [...match.score],
      remaining: match.ends ? Math.max(0, match.ends - time) : DURATION,
      wait: Math.max(0, match.until - time), ball: { x: match.ball.x, y: match.ball.y },
      players: roster(match), reason: match.reason || '', winner: match.winner ?? -1
    };
  }

  function snapshot(match) {
    const data = state(match);
    for (const entry of match.entries.values()) emit(players.get(entry.id), data);
    match.sent = now();
  }

  function reset(match) {
    match.round = (match.round || 0) + 1;
    const slots = [0, 0];
    for (const entry of match.entries.values()) {
      const index = slots[entry.team]++;
      entry.x = FIELD.x + (entry.team === 0 ? 100 : FIELD.w - 100);
      entry.y = FIELD.y + FIELD.h / 2 + [0, -54, 54][index];
      entry.dx = 0;
      entry.dy = 0;
      entry.inputAt = 0;
      entry.inputs = [];
      entry.received = 0;
      entry.ack = 0;
      entry.sequenced = false;
      entry.pendingKick = null;
      const p = players.get(entry.id);
      p.x = entry.x;
      p.y = entry.y;
      p.an = entry.team === 0 ? 'Idle_Right' : 'Idle_Left';
    }
    match.ball = { x: FIELD.x + FIELD.w / 2, y: FIELD.y + FIELD.h / 2, vx: 0, vy: 0 };
  }

  function start(ids) {
    const match = {
      id: 'football-' + nextId++, entries: new Map(), score: [0, 0],
      phase: 'kickoff', until: now() + 3000, ends: 0, stepped: now(), sent: 0
    };
    for (let index = 0; index < ids.length; index++) {
      const p = players.get(ids[index]);
      queue.delete(p.id);
      const entry = { id: p.id, team: index % 2, kickAt: -Infinity,
        back: { x: p.x, y: p.y, an: p.an, in: p.in || 0, il: p.il || null } };
      match.entries.set(p.id, entry);
      members.set(p.id, match);
      p.football = match.id;
      p.in = 0;
      p.il = null;
    }
    matches.set(match.id, match);
    reset(match);
    snapshot(match);
    queueUntil = 0;
    queueState();
  }

  function finish(match, reason, winner) {
    if (match.phase === 'finished') return;
    match.phase = 'finished';
    match.reason = reason;
    match.winner = winner;
    match.until = now() + 4000;
    snapshot(match);
  }

  function returnPlayer(match, entry, reason) {
    const p = players.get(entry.id);
    members.delete(entry.id);
    match.entries.delete(entry.id);
    if (!p) return;
    delete p.football;
    Object.assign(p, entry.back);
    p.uT = now();
    emit(p, { op: 'end', reason, x: p.x, y: p.y, score: [...match.score], winner: match.winner ?? -1 });
  }

  function leave(id, reason = 'leave') {
    const p = players.get(id);
    const queued = queue.delete(id);
    if (queued) queueState();
    const match = members.get(id);
    if (!match) { emit(p, { op: 'queue', joined: false, count: queue.size, starts: 0 }); return; }
    returnPlayer(match, match.entries.get(id), reason);
    if (!match.entries.size) { matches.delete(match.id); return; }
    const teams = [0, 0];
    for (const entry of match.entries.values()) teams[entry.team]++;
    if (!teams[0] || !teams[1]) finish(match, 'forfeit', teams[0] ? 0 : 1);
    else snapshot(match);
  }

  function kick(p, match, m) {
    const entry = match.entries.get(p.id);
    if (match.phase !== 'playing' || now() - entry.kickAt < 350 ||
      !Number.isFinite(m.dx) || !Number.isFinite(m.dy)) return;
    const length = Math.hypot(m.dx, m.dy);
    if (length < 0.01 || length > 1.21 || Math.hypot(entry.x - match.ball.x, entry.y - match.ball.y) > 22) return;
    entry.kickAt = now();
    match.ball.vx = m.dx / length * 260;
    match.ball.vy = m.dy / length * 260;
    snapshot(match);
  }

  function handle(p, m) {
    if (!live(p)) return;
    const time = now();
    let rate = rates.get(p.id);
    if (!rate || time - rate.at >= 1000) { rate = { at: time, n: 0 }; rates.set(p.id, rate); }
    if (++rate.n > 50) return;
    if (m.op === 'leave') return leave(p.id);
    const match = members.get(p.id);
    if (m.op === 'get') {
      if (match) return emit(p, state(match));
      return emit(p, { op: 'queue', joined: queue.has(p.id), count: queue.size, starts: Math.max(0, queueUntil - time) });
    }
    if (m.op === 'join') {
      if (m.version !== 1) return error(p, 'Atualize o jogo para jogar futebol.');
      if (match) return emit(p, state(match));
      if (queue.has(p.id)) return emit(p, { op: 'queue', joined: true, count: queue.size, starts: Math.max(0, queueUntil - time) });
      if (!eligible(p)) return error(p, 'Entre a pé, vivo e sem carregar itens, no mundo principal e fora do Spar.');
      queue.add(p.id);
      queueState();
      return;
    }
    if (!match) return;
    if ((m.match !== undefined && m.match !== match.id) || (m.round !== undefined && m.round !== match.round)) return;
    if (m.op === 'kick') {
      if (m.after === undefined) return kick(p, match, m);
      const entry = match.entries.get(p.id);
      if (match.phase !== 'playing' || !Number.isSafeInteger(m.after) || m.after < entry.ack ||
        m.after > entry.received || !Number.isFinite(m.dx) || !Number.isFinite(m.dy) ||
        Math.hypot(m.dx, m.dy) < 0.01 || Math.hypot(m.dx, m.dy) > 1.21) return;
      entry.pendingKick = { after: m.after, dx: m.dx, dy: m.dy };
      return;
    }
    if (m.op === 'move' && Number.isFinite(m.dx) && Number.isFinite(m.dy) && Math.hypot(m.dx, m.dy) <= 1.21) {
      const entry = match.entries.get(p.id);
      if (m.seq !== undefined) {
        // Cada seq descreve 50 ms. A simulação consome um comando por passo.
        if (match.phase !== 'playing' || m.match !== match.id || m.round !== match.round ||
          !Number.isSafeInteger(m.seq) || m.seq !== entry.received + 1 || m.seq > 1e9 || entry.inputs.length >= 20) return;
        entry.sequenced = true;
        entry.received = m.seq;
        entry.inputs.push({ seq: m.seq, dx: m.dx, dy: m.dy });
        return;
      }
      if (entry.sequenced) return;
      entry.dx = m.dx;
      entry.dy = m.dy;
      entry.inputAt = time;
    }
  }

  function goal(match, team) {
    match.score[team]++;
    match.phase = 'goal';
    match.until = now() + 2500;
    reset(match);
    snapshot(match);
  }

  function stepBall(match) {
    const ball = match.ball;
    const speed = Math.hypot(ball.vx, ball.vy);
    const count = Math.max(1, Math.ceil(speed * STEP / 1000 / 2));
    const dt = STEP / 1000 / count;
    for (let i = 0; i < count; i++) {
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if (ball.y < FIELD.y + RADIUS || ball.y > FIELD.y + FIELD.h - RADIUS) {
        ball.y = Math.max(FIELD.y + RADIUS, Math.min(FIELD.y + FIELD.h - RADIUS, ball.y));
        ball.vy *= -0.7;
      }
      const mouth = Math.abs(ball.y - FIELD.y - FIELD.h / 2) <= FIELD.goal / 2 - RADIUS;
      if (mouth && ball.x > FIELD.x + FIELD.w + RADIUS) { goal(match, 0); return; }
      if (mouth && ball.x < FIELD.x - RADIUS) { goal(match, 1); return; }
      if (!mouth && (ball.x < FIELD.x + RADIUS || ball.x > FIELD.x + FIELD.w - RADIUS)) {
        ball.x = Math.max(FIELD.x + RADIUS, Math.min(FIELD.x + FIELD.w - RADIUS, ball.x));
        ball.vx *= -0.7;
      }
    }
    const friction = Math.max(0, speed - 100 * STEP / 1000) / (speed || 1);
    ball.vx *= friction;
    ball.vy *= friction;
  }

  function step(match) {
    for (const entry of match.entries.values()) {
      const p = players.get(entry.id);
      const input = entry.sequenced ? entry.inputs.shift() : null;
      const fresh = !entry.sequenced && now() - entry.inputAt <= 250;
      const dx = input ? input.dx : (fresh ? entry.dx : 0);
      const dy = input ? input.dy : (fresh ? entry.dy : 0);
      if (input) entry.ack = input.seq;
      entry.x = Math.max(FIELD.x + 8, Math.min(FIELD.x + FIELD.w - 8, entry.x + dx * SPEED * STEP / 1000));
      entry.y = Math.max(FIELD.y + 8, Math.min(FIELD.y + FIELD.h - 8, entry.y + dy * SPEED * STEP / 1000));
      p.x = entry.x;
      p.y = entry.y;
      p.uT = now();
      if (dx || dy) {
        entry.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'Right' : 'Left') : (dy > 0 ? 'Down' : 'Up');
      }
      p.an = (dx || dy ? 'Run_' : 'Idle_') + (entry.facing || (entry.team === 0 ? 'Right' : 'Left'));
      const bx = match.ball.x - entry.x;
      const by = match.ball.y - entry.y;
      const distance = Math.hypot(bx, by);
      if (distance < 13 && (dx || dy) && now() - entry.kickAt > 150) {
        const length = Math.hypot(dx, dy);
        match.ball.x = entry.x + dx / length * 13;
        match.ball.y = entry.y + dy / length * 13;
        match.ball.vx = dx * SPEED;
        match.ball.vy = dy * SPEED;
      }
    }
    for (const entry of match.entries.values()) {
      if (entry.pendingKick && entry.ack >= entry.pendingKick.after) {
        const request = entry.pendingKick;
        entry.pendingKick = null;
        kick(players.get(entry.id), match, request);
      }
    }
    stepBall(match);
  }

  function tick() {
    const time = now();
    let changed = false;
    for (const id of queue) if (!eligible(players.get(id))) {
      queue.delete(id);
      emit(players.get(id), { op: 'queue', joined: false, count: queue.size, starts: 0 });
      changed = true;
    }
    if (changed) queueState();
    if (queue.size >= 2 && (queue.size >= 6 || time >= queueUntil)) start([...queue].slice(0, 6));
    for (const match of matches.values()) {
      for (const entry of [...match.entries.values()]) {
        const p = players.get(entry.id);
        if (!live(p) || p.hid) leave(entry.id, 'disconnect');
      }
      if (!matches.has(match.id)) continue;
      if (match.phase === 'finished') {
        if (time >= match.until) {
          for (const entry of [...match.entries.values()]) returnPlayer(match, entry, match.reason);
          matches.delete(match.id);
        }
        continue;
      }
      if (match.ends && time >= match.ends) {
        finish(match, 'time', match.score[0] === match.score[1] ? -1 : (match.score[0] > match.score[1] ? 0 : 1));
        continue;
      }
      if ((match.phase === 'kickoff' || match.phase === 'goal') && time >= match.until) {
        match.phase = 'playing';
        if (!match.ends) match.ends = time + DURATION;
        match.stepped = time;
        snapshot(match);
      }
      if (match.phase === 'playing') {
        let steps = Math.min(4, Math.floor((time - match.stepped) / STEP));
        while (steps-- > 0 && match.phase === 'playing') {
          match.stepped += STEP;
          step(match);
        }
        if (time - match.stepped > 200) match.stepped = time;
      } else {
        match.stepped = time;
      }
      if (time - match.sent >= 100) snapshot(match);
    }
  }

  return {
    handle, tick,
    has: p => !!p && (queue.has(p.id) || members.has(p.id)),
    disconnect(id) { leave(id, 'disconnect'); rates.delete(id); }
  };
};

module.exports.FIELD = FIELD;
