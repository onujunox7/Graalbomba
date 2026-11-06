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
 *  Spawns de monstros: o menu 👾 (tecla N) de admins/dono grava a lista em PostgreSQL (tabela graal_kv); todos os jogadores recebem a mesma lista ao entrar.
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
let AD = { admins: {}, bans: {}, owners: {} }; // owners: contas Discord que já provaram ser o dono (token) e voltam como dono em qualquer navegador
try { const o = JSON.parse(fs.readFileSync(ADM_FILE, 'utf8')); if (o && typeof o === 'object') AD = { admins: o.admins || {}, bans: o.bans || {}, owners: o.owners || {} } } catch (e) { }
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
function spLoad(o) { // normaliza o objeto salvo ({add,rem,nid}) e carrega em SP; devolve true se era válido
  if (!(o && Array.isArray(o.add) && Array.isArray(o.rem))) return false;
  const seen = new Set();
  SP.add = o.add.map(a => { const c = spClean(a), id = a && +a.id; if (!c || !(id > 0) || seen.has(id)) return null; seen.add(id); c.id = id; return c }).filter(Boolean).slice(0, SP_MAX);
  SP.rem = [...new Set(o.rem.filter(spKey))].slice(0, SP_MAXR);
  SP.nid = SP.add.reduce((m, a) => Math.max(m, a.id + 1), Math.max(1, +o.nid || 1));
  return true;
}
try { spLoad(JSON.parse(fs.readFileSync(SP_FILE, 'utf8'))) } catch (e) { } // cópia local (só vale como migração/reserva; o oficial é o PostgreSQL)
/* PERSISTÊNCIA OFICIAL: PostgreSQL (tabela graal_kv, chave 'spawns'). O disco do Render some a cada reinício; o banco não. */
let spDirty = false, spBusy = false;
async function spFlush() {
  if (spBusy) return; spBusy = true;
  try {
    while (spDirty) {
      spDirty = false;
      try { await pgPool.query(`INSERT INTO graal_kv (k, v, updated_at) VALUES ('spawns', $1::jsonb, $2)
        ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = EXCLUDED.updated_at`, [JSON.stringify(SP), Date.now()]) }
      catch (e) { console.error('Falha ao gravar spawns no PostgreSQL:', e.message); spDirty = true; await new Promise(r => setTimeout(r, 3000)) }
    }
  } finally { spBusy = false }
}
async function initSpawnsDB() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_at BIGINT NOT NULL)`);
  const r = await pgPool.query(`SELECT v FROM graal_kv WHERE k = 'spawns'`);
  if (r.rowCount && spLoad(r.rows[0].v)) console.log('Spawns carregados do PostgreSQL:', SP.add.length, 'adicionados,', SP.rem.length, 'removidos');
  else if (SP.add.length || SP.rem.length) { console.log('Spawns migrados do arquivo para o PostgreSQL'); spDirty = true; await spFlush() }
  else console.log('Spawns: nenhum salvo ainda');
}
function saveSP() { // grava no banco (assíncrono, sem travar o jogo) e mantém uma cópia em arquivo
  spDirty = true; spFlush().catch(e => console.error(e));
  try { const t = SP_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(SP)); fs.renameSync(t, SP_FILE) } catch (e) { }
}
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
const ACC_KEYS = ['graal_nick', 'graal_classic_save_v1', 'graal_classic_zelda_v1', 'graal_skin_v2', 'graal_equip_v1', 'graal_playtime', 'graal_custom_v1', 'graal_pos_v1'];
const ACC_MAX = 600000, SES_DAYS = 30;
/* VISITANTE SALVO: quem não entrou com o Discord ganha uma conta de visitante (id aleatório num cookie de 1 ano, só neste navegador).
 * O progresso fica no PostgreSQL igual ao da conta Discord. Visitantes sem uso há GUEST_KEEP_DAYS dias são apagados. */
const GID_RE = /^g[a-f0-9]{32}$/, GUEST_DAYS = 365, GUEST_KEEP_DAYS = 90;
const newGid = () => 'g' + crypto.randomBytes(16).toString('hex');
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
if (!DATABASE_URL) throw new Error('DATABASE_URL não configurada no Render; contas Discord precisam do PostgreSQL.');
const pgPool = new Pool({ connectionString: DATABASE_URL, ssl: /render\.com|neon\.tech|supabase\.co/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
let ACC = {}, accT = null, accSlow = false, accDirty = new Set(); // cache em memória; persistência oficial no PostgreSQL
async function initAccountsDB() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_accounts (
    discord_id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, created_at BIGINT NOT NULL,
    last_seen BIGINT NOT NULL, data JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pgPool.query(`DELETE FROM graal_accounts WHERE discord_id LIKE 'g%' AND last_seen < $1`, [Date.now() - GUEST_KEEP_DAYS * 864e5]);
  const r = await pgPool.query('SELECT discord_id, name, avatar, created_at, last_seen, data FROM graal_accounts');
  for (const row of r.rows) ACC[row.discord_id] = { guest: GID_RE.test(row.discord_id), id: row.discord_id, name: row.name, av: row.avatar, at: Number(row.created_at), last: Number(row.last_seen), data: row.data || {} };
  console.log('PostgreSQL: contas carregadas (Discord + visitantes):', r.rowCount);
}
async function flushACC() {
  accT = null; accSlow = false;
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
/* slow: mudança só de posição (acontece o tempo todo) -> grava no banco no máximo a cada ~12 s; qualquer outra mudança grava em 1 s */
const saveACC = (id, slow) => { if (id) accDirty.add(String(id));
  if (accT && accSlow && !slow) { clearTimeout(accT); accT = null }
  if (!accT) { accSlow = !!slow; accT = setTimeout(() => flushACC().catch(e => console.error(e)), slow ? 12000 : 1000) } };
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
const guestOf = req => { const v = readCookie(req, 'ggid'); return GID_RE.test(v) ? v : null };
const ensureGuest = id => ACC[id] || (ACC[id] = { id, guest: true, name: 'Visitante', av: null, at: Date.now(), last: Date.now(), data: {} });
const avatarOf = a => a.guest ? 'https://cdn.discordapp.com/embed/avatars/0.png' : a.av ? 'https://cdn.discordapp.com/avatars/' + a.id + '/' + a.av + '.png?size=64' : 'https://cdn.discordapp.com/embed/avatars/' + Number((BigInt(a.id) >> 22n) % 6n) + '.png';
const nickOf = n => String(n).replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12) || 'Jogador';
const accMsg = a => ({ t: 'acc', guest: !!a.guest, id: a.id, name: a.name, av: avatarOf(a), data: a.data || {} });
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

/* ---------------- fotos de fundo do perfil (com moderação) ----------------
 *  O jogador envia a foto (JPEG reduzido pelo navegador, ou GIF original) por POST /api/pfbg.
 *  Ela fica PENDENTE: só o dono vê (no próprio navegador). Um admin/dono vê a foto no painel 🛡 e APROVA ou RECUSA.
 *  Só fotos aprovadas são entregues a outros jogadores (GET /api/pfbg/<id do jogador>, buscado só quando alguém abre o perfil).
 *  Admin/dono que envia foto já nasce aprovado. Persistência: PostgreSQL (tabela graal_pfbg). */
const PF_MAX = 1.6 * 1024 * 1024, PF_MAX_GIF = 4 * 1024 * 1024, PF_CACHE_MAX = 48 * 1024 * 1024;
const PF = new Map(); // uh -> { nm, mime, st: 'pend'|'ok'|'no', len, h, at }  (sem os bytes)
const PFD = new Map(); let pfBytes = 0; // cache LRU dos bytes: "uh:h" -> Buffer
const PF_RATE = new Map(); // uh -> [horários dos últimos envios]
async function initPfDB() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_pfbg (uh TEXT PRIMARY KEY, nm TEXT, mime TEXT NOT NULL, st TEXT NOT NULL, len INT NOT NULL, h TEXT NOT NULL, at BIGINT NOT NULL, data BYTEA NOT NULL)`);
  const r = await pgPool.query('SELECT uh, nm, mime, st, len, h, at FROM graal_pfbg');
  for (const o of r.rows) PF.set(o.uh, { nm: o.nm || '?', mime: o.mime, st: o.st, len: o.len, h: o.h, at: +o.at });
  console.log('Fotos de perfil:', PF.size, 'guardadas,', pfCount(), 'aguardando aprovação');
}
const pfCount = () => { let n = 0; for (const v of PF.values()) if (v.st === 'pend') n++; return n };
function pfSniff(b) { // confere os bytes do arquivo (não confia no Content-Type)
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b.toString('latin1', 1, 4) === 'PNG' && b[0] === 0x89) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}
async function pfData(uh) {
  const v = PF.get(uh); if (!v) return null;
  const key = uh + ':' + v.h, c = PFD.get(key);
  if (c) { PFD.delete(key); PFD.set(key, c); return c }
  const r = await pgPool.query('SELECT data FROM graal_pfbg WHERE uh = $1', [uh]);
  if (!r.rowCount) return null;
  const b = r.rows[0].data; PFD.set(key, b); pfBytes += b.length;
  while (pfBytes > PF_CACHE_MAX && PFD.size > 1) { const k = PFD.keys().next().value, o = PFD.get(k); PFD.delete(k); pfBytes -= o.length }
  return b;
}
function pfDrop(uh) { for (const k of [...PFD.keys()]) if (k.startsWith(uh + ':')) { pfBytes -= PFD.get(k).length; PFD.delete(k) } }
function pfList(all) {
  const a = []; for (const [k, v] of PF) if (all || v.st === 'pend') a.push({ k, nm: v.nm, st: v.st, len: v.len, mime: v.mime, at: v.at });
  a.sort((x, y) => (x.st === 'pend' ? 0 : 1) - (y.st === 'pend' ? 0 : 1) || y.at - x.at);
  return a.slice(0, 60);
}
const pfAdmins = msg => { const s = JSON.stringify(msg); for (const o of P.values()) if (o.role >= 1) sendTo(o.ws, s) };
const pfOwner = (uh, st) => { for (const o of P.values()) if (o.uh === uh) sendTo(o.ws, { t: 'pfs', st }) };
async function pfSetSt(uh, st) { // aprovar / recusar
  const v = PF.get(uh); if (!v || v.st === st) return false;
  await pgPool.query('UPDATE graal_pfbg SET st = $2 WHERE uh = $1', [uh, st]);
  v.st = st; pfOwner(uh, st); pfAdmins({ t: 'adm', pfn: pfCount() }); return true;
}
const pfUh = req => { const sid = sessionOf(req); if (sid) return sha('discord:' + sid); const u = String(req.headers['x-uid'] || ''); return /^[a-f0-9]{32}$/.test(u) ? sha(u) : null };
const pfJson = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)) };
function pfSendImg(req, res, uh, v, data) {
  const h = { 'Content-Type': v.mime, 'Cache-Control': 'no-cache', ETag: '"' + v.h + '"', 'X-Content-Type-Options': 'nosniff', 'Content-Length': data.length };
  if (req.headers['if-none-match'] === h.ETag) { res.writeHead(304, { ETag: h.ETag, 'Cache-Control': 'no-cache' }); return res.end() }
  res.writeHead(200, h); res.end(req.method === 'HEAD' ? undefined : data);
}
function pfHttp(req, res, url) { // devolve true se a rota era desta função
  const m = url.match(/^\/api\/pfbg(?:\/(me\/img|me|\d{1,9}))?$/);
  if (!m) return false;
  const sub = m[1], uh = pfUh(req);
  const fail = e => { console.error('pfbg:', e && e.message); if (!res.headersSent) pfJson(res, 500, { ok: false, erro: 'erro no servidor' }) };
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (!sub) return pfJson(res, 404, { ok: false }), true;
    if (sub === 'me') { const v = uh && PF.get(uh); pfJson(res, 200, v ? { st: v.st, len: v.len, mime: v.mime } : { st: null }); return true }
    let who = uh, onlyOk = false;
    if (sub !== 'me/img') { const o = P.get(+sub); who = o && o.uh; onlyOk = true } // foto de outro jogador: só se aprovada
    const v = who && PF.get(who);
    if (!v || (onlyOk && v.st !== 'ok')) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return true }
    pfData(who).then(d => { if (!d) { res.writeHead(404); return res.end() } pfSendImg(req, res, who, v, d) }).catch(fail);
    return true;
  }
  if (sub) return pfJson(res, 405, { ok: false }), true;
  if (!uh) { req.resume(); pfJson(res, 401, { ok: false, erro: 'sem identidade' }); return true }
  if (req.method === 'DELETE') {
    if (!PF.has(uh)) return pfJson(res, 200, { ok: true }), true;
    pgPool.query('DELETE FROM graal_pfbg WHERE uh = $1', [uh]).then(() => { PF.delete(uh); pfDrop(uh); pfAdmins({ t: 'adm', pfn: pfCount() }); pfJson(res, 200, { ok: true }) }).catch(fail);
    return true;
  }
  if (req.method !== 'POST') return pfJson(res, 405, { ok: false }), true;
  if (AD.bans[uh]) { req.resume(); pfJson(res, 403, { ok: false, erro: 'banido' }); return true }
  const now = Date.now(), hist = (PF_RATE.get(uh) || []).filter(t => now - t < 3600e3);
  if (hist.length >= 12 || (hist.length && now - hist[hist.length - 1] < 4000)) { req.resume(); pfJson(res, 429, { ok: false, erro: 'muitos envios; espere um pouco' }); return true }
  if (+req.headers['content-length'] > PF_MAX_GIF) { req.resume(); pfJson(res, 413, { ok: false, erro: 'arquivo grande demais' }); return true }
  let size = 0, dead = false; const chunks = [];
  req.on('data', d => { size += d.length; if (size > PF_MAX_GIF) { dead = true; pfJson(res, 413, { ok: false, erro: 'arquivo grande demais' }); req.destroy() } else chunks.push(d) });
  req.on('end', () => {
    if (dead) return;
    const b = Buffer.concat(chunks), mime = pfSniff(b);
    if (!mime) return pfJson(res, 400, { ok: false, erro: 'formato inválido (use JPG, PNG, WebP ou GIF)' });
    if (b.length > (mime === 'image/gif' ? PF_MAX_GIF : PF_MAX)) return pfJson(res, 413, { ok: false, erro: 'arquivo grande demais' });
    hist.push(now); PF_RATE.set(uh, hist);
    const me = [...P.values()].find(o => o.uh === uh), staff = [...P.values()].some(o => o.uh === uh && o.role >= 1);
    const nm = String((me && me.nm) || (PF.get(uh) && PF.get(uh).nm) || '?').slice(0, 24), st = staff ? 'ok' : 'pend', h = crypto.createHash('sha1').update(b).digest('hex').slice(0, 16);
    pgPool.query(`INSERT INTO graal_pfbg (uh, nm, mime, st, len, h, at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (uh) DO UPDATE SET nm = EXCLUDED.nm, mime = EXCLUDED.mime, st = EXCLUDED.st, len = EXCLUDED.len, h = EXCLUDED.h, at = EXCLUDED.at, data = EXCLUDED.data`,
      [uh, nm, mime, st, b.length, h, now, b]).then(() => {
      pfDrop(uh); PF.set(uh, { nm, mime, st, len: b.length, h, at: now });
      pfAdmins({ t: 'adm', pfn: pfCount() }); pfJson(res, 200, { ok: true, st });
    }).catch(fail);
  });
  req.on('error', () => { });
  return true;
}

/* ---------------- HTTP ---------------- */
const isLoop = r => { const a = r.socket.remoteAddress || ''; return (a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1') && !r.headers['x-forwarded-for'] };
function isAdmin(req) {
  const t = String(req.headers['x-admin-token'] || '');
  if (!ADMIN) return isLoop(req); // sem ADMIN_TOKEN só aceita escrita de localhost
  const a = Buffer.from(t), b = Buffer.from(ADMIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) };

let IDX = null; // index.html em memória (bruto + gzip)
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
    if (a) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ on: true, id: a.id, data: a.data || {} })) }
    const g = guestOf(req) || newGid(), ga = ACC[g]; // sem Discord: conta de visitante (o cookie é renovado a cada visita)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': ck(req, 'ggid', g, GUEST_DAYS * 86400) });
    return res.end(JSON.stringify({ on: true, id: g, guest: true, data: (ga && ga.data) || {} }));
  }
  if (url === '/api/me' && req.method === 'GET') {
    const id = sessionOf(req), a = id && ACC[id];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ on: AUTH_ON, user: a ? { id: a.id, name: a.name, av: avatarOf(a) } : null }));
  }

  if (url.startsWith('/api/pfbg') && pfHttp(req, res, url)) return;

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

  /* arquivos do PWA/APK (manifest, service worker, ícones e o assetlinks.json do Android) */
  if ((req.method === 'GET' || req.method === 'HEAD') && (url === '/manifest.webmanifest' || url === '/sw.js' || /^\/vendor\/[a-z0-9.\-]+\.js$/.test(url) || url === '/.well-known/assetlinks.json' || /^\/icons\/[a-z0-9-]+\.png$/.test(url))) {
    const f = path.join(__dirname, 'public', url);
    const ct = url.endsWith('.png') ? 'image/png' : url.endsWith('.js') ? 'application/javascript; charset=utf-8' : url.endsWith('.json') ? 'application/json' : 'application/manifest+json; charset=utf-8';
    return fs.readFile(f, (e, d) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('não encontrado') }
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': url === '/sw.js' ? 'no-cache' : 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' }); res.end(req.method === 'HEAD' ? undefined : d);
    });
  }

  fs.stat(INDEX, (e0, st) => {
    if (e0) { res.writeHead(500); return res.end('erro') }
    const send = () => {
      const h = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: IDX.etag, Vary: 'Accept-Encoding' };
      if (req.headers['if-none-match'] === IDX.etag) { res.writeHead(304, h); return res.end() }
      const ae = req.headers['accept-encoding'] || '';
      if (IDX.br && /\bbr\b/.test(ae)) { h['Content-Encoding'] = 'br'; res.writeHead(200, h); return res.end(req.method === 'HEAD' ? undefined : IDX.br) }
      if (IDX.gz && /\bgzip\b/.test(ae)) { h['Content-Encoding'] = 'gzip'; res.writeHead(200, h); return res.end(req.method === 'HEAD' ? undefined : IDX.gz) }
      res.writeHead(200, h); res.end(req.method === 'HEAD' ? undefined : IDX.raw);
    };
    if (IDX && IDX.m === st.mtimeMs) return send();
    fs.readFile(INDEX, (e, d) => {
      if (e) { res.writeHead(500); return res.end('erro') }
      // compressão assíncrona (thread pool): não trava o loop do servidor/WebSocket; enquanto não termina, serve o arquivo sem compressão (só na 1ª vez)
      const cur = IDX = { m: st.mtimeMs, raw: d, gz: null, br: null, etag: '"' + crypto.createHash('sha1').update(d).digest('hex').slice(0, 16) + '"' };
      zlib.gzip(d, { level: 9 }, (er, b) => { if (!er) cur.gz = b });
      zlib.brotliCompress(d, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: d.length } }, (er, b) => { if (!er) cur.br = b });
      send();
    });
  });
});

// aquece o cache do index.html (e a compressão) ao iniciar
try { fs.stat(INDEX, (e0, st) => { if (e0) return; fs.readFile(INDEX, (e, d) => { if (e || IDX) return; const cur = IDX = { m: st.mtimeMs, raw: d, gz: null, br: null, etag: '"' + crypto.createHash('sha1').update(d).digest('hex').slice(0, 16) + '"' }; zlib.gzip(d, { level: 9 }, (er, b) => { if (!er) cur.gz = b }); zlib.brotliCompress(d, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: d.length } }, (er, b) => { if (!er) cur.br = b }) }) }) } catch (e) { }

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
  if (!Object.keys(out).length) return;
  if (out.graal_pos_v1 !== undefined && out.graal_pos_v1.length > 400) delete out.graal_pos_v1; // posição é um JSON minúsculo
  const slow = Object.keys(out).every(k => k === 'graal_pos_v1');
  p.svT = Date.now(); a.data = Object.assign(a.data || {}, out); a.last = p.svT; saveACC(a.id, slow);
}
/* arbustos cortados (compartilhado entre todos): chave "x,y" (tile) -> quando volta a crescer (ms). Mundo: 1664 x 2752 tiles. */
const BUSH_MS = 15000, BUSH_MAX = 4000, BCUT = new Map();
setInterval(() => { const n = Date.now(); for (const [k, t] of BCUT) if (t <= n) BCUT.delete(k) }, 5000);
const PNG = s => typeof s === 'string' && s.length < 290000 && s.startsWith('data:image/png');
// cores indexadas do body (pele, casaco, mangas, sapatos, cinto): 5 itens "#rrggbb" ou null (= padrão)
const HEXC = /^#[0-9a-f]{6}$/i;
const COLS = c => Array.isArray(c) && c.length === 5 && c.some(x => typeof x === 'string' && HEXC.test(x)) ? c.map(x => typeof x === 'string' && HEXC.test(x) ? x.toLowerCase() : null) : null;
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, +v || 0));
const sendTo = (ws, o) => { if (ws.readyState === 1) ws.send(typeof o === 'string' ? o : JSON.stringify(o)) };
/* batimento: derruba conexões mortas (aba fechada sem avisar, rede caiu) para o jogador sumir do mapa */
setInterval(() => { for (const c of wss.clients) { if (c.isAlive === false) { try { c.terminate() } catch (e) { } continue } c.isAlive = false; try { c.ping() } catch (e) { } } }, 10000);
/* anfitrião dos monstros: o jogador online mais antigo (menor id) que mandou posição nos últimos 4s. Só ele roda a IA dos monstros. */
let HOST = 0;
function electHost() {
  const now = Date.now(); let h = 0;
  for (const q of P.values()) if (q.ok && now - q.uT < 4000 && (!h || q.id < h)) h = q.id;
  if (h === HOST) return;
  const old = P.get(HOST); if (old) sendTo(old.ws, { t: 'host', v: 0 });
  HOST = h; const nw = P.get(h); if (nw) sendTo(nw.ws, { t: 'host', v: 1 });
}
setInterval(electHost, 1000);
/* itens no chão (gralats): o servidor lembra para quem entra depois; id -> [id,x,y,v]; máx. 300 (o mais antigo some para todos) */
const DROPS = new Map();
setInterval(() => { const n = Date.now(); for (const [k, a] of DROPS) if (a[5] && a[5] < n) DROPS.delete(k) }, 5000); // corações/bombas/flechas somem em 20s
const CHAT = []; // histórico do chat global (últimas 60 mensagens), enviado a quem entra
const others = (id, msg) => wss.clients.forEach(c => { if (c.pid !== id) sendTo(c, msg) });

wss.on('connection', (ws, req) => {
  const id = nid++; ws.pid = id; ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true });
  const p = { id, ws, x: 0, y: 0, nm: '?', an: 'Idle_Down', al: 1, b: 0, h: 0, s: 0, sw: 0, ok: 0, bs: null, hs: null, c: null, e: null, lastChat: 0, bT: 0, bN: 0, svT: 0, acc: null,
    role: 0, uh: null, muted: 0, authFails: 0, cmdT: 0, spT: 0 };
  P.set(id, p);
  sendTo(ws, { t: 'id', id, v: 3 });
  if (HOST) sendTo(ws, { t: 'host', v: 0 }); // já existe anfitrião: este cliente só copia os monstros
  sendTo(ws, spAll()); // spawns de monstros (iguais para todos)
  if (CHAT.length) sendTo(ws, { t: 'chh', a: CHAT });
  if (DROPS.size) { const now = Date.now(); sendTo(ws, { t: 'dall', a: [...DROPS.values()].map(a => [a[0], a[1], a[2], a[3], a[4] || 0, a[5] ? Math.max(0, a[5] - now) : 0]) }) }
  { const now = Date.now(), a = []; BCUT.forEach((t, k) => { if (t > now) { const q = k.split(','); a.push([+q[0], +q[1], t - now]) } }); if (a.length) sendTo(ws, { t: 'ball', a }) } // arbustos que estão cortados agora
  for (const o of P.values()) if (o.id !== id) { // quem entra agora já vê skin/equip de quem está online
    if (o.bs || o.hs) sendTo(ws, { t: 'k', id: o.id, bs: o.bs, hs: o.hs });
    if (o.c) sendTo(ws, { t: 'kc', id: o.id, c: o.c });
    if (o.e) sendTo(ws, { t: 'q', id: o.id, e: o.e });
    if (o.pi) sendTo(ws, Object.assign({ t: 'pi', id: o.id }, o.pi));
  }

  const hiT = setTimeout(() => { if (!p.uh && ws.readyState === 1) { sendTo(ws, { t: 'kick', r: 'Recarregue a página (F5) para entrar no jogo.' }); setTimeout(() => ws.close(), 100) } }, 8000);
  ws.on('close', () => clearTimeout(hiT));
  const setRole = r => { p.role = r; sendTo(ws, { t: 'role', r }); if (r >= 1) sendTo(ws, { t: 'adm', pfn: pfCount() }) };
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
        setRole(AD.owners[p.uh] ? 2 : AD.admins[p.uh] ? 1 : 0);
        sendTo(ws, accMsg(ACC[sid]));
      }
    } else {
      const gid = guestOf(req); // visitante: conta salva no servidor; admin/ban continuam presos ao uid do navegador (definido no 'hi')
      if (gid) {
        const a = ensureGuest(gid); a.last = Date.now(); p.gid = gid; p.acc = gid;
        for (const o of P.values()) if (o !== p && o.acc === gid) { o.acc = null; sendTo(o.ws, { t: 'kick', r: 'Sua conta entrou em outro lugar.' }); setTimeout(() => { try { o.ws.close() } catch (e) { } }, 100) }
        ACTIVE_ACC.set(gid, p);
        sendTo(ws, accMsg(a));
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
      if (ownerTokenOk(m.token, req)) { setRole(2); if (p.uh && p.acc && !GID_RE.test(p.acc) && !AD.owners[p.uh]) { AD.owners[p.uh] = { nm: String(p.nm || '?').slice(0, 24), at: Date.now() }; saveAD() } } // conta Discord vira dono de forma permanente
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
      if (c === 'pfl') { sendTo(ws, { t: 'adm', pfl: pfList(!!m.all), pfn: pfCount() }); return } // fila de fotos de perfil
      if (c === 'pfv') { // admin vê a foto ANTES de aprovar (vai pelo WebSocket, só para quem tem cargo)
        const k = String(m.k || ''); if (!PF.has(k)) return;
        pfData(k).then(d => { const v = PF.get(k); if (d && v) sendTo(ws, { t: 'pfimg', k, mime: v.mime, d: d.toString('base64') }) }).catch(() => { }); return }
      if (c === 'pfok' || c === 'pfno') {
        const k = String(m.k || ''), ok = c === 'pfok', v = PF.get(k); if (!v) return note('Foto não encontrada.');
        pfSetSt(k, ok ? 'ok' : 'no').then(() => { note((ok ? 'Foto aprovada: ' : 'Foto recusada: ') + v.nm); sendTo(ws, { t: 'adm', pfl: pfList(!!m.all), pfn: pfCount() }) }).catch(() => note('Erro ao salvar.')); return }
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
    if (m.t === 'ty') { p.ty = m.v ? 1 : 0; return } // chat aberto: mostra balão "..." na cabeça
    if (m.t === 'dr') { // item solto no chão
      const now = Date.now(); if (now - (p.drW || 0) > 1000) { p.drW = now; p.drN = 0 } if (++p.drN > 40) return;
      if (typeof m.id !== 'string' || !/^\d{1,9}-\d{1,9}$/.test(m.id) || DROPS.has(m.id)) return;
      const x = Math.round(num(m.x, -1e6, 1e6)), y = Math.round(num(m.y, -1e6, 1e6)), v = num(m.v, 0, 999) | 0, pop = m.pop ? 1 : 0;
      const k = /^[hba]$/.test(m.k) ? m.k : 0; DROPS.set(m.id, [m.id, x, y, v, k, k ? now + 20000 : 0]);
      if (DROPS.size > 300) { const k = DROPS.keys().next().value; DROPS.delete(k); wss.clients.forEach(c => sendTo(c, { t: 'dp', id: k })) }
      others(id, { t: 'dr', id: m.id, x, y, v, pop, k }); return;
    }
    if (m.t === 'bo' || m.t === 'ar') { // bomba colocada / flecha atirada: só efeito visual para os outros
      const now = Date.now(); if (now - (p.evW || 0) > 1000) { p.evW = now; p.evN = 0 } if (++p.evN > 30) return;
      if (m.t === 'bo') others(id, { t: 'bo', sx: num(m.sx, -1e6, 1e6), sy: num(m.sy, -1e6, 1e6), tx: num(m.tx, -1e6, 1e6), ty: num(m.ty, -1e6, 1e6), fl: num(m.fl, 0, 1) });
      else others(id, { t: 'ar', x: num(m.x, -1e6, 1e6), y: num(m.y, -1e6, 1e6), vx: num(m.vx, -400, 400), vy: num(m.vy, -400, 400) });
      return;
    }
    if (m.t === 'dp') { // item pego
      if (typeof m.id !== 'string' || !DROPS.delete(m.id)) return;
      others(id, { t: 'dp', id: m.id }); return;
    }
    if (m.t === 'ms') { // estado dos monstros: só o anfitrião manda; vai para todos os outros
      if (p.id !== HOST || d.length > 20000 || !Array.isArray(m.e) || m.e.length > 300) return;
      others(id, { t: 'ms', n: m.n | 0, e: m.e }); return;
    }
    if (m.t === 'mh') { // golpe em monstro de quem não é anfitrião: vai só para o anfitrião
      const now = Date.now(); if (now - (p.mhW || 0) > 1000) { p.mhW = now; p.mhN = 0 } if (++p.mhN > 60) return;
      const h = HOST && HOST !== p.id && P.get(HOST); if (h) sendTo(h.ws, { t: 'mh', i: m.i | 0, d: num(m.d, 0, 2000) }); return;
    }
    if (m.t === 'mp') { // monstro bateu em jogador remoto: vai só para a vítima
      if (p.id !== HOST) return;
      const now = Date.now(); if (now - (p.mpW || 0) > 1000) { p.mpW = now; p.mpN = 0 } if (++p.mpN > 120) return;
      const v = P.get(m.pid | 0); if (v && v !== p) sendTo(v.ws, { t: 'mp', dk: num(m.dk, 0, 20) }); return;
    }
    if (m.t === 'pi') { // perfil público: título, status, contadores e opção de sparring (muda de vez em quando)
      if (d.length > 600) return;
      const now = Date.now(); if (now - (p.piT || 0) < 700) return; p.piT = now;
      const tx = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
      const n = v => Math.max(0, Math.min(1e9, +v || 0)) | 0;
      p.pi = { c: /^[a-z0-9]{1,6}$/.test(m.c) ? m.c : '', tt: /^[a-z]{1,16}$/.test(m.tt) ? m.tt : 'novato', st: tx(m.st, 40), el: n(m.el), pk: n(m.pk), sl: n(m.sl), dk: n(m.dk), spo: m.spo ? 1 : 0, pt: n(m.pt) };
      others(id, Object.assign({ t: 'pi', id }, p.pi)); return;
    }
    if (m.t === 'ph') { // golpe de sparring: só vale se os dois aceitaram e estão perto; o servidor repassa só à vítima
      const now = Date.now(); if (now - (p.phW || 0) > 1000) { p.phW = now; p.phN = 0 } if (++p.phN > 8) return;
      const q = P.get(m.to | 0); if (!q || q === p || !p.pi || !p.pi.spo || !q.pi || !q.pi.spo) return;
      if (Math.hypot(p.x - q.x, p.y - q.y) > 110) return;
      q.phFrom = id; q.phT = now; sendTo(q.ws, { t: 'ph', from: id, d: num(m.d, 0, 2000) }); return;
    }
    if (m.t === 'pk') { // a vítima do sparring avisa quem a derrubou (só vale se levou golpe dele há pouco)
      const k = P.get(m.by | 0), now = Date.now(); if (!k || k === p || p.phFrom !== k.id || now - (p.phT || 0) > 15000) return;
      p.phFrom = 0; sendTo(k.ws, { t: 'pk', id, nm: p.nm }); return;
    }
    if (m.t === 'u') {
      if (d.length > 400) return;
      p.x = num(m.x, -1e6, 1e6); p.y = num(m.y, -1e6, 1e6); p.nm = String(m.nm || '?').slice(0, 12);
      p.an = normAn(m.an); p.al = m.al == 1 ? 1 : .4;
      if (m.lv != null) { p.lv = num(m.lv, 1, 999) | 0; p.hp = num(m.hp, 0, 99999) | 0; p.hm = num(m.hm, 0, 99999) | 0; p.kl = num(m.kl, 0, 1e9) | 0 }
      p.b = num(m.b, 0, 999) | 0; p.h = num(m.h, 0, 999) | 0; p.s = num(m.s, 0, 999) | 0; p.sw = m.sw ? 1 : 0; p.ct = typeof m.ct === 'number' && isFinite(m.ct) ? m.ct : undefined; p.ak = num(m.ak, 0, 1e9) | 0; p.ad = num(m.ad, 50, 1000) | 0; p.uT = Date.now(); if (!p.ok) { p.ok = 1; electHost() } else p.ok = 1; others(id, JSON.stringify({ t: 'pu', p: pstate(p) }));
    } else if (m.t === 'k') {
      p.bs = PNG(m.bs) ? m.bs : null; p.hs = PNG(m.hs) ? m.hs : null;
      others(id, { t: 'k', id, bs: p.bs, hs: p.hs });
    } else if (m.t === 'kc') {
      p.c = COLS(m.c);
      others(id, { t: 'kc', id, c: p.c });
    } else if (m.t === 'q') {
      if (!m.e || typeof m.e !== 'object' || d.length > 20000) return;
      p.e = { h: m.e.h, s: m.e.s, d: m.e.d };
      others(id, { t: 'q', id, e: p.e });
    } else if (m.t === 'c') {
      const x = String(m.x || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100), now = Date.now();
      if (!x || p.muted || now - p.lastChat < 500) return; p.lastChat = now;
      const at = now, r = p.role | 0; CHAT.push({ nm: p.nm, x, r, at }); if (CHAT.length > 60) CHAT.shift();
      const out = JSON.stringify({ t: 'c', id, nm: p.nm, x, r, at });
      wss.clients.forEach(c => sendTo(c, out)); // inclusive o remetente (o cliente espera o eco)
    }
  });
  ws.on('close', () => { if (p.svTm) clearTimeout(p.svTm); if (p.svD) { applySv(p, p.svD); p.svD = null } if (p.acc && ACTIVE_ACC.get(p.acc) === p) ACTIVE_ACC.delete(p.acc); { const g = p.gid, a = g && ACC[g]; if (a && !ACTIVE_ACC.has(g) && !accDirty.has(g) && !Object.keys(a.data || {}).length) delete ACC[g] } P.delete(id); others(id, { t: 'l', id }); if (id === HOST) electHost(); if (!P.size) DROPS.clear() });
  ws.on('error', () => { });
});

/* animação do jogador: aceita direção por nome (Run_Down, clientes antigos) ou número 0-3 (Run_2) e guarda SEMPRE por nome,
   que é o que todos os clientes (antigos e novos) sabem desenhar. Antes, o nome era descartado e virava Idle_2: o amigo deslizava parado. */
const AN_DIR = ['Up', 'Left', 'Down', 'Right'];
function normAn(a) {
  const m = /^(Idle|Run|Attack)_([0-3]|Up|Left|Down|Right)$/.exec(a);
  if (!m) return 'Idle_Down';
  return m[1] + '_' + (/^[0-3]$/.test(m[2]) ? AN_DIR[+m[2]] : m[2]);
}

const pstate = p => ({ id: p.id, ct: p.ct, ak: p.ak, ad: p.ad, x: p.x, y: p.y, nm: p.nm, an: p.an, al: p.al, b: p.b, h: p.h, s: p.s, sw: p.sw, r: p.role, tp: p.ty | 0, lv: p.lv, hp: p.hp, hm: p.hm, kl: p.kl });
setInterval(() => {
  const a = [...P.values()].filter(p => p.ok).map(pstate);
  if (!a.length) return;
  const msg = JSON.stringify({ t: 'st', p: a });
  wss.clients.forEach(c => sendTo(c, msg));
}, 500); // sincronização completa (limpeza de quem saiu); o movimento vai por 'pu', na hora

Promise.all([initAccountsDB(), initSpawnsDB(), initPfDB()]).then(() => {
  srv.listen(PORT, () => {
    console.log('Graal Online em http://localhost:' + PORT);
    if (!ADMIN) console.log('AVISO: ADMIN_TOKEN não definido — só o localhost consegue salvar edições no servidor.');
  });
}).catch(e => { console.error('Falha ao iniciar PostgreSQL:', e); process.exit(1); });
