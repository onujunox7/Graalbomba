'use strict';
// Sockets e rota HTTP reais. As sessões de conta são isoladas do banco e da hospedagem.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket, WebSocketServer } = require('ws');
const createSpeakers = require('./speakers');
const { youtubeId, MAX_AUDIO } = require('./speaker_media');

async function createFixture({ adminId = 1, latency = 0 } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const wsStart = source.indexOf("  ws.on('message', d => {");
  const wsEnd = source.indexOf("  ws.on('close',", wsStart);
  const handler = source.slice(wsStart, wsEnd);
  const helperStart = source.indexOf('const AN_DIR =');
  const helperEnd = source.indexOf('setInterval(', helperStart);
  const { pstate, normAn } = vm.runInNewContext(source.slice(helperStart, helperEnd) + '\n({pstate,normAn});');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aetheria-speakers-'));
  let sample = process.env.SPEAKER_TEST_AUDIO_FILE;
  let duration = Number(process.env.SPEAKER_TEST_AUDIO_DURATION) || 19;
  if (!sample || !fs.existsSync(sample)) {
    sample = path.join(directory, 'sample.mp3');
    duration = 8;
    execFileSync(require('ffmpeg-static'), ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=8', '-ac', '1', '-ar', '44100', '-b:a', '96k', sample], { timeout: 15000, windowsHide: true });
  }
  const key = crypto.createHash('sha256').update(fs.readFileSync(sample)).digest('hex');
  const track = { id: 'jNQXAC9IVRw', key, title: 'Faixa de teste', duration, bytes: fs.statSync(sample).size };
  const cached = new Set();
  const players = new Map();
  const clients = [];
  const states = [];
  const send = (ws, data) => {
    const bytes = typeof data === 'string' ? data : JSON.stringify(data);
    const deliver = () => { if (ws.readyState === 1) ws.send(bytes); };
    if (latency) setTimeout(deliver, latency);
    else deliver();
  };
  const media = {
    maxBytes: MAX_AUDIO,
    async resolve(url) {
      if (youtubeId(url) !== track.id) throw new Error('Use o vídeo de teste no cenário isolado.');
      cached.add(key);
      return { ...track };
    },
    async matchSpotify(song){
      const result=song.title==='Segunda música'?{...track,id:'bbbbbbbbbbb',key:crypto.createHash('sha256').update('second:'+key).digest('hex')}:{...track};
      cached.add(result.key);return result;
    },
    file: value => cached.has(value) ? { path: sample, size: track.bytes } : null,
    prune: values => { if (!values.includes(key)) cached.delete(key); }
  };
  const speakers = createSpeakers({ players, send, media, authorized: p => p.allowed,
    loadPlaylist:async()=>({title:'Playlist de teste',tracks:[{id:'0'.repeat(22),title:'Primeira música',artist:'Primeiro artista',duration},{id:'1'.repeat(22),title:'Segunda música',artist:'Segundo artista',duration}]}),
    save: value => states.push(structuredClone(value)) });
  const routeStart = source.indexOf("  if (url.startsWith('/api/speaker/audio/'))");
  const routeEnd = source.indexOf('\n  // SITE PC:', routeStart);
  if (routeStart < 0 || routeEnd < 0 || wsStart < 0 || wsEnd < 0) throw new Error('Production routes missing');
  const route = vm.runInNewContext("(req,res) => { const url=(req.url||'/').split('?')[0];\n" +
    source.slice(routeStart, routeEnd) + "\nres.writeHead(404);res.end(); }", { speakers, fs });
  const server = http.createServer(route);
  const wss = new WebSocketServer({ server });
  let nextId = 1;
  const sameLine = source.split('\n').find(line => line.startsWith('const othersSame ='));
  wss.on('connection', ws => {
    const id = nextId++;
    if (process.argv.includes('--serve') && id >= 3) console.log(id === adminId ? 'SPEAKER_ADMIN_CONNECTED' : 'SPEAKER_LISTENER_CONNECTED');
    ws.pid = id; ws.pingMs = latency * 2;
    const p = { id, ws, role: id === adminId ? 1 : 0, allowed: true, ok: 1,
      x: 6704 + id, y: 17104, nm: 'Player ' + id, hp: 60, hm: 60,
      uh: 'isolated-speaker-session', economyClient: true, acc: 'fixture-' + id };
    players.set(id, p);
    const context = vm.createContext({ ws, p, id, speakers, sendTo: send, normAn,
      P: players, wss, pstate, Date, console, setTimeout, clearTimeout, SPAR_QUEUE: [], PFC: new Map(), CHAT: [],
      others: (sender, data) => { for (const q of players.values()) if (q.id !== sender) send(q.ws, data); },
      num: (v, lo, hi) => Math.max(lo, Math.min(hi, +v || 0)),
      economicRequest: async () => {}, economicSession: () => false, electHost() {},
      economy: { peek: () => ({ hats: [] }) }, canHearLocal: () => true,
      football: { has: () => false, handle() {}, disconnect() {} }, parties: { handle() {}, disconnect() {} },
      PNG: () => false, COLS: () => null
    });
    vm.runInContext(sameLine + '\n' + handler, context);
    ws.on('close', () => players.delete(id));
    send(ws, { t: 'id', id, v: 3, economy: 1 });
    send(ws, { t: 'role', r: p.role });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const timer = setInterval(() => speakers.tick(), 100);
  async function connect() {
    const ws = new WebSocket('ws://127.0.0.1:' + server.address().port);
    const messages = [];
    ws.on('message', bytes => messages.push(JSON.parse(bytes)));
    clients.push(ws);
    await once(ws, 'open');
    await waitFor(() => messages.find(m => m.t === 'id'));
    const id = messages.find(m => m.t === 'id').id;
    return { id, ws, messages, send: data => ws.send(JSON.stringify({ t: 'speaker', ...data })),
      state: () => messages.findLast(m => m.t === 'speaker' && m.op === 'state') };
  }
  return { server, speakers, players, track, states, connect, port: server.address().port,
    async close() {
      clearInterval(timer);
      for (const ws of clients) ws.terminate();
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
      if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('aetheria-speakers-')) fs.rmSync(directory, { recursive: true, force: true });
    } };
}

async function waitFor(predicate, timeout = 5000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for speaker fixture');
}

module.exports = { createFixture, waitFor };

if (require.main === module && process.argv.includes('--serve')) {
  createFixture({ adminId: 4, latency: 150 }).then(async fixture => {
    const near = await fixture.connect();
    const far = await fixture.connect();
    fixture.players.get(far.id).x = 10000;
    let blocked = false;
    let heard = false;
    near.ws.on('message', () => {
      const box = near.state()?.boxes[0];
      if (box && !blocked) { blocked = true; near.send({ op: 'volume', id: box.id, volume: 0, role: 2 }); }
      if (box?.playing && !heard) { heard = true; console.log('SPEAKER_NEAR_STATE playing=1'); }
    });
    far.ws.on('message', () => {
      if ((far.state()?.boxes.length || 0) > 0) console.error('SPEAKER_FAR_LEAK');
    });
    fs.writeFileSync(process.env.SPEAKER_PORT_FILE, String(fixture.port));
    console.log('SPEAKER_FIXTURE_READY');
    process.on('SIGTERM', async () => { await fixture.close(); process.exit(0); });
  }).catch(error => { console.error(error.message); process.exit(1); });
}
