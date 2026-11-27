'use strict';

const FIELD = Object.freeze({ x: 512, y: 1024, w: 576, h: 384, goal: 160 });
const TEAM_SIZE = 5;
const POSITIONS = Object.freeze({ attacker: 2, midfielder: 2, keeper: 1 });
const STEP = 50;
const DURATION = 300000;
const RADIUS = 5;
const SPAWN = 92;          // distância do centro do campo até o ponto de saída de cada time
const SPEED = 125;
const CONTROL_SPEED = SPEED * 0.8; // quem está com a bola corre 20% mais devagar
const TURN_RATE = 14;       // radianos por segundo durante uma curva com a bola

// Física da bola (px, segundos). Jogadores são corpos cinemáticos de massa infinita.
const AREA_DEPTH = 56;
const BODY = 6;            // raio do corpo do jogador
const CONTROL_DISTANCE = BODY + RADIUS + 1; // bola protegida permanece aos pés
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

module.exports = function createFootball({ players, send, authorized, viewPlayer, blocksMove = () => false, now = Date.now }) {
  const queue = new Map();
  const matches = new Map();
  const members = new Map();
  const rates = new Map();
  let nextId = 1;
  let queueUntil = 0;

  const live = p => !!p && players.get(p.id) === p && p.ws.readyState === 1 && authorized(p);
  const eligible = p => live(p) && p.ok && !p.hid && !p.in && !p.spar && !p.sparPending && !p.ctf && !p.ctfQueued &&
    !p.mt && !p.cy && p.hp > 0 && Number.isFinite(p.x) && Number.isFinite(p.y);
  const emit = (p, data) => { if (p && p.ws.readyState === 1) send(p.ws, { t: 'football', ...data }); };
  const error = (p, message) => emit(p, { op: 'error', message });

  function freeSlot(entries, team, position, exclude) {
    const used = new Set([...entries].filter(([id, entry]) => id !== exclude && entry.team === team && entry.position === position).map(([, entry]) => entry.slot));
    for (let slot = 0; slot < POSITIONS[position]; slot++) if (!used.has(slot)) return slot;
    return -1;
  }

  function queuePacket(id) {
    const teams = [{ attacker: 0, midfielder: 0, keeper: 0 }, { attacker: 0, midfielder: 0, keeper: 0 }];
    const lineups = [[], []];
    for (const [memberId, choice] of queue) {
      teams[choice.team][choice.position]++;
      lineups[choice.team].push({ id: memberId, nm: String(players.get(memberId)?.nm || 'Jogador'), ...choice });
    }
    const choice = queue.get(id);
    return { op: 'queue', selection: 1, formation: 1, lineups, slot: choice ? choice.slot : -1, count: queue.size, starts: Math.max(0, queueUntil - now()),
      joined: !!choice, team: choice ? choice.team : -1, position: choice ? choice.position : '', teams };
  }

  function queueState() {
    const teams = new Set([...queue.values()].map(choice => choice.team));
    if (teams.size < 2) queueUntil = 0;
    else if (!queueUntil) queueUntil = now() + 10000;
    for (const id of queue.keys()) emit(players.get(id), queuePacket(id));
  }

  function roster(match) {
    return [...match.entries.values()].filter(entry => players.has(entry.id)).map(entry => {
      const p = players.get(entry.id);
      return { ...viewPlayer(p), x: entry.x, y: entry.y, team: entry.team, position: entry.position, slot: entry.slot, ack: entry.ack, keeper: entry.position === 'keeper' };
    });
  }

  function state(match) {
    const time = now();
    return {
      op: 'state', match: match.id, movement: 3, selection: 1, formation: 1, round: match.round,
      phase: match.phase, field: FIELD, score: [...match.score], holder: match.holder, hold: match.hold,
      owner: match.control ? match.control.id : 0,
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

  function keeperArea(team) {
    return { x: team === 0 ? FIELD.x : FIELD.x + FIELD.w - AREA_DEPTH,
      y: FIELD.y + FIELD.h / 2 - FIELD.goal / 2 - 34, w: AREA_DEPTH, h: FIELD.goal + 68 };
  }

  function insideArea(team, x, y) {
    const area = keeperArea(team);
    return x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h;
  }

  function updateHeldBall(match) {
    const keeper = match.entries.get(match.holder);
    if (!keeper) { match.holder = 0; return false; }
    match.ball.x = keeper.x;
    match.ball.y = keeper.y - BODY - RADIUS - 1;
    match.ball.vx = 0;
    match.ball.vy = 0;
    return true;
  }

  function catchBall(match, motion, t) {
    for (const body of motion) {
      if (!body.keeper) continue;
      const x = body.x0 + (body.x1 - body.x0) * t;
      const y = body.y0 + (body.y1 - body.y0) * t;
      if (!insideArea(body.team, x, y) || !insideArea(body.team, match.ball.x, match.ball.y) ||
          Math.hypot(match.ball.x - x, match.ball.y - y) > BODY + RADIUS) continue;
      // O contato pode ocorrer antes do fim do passo de movimento.
      const keeper = match.entries.get(body.id);
      const limits = keeperArea(body.team);
      keeper.x = Math.max(limits.x + 8, Math.min(limits.x + limits.w - 8, keeper.x));
      keeper.y = Math.max(limits.y + 8, Math.min(limits.y + limits.h - 8, keeper.y));
      const player = players.get(body.id);
      player.x = keeper.x;
      player.y = keeper.y;
      match.holder = body.id;
      match.hold++;
      match.control = null;
      for (const entry of match.entries.values()) entry.pendingKick = null;
      updateHeldBall(match);
      return true;
    }
    return false;
  }

  function reset(match) {
    match.control = null;
    match.contacts = new Set();
    match.holder = 0;
    match.hold = 0;
    match.round = (match.round || 0) + 1;
    for (const entry of match.entries.values()) {
      const index = entry.slot;
      const depth = entry.position === 'midfielder' ? SPAWN + 64 : SPAWN;
      entry.x = FIELD.x + FIELD.w / 2 + (entry.team === 0 ? -depth : depth);
      entry.y = FIELD.y + FIELD.h / 2 + (entry.position === 'midfielder' ? [-80, 80][index] : [0, -64][index]);
      if (entry.position === 'keeper') {
        entry.x = entry.team === 0 ? FIELD.x + 24 : FIELD.x + FIELD.w - 24;
        entry.y = FIELD.y + FIELD.h / 2;
      }
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
      const choice = queue.get(p.id);
      queue.delete(p.id);
      const entry = { id: p.id, team: choice.team, position: choice.position, slot: choice.slot, kickAt: -Infinity,
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
    match.control = null;
    match.contacts = new Set();
    match.holder = 0;
    match.reason = reason;
    match.winner = winner;
    match.until = now() + 4000;
    snapshot(match);
  }

  function returnPlayer(match, entry, reason) {
    const p = players.get(entry.id);
    if (match.control && match.control.id === entry.id) {
      match.control = null;
      match.ball.vx = 0;
      match.ball.vy = 0;
    }
    if (match.holder === entry.id) {
      match.holder = 0;
      match.ball.vx = 0;
      match.ball.vy = 0;
    }
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
    if (!match) { emit(p, queuePacket(id)); return; }
    returnPlayer(match, match.entries.get(id), reason);
    if (!match.entries.size) { matches.delete(match.id); return; }
    const teams = [0, 0];
    for (const entry of match.entries.values()) teams[entry.team]++;
    if (!teams[0] || !teams[1]) finish(match, 'forfeit', teams[0] ? 0 : 1);
    else snapshot(match);
  }

  function kick(p, match, m) {
    const entry = match.entries.get(p.id);
    const throwing = match.holder === p.id;
    // Bola conduzida só sai por chute do dono ou por uma trombada registrada no passo físico.
    if (match.control && match.control.id !== p.id) return;
    if (m.hold !== undefined && !throwing) return;
    if (match.holder && (!throwing || m.hold !== match.hold || m.match !== match.id || m.round !== match.round)) return;
    if (match.phase !== 'playing' || (!throwing && now() - entry.kickAt < 350) ||
      !Number.isFinite(m.dx) || !Number.isFinite(m.dy)) return;
    const length = Math.hypot(m.dx, m.dy);
    const distance = Math.hypot(entry.x - match.ball.x, entry.y - match.ball.y);
    if (length < 0.01 || length > 1.21 || distance > REACH) return;
    entry.kickAt = now();
    match.control = null;
    if (throwing) {
      match.holder = 0;
      match.ball.x = entry.x + m.dx / length * (BODY + RADIUS + 1);
      match.ball.y = entry.y + m.dy / length * (BODY + RADIUS + 1);
    }
    // Quanto mais colado na bola, mais forte o chute.
    const contact = BODY + RADIUS;
    const far = Math.min(1, Math.max(0, (distance - contact) / (REACH - contact)));
    const power = throwing ? KICK_MAX : KICK_MAX - far * (KICK_MAX - KICK_MIN);
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
      return emit(p, queuePacket(p.id));
    }
    if (m.op === 'join') {
      if (m.version !== 1) return error(p, 'Atualize o jogo para jogar futebol.');
      if (match) return emit(p, state(match));
      if (!Number.isInteger(m.team) || m.team < 0 || m.team > 1 || typeof m.position !== 'string' || !Object.hasOwn(POSITIONS, m.position)) {
        return error(p, 'Escolha o time e a posição antes de entrar na fila.');
      }
      if (!eligible(p)) return error(p, 'Entre a pé, vivo e sem carregar itens, no mundo principal e fora do Spar.');
      const previous = queue.get(p.id);
      const samePosition = previous && previous.team === m.team && previous.position === m.position;
      const slot = m.slot === undefined ? (samePosition ? previous.slot : freeSlot(queue.entries(), m.team, m.position, p.id)) : m.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot >= POSITIONS[m.position]) return error(p, 'Essa vaga não está disponível nesse time.');
      const occupied = [...queue.entries()].some(([id, choice]) => id !== p.id && choice.team === m.team && choice.position === m.position && choice.slot === slot);
      if (occupied) return error(p, 'Essa vaga acabou de ser ocupada. Escolha outra posição no campo.');
      if (samePosition && previous.slot === slot) return emit(p, queuePacket(p.id));
      queue.set(p.id, { team: m.team, position: m.position, slot });
      queueState();
      return;
    }
    if (!match) return;
    if ((m.match !== undefined && m.match !== match.id) || (m.round !== undefined && m.round !== match.round)) return;
    if (m.op === 'position') {
      if (m.match !== match.id || m.round !== match.round || typeof m.position !== 'string' ||
          !Object.hasOwn(POSITIONS, m.position) || match.phase === 'finished') return;
      const entry = match.entries.get(p.id);
      if (entry.position === m.position && (m.slot === undefined || m.slot === entry.slot)) return emit(p, state(match));
      if (match.holder === p.id) return error(p, 'Lance a bola antes de trocar de posição.');
      const slot = m.slot === undefined ? freeSlot(match.entries.entries(), entry.team, m.position, p.id) : m.slot;
      if (!Number.isInteger(slot) || slot < 0 || slot >= POSITIONS[m.position]) return error(p, 'Essa vaga não está disponível no seu time.');
      const occupied = [...match.entries.values()].some(other => other.id !== p.id && other.team === entry.team && other.position === m.position && other.slot === slot);
      if (occupied) return error(p, 'Essa vaga já está ocupada no seu time.');
      entry.position = m.position;
      entry.slot = slot;
      snapshot(match);
      return;
    }
    if (m.op === 'keeper') return error(p, 'Escolha a posição no menu do futebol.');
    if (m.op === 'kick') {
      if (match.holder && match.holder !== p.id) return;
      if (m.after === undefined) return kick(p, match, m);
      const entry = match.entries.get(p.id);
      if (match.phase !== 'playing' || !Number.isSafeInteger(m.after) || m.after < entry.ack ||
        m.after > entry.received || !Number.isFinite(m.dx) || !Number.isFinite(m.dy) ||
        Math.hypot(m.dx, m.dy) < 0.01 || Math.hypot(m.dx, m.dy) > 1.21) return;
      entry.pendingKick = { after: m.after, dx: m.dx, dy: m.dy, hold: m.hold, match: m.match, round: m.round };
      return;
    }
    if (m.op === 'move' && Number.isFinite(m.dx) && Number.isFinite(m.dy) && Math.hypot(m.dx, m.dy) <= 1.21) {
      const entry = match.entries.get(p.id);
      if (m.seq !== undefined) {
        // Cada seq descreve 50 ms. A simulação consome um comando por passo.
        if (match.phase !== 'playing' || m.match !== match.id || m.round !== match.round ||
          !Number.isSafeInteger(m.seq) || m.seq !== entry.received + 1 || m.seq > 1e9 || entry.inputs.length >= 20) return;
        const facing = m.facing;
        if (facing !== undefined && (!facing || typeof facing !== 'object' || Array.isArray(facing) ||
          !Number.isFinite(facing.x) || !Number.isFinite(facing.y) || Math.hypot(facing.x, facing.y) > 1.21)) return;
        entry.sequenced = true;
        entry.received = m.seq;
        entry.inputs.push({ seq: m.seq, dx: m.dx, dy: m.dy,
          facing: facing === undefined ? null : { x: facing.x, y: facing.y } });
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
      return 'dribble';
    }
    ball.x = px + nx * minimum;
    ball.y = py + ny * minimum;
    if (normal >= 0) return 'contact'; // já está se afastando
    const tangent = rvx * -ny + rvy * nx;
    const outward = -normal * bounce;
    const slide = tangent * (1 - GRIP);
    ball.vx = pvx + nx * outward + -ny * slide;
    ball.vy = pvy + ny * outward + nx * slide;
    return 'contact';
  }

  function collidePosts(ball) {
    const middle = FIELD.y + FIELD.h / 2;
    let contact = false;
    for (const x of [FIELD.x, FIELD.x + FIELD.w]) {
      if (collide(ball, x, middle - FIELD.goal / 2, 0, 0, POST, BOUNCE_POST)) contact = true;
      if (collide(ball, x, middle + FIELD.goal / 2, 0, 0, POST, BOUNCE_POST)) contact = true;
    }
    return contact;
  }

  // A posse não expira por distância, curva, parada ou parede: a bola acompanha os pés.
  function steerDribble(match, body, t, dt) {
    const control = match.control;
    if (!body || !control) {
      match.control = null;
      return false;
    }
    let dx = control.dx;
    let dy = control.dy;
    const facingX = body.facing && Math.hypot(body.facing.x, body.facing.y) > 1e-6 ? body.facing.x : body.vx;
    const facingY = body.facing && Math.hypot(body.facing.x, body.facing.y) > 1e-6 ? body.facing.y : body.vy;
    const facingLength = Math.hypot(facingX, facingY);
    if (facingLength > 1e-6) {
      const desiredX = facingX / facingLength;
      const desiredY = facingY / facingLength;
      const angle = Math.atan2(dx * desiredY - dy * desiredX, dx * desiredX + dy * desiredY);
      const turn = Math.max(-TURN_RATE * dt, Math.min(TURN_RATE * dt, angle));
      const cos = Math.cos(turn);
      const sin = Math.sin(turn);
      const previousX = dx;
      dx = previousX * cos - dy * sin;
      dy = previousX * sin + dy * cos;
    }
    const ball = match.ball;
    ball.x = body.x0 + (body.x1 - body.x0) * t + dx * CONTROL_DISTANCE;
    ball.y = body.y0 + (body.y1 - body.y0) * t + dy * CONTROL_DISTANCE;
    ball.vx = body.vx;
    ball.vy = body.vy;
    control.dx = dx;
    control.dy = dy;
    return true;
  }

  function bodyPoint(body, t) {
    return { x: body.x0 + (body.x1 - body.x0) * t, y: body.y0 + (body.y1 - body.y0) * t };
  }

  // Uma trombada só conta na transição separado → encostado. Assim dois corpos que
  // continuam sobrepostos não ficam roubando a posse um do outro a cada subpasso.
  function stealOnBump(match, motion, t) {
    const previous = match.contacts || new Set();
    const touching = new Set();
    const points = motion.map(body => ({ body, ...bodyPoint(body, t) }));
    let candidate = null;
    for (let i = 0; i < points.length; i++) {
      for (let j = i + 1; j < points.length; j++) {
        const a = points[i];
        const b = points[j];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance > BODY * 2) continue;
        const key = [a.body.id, b.body.id].sort((x, y) => x - y).join(':');
        touching.add(key);
        if (!match.control || previous.has(key)) continue;
        let challenger = null;
        if (a.body.id === match.control.id) challenger = b;
        if (b.body.id === match.control.id) challenger = a;
        if (challenger && (!candidate || distance < candidate.distance)) candidate = { ...challenger, distance };
      }
    }
    match.contacts = touching;
    if (!candidate) return;
    const body = candidate.body;
    let dx = body.facing ? body.facing.x : body.vx;
    let dy = body.facing ? body.facing.y : body.vy;
    let length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      dx = match.ball.x - candidate.x;
      dy = match.ball.y - candidate.y;
      length = Math.hypot(dx, dy);
    }
    if (length < 1e-6) { dx = body.team === 0 ? 1 : -1; dy = 0; length = 1; }
    match.control = { id: body.id, dx: dx / length, dy: dy / length };
  }

  // Bolas lentas são dominadas no contato. Chutes rápidos continuam rebatendo no corpo.
  function acquireControl(match, motion, t) {
    const ball = match.ball;
    if (Math.hypot(ball.vx, ball.vy) > SPEED * 1.5) return false;
    let candidate = null;
    for (const body of motion) {
      const point = bodyPoint(body, t);
      const distance = Math.hypot(ball.x - point.x, ball.y - point.y);
      if (distance > BODY + RADIUS || (candidate && distance >= candidate.distance)) continue;
      candidate = { body, ...point, distance };
    }
    if (!candidate) return false;
    const body = candidate.body;
    let dx = ball.x - candidate.x;
    let dy = ball.y - candidate.y;
    let length = Math.hypot(dx, dy);
    if (length < 1e-6) {
      dx = body.facing ? body.facing.x : body.vx;
      dy = body.facing ? body.facing.y : body.vy;
      length = Math.hypot(dx, dy);
    }
    if (length < 1e-6) { dx = body.team === 0 ? 1 : -1; dy = 0; length = 1; }
    match.control = { id: body.id, dx: dx / length, dy: dy / length };
    steerDribble(match, body, t, 0);
    return true;
  }

  function stepBall(match, motion) {
    if (match.holder && updateHeldBall(match)) return;
    const ball = match.ball;
    const dt = STEP / 1000 / SUBSTEPS;
    for (let i = 1; i <= SUBSTEPS; i++) {
      const t = i / SUBSTEPS;
      stealOnBump(match, motion, t);
      const carrier = match.control && motion.find(body => body.id === match.control.id);
      if (match.control && !carrier) match.control = null;
      if (carrier && steerDribble(match, carrier, t, dt)) {
        // Também é possível conduzir até dentro do gol; a rodada reinicia normalmente.
        const mouth = Math.abs(ball.y - FIELD.y - FIELD.h / 2) <= FIELD.goal / 2 - RADIUS;
        if (mouth && ball.x > FIELD.x + FIELD.w) { goal(match, 0); return; }
        if (mouth && ball.x < FIELD.x) { goal(match, 1); return; }
        continue;
      }
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      if (catchBall(match, motion, t)) return;
      if (acquireControl(match, motion, t)) continue;
      for (const body of motion) {
        const point = bodyPoint(body, t);
        collide(ball, point.x, point.y, body.vx, body.vy, BODY, BOUNCE_BODY);
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
    // A bola protegida usa a velocidade do dono e não sofre atrito de rolamento.
    if (match.control) return;
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
      const limits = match.holder === entry.id ? keeperArea(entry.team) : FIELD;
      const speed = match.holder === entry.id || (match.control && match.control.id === entry.id) ? CONTROL_SPEED : SPEED;
      const targetX=Math.max(limits.x + 8, Math.min(limits.x + limits.w - 8, entry.x + dx * speed * STEP / 1000));
      const targetY=Math.max(limits.y + 8, Math.min(limits.y + limits.h - 8, entry.y + dy * speed * STEP / 1000));
      if(!blocksMove(p,{x:entry.x,y:entry.y},{x:targetX,y:entry.y}))entry.x=targetX;
      if(!blocksMove(p,{x:entry.x,y:entry.y},{x:entry.x,y:targetY}))entry.y=targetY;
      p.x = entry.x;
      p.y = entry.y;
      p.uT = now();
      if (dx || dy) {
        entry.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'Right' : 'Left') : (dy > 0 ? 'Down' : 'Up');
      }
      p.an = (dx || dy ? 'Run_' : 'Idle_') + (entry.facing || (entry.team === 0 ? 'Right' : 'Left'));
      // Velocidade real (já limitada pelas bordas) para a colisão com a bola.
      motion.push({ id: entry.id, keeper: entry.position === 'keeper', team: entry.team, x0, y0, x1: entry.x, y1: entry.y, facing: input ? input.facing : null,
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
    for (const id of queue.keys()) if (!eligible(players.get(id))) {
      queue.delete(id);
      emit(players.get(id), queuePacket(id));
      changed = true;
    }
    if (changed) queueState();
    if (queueUntil && (queue.size === TEAM_SIZE * 2 || time >= queueUntil)) start([...queue.keys()]);
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
