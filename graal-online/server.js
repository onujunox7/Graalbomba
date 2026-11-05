/* Graal Online — servidor
 *  - HTTP: serve o jogo + /graal-config.json (config compartilhada) + PUT /api/config/:chave (admin)
 *  - WebSocket (protocolo v3): jogadores, skins, equipamentos e chat
 *
 *  Variáveis de ambiente:
 *    ADMIN_TOKEN  senha de quem pode salvar mudanças do editor no servidor (OBRIGATÓRIA em produção)
 *    DATA_DIR     pasta onde a config é gravada (padrão ./data). Em hospedagem, aponte p/ um disco persistente.
 *    PORT         porta (padrão 3000)
 */
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const ADMIN = process.env.ADMIN_TOKEN || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CFG_FILE = path.join(DATA_DIR, 'graal-config.json');
const BAK_FILE = path.join(DATA_DIR, 'graal-config.bak.json');
const INDEX = path.join(__dirname, 'public', 'index.html');
const MAX_BODY = 40 * 1024 * 1024;

/* chave da API -> validação do valor (sempre string, igual ao que o jogo guarda no localStorage) */
const jsonOk = s => { try { JSON.parse(s); return true } catch (e) { return false } };
const KEYS = {
  doors: jsonOk, map: jsonOk, tilesets: jsonOk, interior: jsonOk, levels: jsonOk,
  tsol: s => /^[01]{4096}$/.test(s)
};

/* ---------------- config persistente ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
let cfg = {};
(function load() {
  for (const f of [CFG_FILE, BAK_FILE, path.join(__dirname, 'public', 'graal-config.json')]) { // o último aproveita um "Exportar tudo" antigo
    try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); if (o && typeof o === 'object') { cfg = o; console.log('Config carregada de', f); return } } catch (e) { }
  }
})();

let cache = null, saveT = null, lastBak = 0;
const invalidate = () => { cache = null };
function getCache() {
  if (!cache) {
    const body = Buffer.from(JSON.stringify(cfg));
    cache = { body, gz: zlib.gzipSync(body), etag: '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"' };
  }
  return cache;
}
function flush() {
  saveT = null;
  try {
    if (fs.existsSync(CFG_FILE) && Date.now() - lastBak > 10 * 60 * 1000) { fs.copyFileSync(CFG_FILE, BAK_FILE); lastBak = Date.now() }
    const tmp = CFG_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg));
    fs.renameSync(tmp, CFG_FILE); // troca atômica: nunca fica arquivo pela metade
  } catch (e) { console.error('Falha ao gravar config:', e.message) }
}
const scheduleSave = () => { if (!saveT) saveT = setTimeout(flush, 300) };
process.on('SIGTERM', () => { if (saveT) flush(); process.exit(0) });
process.on('SIGINT', () => { if (saveT) flush(); process.exit(0) });

/* ---------------- HTTP ---------------- */
const isLoop = r => { const a = r.socket.remoteAddress || ''; return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') && !r.headers['x-forwarded-for'] };
function isAdmin(req) {
  const t = String(req.headers['x-admin-token'] || '');
  if (!ADMIN) return isLoop(req); // sem ADMIN_TOKEN só aceita escrita de localhost
  const a = Buffer.from(t), b = Buffer.from(ADMIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) };

const srv = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  if (url === '/graal-config.json' && req.method === 'GET') {
    const c = getCache();
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: c.etag };
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, h); return res.end() }
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(c.gz) }
    res.writeHead(200, h); return res.end(c.body);
  }

  const m = url.match(/^\/api\/config\/([a-z]+)$/);
  if (m) {
    if (req.method !== 'PUT') return send(res, 405, { ok: false, erro: 'use PUT' });
    const key = m[1];
    if (!KEYS[key]) return send(res, 404, { ok: false, erro: 'chave desconhecida' });
    if (!isAdmin(req)) { req.resume(); return send(res, 403, { ok: false, erro: 'token inválido' }) }
    let size = 0; const chunks = [];
    req.on('data', d => { size += d.length; if (size > MAX_BODY) { send(res, 413, { ok: false, erro: 'grande demais' }); req.destroy() } else chunks.push(d) });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')).v } catch (e) { return send(res, 400, { ok: false, erro: 'JSON inválido' }) }
      if (v === null) cfg[key] = null; // null = o editor apagou/restaurou o padrão
      else if (typeof v === 'string' && KEYS[key](v)) cfg[key] = v;
      else return send(res, 400, { ok: false, erro: 'valor inválido para ' + key });
      invalidate(); scheduleSave();
      const msg = JSON.stringify({ t: 'cfg', k: key });
      wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg) }); // avisa os jogadores online
      send(res, 200, { ok: true, etag: getCache().etag });
    });
    return;
  }

  fs.readFile(INDEX, (e, d) => {
    if (e) { res.writeHead(500); return res.end('erro') }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(d);
  });
});

/* ---------------- jogo (WebSocket, protocolo v3) ---------------- */
const wss = new WebSocketServer({ server: srv, maxPayload: 700 * 1024 });
let nid = 1; const P = new Map();
const PNG = s => typeof s === 'string' && s.length < 290000 && s.startsWith('data:image/png');
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, +v || 0));
const sendTo = (ws, o) => { if (ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)) };
const others = (id, msg) => wss.clients.forEach(c => { if (c.pid !== id) sendTo(c, msg) });

wss.on('connection', ws => {
  const id = nid++; ws.pid = id;
  const p = { id, x: 0, y: 0, nm: '?', an: 'Idle_2', al: 1, b: 0, h: 0, s: 0, sw: 0, ok: 0, bs: null, hs: null, e: null, lastChat: 0 };
  P.set(id, p);
  sendTo(ws, { t: 'id', id, v: 3 });
  for (const o of P.values()) if (o.id !== id) { // quem entra agora já vê skin/equip de quem está online
    if (o.bs || o.hs) sendTo(ws, { t: 'k', id: o.id, bs: o.bs, hs: o.hs });
    if (o.e) sendTo(ws, { t: 'q', id: o.id, e: o.e });
  }

  ws.on('message', d => {
    let m; try { m = JSON.parse(d) } catch (e) { return }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'u') {
      if (d.length > 400) return;
      p.x = num(m.x, -1e6, 1e6); p.y = num(m.y, -1e6, 1e6); p.nm = String(m.nm || '?').slice(0, 12);
      p.an = /^(Idle|Run|Attack)_[0-3]$/.test(m.an) ? m.an : 'Idle_2'; p.al = m.al == 1 ? 1 : .4;
      p.b = num(m.b, 0, 999) | 0; p.h = num(m.h, 0, 999) | 0; p.s = num(m.s, 0, 999) | 0; p.sw = m.sw ? 1 : 0; p.ok = 1;
    } else if (m.t === 'k') {
      p.bs = PNG(m.bs) ? m.bs : null; p.hs = PNG(m.hs) ? m.hs : null;
      others(id, { t: 'k', id, bs: p.bs, hs: p.hs });
    } else if (m.t === 'q') {
      if (!m.e || typeof m.e !== 'object' || d.length > 20000) return;
      p.e = { h: m.e.h, s: m.e.s, d: m.e.d };
      others(id, { t: 'q', id, e: p.e });
    } else if (m.t === 'c') {
      const x = String(m.x || '').trim().slice(0, 100), now = Date.now();
      if (!x || now - p.lastChat < 500) return; p.lastChat = now;
      const out = JSON.stringify({ t: 'c', id, nm: p.nm, x });
      wss.clients.forEach(c => sendTo(c, out)); // inclusive o remetente (o cliente espera o eco)
    }
  });
  ws.on('close', () => { P.delete(id); others(id, { t: 'l', id }) });
  ws.on('error', () => { });
});

setInterval(() => {
  const a = [...P.values()].filter(p => p.ok).map(p => ({ id: p.id, x: p.x, y: p.y, nm: p.nm, an: p.an, al: p.al, b: p.b, h: p.h, s: p.s, sw: p.sw }));
  if (!a.length) return;
  const msg = JSON.stringify({ t: 'st', p: a });
  wss.clients.forEach(c => sendTo(c, msg));
}, 100);

srv.listen(PORT, () => {
  console.log('Graal Online em http://localhost:' + PORT);
  if (!ADMIN) console.log('AVISO: ADMIN_TOKEN não definido — só o localhost consegue salvar edições no servidor.');
});
