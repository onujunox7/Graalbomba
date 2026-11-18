'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { WebSocket, WebSocketServer } = require('ws');
const createTelevisions = require('./televisions');
const { readSegments } = require('./television_media');

async function waitFor(predicate, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('TV fixture timeout');
}

async function createFixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aetheria-tv-'));
  execFileSync(require('ffmpeg-static'), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=16', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '20', '-c:v', 'libtheora', '-q:v', '5', '-g', '64', '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-c:a', 'libvorbis', '-q:a', '2', '-f', 'segment', '-segment_time', '4', '-reset_timestamps', '1',
    '-segment_format', 'ogg', '-segment_list', path.join(directory, 'segments.csv'), path.join(directory, '%06d.ogv')
  ], { timeout: 20000, windowsHide: true });
  const segments = readSegments(directory);
  const sessions = new Map();
  let serial = 0;
  const media = {
    async open() {
      const key = String(++serial).padStart(32, '0');
      const session = { key, title: 'TV teste • imagem e som', live: false, error: '', finished: true, segments };
      sessions.set(key, session);
      return session;
    },
    poll: key => sessions.get(key),
    stop: key => sessions.delete(key),
    file(key, index) {
      const segment = sessions.get(key)?.segments.find(item => item.index === index);
      return segment ? { path: path.join(directory, String(index).padStart(6, '0') + '.ogv'), size: segment.bytes } : null;
    }
  };
  const players = new Map();
  const send = (ws, data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };
  const televisions = createTelevisions({ players, media, send, authorized: p => p.allowed });
  const source = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const routeStart = source.indexOf("  if (url.startsWith('/api/television/video/'))");
  const routeEnd = source.indexOf("  if (url.startsWith('/api/speaker/audio/'))", routeStart);
  const line = source.split('\n').find(value => value.includes("if (m.t === 'television')"));
  if (routeStart < 0 || routeEnd < 0 || !line) throw new Error('Production TV routes missing');
  const route = vm.runInNewContext('(req,res)=>{const url=(req.url||"/").split("?")[0];\n' +
    source.slice(routeStart, routeEnd) + '\nres.writeHead(404);res.end();}', { televisions, fs });
  const dispatch = vm.runInNewContext('(m,p,ws)=>{' + line + '}', { televisions, sendTo: send });
  const server = http.createServer(route);
  const wss = new WebSocketServer({ server });
  const clients = [];
  let id = 0;
  wss.on('connection', ws => {
    const p = { id: ++id, ws, role: id === 1 ? 1 : 0, allowed: true, ok: true, x: 6704, y: 17104 };
    players.set(p.id, p);
    ws.on('message', bytes => {
      let message;
      try { message = JSON.parse(bytes); } catch { return; }
      dispatch(message, p, ws);
    });
    ws.on('close', () => players.delete(p.id));
    send(ws, { t: 'id', id: p.id, v: 3, economy: 1 });
    send(ws, { t: 'role', r: p.role });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const timer = setInterval(() => televisions.tick(), 100);
  async function connect() {
    const ws = new WebSocket('ws://127.0.0.1:' + server.address().port);
    const messages = [];
    clients.push(ws);
    ws.on('message', bytes => messages.push(JSON.parse(bytes)));
    await once(ws, 'open');
    const packet = await waitFor(() => messages.find(m => m.t === 'id'));
    return { id: packet.id, ws, messages, send: data => ws.send(JSON.stringify({ t: 'television', ...data })),
      state: () => messages.findLast(m => m.t === 'television' && m.op === 'state') };
  }
  return { televisions, players, connect, port: server.address().port,
    async close() {
      clearInterval(timer);
      televisions.close();
      for (const ws of [...clients, ...wss.clients]) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
      if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('aetheria-tv-')) fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

module.exports = { createFixture, waitFor };
if (require.main === module && process.argv.includes('--serve')) {
  createFixture().then(fixture => {
    fs.writeFileSync(process.env.TV_PORT_FILE, String(fixture.port));
    console.log('TV_FIXTURE_READY');
    process.on('SIGTERM', async () => { await fixture.close(); process.exit(0); });
    process.on('message', async message => { if (message === 'stop') { await fixture.close(); process.exit(0); } });
    setTimeout(async () => { await fixture.close(); process.exit(0); }, 90000).unref();
  }).catch(() => { console.error('TV fixture failed'); process.exit(1); });
}
