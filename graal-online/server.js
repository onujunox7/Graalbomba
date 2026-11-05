/* Graal Online — servidor
 *  - HTTP: serve o jogo + /graal-config.json (config compartilhada) + PUT /api/config/:chave (admin)
 *  - WebSocket (protocolo v3): jogadores, skins, equipamentos e chat
 *
 *  Variáveis de ambiente:
 *    ADMIN_TOKEN  senha de quem pode salvar mudanças do editor no servidor (OBRIGATÓRIA em produção)
 *    DATA_DIR     pasta onde a config é gravada (padrão ./data). Em hospedagem, aponte p/ um disco persistente.
 *    PORT         porta (padrão 3000)
 *
 *  Cargos (painel 🛡 no jogo):
 *    DONO   quem abre o jogo com ?admin=ADMIN_TOKEN (o mesmo token do editor). Pode tudo, inclusive dar/tirar o cargo de admin e banir.
 *    ADMIN  jogador a quem o dono deu o cargo (fica salvo em DATA_DIR/graal-admins.json, preso à identidade do navegador dele).
 *           Pode: avisar todos, expulsar, silenciar, teleportar, curar, dar gralats/níveis, renascer monstros.
 *    Toda permissão é checada AQUI no servidor; o cliente só mostra o painel.
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

/* ---------------- cargos: admins e banidos (persistentes) ---------------- */
const ADM_FILE = path.join(DATA_DIR, 'graal-admins.json');
let AD = { admins: {}, bans: {} };
try { const o = JSON.parse(fs.readFileSync(ADM_FILE, 'utf8')); if (o && typeof o === 'object') AD = { admins: o.admins || {}, bans: o.bans || {} } } catch (e) { }
function saveAD() { try { const t = ADM_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(AD)); fs.renameSync(t, ADM_FILE) } catch (e) { console.error('Falha ao gravar admins:', e.message) } }
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
function ownerTokenOk(token, req) {
  if (!ADMIN) return isLoop(req); // sem ADMIN_TOKEN: só o localhost é dono
  const a = Buffer.from(String(token || '')), b = Buffer.from(ADMIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

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

wss.on('connection', (ws, req) => {
  const id = nid++; ws.pid = id;
  const p = { id, ws, x: 0, y: 0, nm: '?', an: 'Idle_2', al: 1, b: 0, h: 0, s: 0, sw: 0, ok: 0, bs: null, hs: null, e: null, lastChat: 0,
    role: 0, uh: null, muted: 0, authFails: 0, cmdT: 0 };
  P.set(id, p);
  sendTo(ws, { t: 'id', id, v: 3 });
  for (const o of P.values()) if (o.id !== id) { // quem entra agora já vê skin/equip de quem está online
    if (o.bs || o.hs) sendTo(ws, { t: 'k', id: o.id, bs: o.bs, hs: o.hs });
    if (o.e) sendTo(ws, { t: 'q', id: o.id, e: o.e });
  }

  const setRole = r => { p.role = r; sendTo(ws, { t: 'role', r }) };
  const note = x => sendTo(ws, { t: 'adm', note: x });
  const lists = () => sendTo(ws, { t: 'adm',
    admins: Object.entries(AD.admins).map(([k, v]) => ({ k, nm: v.nm })),
    bans: Object.entries(AD.bans).map(([k, v]) => ({ k, nm: v.nm })) });

  ws.on('message', d => {
    let m; try { m = JSON.parse(d) } catch (e) { return }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hi') { // identidade do navegador (segredo aleatório; o servidor só guarda o hash)
      if (p.uh || typeof m.uid !== 'string' || !/^[a-f0-9]{32}$/.test(m.uid)) return;
      p.uh = sha(m.uid);
      if (AD.bans[p.uh]) { sendTo(ws, { t: 'kick', r: 'Você está banido deste servidor.' }); setTimeout(() => ws.close(), 100); return }
      if (p.role < 2) setRole(AD.admins[p.uh] ? 1 : 0);
      return;
    }
    if (m.t === 'auth') { // dono: mesmo ADMIN_TOKEN do editor
      if (p.authFails >= 5) return;
      if (ownerTokenOk(m.token, req)) setRole(2);
      else { p.authFails++; if (p.authFails >= 5) ws.close() }
      return;
    }
    if (m.t === 'a') { // comandos do painel admin
      if (p.role < 1) return;
      const now = Date.now(); if (now - p.cmdT < 80) return; p.cmdT = now;
      const owner = p.role === 2, c = String(m.c || ''), tg = P.get(+m.id);
      const can = o => o && o !== p && (owner ? o.role < 2 : o.role < 1); // admin só mexe em jogador comum; dono em todos menos nele mesmo
      const nameOf = o => String(o.nm || '?');
      if (c === 'say') { const x = String(m.x || '').trim().slice(0, 100); if (!x) return; const out = JSON.stringify({ t: 'c', id: 0, nm: '📢 Aviso', x }); wss.clients.forEach(k => sendTo(k, out)); return }
      if (c === 'list') { if (owner) lists(); return }
      if (c === 'unban') { if (!owner || !AD.bans[m.k]) return; delete AD.bans[m.k]; saveAD(); lists(); note('Desbanido.'); return }
      if (c === 'deop') {
        const k = m.k || (tg && tg.uh);
        if (!owner || !k || !AD.admins[k]) return; delete AD.admins[k]; saveAD();
        for (const o of P.values()) if (o.uh === k && o.role === 1) { o.role = 0; sendTo(o.ws, { t: 'role', r: 0 }) }
        lists(); note('Cargo de admin removido.'); return }
      if (!tg) return note('Jogador não encontrado.');
      if (c === 'tp') { if (tg === p) return; sendTo(ws, { t: 'cmd', c: 'tp', x: tg.x, y: tg.y }); return }
      if (c === 'heal') { sendTo(tg.ws, { t: 'cmd', c: 'heal' }); note('Curou ' + nameOf(tg)); return }
      if (c === 'gl') { sendTo(tg.ws, { t: 'cmd', c: 'gl', v: num(m.v, 1, 100000) | 0 }); note('Gralats enviados para ' + nameOf(tg)); return }
      if (c === 'lvl') { sendTo(tg.ws, { t: 'cmd', c: 'lvl', v: num(m.v, 1, 50) | 0 }); note('Níveis enviados para ' + nameOf(tg)); return }
      if (c === 'mobs') { sendTo(tg.ws, { t: 'cmd', c: 'mobs' }); note('Monstros de ' + nameOf(tg) + ' renasceram'); return }
      if (c === 'op') {
        if (!owner || tg.role === 2) return;
        if (!tg.uh) return note('Esse jogador está com um cliente desatualizado (sem identidade). Peça para recarregar a página.');
        AD.admins[tg.uh] = { nm: nameOf(tg), at: Date.now() }; saveAD(); tg.role = 1; sendTo(tg.ws, { t: 'role', r: 1 });
        sendTo(tg.ws, { t: 'adm', note: 'Você virou ADMIN.' }); note(nameOf(tg) + ' agora é admin.'); return }
      if (!can(tg)) return note('Você não pode fazer isso com esse jogador.');
      if (c === 'bringto') { sendTo(tg.ws, { t: 'cmd', c: 'tp', x: p.x, y: p.y }); return }
      if (c === 'mute') { tg.muted = tg.muted ? 0 : 1; note(nameOf(tg) + (tg.muted ? ' silenciado.' : ' pode falar de novo.')); return }
      if (c === 'kick') { sendTo(tg.ws, { t: 'kick', r: 'Você foi expulso por um admin.' }); setTimeout(() => tg.ws.close(), 100); note(nameOf(tg) + ' expulso.'); return }
      if (c === 'ban') {
        if (!owner) return;
        if (!tg.uh) return note('Sem identidade para banir (cliente desatualizado). Use Expulsar.');
        AD.bans[tg.uh] = { nm: nameOf(tg), at: Date.now() }; saveAD(); sendTo(tg.ws, { t: 'kick', r: 'Você foi banido deste servidor.' }); setTimeout(() => tg.ws.close(), 100); note(nameOf(tg) + ' banido.'); return }
      return;
    }
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
      if (!x || p.muted || now - p.lastChat < 500) return; p.lastChat = now;
      const out = JSON.stringify({ t: 'c', id, nm: p.nm, x });
      wss.clients.forEach(c => sendTo(c, out)); // inclusive o remetente (o cliente espera o eco)
    }
  });
  ws.on('close', () => { P.delete(id); others(id, { t: 'l', id }) });
  ws.on('error', () => { });
});

setInterval(() => {
  const a = [...P.values()].filter(p => p.ok).map(p => ({ id: p.id, x: p.x, y: p.y, nm: p.nm, an: p.an, al: p.al, b: p.b, h: p.h, s: p.s, sw: p.sw, r: p.role }));
  if (!a.length) return;
  const msg = JSON.stringify({ t: 'st', p: a });
  wss.clients.forEach(c => sendTo(c, msg));
}, 100);

srv.listen(PORT, () => {
  console.log('Graal Online em http://localhost:' + PORT);
  if (!ADMIN) console.log('AVISO: ADMIN_TOKEN não definido — só o localhost consegue salvar edições no servidor.');
});
