'use strict';

const FIELD = Object.freeze({ x: 512, y: 1024, w: 576, h: 384, goal: 160 });
const TEAM_SIZE = 5;
const STEP = 50;
const DURATION = 300000;
const RADIUS = 5;
const SPAWN = 92;          // distância do centro do campo até o ponto de saída de cada time
const SPEED = 125;

// Física da bola (px, segundos). Jogadores são corpos cinemáticos de massa infinita.
const BODY = 6;            // raio do corpo do jogador
const POST = 2;            // raio da trave
const REACH = 22;          // alcance máximo do chute
const KICK_MIN = 260;      // chute de longe
const KICK_MAX = 330;      // chute colado na bola
const MAX_BALL = 380;      // velocidade máxima da bola
const SUBSTEPS = 4;        // sub-passos por passo de 50 ms (evita atravessar jogadores)
const ROLL_DAMP = 0.55;    // resistência proporcional à velocidade (1/s)
const ROLL_DRAG = 22;      // atrito de rolamento constante (px/s²)
const BOUNCE_WALL = 0.65;  // restituição nas laterais e no fundo
const BOUNCE_BODY = 0.35;  // restituição no corpo do jogador
const BOUNCE_POST = 0.6;   // restituição nas traves
const GRIP = 0.2;          // atrito tangencial no contato

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
      bv: { x: Math.round(match.ball.vx * 10) / 10, y: Math.round(match.ball.vy * 10) / 10 },
      players: roster(match), reason: match.reason || '', winner: match.winner ?? -1
    };
  }

  function snapshot(match) {
    const data = state(match);
    for (const entry of match.entries.values()) {
      const p = players.get(entry.id);
      // Ping (ida e volta, ms) medido pelo servidor: o cliente usa para alinhar a correção da bola.
      const rtt = p && p.ws && Number.isFinite(p.ws.pingMs) ? Math.min(600, Math.max(0, Math.round(p.ws.pingMs))) : 0;
      emit(p, { ...data, rtt });
    }
    match.sent = now();
  }

  function reset(match) {
    match.round = (match.round || 0) + 1;
    const slots = [0, 0];
    for (const entry of match.entries.values()) {
      const index = slots[entry.team]++;
      entry.x = FIELD.x + FIELD.w / 2 + (entry.team === 0 ? -SPAWN : SPAWN);
      entry.y = FIELD.y + FIELD.h / 2 + [0, -64, 64, -128, 128][index];
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
    const distance = Math.hypot(entry.x - match.ball.x, entry.y - match.ball.y);
    if (length < 0.01 || length > 1.21 || distance > REACH) return;
    entry.kickAt = now();
    // Quanto mais colado na bola, mais forte o chute.
    const contact = BODY + RADIUS;
    const far = Math.min(1, Math.max(0, (distance - contact) / (REACH - contact)));
    const power = KICK_MAX - far * (KICK_MAX - KICK_MIN);
    match.ball.vx = m.dx / length * power;
    match.ball.vy = m.dy / length * power;
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

  // Colisão círculo × círculo entre a bola e um corpo (jogador ou trave).
  // O corpo tem massa infinita: a bola reflete a velocidade relativa com restituição
  // e perde um pouco de velocidade tangencial (atrito). Um jogador correndo "conduz" a bola.
  function collide(ball, px, py, pvx, pvy, radius, bounce, dribble = false) {
    const minimum = radius + RADIUS;
    let nx = ball.x - px;
    let ny = ball.y - py;
    let distance = Math.hypot(nx, ny);
    if (distance >= minimum) return;
    if (distance < 1e-6) {
      const speed = Math.hypot(pvx, pvy);
      nx = speed ? pvx / speed : 1;
      ny = speed ? pvy / speed : 0;
    } else {
      nx /= distance;
      ny /= distance;
    }
    const rvx = ball.vx - pvx;
    const rvy = ball.vy - pvy;
    const normal = rvx * nx + rvy * ny;
    const bodySpeed = Math.hypot(pvx, pvy);
    // Condução frontal mantém a linha de movimento e o afastamento lateral existente.
    // A separação radial e a restituição amplificavam pequenos contatos fora do centro.
    if (dribble && bodySpeed > 0 &&
        (nx * pvx + ny * pvy) / bodySpeed >= 0.5 &&
        Math.hypot(ball.vx, ball.vy) <= bodySpeed * 1.5) {
      const dx = pvx / bodySpeed;
      const dy = pvy / bodySpeed;
      const lateral = (ball.x - px) * -dy + (ball.y - py) * dx;
      const forward = Math.sqrt(Math.max(0, minimum * minimum - lateral * lateral));
      ball.x = px + dx * forward - dy * lateral;
      ball.y = py + dy * forward + dx * lateral;
      if (normal < 0) {
        ball.vx = pvx * 1.1;
        ball.vy = pvy * 1.1;
      }
      return;
    }
    ball.x = px + nx * minimum;
    ball.y = py + ny * minimum;
    if (normal >= 0) return; // já está se afastando
    const tangent = rvx * -ny + rvy * nx;
    const outward = -normal * bounce;
    const slide = tangent * (1 - GRIP);
    ball.vx = pvx + nx * outward + -ny * slide;
    ball.vy = pvy + ny * outward + nx * slide;
  }

  function collidePosts(ball) {
    const middle = FIELD.y + FIELD.h / 2;
    for (const x of [FIELD.x, FIELD.x + FIELD.w]) {
      collide(ball, x, middle - FIELD.goal / 2, 0, 0, POST, BOUNCE_POST);
      collide(ball, x, middle + FIELD.goal / 2, 0, 0, POST, BOUNCE_POST);
    }
  }

  function stepBall(match, motion) {
    const ball = match.ball;
    const dt = STEP / 1000 / SUBSTEPS;
    for (let i = 1; i <= SUBSTEPS; i++) {
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      const t = i / SUBSTEPS;
      for (const body of motion) {
        collide(ball, body.x0 + (body.x1 - body.x0) * t, body.y0 + (body.y1 - body.y0) * t,
          body.vx, body.vy, BODY, BOUNCE_BODY, true);
      }
      collidePosts(ball);
      if (ball.y < FIELD.y + RADIUS || ball.y > FIELD.y + FIELD.h - RADIUS) {
        ball.y = Math.max(FIELD.y + RADIUS, Math.min(FIELD.y + FIELD.h - RADIUS, ball.y));
        ball.vy *= -BOUNCE_WALL;
        ball.vx *= 0.96;
      }
      const mouth = Math.abs(ball.y - FIELD.y - FIELD.h / 2) <= FIELD.goal / 2 - RADIUS;
      if (mouth && ball.x > FIELD.x + FIELD.w + RADIUS) { goal(match, 0); return; }
      if (mouth && ball.x < FIELD.x - RADIUS) { goal(match, 1); return; }
      if (!mouth && (ball.x < FIELD.x + RADIUS || ball.x > FIELD.x + FIELD.w - RADIUS)) {
        ball.x = Math.max(FIELD.x + RADIUS, Math.min(FIELD.x + FIELD.w - RADIUS, ball.x));
        ball.vx *= -BOUNCE_WALL;
        ball.vy *= 0.96;
      }
    }
    // Atrito de rolamento: proporcional à velocidade + constante, até parar.
    const speed = Math.hypot(ball.vx, ball.vy);
    if (speed > 0) {
      const seconds = STEP / 1000;
      const slowed = Math.min(MAX_BALL, speed * Math.exp(-ROLL_DAMP * seconds));
      const next = Math.max(0, slowed - ROLL_DRAG * seconds);
      const scale = next < 1 ? 0 : next / speed;
      ball.vx *= scale;
      ball.vy *= scale;
    }
  }

  function step(match) {
    const motion = [];
    for (const entry of match.entries.values()) {
      const p = players.get(entry.id);
      const input = entry.sequenced ? entry.inputs.shift() : null;
      const fresh = !entry.sequenced && now() - entry.inputAt <= 250;
      const dx = input ? input.dx : (fresh ? entry.dx : 0);
      const dy = input ? input.dy : (fresh ? entry.dy : 0);
      if (input) entry.ack = input.seq;
      const x0 = entry.x;
      const y0 = entry.y;
      entry.x = Math.max(FIELD.x + 8, Math.min(FIELD.x + FIELD.w - 8, entry.x + dx * SPEED * STEP / 1000));
      entry.y = Math.max(FIELD.y + 8, Math.min(FIELD.y + FIELD.h - 8, entry.y + dy * SPEED * STEP / 1000));
      p.x = entry.x;
      p.y = entry.y;
      p.uT = now();
      if (dx || dy) {
        entry.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'Right' : 'Left') : (dy > 0 ? 'Down' : 'Up');
      }
      p.an = (dx || dy ? 'Run_' : 'Idle_') + (entry.facing || (entry.team === 0 ? 'Right' : 'Left'));
      // Velocidade real (já limitada pelas bordas) para a colisão com a bola.
      motion.push({ x0, y0, x1: entry.x, y1: entry.y,
        vx: (entry.x - x0) * 1000 / STEP, vy: (entry.y - y0) * 1000 / STEP });
    }
    for (const entry of match.entries.values()) {
      if (entry.pendingKick && entry.ack >= entry.pendingKick.after) {
        const request = entry.pendingKick;
        entry.pendingKick = null;
        kick(players.get(entry.id), match, request);
      }
    }
    stepBall(match, motion);
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
    if (queue.size >= 2 && (queue.size >= TEAM_SIZE * 2 || time >= queueUntil)) start([...queue].slice(0, TEAM_SIZE * 2));
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
      if (time - match.sent >= 50) snapshot(match);
    }
  }

  return {
    handle, tick,
    has: p => !!p && (queue.has(p.id) || members.has(p.id)),
    disconnect(id) { leave(id, 'disconnect'); rates.delete(id); }
  };
};

module.exports.FIELD = FIELD;
