/* Graal Online — servidor
 *  - HTTP: serve o jogo + /graal-config.json (config compartilhada) + PUT /api/config/:chave (admin)
 *  - WebSocket (protocolo v3): jogadores, skins, equipamentos e chat
 *
 *  Variáveis de ambiente:
 *    ADMIN_TOKEN  senha de quem pode salvar mudanças do editor no servidor (OBRIGATÓRIA em produção)
 *    DATA_DIR     pasta onde a config é gravada (padrão ./data). Em hospedagem, aponte p/ um disco persistente.
 *    PORT         porta (padrão 3000)
 *    KICK_MINUTES quanto tempo quem foi expulso fica sem conseguir voltar (padrão 5)
 *
 *  Spawns de monstros: o menu 👾 (tecla N) de admins/dono grava a lista em DATA_DIR/graal-spawns.json; todos os jogadores recebem a mesma lista ao entrar.
 *
 *  Cargos (painel 🛡 no jogo):
 *    DONO   quem abre o jogo com ?admin=ADMIN_TOKEN (o mesmo token do editor). Pode tudo, inclusive dar/tirar o cargo de admin e banir.
 *    ADMIN  jogador a quem o dono deu o cargo (fica salvo em DATA_DIR/graal-admins.json, preso à identidade do navegador dele).
 *           Pode: avisar todos, expulsar, silenciar, teleportar, curar, dar gralats/níveis, renascer monstros.
 *    Toda permissão é checada AQUI no servidor; o cliente só mostra o painel.
 */
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');

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
const KICK_MS = Math.max(0, +(process.env.KICK_MINUTES || 5)) * 60 * 1000, KICKED = new Map(); // uid -> até quando está bloqueado
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 32);
function ownerTokenOk(token, req) {
  if (!ADMIN) return isLoop(req); // sem ADMIN_TOKEN: só o localhost é dono
  const a = Buffer.from(String(token || '')), b = Buffer.from(ADMIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- spawns de monstros: compartilhados e persistentes ---------------- */
const SP_FILE = path.join(DATA_DIR, 'graal-spawns.json'), SP_MAX = 2000, SP_MAXR = 5000;
let SP = { add: [], rem: [], nid: 1 }; // add: monstros colocados por admins ({id,k,x,y,lv}); rem: monstros do mapa removidos (chave "x,y" do ponto de nascimento)
const spKey = s => typeof s === 'string' && /^-?\d{1,7},-?\d{1,7}$/.test(s);
function spClean(a) { // devolve o spawn limpo ({k,x,y,lv}) ou null se for inválido
  if (!a || typeof a !== 'object' || typeof a.k !== 'string' || !/^[A-Za-z0-9_]{1,24}$/.test(a.k)) return null;
  const x = Math.round(+a.x), y = Math.round(+a.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 200000 || y > 200000) return null;
  return { k: a.k, x, y, lv: Math.max(1, Math.min(100, (+a.lv | 0) || 1)) };
}
try {
  const o = JSON.parse(fs.readFileSync(SP_FILE, 'utf8'));
  if (o && Array.isArray(o.add) && Array.isArray(o.rem)) {
    const seen = new Set();
    SP.add = o.add.map(a => { const c = spClean(a), id = a && +a.id; if (!c || !(id > 0) || seen.has(id)) return null; seen.add(id); c.id = id; return c }).filter(Boolean).slice(0, SP_MAX);
    SP.rem = [...new Set(o.rem.filter(spKey))].slice(0, SP_MAXR);
    SP.nid = SP.add.reduce((m, a) => Math.max(m, a.id + 1), Math.max(1, +o.nid || 1));
    console.log('Spawns carregados:', SP.add.length, 'adicionados,', SP.rem.length, 'removidos');
  }
} catch (e) { }
function saveSP() { try { const t = SP_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(SP)); fs.renameSync(t, SP_FILE) } catch (e) { console.error('Falha ao gravar spawns:', e.message) } }
const spAll = () => ({ t: 'spall', add: SP.add, rem: SP.rem });
const spBroadcast = o => { const s = JSON.stringify(o); wss.clients.forEach(c => sendTo(c, s)) };

/* ---------------- contas (login com Discord, OAuth2) ----------------
 *  Variáveis: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET (texto longo e aleatório), PUBLIC_URL (opcional, ex.: https://graalbomba.onrender.com)
 *  Redirect no portal do Discord: <PUBLIC_URL>/auth/discord/callback
 *  A conta guarda uma cópia das chaves de progresso do navegador (nível, gralats, skin, equipamentos...) em DATA_DIR/graal-accounts.json.
 *  Sem as variáveis, o login fica desligado e o jogo funciona como antes (visitante). */
const DC_ID = process.env.DISCORD_CLIENT_ID || '', DC_SECRET = process.env.DISCORD_CLIENT_SECRET || '', SES_SECRET = process.env.SESSION_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const AUTH_ON = !!(DC_ID && DC_SECRET && SES_SECRET);
const ACC_KEYS = ['graal_nick', 'graal_classic_save_v1', 'graal_classic_zelda_v1', 'graal_skin_v2', 'graal_equip_v1', 'graal_playtime', 'graal_custom_v1'];
const ACC_MAX = 600000, SES_DAYS = 30;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
if (!DATABASE_URL) throw new Error('DATABASE_URL não configurada no Render; contas Discord precisam do PostgreSQL.');
const pgPool = new Pool({ connectionString: DATABASE_URL, ssl: /render\.com|neon\.tech|supabase\.co/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
let ACC = {}, accT = null, accDirty = new Set(); // cache em memória; persistência oficial no PostgreSQL
async function initAccountsDB() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_accounts (
    discord_id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, created_at BIGINT NOT NULL,
    last_seen BIGINT NOT NULL, data JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  const r = await pgPool.query('SELECT discord_id, name, avatar, created_at, last_seen, data FROM graal_accounts');
  for (const row of r.rows) ACC[row.discord_id] = { id: row.discord_id, name: row.name, av: row.avatar, at: Number(row.created_at), last: Number(row.last_seen), data: row.data || {} };
  console.log('PostgreSQL: contas Discord carregadas:', r.rowCount);
}
async function flushACC() {
  accT = null;
  const ids = [...accDirty]; accDirty.clear();
  for (const id of ids) {
    const a = ACC[id]; if (!a) continue;
    try { await pgPool.query(`INSERT INTO graal_accounts (discord_id,name,avatar,created_at,last_seen,data)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT (discord_id) DO UPDATE SET
      name=EXCLUDED.name, avatar=EXCLUDED.avatar, last_seen=EXCLUDED.last_seen, data=EXCLUDED.data`,
      [a.id, a.name, a.av, a.at, a.last, JSON.stringify(a.data || {})]);
      const pl = ACTIVE_ACC.get(id); if (pl) sendTo(pl.ws, { t: 'svok', at: Date.now() }); }
    catch (e) { console.error('Falha ao salvar conta no PostgreSQL:', e.message); accDirty.add(id);
      const pl = ACTIVE_ACC.get(id); if (pl) sendTo(pl.ws, { t: 'sverr', m: String(e.message).slice(0, 140) }); }
  }
  if (accDirty.size && !accT) accT = setTimeout(() => flushACC().catch(e => console.error(e)), 3000);
}
const saveACC = id => { if (id) accDirty.add(String(id)); if (!accT) accT = setTimeout(() => flushACC().catch(e => console.error(e)), 1000) };
const sign = s => crypto.createHmac('sha256', SES_SECRET).update(s).digest('base64url');
const mkSession = id => { const p = Buffer.from(JSON.stringify({ id, exp: Date.now() + SES_DAYS * 864e5 })).toString('base64url'); return p + '.' + sign(p) };
const readCookie = (req, name) => { const c = (req.headers.cookie || '').split(/;\s*/).find(x => x.startsWith(name + '=')); try { return c ? decodeURIComponent(c.slice(name.length + 1)) : '' } catch (e) { return '' } };
const baseUrl = req => PUBLIC_URL || ((req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() + '://' + req.headers.host);
const ck = (req, name, val, sec) => name + '=' + encodeURIComponent(val) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + sec + (baseUrl(req).startsWith('https') ? '; Secure' : '');
function sessionOf(req) { // id da conta se o cookie de sessão for válido e assinado por nós
  if (!AUTH_ON) return null;
  const v = readCookie(req, 'gsid'), i = v.lastIndexOf('.'); if (i < 1) return null;
  const p = v.slice(0, i), a = Buffer.from(v.slice(i + 1)), b = Buffer.from(sign(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { const o = JSON.parse(Buffer.from(p, 'base64url').toString()); return o && o.exp > Date.now() && ACC[o.id] ? o.id : null } catch (e) { return null }
}
const avatarOf = a => a.av ? 'https://cdn.discordapp.com/avatars/' + a.id + '/' + a.av + '.png?size=64' : 'https://cdn.discordapp.com/embed/avatars/' + Number((BigInt(a.id) >> 22n) % 6n) + '.png';
const nickOf = n => String(n).replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12) || 'Jogador';
const accMsg = a => ({ t: 'acc', id: a.id, name: a.name, av: avatarOf(a), data: a.data || {} });
async function discordCallback(req, res) {
  const fail = why => { console.error('Login Discord falhou:', why); res.writeHead(302, { Location: '/?login=erro' }); res.end() };
  try {
    const q = new URL(req.url, 'http://x').searchParams, code = q.get('code'), st = q.get('state');
    if (!AUTH_ON || !code || !st || st !== readCookie(req, 'gst')) return fail('state/código inválido');
    const redirect = baseUrl(req) + '/auth/discord/callback';
    const tr = await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: DC_ID, client_secret: DC_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirect }) });
    if (!tr.ok) return fail('token ' + tr.status + ' ' + (await tr.text()).slice(0, 200));
    const tk = await tr.json();
    const ur = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + tk.access_token } });
    if (!ur.ok) return fail('users/@me ' + ur.status);
    const u = await ur.json();
    if (!/^\d{5,25}$/.test(String(u.id))) return fail('id inválido');
    const name = String(u.global_name || u.username || 'Jogador').slice(0, 32);
    const a = ACC[u.id] || (ACC[u.id] = { id: String(u.id), at: Date.now(), data: {} });
    a.name = name; a.av = u.avatar && /^[A-Za-z0-9_]+$/.test(u.avatar) ? u.avatar : null; a.last = Date.now();
    if (!a.data.graal_nick) a.data.graal_nick = nickOf(name); // conta nova: o nick inicial é o nome do Discord
    saveACC(a.id);
    res.writeHead(302, { Location: '/', 'Set-Cookie': [ck(req, 'gsid', mkSession(a.id), SES_DAYS * 86400), ck(req, 'gst', '', 0)] }); res.end();
  } catch (e) { fail(e.message) }
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
process.on('SIGTERM', async () => { if (saveT) flush(); if (accT) clearTimeout(accT); await flushACC(); await pgPool.end(); process.exit(0) });
process.on('SIGINT', async () => { if (saveT) flush(); if (accT) clearTimeout(accT); await flushACC(); await pgPool.end(); process.exit(0) });

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

  if (url === '/auth/discord' && req.method === 'GET') {
    if (!AUTH_ON) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Login com Discord não configurado no servidor.') }
    const st = crypto.randomBytes(16).toString('hex');
    const q = new URLSearchParams({ client_id: DC_ID, response_type: 'code', scope: 'identify', redirect_uri: baseUrl(req) + '/auth/discord/callback', state: st, prompt: 'none' });
    res.writeHead(302, { Location: 'https://discord.com/oauth2/authorize?' + q, 'Set-Cookie': ck(req, 'gst', st, 600) }); return res.end();
  }
  if (url === '/auth/discord/callback' && req.method === 'GET') return discordCallback(req, res);
  if (url === '/auth/logout') { const sid = sessionOf(req), pl = sid && ACTIVE_ACC.get(sid); if (pl) { if (pl.svTm) clearTimeout(pl.svTm); if (pl.svD) { applySv(pl, pl.svD); pl.svD = null } ACTIVE_ACC.delete(sid); pl.acc = null; sendTo(pl.ws, { t: 'out' }); setTimeout(() => { try { pl.ws.close() } catch (e) { } }, 200) } res.writeHead(302, { Location: '/?logout=1', 'Set-Cookie': [ck(req, 'gsid', '', 0), ck(req, 'gst', '', 0)], 'Cache-Control': 'no-store' }); return res.end() }
  if (url === '/api/acc' && req.method === 'GET') { // progresso da conta entregue ANTES do jogo começar (o navegador aplica antes de carregar o jogo)
    const id = sessionOf(req), a = id && ACC[id];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(a ? { on: true, id: a.id, data: a.data || {} } : { on: AUTH_ON }));
  }
  if (url === '/api/me' && req.method === 'GET') {
    const id = sessionOf(req), a = id && ACC[id];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ on: AUTH_ON, user: a ? { id: a.id, name: a.name, av: avatarOf(a) } : null }));
  }

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
// Uma única conexão ativa por conta Discord: impede que uma aba/dispositivo antigo
// sobrescreva o progresso mais recente depois de uma nova entrada.
const ACTIVE_ACC = new Map();
function applySv(p, d) { // grava na conta o progresso enviado pelo navegador
  const a = p.acc && ACC[p.acc];
  if (!a || ACTIVE_ACC.get(p.acc) !== p || !d || typeof d !== 'object') return;
  const out = {}; let n = 0;
  for (const k of ACC_KEYS) { const v = d[k]; if (typeof v === 'string') { n += v.length + k.length; out[k] = v } }
  if (n > ACC_MAX) { console.error('Save da conta ' + a.id + ' ignorado: grande demais (' + n + ' > ' + ACC_MAX + ')'); return }
  if (out.graal_nick !== undefined) out.graal_nick = out.graal_nick.slice(0, 12);
  p.svT = Date.now(); a.data = Object.assign(a.data || {}, out); a.last = p.svT; saveACC(a.id);
}
/* arbustos cortados (compartilhado entre todos): chave "x,y" (tile) -> quando volta a crescer (ms). Mundo: 1664 x 2752 tiles. */
const BUSH_MS = 15000, BUSH_MAX = 4000, BCUT = new Map();
setInterval(() => { const n = Date.now(); for (const [k, t] of BCUT) if (t <= n) BCUT.delete(k) }, 5000);
const PNG = s => typeof s === 'string' && s.length < 290000 && s.startsWith('data:image/png');
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, +v || 0));
const sendTo = (ws, o) => { if (ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)) };
/* batimento: derruba conexões mortas (aba fechada sem avisar, rede caiu) para o jogador sumir do mapa */
setInterval(() => { for (const c of wss.clients) { if (c.isAlive === false) { try { c.terminate() } catch (e) { } continue } c.isAlive = false; try { c.ping() } catch (e) { } } }, 10000);
const others = (id, msg) => wss.clients.forEach(c => { if (c.pid !== id) sendTo(c, msg) });

wss.on('connection', (ws, req) => {
  const id = nid++; ws.pid = id; ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true });
  const p = { id, ws, x: 0, y: 0, nm: '?', an: 'Idle_2', al: 1, b: 0, h: 0, s: 0, sw: 0, ok: 0, bs: null, hs: null, e: null, lastChat: 0, bT: 0, bN: 0, svT: 0, acc: null,
    role: 0, uh: null, muted: 0, authFails: 0, cmdT: 0, spT: 0 };
  P.set(id, p);
  sendTo(ws, { t: 'id', id, v: 3 });
  sendTo(ws, spAll()); // spawns de monstros (iguais para todos)
  { const now = Date.now(), a = []; BCUT.forEach((t, k) => { if (t > now) { const q = k.split(','); a.push([+q[0], +q[1], t - now]) } }); if (a.length) sendTo(ws, { t: 'ball', a }) } // arbustos que estão cortados agora
  for (const o of P.values()) if (o.id !== id) { // quem entra agora já vê skin/equip de quem está online
    if (o.bs || o.hs) sendTo(ws, { t: 'k', id: o.id, bs: o.bs, hs: o.hs });
    if (o.e) sendTo(ws, { t: 'q', id: o.id, e: o.e });
  }

  const hiT = setTimeout(() => { if (!p.uh && ws.readyState === 1) { sendTo(ws, { t: 'kick', r: 'Recarregue a página (F5) para entrar no jogo.' }); setTimeout(() => ws.close(), 100) } }, 8000);
  ws.on('close', () => clearTimeout(hiT));
  const setRole = r => { p.role = r; sendTo(ws, { t: 'role', r }) };
  const note = x => sendTo(ws, { t: 'adm', note: x });
  const lists = () => sendTo(ws, { t: 'adm',
    admins: Object.entries(AD.admins).map(([k, v]) => ({ k, nm: v.nm })),
    bans: Object.entries(AD.bans).map(([k, v]) => ({ k, nm: v.nm })) });

  { // conectou com a sessão do Discord: a identidade (bans/admins) passa a ser a conta, e o progresso vem do servidor
    const sid = sessionOf(req);
    if (sid) {
      p.acc = sid; p.uh = sha('discord:' + sid);
      const ku = KICKED.get(p.uh);
      if (AD.bans[p.uh]) { sendTo(ws, { t: 'kick', r: 'Você está banido deste servidor.' }); setTimeout(() => ws.close(), 100) }
      else if (ku && ku > Date.now()) { sendTo(ws, { t: 'kick', r: 'Você foi expulso do servidor. Volte em ' + Math.ceil((ku - Date.now()) / 60000) + ' min.' }); setTimeout(() => ws.close(), 100) }
      else {
        KICKED.delete(p.uh);
        for (const o of P.values()) if (o !== p && o.acc === sid) { o.acc = null; sendTo(o.ws, { t: 'kick', r: 'Sua conta entrou em outro lugar.' }); setTimeout(() => o.ws.close(), 100) }
        ACTIVE_ACC.set(sid, p);
        setRole(AD.admins[p.uh] ? 1 : 0);
        sendTo(ws, accMsg(ACC[sid]));
      }
    }
  }

  ws.on('message', d => {
    let m; try { m = JSON.parse(d) } catch (e) { return }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hi') { // identidade do navegador (segredo aleatório; o servidor só guarda o hash)
      if (p.uh || typeof m.uid !== 'string' || !/^[a-f0-9]{32}$/.test(m.uid)) return;
      p.uh = sha(m.uid);
      for (const o of P.values()) if (o !== p && o.uh === p.uh && !o.acc) { sendTo(o.ws, { t: 'dup' }); setTimeout(() => { try { o.ws.close() } catch (e) { } }, 100); P.delete(o.id); others(o.id, { t: 'l', id: o.id }) } // mesmo navegador já online como visitante: remove o antigo
      if (AD.bans[p.uh]) { sendTo(ws, { t: 'kick', r: 'Você está banido deste servidor.' }); setTimeout(() => ws.close(), 100); return }
      const ku = KICKED.get(p.uh);
      if (ku && ku > Date.now()) { sendTo(ws, { t: 'kick', r: 'Você foi expulso do servidor. Volte em ' + Math.ceil((ku - Date.now()) / 60000) + ' min.' }); setTimeout(() => ws.close(), 100); return }
      KICKED.delete(p.uh);
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
      if (c === 'kick') {
        if (tg.uh && KICK_MS) KICKED.set(tg.uh, Date.now() + KICK_MS);
        sendTo(tg.ws, { t: 'kick', r: 'Você foi expulso por um admin.' + (KICK_MS ? ' Só poderá voltar em ' + Math.max(1, Math.round(KICK_MS / 60000)) + ' min.' : '') });
        setTimeout(() => tg.ws.close(), 100); note(nameOf(tg) + ' expulso.'); return }
      if (c === 'ban') {
        if (!owner) return;
        if (!tg.uh) return note('Sem identidade para banir (cliente desatualizado). Use Expulsar.');
        AD.bans[tg.uh] = { nm: nameOf(tg), at: Date.now() }; saveAD(); sendTo(tg.ws, { t: 'kick', r: 'Você foi banido deste servidor.' }); setTimeout(() => tg.ws.close(), 100); note(nameOf(tg) + ' banido.'); return }
      return;
    }
    if (m.t === 'sps') { // edição dos spawns de monstros: só admin/dono; valida, grava no disco e avisa todo mundo
      if (p.role < 1) return;
      const now = Date.now(); if (now - p.spT < 40) return; p.spT = now;
      if (m.op === 'add') {
        const c = spClean(m.a); if (!c || SP.add.length >= SP_MAX) return;
        c.id = SP.nid++; SP.add.push(c); saveSP(); spBroadcast({ t: 'sp', op: 'add', a: c });
      } else if (m.op === 'del') {
        const id = +m.id, i = SP.add.findIndex(a => a.id === id); if (i < 0) return;
        SP.add.splice(i, 1); saveSP(); spBroadcast({ t: 'sp', op: 'del', id });
      } else if (m.op === 'rem') {
        if (!spKey(m.key) || SP.rem.includes(m.key) || SP.rem.length >= SP_MAXR) return;
        SP.rem.push(m.key); saveSP(); spBroadcast({ t: 'sp', op: 'rem', key: m.key });
      } else if (m.op === 'reset') {
        if (p.role < 2) return note('Só o dono pode restaurar os spawns padrão.');
        SP.add = []; SP.rem = []; saveSP(); spBroadcast({ t: 'sp', op: 'reset' });
      } else if (m.op === 'set') { // importação inicial: só vale enquanto o servidor ainda não tem nenhum spawn salvo
        if (SP.add.length || SP.rem.length) return;
        SP.add = (Array.isArray(m.add) ? m.add : []).slice(0, SP_MAX).map(spClean).filter(Boolean).map(c => { c.id = SP.nid++; return c });
        SP.rem = [...new Set((Array.isArray(m.rem) ? m.rem : []).filter(spKey))].slice(0, SP_MAXR);
        saveSP(); spBroadcast(spAll());
      }
      return;
    }
    if (m.t === 'sv') { // salva o progresso na conta; se vier rápido demais guarda o último e grava logo depois (não descarta)
      if (!p.acc || ACTIVE_ACC.get(p.acc) !== p || !m.d || typeof m.d !== 'object') return;
      const now = Date.now();
      if (now - p.svT < 2000) { p.svD = m.d; if (!p.svTm) p.svTm = setTimeout(() => { p.svTm = null; const d = p.svD; p.svD = null; applySv(p, d) }, 2050 - (now - p.svT)); return }
      p.svD = null; applySv(p, m.d); return;
    }
    if (m.t === 'bc') { // arbusto cortado: valida, guarda e avisa os outros (quem cortou já mostrou na própria tela)
      const x = m.x | 0, y = m.y | 0, now = Date.now();
      if (!p.ok || m.x !== x || m.y !== y || x < 0 || y < 0 || x >= 1664 || y >= 2752) return;
      if (now - p.bT > 1000) { p.bT = now; p.bN = 0 } if (++p.bN > 30) return;
      const k = x + ',' + y, t = BCUT.get(k);
      if ((t && t > now) || BCUT.size >= BUSH_MAX) return;
      BCUT.set(k, now + BUSH_MS); others(id, { t: 'bc', x, y, l: BUSH_MS }); return;
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
  ws.on('close', () => { if (p.svTm) clearTimeout(p.svTm); if (p.svD) { applySv(p, p.svD); p.svD = null } if (p.acc && ACTIVE_ACC.get(p.acc) === p) ACTIVE_ACC.delete(p.acc); P.delete(id); others(id, { t: 'l', id }) });
  ws.on('error', () => { });
});

setInterval(() => {
  const a = [...P.values()].filter(p => p.ok).map(p => ({ id: p.id, x: p.x, y: p.y, nm: p.nm, an: p.an, al: p.al, b: p.b, h: p.h, s: p.s, sw: p.sw, r: p.role }));
  if (!a.length) return;
  const msg = JSON.stringify({ t: 'st', p: a });
  wss.clients.forEach(c => sendTo(c, msg));
}, 100);

initAccountsDB().then(() => {
  srv.listen(PORT, () => {
    console.log('Graal Online em http://localhost:' + PORT);
    if (!ADMIN) console.log('AVISO: ADMIN_TOKEN não definido — só o localhost consegue salvar edições no servidor.');
  });
}).catch(e => { console.error('Falha ao iniciar PostgreSQL:', e); process.exit(1); });
