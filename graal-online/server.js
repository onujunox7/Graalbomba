/* Graal Online — servidor
 *  - HTTP: serve o jogo + /graal-config.json (config compartilhada) + PUT /api/config/:chave (admin)
 *  - WebSocket (protocolo v3): jogadores, skins, equipamentos e chat
 *
 *  Variáveis de ambiente:
 *    ADMIN_TOKEN  senha de quem pode salvar mudanças do editor no servidor (OBRIGATÓRIA em produção)
 *    DATA_DIR     pasta onde a config é gravada (padrão ./data). Em hospedagem, aponte p/ um disco persistente.
 *    PORT         porta (padrão 3000)
 *    KICK_MINUTES tempo padrão de bloqueio de quem foi expulso (padrão 5). Pode ser mudado no painel 🛡 (aba ⏱ Punições) e na hora de expulsar/banir.
 *
 *  Spawns de monstros: o menu 👾 (tecla N) de admins/dono grava a lista em PostgreSQL (tabela graal_kv); todos os jogadores recebem a mesma lista ao entrar.
 *
 *  Cargos (painel 🛡 no jogo):
 *    DONO   quem abre o jogo com ?admin=ADMIN_TOKEN (o mesmo token do editor). Pode tudo, inclusive dar/tirar o cargo de admin e banir.
 *    ADMIN  jogador a quem o dono deu o cargo (fica salvo em DATA_DIR/graal-admins.json, preso à identidade do navegador dele).
 *           Pode: avisar todos, expulsar (com tempo), silenciar, teleportar, curar, dar Glims/níveis, renascer monstros,
 *           ficar invisível/espectador, ver quem está online e mudar o tempo padrão de expulsão. Só o dono bane (com tempo ou permanente).
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
  tsol: s => /^[01]{4096}$/.test(s), spararea: s => { try { const a = JSON.parse(s); return a === null || !!cleanSparConfig(a) } catch (e) { return false } }
};

/* ---------------- config persistente ---------------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
let cfg = {};
(function load() {
  for (const f of [CFG_FILE, BAK_FILE, path.join(__dirname, 'public', 'graal-config.json')]) { // cópia local; o PostgreSQL prevalece na inicialização
    try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); if (o && typeof o === 'object') { cfg = o; console.log('Config local carregada de', f); return } } catch (e) { }
  }
})();
async function initConfigDB() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_config (config_key TEXT PRIMARY KEY, config_value TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const r = await pgPool.query('SELECT config_key, config_value FROM graal_config');
  if (r.rowCount) {
    cfg = Object.fromEntries(r.rows.map(row => [row.config_key, row.config_value]));
    console.log('Configurações carregadas do PostgreSQL:', r.rowCount);
    return;
  }
  const entries = Object.entries(cfg).filter(([key, value]) => KEYS[key] && (value === null || (typeof value === 'string' && KEYS[key](value))));
  for (const [key, value] of entries) await pgPool.query('INSERT INTO graal_config (config_key, config_value) VALUES ($1, $2) ON CONFLICT (config_key) DO NOTHING', [key, value]);
  if (entries.length) console.log('Config local migrada para PostgreSQL:', entries.length);
}

/* ---------------- cargos: admins e banidos (persistentes) ---------------- */
const ADM_FILE = path.join(DATA_DIR, 'graal-admins.json');
let AD = { admins: {}, bans: {}, owners: {}, cfg: {} }; // owners: contas Discord que já provaram ser o dono (token) e voltam como dono em qualquer navegador
try { const o = JSON.parse(fs.readFileSync(ADM_FILE, 'utf8')); if (o && typeof o === 'object') AD = { admins: o.admins || {}, bans: o.bans || {}, owners: o.owners || {}, cfg: o.cfg && typeof o.cfg === 'object' ? o.cfg : {} } } catch (e) { }
/* O oficial fica no PostgreSQL (graal_kv, chave 'roles'), com cópia em arquivo: reiniciar o servidor NÃO apaga mais admins, donos, bans nem tempos de punição.
   Só o dono remove um admin, manualmente, pelo painel. */
let adDirty = false, adBusy = false;
async function adFlush() {
  if (adBusy) return; adBusy = true;
  try {
    while (adDirty) {
      adDirty = false;
      try { await pgPool.query(`INSERT INTO graal_kv (k, v, updated_at) VALUES ('roles', $1::jsonb, $2)
        ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = EXCLUDED.updated_at`, [JSON.stringify(AD), Date.now()]) }
      catch (e) { console.error('Falha ao gravar admins no PostgreSQL:', e.message); adDirty = true; await new Promise(r => setTimeout(r, 3000)) }
    }
  } finally { adBusy = false }
}
function saveAD() {
  adDirty = true; adFlush().catch(e => console.error(e));
  try { const t = ADM_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(AD)); fs.renameSync(t, ADM_FILE) } catch (e) { console.error('Falha ao gravar admins (arquivo):', e.message) }
}
async function initRolesDB() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_at BIGINT NOT NULL)`);
  const r = await pgPool.query(`SELECT v FROM graal_kv WHERE k = 'roles'`), o = r.rowCount ? r.rows[0].v : null;
  if (o && typeof o === 'object') {
    // junta com o que veio do arquivo local (se houver), sem perder ninguém; o banco manda em caso de conflito
    AD = { admins: Object.assign({}, AD.admins, o.admins || {}), bans: Object.assign({}, AD.bans, o.bans || {}), owners: Object.assign({}, AD.owners, o.owners || {}), cfg: Object.assign({}, AD.cfg, o.cfg && typeof o.cfg === 'object' ? o.cfg : {}) };
    console.log('Cargos carregados do PostgreSQL:', Object.keys(AD.admins).length, 'admins,', Object.keys(AD.owners).length, 'donos,', Object.keys(AD.bans).length, 'bans');
  } else console.log('Cargos: nada no PostgreSQL ainda' + (Object.keys(AD.admins).length + Object.keys(AD.owners).length ? ' — migrando do arquivo' : ''));
  adDirty = true; await adFlush();
}
const KICKED = new Map(); // uid -> até quando está bloqueado
/* tempos de punição (em MINUTOS), editáveis no painel e salvos em graal-admins.json: expulsão (admin e dono) e ban (só o dono). Ban 0 = permanente. */
const KICK_DEF = Math.max(0, +(process.env.KICK_MINUTES || 5)), PUN_MAX = 60 * 24 * 365 * 5; // máx. 5 anos
const cleanMin = (v, d) => { const n = Math.floor(+v); return Number.isFinite(n) ? Math.max(0, Math.min(PUN_MAX, n)) : d };
const kickMin = () => cleanMin(AD.cfg.kickMin, KICK_DEF), banMin = () => cleanMin(AD.cfg.banMin, 0);
const punCfg = () => ({ kickMin: kickMin(), banMin: banMin() });
const fmtDur = ms => { const m = Math.max(1, Math.ceil(ms / 60000)); if (m < 60) return m + ' min'; const h = Math.floor(m / 60); if (h < 24) return h + ' h' + (m % 60 ? ' ' + (m % 60) + ' min' : ''); const d = Math.floor(h / 24); return d + ' d' + (h % 24 ? ' ' + (h % 24) + ' h' : '') };
/* ban ativo de uma identidade (apaga sozinho o que já venceu) */
const banOf = uh => { const b = uh && AD.bans[uh]; if (!b) return null; if (b.until && b.until <= Date.now()) { delete AD.bans[uh]; saveAD(); return null } return b };
const banMsg = b => 'Você está banido deste servidor' + (b.until ? '. Faltam ' + fmtDur(b.until - Date.now()) : '') + '.';
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
/* ---------------- NPCs vendedores (menu 🧙): compartilhados e persistentes ----------------
 * Só admin/dono edita (checado em 'npc'). A lista inteira vai e volta; o oficial fica no PostgreSQL (graal_kv, chave 'npcs'), com cópia em arquivo. */
const NP_FILE = path.join(DATA_DIR, 'graal-npcs.json'), NP_MAX = 200, NP_BYTES = 600000; // cabe no limite de 700 KB por mensagem do WebSocket
let NP = { a: [], saved: false }; // saved=false: ninguém salvou ainda (o 1º admin que entrar com NPCs no navegador migra a lista dele)
const npNum = (v, lo, hi, d) => { v = Math.round(+v); return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d };
const npLines = (a, m) => (Array.isArray(a) ? a : []).map(x => String(x || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').trim().slice(0, 100)).filter(Boolean).slice(0, m);
const npTx = (v, n, d) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n) || d;
function npCleanOne(n) {
  if (!n || typeof n !== 'object' || !Number.isFinite(+n.x) || !Number.isFinite(+n.y)) return null;
  const x = Math.round(+n.x), y = Math.round(+n.y); if (x < 0 || y < 0 || x > 200000 || y > 200000) return null;
  const it = [];
  for (const i of (Array.isArray(n.it) ? n.it : [])) {
    if (!i || typeof i !== 'object' || it.length >= 24) continue;
    if (i.t === 'x') { if (typeof i.e === 'string' && /^[a-z]{1,8}$/.test(i.e)) it.push({ t: 'x', ic: String(i.ic || '🎁').slice(0, 4), nm: npTx(i.nm, 22, 'Item'), c: npNum(i.c, 0, 99999, 10), e: i.e, v: npNum(i.v, 1, 9999, 1) }) }
    else if (typeof i.t === 'string' && /^[a-z]{1,12}$/.test(i.t)) it.push({ t: i.t, c: npNum(i.c, 0, 99999, 10), q: npNum(i.q, 1, 99, 1) });
  }
  const sk = n.sk && Number.isFinite(+n.sk.b) && Number.isFinite(+n.sk.h) ? { b: npNum(n.sk.b, 0, 9999, 0), h: npNum(n.sk.h, 0, 9999, 0) } : null;
  const eqv = (v, d) => typeof v === 'number' ? (Number.isInteger(v) && v >= 0 && v <= 6 ? v : d) : (typeof v === 'string' && v.length < 90000 && /^data:image\/png;base64,[A-Za-z0-9+\/=]+$/.test(v) ? v : d); // chapéu/escudo: 0 original · 1-5 cores · 6 nenhum · ou PNG enviado
  return { x, y, nm: npTx(n.nm, 18, 'Vendedor'), hue: npNum(n.hue, 0, 359, 160), it, fl: npLines(n.fl, 8), fb: npLines(n.fb, 5), eq: { h: eqv(n.eq && n.eq.h, 0), d: eqv(n.eq && n.eq.d, 6) }, sk };
}
function npClean(a) { // lista limpa ou null se for inválida/grande demais
  if (!Array.isArray(a) || a.length > NP_MAX) return null;
  const r = a.map(npCleanOne).filter(Boolean);
  return JSON.stringify(r).length > NP_BYTES ? null : r;
}
try { const o = JSON.parse(fs.readFileSync(NP_FILE, 'utf8')); const a = npClean(o && o.a); if (a) NP = { a, saved: !!o.saved } } catch (e) { } // cópia local (reserva)
let npDirty = false, npBusy = false;
async function npFlush() {
  if (npBusy) return; npBusy = true;
  try {
    while (npDirty) {
      npDirty = false;
      try { await pgPool.query(`INSERT INTO graal_kv (k, v, updated_at) VALUES ('npcs', $1::jsonb, $2)
        ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = EXCLUDED.updated_at`, [JSON.stringify(NP.a), Date.now()]) }
      catch (e) { console.error('Falha ao gravar NPCs no PostgreSQL:', e.message); npDirty = true; await new Promise(r => setTimeout(r, 3000)) }
    }
  } finally { npBusy = false }
}
async function initNpcsDB() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_kv (k TEXT PRIMARY KEY, v JSONB NOT NULL, updated_at BIGINT NOT NULL)`);
  const r = await pgPool.query(`SELECT v FROM graal_kv WHERE k = 'npcs'`), a = r.rowCount ? npClean(r.rows[0].v) : null;
  if (a) { NP = { a, saved: true }; console.log('NPCs carregados do PostgreSQL:', a.length) }
  else if (NP.saved) { console.log('NPCs migrados do arquivo para o PostgreSQL'); npDirty = true; await npFlush() }
  else console.log('NPCs: nenhum salvo ainda');
}
function saveNP() { // grava no banco (assíncrono) e mantém cópia em arquivo
  npDirty = true; npFlush().catch(e => console.error(e));
  try { const t = NP_FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(NP)); fs.renameSync(t, NP_FILE) } catch (e) { }
}
const npAll = () => ({ t: 'npall', a: NP.a, init: NP.saved ? 1 : 0 });

const spAll = () => ({ t: 'spall', add: SP.add, rem: SP.rem });
const spBroadcast = o => { const s = JSON.stringify(o); wss.clients.forEach(c => sendTo(c, s)) };

/* ---------------- contas (login com Discord, OAuth2) ----------------
 *  Variáveis: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SESSION_SECRET (texto longo e aleatório), PUBLIC_URL (opcional, ex.: https://graalbomba.onrender.com)
 *  Redirect no portal do Discord: <PUBLIC_URL>/auth/discord/callback
 *  A conta guarda uma cópia das chaves de progresso do navegador (nível, Glims, skin, equipamentos...) em DATA_DIR/graal-accounts.json.
 *  Sem as variáveis, o login fica desligado e o jogo funciona como antes (visitante). */
const DC_ID = process.env.DISCORD_CLIENT_ID || '', DC_SECRET = process.env.DISCORD_CLIENT_SECRET || '', SES_SECRET = process.env.SESSION_SECRET || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const AUTH_ON = !!(DC_ID && DC_SECRET && SES_SECRET);
const ACC_KEYS = ['graal_nick', 'graal_classic_save_v1', 'graal_classic_zelda_v1', 'graal_skin_v2', 'graal_equip_v1', 'graal_playtime', 'graal_profile_v1', 'graal_custom_v1', 'graal_headbuy_v1', 'graal_pos_v1', 'graal_npc_bag_v1', 'graal_mount_owned'];
const ACC_MAX = 600000, SES_DAYS = 30;
/* VISITANTE SALVO: quem não entrou com o Discord ganha uma conta de visitante (id aleatório num cookie de 1 ano, só neste navegador).
 * O progresso fica no PostgreSQL igual ao da conta Discord. Visitantes sem uso há GUEST_KEEP_DAYS dias são apagados. */
const GID_RE = /^g[a-f0-9]{32}$/, GUEST_DAYS = 365, GUEST_KEEP_DAYS = 90;
const newGid = () => 'g' + crypto.randomBytes(16).toString('hex');
/* ID PÚBLICO DA CONTA: número sequencial permanente (nunca reaproveitado), mostrado no formato padrão AE-000123.
 * Para mudar o modelo basta editar PID_PREFIX / PID_DIGITS. Vale para contas Discord e de visitante. */
const PID_PREFIX = 'AE', PID_DIGITS = 6;
const fmtPid = n => PID_PREFIX + '-' + String(n).padStart(PID_DIGITS, '0');
let PID_SEQ = 0;
const savePidSeq = () => pgPool.query(`INSERT INTO graal_kv (k,v,updated_at) VALUES ('pid_seq',$1::jsonb,$2) ON CONFLICT (k) DO UPDATE SET v=to_jsonb(GREATEST((graal_kv.v #>> '{}')::bigint,(EXCLUDED.v #>> '{}')::bigint)), updated_at=EXCLUDED.updated_at`, [JSON.stringify(PID_SEQ), Date.now()]).catch(e => console.error('pid_seq:', e.message));
/* O ID (número + código no modelo padrão) nasce UMA vez, é gravado no PostgreSQL (colunas pid e pid_code) e nunca mais é recalculado:
 * mesmo que PID_PREFIX / PID_DIGITS mudem no futuro, as contas existentes mantêm o código que já receberam. */
const ensurePid = a => { if (!a) return a;
  if (!a.pid) { a.pid = ++PID_SEQ; savePidSeq(); a.code = fmtPid(a.pid); saveACC(a.id) }
  else if (!a.code) { a.code = fmtPid(a.pid); saveACC(a.id) } // conta antiga (só tinha o número): congela o código agora
  return a };
const pidOf = a => ensurePid(a).code;
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
if (!DATABASE_URL) throw new Error('DATABASE_URL não configurada no Render; contas Discord precisam do PostgreSQL.');
const pgPool = new Pool({ connectionString: DATABASE_URL, ssl: /render\.com|neon\.tech|supabase\.co/i.test(DATABASE_URL) ? { rejectUnauthorized: false } : undefined, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
let ACC = {}, accT = null, accSlow = false, accDirty = new Set(); // cache em memória; persistência oficial no PostgreSQL
async function initAccountsDB() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_accounts (
    discord_id TEXT PRIMARY KEY, name TEXT NOT NULL, avatar TEXT, created_at BIGINT NOT NULL,
    last_seen BIGINT NOT NULL, data JSONB NOT NULL DEFAULT '{}'::jsonb
  )`);
  await pgPool.query(`ALTER TABLE graal_accounts ADD COLUMN IF NOT EXISTS pid INTEGER`);
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS graal_accounts_pid_uq ON graal_accounts(pid)`);
  await pgPool.query(`ALTER TABLE graal_accounts ADD COLUMN IF NOT EXISTS pid_code TEXT`);
  await pgPool.query(`CREATE UNIQUE INDEX IF NOT EXISTS graal_accounts_pidcode_uq ON graal_accounts(pid_code)`);
  /* trava no banco: depois de gravados, pid e pid_code não podem ser alterados por nenhum UPDATE */
  await pgPool.query(`CREATE OR REPLACE FUNCTION graal_pid_lock() RETURNS trigger AS $$ BEGIN
    IF OLD.pid IS NOT NULL THEN NEW.pid := OLD.pid; END IF;
    IF OLD.pid_code IS NOT NULL THEN NEW.pid_code := OLD.pid_code; END IF;
    RETURN NEW; END $$ LANGUAGE plpgsql`);
  await pgPool.query(`DROP TRIGGER IF EXISTS graal_pid_lock_t ON graal_accounts`);
  await pgPool.query(`CREATE TRIGGER graal_pid_lock_t BEFORE UPDATE ON graal_accounts FOR EACH ROW EXECUTE FUNCTION graal_pid_lock()`);
  await pgPool.query(`DELETE FROM graal_accounts WHERE discord_id LIKE 'g%' AND last_seen < $1`, [Date.now() - GUEST_KEEP_DAYS * 864e5]);
  const r = await pgPool.query('SELECT discord_id, name, avatar, created_at, last_seen, data, pid, pid_code FROM graal_accounts ORDER BY created_at, discord_id');
  const sq = await pgPool.query(`SELECT v #>> '{}' AS v FROM graal_kv WHERE k='pid_seq'`);
  PID_SEQ = Math.max(+(sq.rows[0] && sq.rows[0].v) || 0, ...r.rows.map(x => x.pid | 0), 0);
  for (const row of r.rows) ACC[row.discord_id] = { guest: GID_RE.test(row.discord_id), id: row.discord_id, name: row.name, av: row.avatar, at: Number(row.created_at), last: Number(row.last_seen), data: row.data || {}, pid: row.pid | 0, code: row.pid_code || '' };
  for (const row of r.rows) ensurePid(ACC[row.discord_id]); // contas antigas ganham ID em ordem de criação
  console.log('PostgreSQL: contas carregadas (Discord + visitantes):', r.rowCount);
}
async function flushACC() {
  accT = null; accSlow = false;
  const ids = [...accDirty]; accDirty.clear();
  for (const id of ids) {
    const a = ACC[id]; if (!a) continue;
    try { await pgPool.query(`INSERT INTO graal_accounts (discord_id,name,avatar,created_at,last_seen,data,pid,pid_code)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (discord_id) DO UPDATE SET
      name=EXCLUDED.name, avatar=EXCLUDED.avatar, last_seen=EXCLUDED.last_seen, data=EXCLUDED.data, pid=COALESCE(graal_accounts.pid, EXCLUDED.pid), pid_code=COALESCE(graal_accounts.pid_code, EXCLUDED.pid_code)`,
      [a.id, a.name, a.av, a.at, a.last, JSON.stringify(a.data || {}), ensurePid(a).pid, a.code]);
      const pl = ACTIVE_ACC.get(id); if (pl) sendTo(pl.ws, { t: 'svok', at: Date.now() }); }
    catch (e) { console.error('Falha ao salvar conta no PostgreSQL:', e.message); accDirty.add(id);
      const pl = ACTIVE_ACC.get(id); if (pl) sendTo(pl.ws, { t: 'sverr', m: String(e.message).slice(0, 140) }); }
  }
  if (accDirty.size && !accT) accT = setTimeout(() => flushACC().catch(e => console.error(e)), 3000);
}
/* slow: mudança só de posição (acontece o tempo todo) -> grava no banco no máximo a cada ~12 s; qualquer outra mudança grava em 1 s */
const saveACC = (id, slow) => { if (id) accDirty.add(String(id));
  if (accT && accSlow && !slow) { clearTimeout(accT); accT = null }
  if (!accT) { accSlow = !!slow; accT = setTimeout(() => flushACC().catch(e => console.error(e)), 1000) } };
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
const ensureGuest = id => ensurePid(ACC[id] || (ACC[id] = { id, guest: true, name: 'Visitante', av: null, at: Date.now(), last: Date.now(), data: {} }));
const avatarOf = a => a.guest ? 'https://cdn.discordapp.com/embed/avatars/0.png' : a.av ? 'https://cdn.discordapp.com/avatars/' + a.id + '/' + a.av + '.png?size=64' : 'https://cdn.discordapp.com/embed/avatars/' + Number((BigInt(a.id) >> 22n) % 6n) + '.png';
const nickOf = n => String(n).replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12) || 'Jogador';
const accMsg = a => ({ t: 'acc', guest: !!a.guest, pid: pidOf(a), id: a.id, name: a.name, av: avatarOf(a), data: a.data || {} });
/* códigos de login do app: 8 letras/números sem ambiguidade, 5 min, uso único, no máximo 500 pendentes */
const APPCODES = new Map();
function appCode(id) {
  const now = Date.now(); for (const [k, v] of APPCODES) if (v.exp < now) APPCODES.delete(k);
  if (APPCODES.size > 500) APPCODES.delete(APPCODES.keys().next().value);
  const al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let c;
  do { c = Array.from(crypto.randomBytes(8), b => al[b % al.length]).join('') } while (APPCODES.has(c));
  APPCODES.set(c, { id, exp: now + 300000 }); return c;
}
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
    const a = ensurePid(ACC[u.id] || (ACC[u.id] = { id: String(u.id), at: Date.now(), data: {} }));
    a.name = name; a.av = u.avatar && /^[A-Za-z0-9_]+$/.test(u.avatar) ? u.avatar : null; a.last = Date.now();
    if (!a.data.graal_nick) a.data.graal_nick = nickOf(name); // conta nova: o nick inicial é o nome do Discord
    saveACC(a.id);
    if (readCookie(req, 'gapp') === '1') { /* login pelo app (Godot): mostra um código de 8 letras, usado uma vez em /auth/app/redeem */
      const code = appCode(a.id);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': [ck(req, 'gst', '', 0), ck(req, 'gapp', '', 0)] });
      return res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Graalbomba</title><body style="font-family:system-ui;background:#10131a;color:#eee;text-align:center;padding:40px 16px"><h2>Login feito!</h2><p>Volte ao jogo e digite este código (vale 5 minutos):</p><p style="font-size:44px;letter-spacing:.15em;font-weight:700;color:#7dd3fc">' + code + '</p>');
    }
    res.writeHead(302, { Location: '/', 'Set-Cookie': [ck(req, 'gsid', mkSession(a.id), SES_DAYS * 86400), ck(req, 'gst', '', 0)] }); res.end();
  } catch (e) { fail(e.message) }
}

let cache = null, saveT = null, lastBak = 0;
const invalidate = () => { cache = null };
function getCache() {
  if (!cache) {
    const body = Buffer.from(JSON.stringify(cfg));
    cache = { body, gz: zlib.gzipSync(body), rev: revHeader(), etag: '"' + crypto.createHash('sha1').update(body).digest('hex').slice(0, 16) + '"' };
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

/* ---------------- histórico de versões + proteção: o mapa NUNCA é apagado ---------------- */
const PROTECT = new Set(['map', 'tilesets', 'tsol', 'levels', 'doors', 'interior']); // nunca aceitam "apagar" (v = null) vindo do site
const hashOf = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
const revHeader = () => Object.keys(cfg).filter(k => typeof cfg[k] === 'string').map(k => k + '=' + hashOf(cfg[k])).join(',');
const GAP_MS = { map: 60 * 1000 }; // intervalo mínimo entre cópias automáticas (demais chaves: 5 min)
let histReady = false;
async function initHistoryDB() {
  await pgPool.query('CREATE TABLE IF NOT EXISTS graal_config_history (id BIGSERIAL PRIMARY KEY, config_key TEXT NOT NULL, config_gz BYTEA NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, note TEXT NOT NULL DEFAULT \'\', saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  await pgPool.query('CREATE INDEX IF NOT EXISTS graal_config_history_key_id ON graal_config_history (config_key, id DESC)');
  histReady = true;
  for (const k of Object.keys(cfg)) if (typeof cfg[k] === 'string') await snapshot(k, cfg[k], 'boot', true); // cópia do que já existe ao ligar o servidor
  console.log('Histórico de versões do mapa ativo.');
}
async function snapshot(key, value, note, force) {
  if (!histReady) throw new Error('histórico indisponível');
  const h = hashOf(value);
  const last = (await pgPool.query('SELECT hash, saved_at FROM graal_config_history WHERE config_key = $1 ORDER BY id DESC LIMIT 1', [key])).rows[0];
  if (last && last.hash === h) return false; // já está guardada
  if (!force && last && Date.now() - new Date(last.saved_at).getTime() < (GAP_MS[key] || 5 * 60 * 1000)) return false;
  await pgPool.query('INSERT INTO graal_config_history (config_key, config_gz, hash, size, note) VALUES ($1, $2, $3, $4, $5)', [key, zlib.gzipSync(Buffer.from(value, 'utf8')), h, value.length, note || '']);
  schedulePrune(key);
  return true;
}
/* poda só as cópias "do meio": mapa = tudo por 48h, 1 por hora até 30 dias, depois 1 por dia PARA SEMPRE; as 5 mais novas, 'boot' e 'restaurar' nunca saem */
const pruneT = {};
function schedulePrune(key) { if (pruneT[key]) return; pruneT[key] = setTimeout(() => { delete pruneT[key]; prune(key).catch(e => console.error('Falha ao podar histórico:', e.message)) }, 10 * 60 * 1000) }
async function prune(key) {
  const rows = (await pgPool.query('SELECT id, saved_at, note FROM graal_config_history WHERE config_key = $1 ORDER BY id DESC', [key])).rows;
  const now = Date.now(), seen = new Set(), del = [];
  const freshH = key === 'map' ? 48 : 6, hourlyH = key === 'map' ? 24 * 30 : 72;
  rows.forEach((r, i) => {
    if (i < 5 || r.note === 'boot' || /restaur/.test(r.note || '')) return;
    const t = new Date(r.saved_at).getTime(), ageH = (now - t) / 3600e3;
    if (ageH <= freshH) return;
    const b = ageH <= hourlyH ? 'h' + Math.floor(t / 3600e3) : 'd' + Math.floor(t / 86400e3);
    if (seen.has(b)) del.push(r.id); else seen.add(b);
  });
  if (del.length) await pgPool.query('DELETE FROM graal_config_history WHERE id = ANY($1::bigint[])', [del]);
}
function shrinks(key, oldV, newV) { // devolve o motivo se a nova versão ia APAGAR muita coisa da atual
  let a = null, b = null; try { a = JSON.parse(oldV); b = JSON.parse(newV) } catch (e) { }
  const n = (o, f) => (o && Array.isArray(o[f])) ? o[f].length : 0;
  if (key === 'map') { const x = n(a, 'edits'), y = n(b, 'edits'); return x >= 50 && y < x * 0.7 ? 'o mapa ia de ' + x + ' para ' + y + ' edições' : '' }
  if (key === 'tilesets') {
    const xo = n(a, 'objs'), yo = n(b, 'objs'), xs = n(a, 'sets'), ys = n(b, 'sets');
    if (xo >= 10 && yo < xo * 0.7) return 'as peças iam de ' + xo + ' para ' + yo;
    if (xs >= 3 && ys < xs * 0.7) return 'os tilesets iam de ' + xs + ' para ' + ys;
    return '';
  }
  if (key === 'tsol') { const c = t => (t.match(/1/g) || []).length, x = c(oldV), y = c(newV); return x >= 100 && y < x * 0.5 ? 'a colisão ia de ' + x + ' para ' + y + ' blocos' : '' }
  return oldV.length > 2000 && newV.length < oldV.length * 0.3 ? 'o conteúdo ia de ' + oldV.length + ' para ' + newV.length + ' caracteres' : '';
}
function summ(key, text) {
  try { const o = JSON.parse(text); if (key === 'map') return (o.edits || []).length + ' edições'; if (key === 'tilesets') return (o.sets || []).length + ' tilesets, ' + (o.objs || []).length + ' peças' } catch (e) { }
  return text.length + ' caracteres';
}
let cfgLock = Promise.resolve();
const withLock = fn => { const p = cfgLock.then(fn, fn); cfgLock = p.catch(() => { }); return p };
async function applyConfigWrite(key, v, o) {
  o = o || {};
  const old = typeof cfg[key] === 'string' ? cfg[key] : null;
  if (v === null && PROTECT.has(key) && !o.force) return { ok: false, code: 409, erro: 'protegido', msg: 'Esta configuração não pode ser apagada.' };
  if (v !== null && v === old) return { ok: true, same: true };
  if (v !== null && old !== null && !o.force) {
    if (o.base && o.base !== hashOf(old)) return { ok: false, code: 409, erro: 'desatualizado', msg: 'O servidor tem uma versão mais nova (outro navegador salvou antes).' };
    const why = shrinks(key, old, v);
    if (why) return { ok: false, code: 409, erro: 'encolheria', msg: 'Salvamento bloqueado: ' + why + '. O servidor continua com a versão completa.' };
  }
  if (old !== null) { // nunca grava por cima sem antes guardar a versão atual
    try { await snapshot(key, old, o.note || 'antes', !!o.force) }
    catch (e) { console.error('Falha ao guardar histórico:', key, e.message); return { ok: false, code: 503, erro: 'sem_backup', msg: 'Não consegui guardar a cópia de segurança; nada foi alterado.' } }
  }
  try {
    if (v === null) await pgPool.query('DELETE FROM graal_config WHERE config_key = $1', [key]);
    else await pgPool.query('INSERT INTO graal_config (config_key, config_value) VALUES ($1, $2) ON CONFLICT (config_key) DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = NOW()', [key, v]);
  } catch (e) { console.error('Falha ao gravar configuração no PostgreSQL:', key, e.message); return { ok: false, code: 503, erro: 'falha_banco', msg: 'falha ao salvar no banco' } }
  if (v === null) delete cfg[key]; else cfg[key] = v;
  invalidate(); scheduleSave();
  const msg = JSON.stringify({ t: 'cfg', k: key });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg) }); // avisa os jogadores online
  return { ok: true };
}
process.on('SIGTERM', async () => { if (saveT) flush(); if (accT) clearTimeout(accT); await flushACC(); await npFlush(); adDirty = true; await adFlush(); await pgPool.end(); process.exit(0) });
process.on('SIGINT', async () => { if (saveT) flush(); if (accT) clearTimeout(accT); await flushACC(); await npFlush(); adDirty = true; await adFlush(); await pgPool.end(); process.exit(0) });

/* ---------------- fotos de fundo do perfil (com moderação) ----------------
 *  O jogador envia a foto (JPEG reduzido pelo navegador, ou GIF original) por POST /api/pfbg.
 *  Ela fica PENDENTE: só o dono vê (no próprio navegador). Um admin/dono vê a foto no painel 🛡 e APROVA ou RECUSA.
 *  Só fotos aprovadas são entregues a outros jogadores (GET /api/pfbg/<id do jogador>, buscado só quando alguém abre o perfil).
 *  Admin/dono que envia foto já nasce aprovado. Persistência: PostgreSQL (tabela graal_pfbg). */
const PF_MAX = 1.6 * 1024 * 1024, PF_MAX_GIF = 4 * 1024 * 1024, PF_CACHE_MAX = 48 * 1024 * 1024;
const PF = new Map(); // uh -> { nm, mime, st: 'pend'|'ok'|'no', len, h, at }  (sem os bytes)
const PFD = new Map(); let pfBytes = 0; // cache LRU dos bytes: "uh:h" -> Buffer
const PFC = new Map(); // uh -> 'rrggbb': cor das barras do perfil (vale no site e no Godot; os outros jogadores veem a cor de quem abrem)
const PF_RATE = new Map(); // uh -> [horários dos últimos envios]
async function initPfDB() {
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_pfbg (uh TEXT PRIMARY KEY, nm TEXT, mime TEXT NOT NULL, st TEXT NOT NULL, len INT NOT NULL, h TEXT NOT NULL, at BIGINT NOT NULL, data BYTEA NOT NULL)`);
  const r = await pgPool.query('SELECT uh, nm, mime, st, len, h, at FROM graal_pfbg');
  for (const o of r.rows) PF.set(o.uh, { nm: o.nm || '?', mime: o.mime, st: o.st, len: o.len, h: o.h, at: +o.at });
  console.log('Fotos de perfil:', PF.size, 'guardadas,', pfCount(), 'aguardando aprovação');
  await pgPool.query(`CREATE TABLE IF NOT EXISTS graal_pfcol (uh TEXT PRIMARY KEY, c TEXT NOT NULL)`);
  for (const o of (await pgPool.query('SELECT uh, c FROM graal_pfcol')).rows) PFC.set(o.uh, o.c);
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
function pcHttp(req, res, url) { // /api/pfcol/me (GET) · /api/pfcol (POST {c:'rrggbb'}) · DELETE volta ao padrão
  const m = url.match(/^\/api\/pfcol(\/me)?$/);
  if (!m) return false;
  const uh = pfUh(req), fail = e => { console.error('pfcol:', e && e.message); if (!res.headersSent) pfJson(res, 500, { ok: false }) };
  if (req.method === 'GET') { pfJson(res, 200, { c: (uh && PFC.get(uh)) || null }); return true }
  if (!uh) { req.resume(); pfJson(res, 401, { ok: false, erro: 'sem identidade' }); return true }
  if (req.method !== 'POST' && req.method !== 'DELETE') { req.resume(); pfJson(res, 405, { ok: false }); return true }
  const apply = c => { // guarda e avisa: os outros jogadores recebem o perfil novo; as outras sessões desta conta recebem 'pfc'
    for (const o of P.values()) if (o.uh === uh) {
      if (o.pi) { o.pi.bc = c || ''; if (!o.hid) others(o.id, Object.assign({ t: 'pi', id: o.id }, o.pi)) }
      sendTo(o.ws, { t: 'pfc', c: c || '' });
    }
    pfJson(res, 200, { ok: true, c: c || null });
  };
  if (req.method === 'DELETE') { req.resume(); pgPool.query('DELETE FROM graal_pfcol WHERE uh = $1', [uh]).then(() => { PFC.delete(uh); apply('') }).catch(fail); return true }
  let size = 0, dead = false; const chunks = [];
  req.on('data', d => { size += d.length; if (size > 256) { dead = true; pfJson(res, 413, { ok: false }); req.destroy() } else chunks.push(d) });
  req.on('end', () => {
    if (dead) return;
    let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (e) {}
    const c = j && /^#?[0-9a-fA-F]{6}$/.test(String(j.c)) ? String(j.c).replace('#', '').toLowerCase() : null;
    if (!c) return pfJson(res, 400, { ok: false, erro: 'cor inválida' });
    pgPool.query(`INSERT INTO graal_pfcol (uh, c) VALUES ($1,$2) ON CONFLICT (uh) DO UPDATE SET c = EXCLUDED.c`, [uh, c]).then(() => { PFC.set(uh, c); apply(c) }).catch(fail);
  });
  return true;
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
  const tk = String(req.headers['x-admin-ticket'] || ''); // admin (cargo dado pelo dono): ticket recebido pelo WebSocket
  if (tk.length >= 32) { for (const o of P.values()) if (o.role >= 1 && o.cfgTk && o.cfgTk.length === tk.length && crypto.timingSafeEqual(Buffer.from(o.cfgTk), Buffer.from(tk))) return true }
  const t = String(req.headers['x-admin-token'] || '');
  if (!ADMIN) return isLoop(req); // sem ADMIN_TOKEN só aceita escrita de localhost
  const a = Buffer.from(t), b = Buffer.from(ADMIN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) };

let IDX = null; // index.html em memória (bruto + gzip)
const srv = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  // SITE PC: / mostra o portal completo. /pagina-jogo.html é a página real.
  // APK/Android: continua carregando o index.html normalmente, inclusive ?login=1.
  // /index.html serve o jogo bruto para o iframe do portal, sem redirecionamento.
  if ((req.method === 'GET' || req.method === 'HEAD') && url === '/pagina-jogo.html') {
    const portal = path.join(__dirname, 'public', 'pagina-jogo.html');
    return fs.readFile(portal, (err, body) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Página do jogo não encontrada') }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : body);
    });
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url === '/') {
    const ua = String(req.headers['user-agent'] || '');
    const androidOrPhone = /Android|iPhone|iPad|iPod|Mobile/i.test(ua);
    const query = new URL(req.url || '/', 'http://localhost').searchParams;
    // Deixa links de login/logout/admin e o Capacitor ?login=1 entrarem direto no jogo.
    const gameQuery = ['login', 'logout', 'admin', 'sync', 'code', 'state'].some(k => query.has(k));
    if (!androidOrPhone && !gameQuery) {
      res.writeHead(302, { Location: '/pagina-jogo.html', 'Cache-Control': 'no-store' });
      return res.end();
    }
  }

  if (url === '/auth/discord' && req.method === 'GET') {
    if (!AUTH_ON) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Login com Discord não configurado no servidor.') }
    const st = crypto.randomBytes(16).toString('hex');
    const q = new URLSearchParams({ client_id: DC_ID, response_type: 'code', scope: 'identify', redirect_uri: baseUrl(req) + '/auth/discord/callback', state: st, prompt: 'none' });
    const isApp = new URL(req.url, 'http://x').searchParams.get('app') === '1';
    res.writeHead(302, { Location: 'https://discord.com/oauth2/authorize?' + q, 'Set-Cookie': [ck(req, 'gst', st, 600), ck(req, 'gapp', isApp ? '1' : '', isApp ? 600 : 0)] }); return res.end();
  }
  if (url === '/auth/app/redeem' && req.method === 'GET') { // o app troca o código por uma sessão (a mesma que o cookie gsid do navegador)
    const c = String(new URL(req.url, 'http://x').searchParams.get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), e = APPCODES.get(c);
    APPCODES.delete(c);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    if (!AUTH_ON || !e || e.exp < Date.now() || !ACC[e.id]) return res.end(JSON.stringify({ ok: false }));
    return res.end(JSON.stringify({ ok: true, sess: mkSession(e.id), name: ACC[e.id].name }));
  }
  if (url === '/auth/discord/callback' && req.method === 'GET') return discordCallback(req, res);
  if (url === '/auth/logout') { const sid = sessionOf(req), pl = sid && ACTIVE_ACC.get(sid); if (pl) { if (pl.svTm) clearTimeout(pl.svTm); if (pl.svD) { applySv(pl, pl.svD); pl.svD = null } ACTIVE_ACC.delete(sid); pl.acc = null; sendTo(pl.ws, { t: 'out' }); setTimeout(() => { try { pl.ws.close() } catch (e) { } }, 200) } res.writeHead(302, { Location: '/?logout=1', 'Set-Cookie': [ck(req, 'gsid', '', 0), ck(req, 'gst', '', 0)], 'Cache-Control': 'no-store' }); return res.end() }
  if (url === '/api/acc' && req.method === 'GET') { // progresso da conta entregue ANTES do jogo começar (o navegador aplica antes de carregar o jogo)
    const id = sessionOf(req), a = id && ACC[id];
    if (a) { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify({ on: true, id: a.id, pid: pidOf(a), data: a.data || {} })) }
    const g = guestOf(req) || newGid(), ga = ACC[g]; // sem Discord: conta de visitante (o cookie é renovado a cada visita)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': ck(req, 'ggid', g, GUEST_DAYS * 86400) });
    return res.end(JSON.stringify({ on: true, id: g, guest: true, data: (ga && ga.data) || {} }));
  }
  if (url === '/api/me' && req.method === 'GET') {
    const id = sessionOf(req), a = id && ACC[id];
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ on: AUTH_ON, user: a ? { id: a.id, pid: pidOf(a), name: a.name, av: avatarOf(a) } : null }));
  }

  if (url.startsWith('/api/pfbg') && pfHttp(req, res, url)) return;
  if (url.startsWith('/api/pfcol') && pcHttp(req, res, url)) return;

  if (url === '/graal-config.json' && req.method === 'GET') {
    const c = getCache();
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache', ETag: c.etag, 'X-Cfg-Rev': c.rev };
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
    req.on('end', async () => {
      if (size > MAX_BODY) return;
      let v; try { v = JSON.parse(Buffer.concat(chunks).toString('utf8')).v } catch (e) { return send(res, 400, { ok: false, erro: 'JSON inválido' }) }
      if (v !== null && !(typeof v === 'string' && KEYS[key](v))) return send(res, 400, { ok: false, erro: 'valor inválido para ' + key });
      const force = String(req.headers['x-force-write'] || '') === 'sim' && !!ADMIN && String(req.headers['x-admin-token'] || '') === ADMIN; // só o dono, com o token, pode passar por cima das proteções
      const r = await withLock(() => applyConfigWrite(key, v, { base: String(req.headers['x-base-rev'] || ''), force }));
      if (!r.ok) return send(res, r.code, { ok: false, erro: r.erro, msg: r.msg });
      send(res, 200, { ok: true, etag: getCache().etag, rev: typeof cfg[key] === 'string' ? hashOf(cfg[key]) : '' });
    });
    return;
  }

  /* histórico e restauração (admin): GET /api/config-history/:chave  ·  GET /api/config-history/:chave/:id  ·  POST /api/config-restore/:chave/:id */
  const hm = url.match(/^\/api\/config-(history|restore)\/([a-z]+)(?:\/(\d+))?$/);
  if (hm) {
    if (!isAdmin(req)) { req.resume(); return send(res, 403, { ok: false, erro: 'token inválido' }) }
    const act = hm[1], hkey = hm[2], hid = hm[3];
    if (!KEYS[hkey]) return send(res, 404, { ok: false, erro: 'chave desconhecida' });
    (async () => {
      try {
        if (act === 'history' && req.method === 'GET' && !hid) {
          const lim = Math.max(1, Math.min(200, +(new URL(req.url, 'http://x').searchParams.get('limite')) || 40));
          const rows = (await pgPool.query('SELECT id, saved_at, size, note, config_gz FROM graal_config_history WHERE config_key = $1 ORDER BY id DESC LIMIT $2', [hkey, lim])).rows;
          const atual = typeof cfg[hkey] === 'string' ? { rev: hashOf(cfg[hkey]), info: summ(hkey, cfg[hkey]) } : null;
          return send(res, 200, { ok: true, chave: hkey, atual, versoes: rows.map(r => ({ id: String(r.id), em: new Date(r.saved_at).toISOString(), tamanho: r.size, nota: r.note, info: summ(hkey, zlib.gunzipSync(r.config_gz).toString('utf8')) })) });
        }
        if (act === 'history' && req.method === 'GET' && hid) {
          const r = (await pgPool.query('SELECT config_gz FROM graal_config_history WHERE config_key = $1 AND id = $2', [hkey, hid])).rows[0];
          if (!r) return send(res, 404, { ok: false, erro: 'versão não encontrada' });
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(zlib.gunzipSync(r.config_gz));
        }
        if (act === 'restore' && req.method === 'POST' && hid) {
          const r = (await pgPool.query('SELECT config_gz FROM graal_config_history WHERE config_key = $1 AND id = $2', [hkey, hid])).rows[0];
          if (!r) return send(res, 404, { ok: false, erro: 'versão não encontrada' });
          const text = zlib.gunzipSync(r.config_gz).toString('utf8');
          const w = await withLock(() => applyConfigWrite(hkey, text, { force: true, note: 'antes-de-restaurar' }));
          if (!w.ok) return send(res, w.code, { ok: false, erro: w.erro, msg: w.msg });
          return send(res, 200, { ok: true, restaurado: hid, info: summ(hkey, text) });
        }
        send(res, 405, { ok: false, erro: 'método não suportado' });
      } catch (e) { console.error('histórico:', e.message); send(res, 500, { ok: false, erro: 'falha no histórico' }) }
    })();
    return;
  }

  /* arquivos do PWA/APK (manifest, service worker, ícones e o assetlinks.json do Android) */
  if ((req.method === 'GET' || req.method === 'HEAD') && (url === '/manifest.webmanifest' || url === '/sw.js' || /^\/vendor\/[a-z0-9.\-]+\.js$/.test(url) || url === '/.well-known/assetlinks.json' || /^\/icons\/[a-z0-9-]+\.png$/.test(url) || url === '/assets/bluechoco.png' || url === '/assets/aetheria-login-background.png' || url === '/assets/aetheria-login-background.webp')) {
    const f = path.join(__dirname, 'public', url);
    const ct = url.endsWith('.webp') ? 'image/webp' : url.endsWith('.png') ? 'image/png' : url.endsWith('.js') ? 'application/javascript; charset=utf-8' : url.endsWith('.json') ? 'application/json' : 'application/manifest+json; charset=utf-8';
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
/* Saiu (fechou, celular matou o app, a internet caiu): o servidor já recebe a posição do jogador o tempo todo, então grava a ÚLTIMA posição conhecida na conta.
   No mundo aberto só vale perto do último ponto salvo pelo navegador (se teleportou, mantém o que o navegador salvou); dentro de casa grava a posição do interior. */
function savePosOnLeave(p) {
  try {
    const a = p.acc && ACC[p.acc];
    if (!a || ACTIVE_ACC.get(p.acc) !== p || !p.ok || p.al !== 1 || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (p.il) { // estava dentro de uma casa: grava a posição do interior e o ponto de retorno
      const o = { x: p.il.x, y: p.il.y, f: p.il.f, l: 'i' }; if (p.il.r) o.r = p.il.r;
      a.data = Object.assign(a.data || {}, { graal_pos_v1: JSON.stringify(o) }); a.last = Date.now(); saveACC(a.id); return;
    }
    let o = null; try { o = JSON.parse((a.data || {}).graal_pos_v1 || 'null') } catch (e) { }
    if (!o || o.l !== 'w' || !Number.isFinite(o.x) || !Number.isFinite(o.y)) return;
    if (Math.hypot(p.x - o.x, p.y - o.y) > 600) return;
    const f = (/(Up|Down|Left|Right)$/.exec(String(p.an || '')) || [])[1] || o.f;
    if (o.x === Math.round(p.x) && o.y === Math.round(p.y) && o.f === f) return;
    o.x = Math.round(p.x); o.y = Math.round(p.y); o.f = f;
    a.data = Object.assign(a.data || {}, { graal_pos_v1: JSON.stringify(o) }); a.last = Date.now(); saveACC(a.id);
  } catch (e) { console.error('savePosOnLeave:', e.message) }
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
  const now = Date.now(); let h = 0, hh = 0; // hh: melhor candidato entre os ocultos (invisível/espectador) — só vale se não houver ninguém visível
  for (const q of P.values()) if (q.ok && now - q.uT < 4000) { if (q.hid) { if (!hh || q.id < hh) hh = q.id } else if (!h || q.id < h) h = q.id }
  if (!h) h = hh;
  if (h === HOST) return;
  const old = P.get(HOST); if (old) sendTo(old.ws, { t: 'host', v: 0 });
  HOST = h; const nw = P.get(h); if (nw) sendTo(nw.ws, { t: 'host', v: 1 });
}
setInterval(electHost, 1000);
/* itens no chão (Glims): o servidor lembra para quem entra depois; id -> [id,x,y,v]; máx. 300 (o mais antigo some para todos) */
const DROPS = new Map();
setInterval(() => { const n = Date.now(); for (const [k, a] of DROPS) if (a[5] && a[5] < n) DROPS.delete(k) }, 5000); // corações/bombas/flechas somem em 20s
const LOCAL_CHAT_RADIUS = 320;
function canHearLocal(sender, receiver) {
  if (!receiver || !receiver.ok || !!sender.in !== !!receiver.in) return false;
  // Os interiores compartilham coordenadas; a porta diferencia as casas.
  if (sender.in && (Math.abs(sender.x - receiver.x) > 16 || Math.abs(sender.y - receiver.y) > 16)) return false;
  const ax = sender.in ? sender.ix : sender.x, ay = sender.in ? sender.iy : sender.y;
  const bx = receiver.in ? receiver.ix : receiver.x, by = receiver.in ? receiver.iy : receiver.y;
  return [ax, ay, bx, by].every(Number.isFinite) && Math.hypot(ax - bx, ay - by) <= LOCAL_CHAT_RADIUS;
}
const CHAT = []; // histórico do chat global (últimas 60 mensagens), enviado a quem entra
const others = (id, msg) => wss.clients.forEach(c => { if (c.pid !== id) sendTo(c, msg) });
/* v16: igual a others(), mas só para quem está no mesmo espaço (mundo aberto ou dentro de casa): bombas/flechas/fogo de dentro de casa não aparecem no mundo e vice-versa */
const othersSame = (p, msg) => wss.clients.forEach(c => { if (c.pid === p.id) return; const q = P.get(c.pid); if (!q || String(q.spar || '') !== String(p.spar || '') || !!q.in !== !!p.in) return; sendTo(c, msg) });
const SPAR_QUEUE = [];
const SPAR_MATCHES = new Map();
const SPAR_PENDING = new Map();
let sparNextId = 1;
const SPAR_ARENA = { x: 512, y: 512, w: 288, h: 224 };
function cleanSparArea(a) {
  if (!a || typeof a !== 'object') return null;
  const x = +a.x, y = +a.y, w = +a.w, h = +a.h;
  if (![x, y, w, h].every(Number.isFinite) || x < 0 || y < 0 || w < 16 || h < 16 || w > 100000 || h > 100000 || x + w > 1e6 || y + h > 1e6) return null;
  return { x: Math.round(x / 8) * 8, y: Math.round(y / 8) * 8, w: Math.round(w / 8) * 8, h: Math.round(h / 8) * 8 };
}
function cleanSparConfig(value) {
  if (!value || typeof value !== 'object') return null;
  // Compatibilidade com a configuração antiga, que guardava um único retângulo.
  const rawAreas = Array.isArray(value.areas) ? value.areas : (cleanSparArea(value) ? [{ ...value, name: 'Spar' }] : []);
  if (rawAreas.length > 32) return null;
  const areas = [];
  const legacySpawns = Array.isArray(value.spawns) ? value.spawns : [];
  for (let i = 0; i < rawAreas.length; i++) {
    const item = rawAreas[i];
    const rect = cleanSparArea(item);
    if (!rect) return null;
    const name = String(item.name || '').trim().slice(0, 32);
    if (!name) return null;
    let rawSpawns = Array.isArray(item.spawns) ? item.spawns : (i === 0 ? legacySpawns : []);
    if (rawSpawns.length > 2) return null;
    const spawns = rawSpawns.map(spawn => spawn == null ? null : cleanSparArea(spawn));
    if (spawns.some(spawn => spawn === null) && rawSpawns.some(spawn => spawn != null)) return null;
    while (spawns.length < 2) spawns.push(null);
    if (spawns[0] && spawns[1] && spawns[0].x === spawns[1].x && spawns[0].y === spawns[1].y && spawns[0].w === spawns[1].w && spawns[0].h === spawns[1].h) return null;
    areas.push({ name, ...rect, spawns });
  }
  return { areas };
}
function sparArea() { try { return cleanSparConfig(JSON.parse(cfg.spararea || 'null')) || { areas: [], spawns: [null, null] } } catch (_) { return { areas: [], spawns: [null, null] } } }
function findSparArea(p) { const x = p.in ? +p.ix : +p.x, y = p.in ? +p.iy + 80000 : +p.y; if (!Number.isFinite(x) || !Number.isFinite(y)) return null; return sparArea().areas.find(a => x >= a.x && y >= a.y && x < a.x + a.w && y < a.y + a.h) || null }
function inSparArea(p) { return !!findSparArea(p) }
function sparQueueState() {
  const n = SPAR_QUEUE.length;
  for (const id of SPAR_QUEUE) { const q = P.get(id); if (q) sendTo(q.ws, { t: 'spq', s: 'waiting', n }) }
}
function removeSparQueue(id) {
  const i = SPAR_QUEUE.indexOf(id);
  if (i >= 0) SPAR_QUEUE.splice(i, 1);
  const p = P.get(id);
  if (p) p.sparAreaConfig = null;
  sparQueueState();
}
function finishSpar(matchId, winnerId = 0, reason = 'cancelled') {
  const match = SPAR_MATCHES.get(String(matchId));
  if (!match || match.done) return;
  match.done = true;
  SPAR_MATCHES.delete(String(matchId));
  for (const id of match.players) {
    const q = P.get(id);
    if (!q) continue;
    q.spar = null;
    q.phFrom = 0; q.phT = 0;
    const back = match.returns[id];
    q.x = back.x; q.y = back.y; q.in = back.in ? 1 : 0; if (back.in) { q.ix = back.ix; q.iy = back.iy; q.ia = back.ia } else { q.ix = undefined; q.iy = undefined; q.ia = undefined } q.hp = q.hm; q.mt = 0; q.cy = 0; q.ac = 0;
    sendTo(q.ws, { t: 'spm', s: 'end', r: reason, w: winnerId === id, x: back.in ? back.ix : back.x, y: back.in ? back.iy + 80000 : back.y, in: back.in ? 1 : 0, ix: back.in ? back.ix : undefined, iy: back.in ? back.iy : undefined, f: back.f });
  }
}
function cancelSparCountdown(pendingId) {
  const pending = SPAR_PENDING.get(String(pendingId));
  if (!pending) return;
  clearTimeout(pending.timer);
  SPAR_PENDING.delete(String(pendingId));
  for (const id of pending.players) {
    const q = P.get(id), back = pending.returns[id];
    if (!q || q.sparPending !== pending.id) continue;
    q.sparPending = null; q.x = back.x; q.y = back.y; q.in = back.in ? 1 : 0;
    if (back.in) { q.ix = back.ix; q.iy = back.iy; q.ia = back.ia } else { q.ix = undefined; q.iy = undefined; q.ia = undefined }
    sendTo(q.ws, { t: 'spm', s: 'end', r: 'cancelled', x: back.in ? back.ix : back.x, y: back.in ? back.iy + 80000 : back.y, in: back.in ? 1 : 0, ix: back.in ? back.ix : undefined, iy: back.in ? back.iy : undefined, f: back.f });
    sendTo(q.ws, { t: 'spq', s: 'idle', n: SPAR_QUEUE.length });
  }
}
function startSpar(a, b, sparConfig) {
  if (a.sparPending || b.sparPending) return;
  const id = 'count-' + String(sparNextId++), players = [a, b], returns = {};
  for (const q of players) returns[q.id] = { x: q.x, y: q.y, in: !!q.in, ix: q.ix, iy: q.iy, ia: q.ia, f: (/(Up|Down|Left|Right)$/.exec(String(q.in ? q.ia : q.an || '')) || [])[1] || 'Down' };
  const customSpawns = !!sparConfig && Array.isArray(sparConfig.spawns) && sparConfig.spawns.length === 2 && sparConfig.spawns.every(Boolean);
  const pickSpawn = area => {
    const marginX = Math.min(20, Math.floor(area.w / 4)), marginY = Math.min(20, Math.floor(area.h / 4));
    const x0 = area.x + marginX, y0 = area.y + marginY;
    const w = Math.max(1, area.w - marginX * 2 - 1), h = Math.max(1, area.h - marginY * 2 - 1);
    return { x: Math.round(x0 + Math.random() * w), y: Math.round(y0 + Math.random() * h) };
  };
  const spawns = customSpawns ? [
    { ...pickSpawn(sparConfig.spawns[0]), f: 'Right' },
    { ...pickSpawn(sparConfig.spawns[1]), f: 'Left' }
  ] : [
    { x: SPAR_ARENA.x + 84, y: SPAR_ARENA.y + 112, f: 'Right' },
    { x: SPAR_ARENA.x + 204, y: SPAR_ARENA.y + 112, f: 'Left' }
  ];
  const center = sparConfig && Number.isFinite(+sparConfig.x) && Number.isFinite(+sparConfig.y)
    ? { x: +sparConfig.x + (+sparConfig.w / 2), y: +sparConfig.y + (+sparConfig.h / 2) }
    : { x: SPAR_ARENA.x + SPAR_ARENA.w / 2, y: SPAR_ARENA.y + SPAR_ARENA.h / 2 };
  const pending = { id, players: players.map(q => q.id), returns, spawns, timer: null };
  SPAR_PENDING.set(id, pending);
  for (let i = 0; i < players.length; i++) {
    const q = players[i], sp = spawns[i], back = returns[q.id];
    q.sparPending = id;
    if (back.in) { q.in = 1; q.ix = sp.x; q.iy = sp.y - 80000; q.ia = 'Idle_' + sp.f }
    else { q.x = sp.x; q.y = sp.y; q.in = 0; q.an = 'Idle_' + sp.f }
    sendTo(q.ws, { t: 'spm', s: 'countdown', m: id, x: sp.x, y: sp.y, f: sp.f, center_x: center.x, center_y: center.y, custom: customSpawns ? 1 : 0, in: back.in ? 1 : 0, ix: back.in ? sp.x : undefined, iy: back.in ? sp.y - 80000 : undefined, ms: 1800 });
    sendTo(q.ws, { t: 'bo', sx: center.x, sy: center.y + 6, tx: center.x, ty: center.y + 6, fl: 0, bt: 1.8, spar: 1 });
  }
  pending.timer = setTimeout(() => {
    if (SPAR_PENDING.get(id) !== pending) return;
    SPAR_PENDING.delete(id);
    for (const pid of pending.players) { const q = P.get(pid); if (q && q.sparPending === id) q.sparPending = null; }
    if (P.get(a.id) === a && P.get(b.id) === b && a.ws.readyState === 1 && b.ws.readyState === 1) startSparNow(a, b, sparConfig, spawns, returns);
    else for (const q of players) if (P.get(q.id) === q) sendTo(q.ws, { t: 'spq', s: 'idle', n: SPAR_QUEUE.length });
  }, 1800);
}
function startSparNow(a, b, sparConfig, spawns, returns) {
  const id = String(sparNextId++);
  const players = [a, b];
  const match = { id, players: players.map(q => q.id), returns, done: false };
  SPAR_MATCHES.set(id, match);
  const customSpawns = !!sparConfig && Array.isArray(sparConfig.spawns) && sparConfig.spawns.length === 2 && sparConfig.spawns.every(Boolean);
  for (let i = 0; i < players.length; i++) {
    const q = players[i], other = players[1 - i], sp = spawns[i];
    q.sparAreaConfig = null;
    q.spar = id; q.mt = 0; q.cy = 0; q.hp = q.hm; q.ac = 0; q.uT = Date.now();
    if (returns[q.id].in) { q.in = 1; q.ix = sp.x; q.iy = sp.y - 80000; q.ia = 'Idle_' + sp.f } else { q.x = sp.x; q.y = sp.y; q.in = 0; q.an = 'Idle_' + sp.f }
    sendTo(q.ws, { t: 'spm', s: 'start', m: id, x: sp.x, y: sp.y, f: sp.f, custom: customSpawns ? 1 : 0, in: returns[q.id].in ? 1 : 0, ix: returns[q.id].in ? sp.x : undefined, iy: returns[q.id].in ? sp.y - 80000 : undefined, ox: SPAR_ARENA.x, oy: SPAR_ARENA.y, ow: SPAR_ARENA.w, oh: SPAR_ARENA.h, oi: other.id, on: String(other.nm || '?') });
  }
}
function requestSpar(p, join) {
  if (!join) {
    removeSparQueue(p.id);
    if (p.sparPending) cancelSparCountdown(p.sparPending);
    p.sparAreaConfig = null;
    if (p.spar) finishSpar(p.spar, 0, 'cancelled');
    sendTo(p.ws, { t: 'spq', s: 'idle', n: SPAR_QUEUE.length });
    return;
  }
  const selectedArea = findSparArea(p);
  if (!selectedArea) {
    sendTo(p.ws, { t: 'spq', s: 'error', msg: 'Vá até a área de spar marcada no mapa para entrar.' });
    return;
  }
  if (!p.ok || p.hid || p.mt || p.cy || p.hp <= 0 || !Number.isFinite(p.x) || !Number.isFinite(p.y) || (p.in && (!Number.isFinite(p.ix) || !Number.isFinite(p.iy)))) {
    sendTo(p.ws, { t: 'spq', s: 'error', msg: 'Não foi possível entrar no spar agora.' });
    return;
  }
  if (p.in && !(Array.isArray(selectedArea.spawns) && selectedArea.spawns.length === 2 && selectedArea.spawns.every(Boolean))) {
    sendTo(p.ws, { t: 'spq', s: 'error', msg: 'Defina os dois spawns da área para jogar spar dentro do interior.' });
    return;
  }
  if (p.sparPending) { sendTo(p.ws, { t: 'spq', s: 'waiting', n: SPAR_QUEUE.length }); return }
  if (p.spar) { sendTo(p.ws, { t: 'spq', s: 'active', n: SPAR_QUEUE.length }); return }
  if (SPAR_QUEUE.includes(p.id)) { removeSparQueue(p.id); p.sparAreaConfig = null; sendTo(p.ws, { t: 'spq', s: 'idle', n: SPAR_QUEUE.length }); return }
  let other = null;
  while (SPAR_QUEUE.length && !other) {
    const id = SPAR_QUEUE.shift(), q = P.get(id);
    const sameSpace = q && !!q.in === !!p.in && (!p.in || (Math.abs(q.x - p.x) <= 16 && Math.abs(q.y - p.y) <= 16)); if (q && q !== p && sameSpace && q.ok && !q.hid && !q.spar && Date.now() - (q.uT || 0) < 5000) other = q;
    else if (q) q.sparAreaConfig = null;
  }
  if (!other) {
    p.sparAreaConfig = selectedArea;
    SPAR_QUEUE.push(p.id);
    sendTo(p.ws, { t: 'spq', s: 'waiting', n: SPAR_QUEUE.length });
    sparQueueState();
    return;
  }
  const arenaConfig = other.sparAreaConfig || selectedArea;
  p.sparAreaConfig = selectedArea;
  startSpar(other, p, arenaConfig);
  sparQueueState();
}
/* invisibilidade / espectador (só admin e dono): o servidor simplesmente PARA de mostrar esse jogador aos outros (nem posição, nem skin, nem perfil).
   Quem vê o personagem transparente é só o próprio admin, no cliente dele. Espectador = invisível + (no cliente) imortal, atravessa tudo e não ataca. */
function setHidden(p, h, sp) {
  removeSparQueue(p.id);
  if (p.spar) finishSpar(p.spar, 0, 'cancelled');
  const was = !!p.hid; p.hid = (h || sp) ? 1 : 0; p.spec = sp ? 1 : 0;
  if (p.hid && !was) others(p.id, { t: 'l', id: p.id });          // some da tela de todo mundo
  else if (!p.hid && was) {                                        // volta a aparecer: reenvia skin/equipamento/perfil/posição
    const id = p.id;
    if (p.bs || p.hs) others(id, { t: 'k', id, bs: p.bs, hs: p.hs });
    if (p.c) others(id, { t: 'kc', id, c: p.c });
    if (p.e) others(id, { t: 'q', id, e: p.e });
    if (p.pi) others(id, Object.assign({ t: 'pi', id }, p.pi));
    if (p.ok) others(id, JSON.stringify({ t: 'pu', p: pstate(p) }));
  }
  electHost();
}
const onlineList = () => [...P.values()].filter(q => q.ok).sort((a, b) => a.id - b.id).map(q => ({ id: q.id, nm: String(q.nm || '?'), r: q.role | 0, lv: q.lv | 0, hid: q.hid ? 1 : 0, sp: q.spec ? 1 : 0, mu: q.muted ? 1 : 0, dc: q.acc && !GID_RE.test(q.acc) ? 1 : 0 }));

wss.on('connection', (ws, req) => {
  const id = nid++; ws.pid = id; ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true });
  const p = { id, ws, x: 0, y: 0, nm: '?', an: 'Idle_Down', al: 1, b: 0, h: 0, s: 0, sw: 0, ok: 0, bs: null, hs: null, c: null, e: null, lastChat: 0, bT: 0, bN: 0, svT: 0, acc: null,
    role: 0, uh: null, muted: 0, authFails: 0, cmdT: 0, spT: 0 };
  P.set(id, p);
  sendTo(ws, { t: 'id', id, v: 3 });
  if (HOST) sendTo(ws, { t: 'host', v: 0 }); // já existe anfitrião: este cliente só copia os monstros
  sendTo(ws, spAll()); // spawns de monstros (iguais para todos)
  sendTo(ws, npAll()); // NPCs vendedores (iguais para todos)
  sendTo(ws, { t: 'spa', a: sparArea() }); // área de acesso à fila de spar, compartilhada e persistente
  if (CHAT.length) sendTo(ws, { t: 'chh', a: CHAT });
  if (DROPS.size) { const now = Date.now(); sendTo(ws, { t: 'dall', a: [...DROPS.values()].map(a => [a[0], a[1], a[2], a[3], a[4] || 0, a[5] ? Math.max(0, a[5] - now) : 0]) }) }
  { const now = Date.now(), a = []; BCUT.forEach((t, k) => { if (t > now) { const q = k.split(','); a.push([+q[0], +q[1], t - now]) } }); if (a.length) sendTo(ws, { t: 'ball', a }) } // arbustos que estão cortados agora
  for (const o of P.values()) if (o.id !== id && !o.hid) { // quem entra agora já vê skin/equip de quem está online (menos de quem está invisível)
    if (o.bs || o.hs) sendTo(ws, { t: 'k', id: o.id, bs: o.bs, hs: o.hs });
    if (o.c) sendTo(ws, { t: 'kc', id: o.id, c: o.c });
    if (o.e) sendTo(ws, { t: 'q', id: o.id, e: o.e });
    if (o.pi) sendTo(ws, Object.assign({ t: 'pi', id: o.id }, o.pi));
  }

  const hiT = setTimeout(() => { if (!p.uh && ws.readyState === 1) { sendTo(ws, { t: 'kick', r: 'Recarregue a página (F5) para entrar no jogo.' }); setTimeout(() => ws.close(), 100) } }, 8000);
  ws.on('close', () => clearTimeout(hiT));
  const setRole = r => { p.role = r; sendTo(ws, { t: 'role', r }); if (r >= 1) { sendTo(ws, { t: 'adm', pfn: pfCount(), cfg: punCfg() }); if (!p.cfgTk) p.cfgTk = crypto.randomBytes(24).toString('hex'); sendTo(ws, { t: 'cfgtk', k: p.cfgTk }) } else p.cfgTk = null /* ticket de salvar mapa/tilesets: só quem tem cargo, vale enquanto conectado */ };
  const note = x => sendTo(ws, { t: 'adm', note: x });
  const lists = () => sendTo(ws, { t: 'adm',
    admins: Object.entries(AD.admins).map(([k, v]) => ({ k, nm: v.nm })),
    bans: Object.entries(AD.bans).filter(([k]) => banOf(k)).map(([k, v]) => ({ k, nm: v.nm, until: v.until || 0 })) });

  { // mesmo aparelho (cookie ggid) já online com OUTRA identidade (ex.: acabou de sair da conta Discord): remove o antigo na hora, sem esperar o fechamento do socket
    const dev = guestOf(req);
    if (dev) { p.dev = dev; for (const o of [...P.values()]) if (o !== p && o.dev === dev) { sendTo(o.ws, { t: 'dup' }); setTimeout(() => { try { o.ws.close() } catch (e) { } }, 100); P.delete(o.id); others(o.id, { t: 'l', id: o.id }) } }
  }
  { // conectou com a sessão do Discord: a identidade (bans/admins) passa a ser a conta, e o progresso vem do servidor
    const sid = sessionOf(req);
    if (sid) {
      p.acc = sid; p.uh = sha('discord:' + sid);
      const ku = KICKED.get(p.uh), bn = banOf(p.uh);
      if (bn) { sendTo(ws, { t: 'kick', r: banMsg(bn) }); setTimeout(() => ws.close(), 100) }
      else if (ku && ku > Date.now()) { sendTo(ws, { t: 'kick', r: 'Você foi expulso do servidor. Volte em ' + fmtDur(ku - Date.now()) + '.' }); setTimeout(() => ws.close(), 100) }
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
      const bn = banOf(p.uh); if (bn) { sendTo(ws, { t: 'kick', r: banMsg(bn) }); setTimeout(() => ws.close(), 100); return }
      const ku = KICKED.get(p.uh);
      if (ku && ku > Date.now()) { sendTo(ws, { t: 'kick', r: 'Você foi expulso do servidor. Volte em ' + fmtDur(ku - Date.now()) + '.' }); setTimeout(() => ws.close(), 100); return }
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
    if (m.t === 'spq') { requestSpar(p, !!m.join); return }
    if (m.t === 'spa') { // área do botão de spar: só admin/dono pode alterar; salva no config persistente e avisa todos
      if (p.role < 1) return;
      const now = Date.now(); if (now - (p.spaT || 0) < 500) return; p.spaT = now;
      const config = m.a == null ? { areas: [], spawns: [null, null] } : cleanSparConfig(m.a);
      if (m.a != null && !config) return sendTo(ws, { t: 'spa', a: sparArea(), err: 'Configuração inválida. Confira os nomes e os retângulos de spar.' });
      (async () => {
        const empty = config.areas.length === 0;
        const value = empty ? null : JSON.stringify(config);
        const r = await withLock(() => applyConfigWrite('spararea', value, { note: 'área-de-spar' }));
        if (!r.ok) return sendTo(ws, { t: 'spa', a: sparArea(), err: r.msg || 'Não foi possível salvar a área.' });
        wss.clients.forEach(c => sendTo(c, { t: 'spa', a: empty ? { areas: [] } : config }));
      })().catch(e => { console.error('Área de spar:', e.message); sendTo(ws, { t: 'spa', a: sparArea(), err: 'Falha ao salvar a área do spar.' }) });
      return;
    }
    if (m.t === 'a') { // comandos do painel admin
      if (p.role < 1) return;
      const now = Date.now(); if (now - p.cmdT < 80) return; p.cmdT = now;
      const owner = p.role === 2, c = String(m.c || ''), tg = P.get(+m.id);
      const can = o => o && o !== p && (owner ? o.role < 2 : o.role < 1); // admin só mexe em jogador comum; dono em todos menos nele mesmo
      const nameOf = o => String(o.nm || '?');
      if (c === 'say') { const x = String(m.x || '').trim().slice(0, 100); if (!x) return; const out = JSON.stringify({ t: 'c', id: 0, nm: '📢 Aviso', x }); wss.clients.forEach(k => sendTo(k, out)); return }
      if (c === 'hid') { setHidden(p, !!m.v, !!m.sp); return } // invisível / espectador (some para os outros)
      if (c === 'ol') { sendTo(ws, { t: 'adm', ol: onlineList() }); return } // quem está online (inclui os invisíveis)
      if (c === 'pun') { // tempos padrão de expulsão (admin/dono) e de ban (só o dono), em minutos
        let ch = 0;
        if (m.kick !== undefined) { AD.cfg.kickMin = cleanMin(m.kick, kickMin()); ch = 1 }
        if (m.ban !== undefined) { if (owner) { AD.cfg.banMin = cleanMin(m.ban, banMin()); ch = 1 } else note('Só o dono muda o tempo de ban.') }
        if (ch) { saveAD(); pfAdmins({ t: 'adm', cfg: punCfg() }); note('⏱ Salvo: expulsão ' + (kickMin() ? fmtDur(kickMin() * 60000) : 'sem bloqueio') + ' · ban ' + (banMin() ? fmtDur(banMin() * 60000) : 'permanente')) }
        return }
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
        for (const o of P.values()) if (o.uh === k && o.role === 1) { o.role = 0; o.cfgTk = null; if (o.hid) setHidden(o, 0, 0); sendTo(o.ws, { t: 'role', r: 0 }) }
        lists(); note('Cargo de admin removido.'); return }
      if (!tg) return note('Jogador não encontrado.');
      if (c === 'tp') { if (tg === p) return; sendTo(ws, { t: 'cmd', c: 'tp', x: tg.x, y: tg.y }); return }
      if (c === 'heal') { sendTo(tg.ws, { t: 'cmd', c: 'heal' }); note('Curou ' + nameOf(tg)); return }
      if (c === 'gl') { sendTo(tg.ws, { t: 'cmd', c: 'gl', v: num(m.v, 1, 100000) | 0 }); note('Glims enviados para ' + nameOf(tg)); return }
      if (c === 'lvl') { sendTo(tg.ws, { t: 'cmd', c: 'lvl', v: num(m.v, 1, 50) | 0 }); note('Níveis enviados para ' + nameOf(tg)); return }
      if (c === 'mobs') { sendTo(tg.ws, { t: 'cmd', c: 'mobs' }); note('Monstros de ' + nameOf(tg) + ' renasceram'); return }
      if (c === 'op') {
        if (!owner || tg.role === 2) return;
        if (!tg.uh) return note('Esse jogador está com um cliente desatualizado (sem identidade). Peça para recarregar a página.');
        AD.admins[tg.uh] = { nm: nameOf(tg), at: Date.now() }; saveAD(); tg.role = 1; sendTo(tg.ws, { t: 'role', r: 1 }); if (!tg.cfgTk) tg.cfgTk = crypto.randomBytes(24).toString('hex'); sendTo(tg.ws, { t: 'cfgtk', k: tg.cfgTk }); // admin recém-promovido já pode salvar o mapa, sem reconectar
        sendTo(tg.ws, { t: 'adm', note: 'Você virou ADMIN.' }); note(nameOf(tg) + ' agora é admin.'); return }
      if (!can(tg)) return note('Você não pode fazer isso com esse jogador.');
      if (c === 'bringto') { sendTo(tg.ws, { t: 'cmd', c: 'tp', x: p.x, y: p.y }); return }
      if (c === 'mute') { tg.muted = tg.muted ? 0 : 1; note(nameOf(tg) + (tg.muted ? ' silenciado.' : ' pode falar de novo.')); return }
      if (c === 'kick') {
        const ms = (m.min !== undefined ? cleanMin(m.min, kickMin()) : kickMin()) * 60000; // m.min = minutos escolhidos na hora; sem ele vale o padrão do painel
        if (tg.uh && ms) KICKED.set(tg.uh, Date.now() + ms);
        sendTo(tg.ws, { t: 'kick', r: 'Você foi expulso por um admin.' + (ms ? ' Só poderá voltar em ' + fmtDur(ms) + '.' : '') });
        setTimeout(() => tg.ws.close(), 100); note(nameOf(tg) + ' expulso' + (ms ? ' por ' + fmtDur(ms) : ' (pode voltar já)') + '.'); return }
      if (c === 'ban') {
        if (!owner) return;
        if (!tg.uh) return note('Sem identidade para banir (cliente desatualizado). Use Expulsar.');
        const mn = m.min !== undefined ? cleanMin(m.min, banMin()) : banMin(); // 0 = permanente
        AD.bans[tg.uh] = { nm: nameOf(tg), at: Date.now(), until: mn ? Date.now() + mn * 60000 : 0 }; saveAD();
        sendTo(tg.ws, { t: 'kick', r: 'Você foi banido deste servidor' + (mn ? ' por ' + fmtDur(mn * 60000) : '') + '.' }); setTimeout(() => tg.ws.close(), 100);
        note(nameOf(tg) + ' banido' + (mn ? ' por ' + fmtDur(mn * 60000) : ' (permanente)') + '.'); return }
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
    if (m.t === 'npc') { // lista de NPCs vendedores: só admin/dono; valida, grava no PostgreSQL e avisa os outros
      if (p.role < 1) return;
      const now = Date.now(); if (now - (p.npT || 0) < 300) return; p.npT = now;
      const a = npClean(m.a); if (!a) return note('Lista de NPCs inválida ou grande demais.');
      NP.a = a; NP.saved = true; saveNP(); others(id, npAll()); return;
    }
    if (m.t === 'sv') { // salva o progresso na conta; se vier rápido demais guarda o último e grava logo depois (não descarta)
      if (!p.acc || ACTIVE_ACC.get(p.acc) !== p || !m.d || typeof m.d !== 'object') return;
      const now = Date.now();
      if (now - p.svT < 900) { p.svD = m.d; if (!p.svTm) p.svTm = setTimeout(() => { p.svTm = null; const d = p.svD; p.svD = null; applySv(p, d) }, 950 - (now - p.svT)); return }
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
      const x = Math.round(num(m.x, -1e6, 1e6)), y = Math.round(num(m.y, -1e6, 1e6)), v = num(m.v, 0, 5000) | 0, pop = m.pop ? 1 : 0;
      const k = /^[hba]$/.test(m.k) ? m.k : 0; DROPS.set(m.id, [m.id, x, y, v, k, k ? now + 20000 : 0]);
      if (DROPS.size > 300) { const k = DROPS.keys().next().value; DROPS.delete(k); wss.clients.forEach(c => sendTo(c, { t: 'dp', id: k })) }
      others(id, { t: 'dr', id: m.id, x, y, v, pop, k }); return;
    }
    if (m.t === 'bo' || m.t === 'ar' || m.t === 'fl' || m.t === 'th') { // bomba colocada/jogada, flecha atirada, fogo do cavalo: só efeito visual para os outros
      if (p.hid) return; // invisível não deixa rastro
      const now = Date.now(); if (now - (p.evW || 0) > 1000) { p.evW = now; p.evN = 0 } if (++p.evN > 30) return;
      if (m.t === 'bo') othersSame(p, { t: 'bo', sx: num(m.sx, -1e6, 1e6), sy: num(m.sy, -1e6, 1e6), tx: num(m.tx, -1e6, 1e6), ty: num(m.ty, -1e6, 1e6), fl: num(m.fl, 0, 1), bt: num(m.bt, 0, 5) }); // bt = tempo de pavio que falta (o outro lado explode junto)
      else if (m.t === 'fl') othersSame(p, { t: 'fl', x: num(m.x, -1e6, 1e6), y: num(m.y, -1e6, 1e6), dx: Math.max(-1, Math.min(1, Math.round(+m.dx || 0))), dy: Math.max(-1, Math.min(1, Math.round(+m.dy || 0))) });
      else if (m.t === 'th') othersSame(p, { t: 'th', sx: num(m.sx, -1e6, 1e6), sy: num(m.sy, -1e6, 1e6), tx: num(m.tx, -1e6, 1e6), ty: num(m.ty, -1e6, 1e6), g: num(m.g, 0, 99999) | 0 }); // arbusto arremessado: só visual
      else othersSame(p, { t: 'ar', x: num(m.x, -1e6, 1e6), y: num(m.y, -1e6, 1e6), vx: num(m.vx, -400, 400), vy: num(m.vy, -400, 400) });
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
      const h = HOST && HOST !== p.id && P.get(HOST); if (h) sendTo(h.ws, { t: 'mh', i: m.i | 0, d: num(m.d, 0, 2000), kx: num(m.kx, -1, 1), ky: num(m.ky, -1, 1) }); return;
    }
    if (m.t === 'mp') { // monstro bateu em jogador remoto: vai só para a vítima
      if (p.id !== HOST) return;
      const now = Date.now(); if (now - (p.mpW || 0) > 1000) { p.mpW = now; p.mpN = 0 } if (++p.mpN > 120) return;
      const v = P.get(m.pid | 0); if (v && v !== p && !v.spar) sendTo(v.ws, { t: 'mp', dk: num(m.dk, 0, 20) }); return;
    }
    if (m.t === 'pi') { // perfil público: título, status, contadores, sparring, gênero, aniversário, idioma, país e sequências (muda de vez em quando)
      if (d.length > 1200) return;
      const now = Date.now(); if (now - (p.piT || 0) < 700) return; p.piT = now;
      const tx = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
      const n = v => Math.max(0, Math.min(1e9, +v || 0)) | 0;
      const bdOk = /^(\d\d)-(\d\d)$/.exec(m.bd), bd = bdOk && +bdOk[1] >= 1 && +bdOk[1] <= 12 && +bdOk[2] >= 1 && +bdOk[2] <= 31 ? m.bd : ''; // aniversário "MM-DD"
      p.pi = { c: /^[a-z0-9]{1,6}$/.test(m.c) ? m.c : '', tt: /^[a-z]{1,16}$/.test(m.tt) ? m.tt : 'novato', st: tx(m.st, 40), el: n(m.el), pk: n(m.pk), sl: n(m.sl), dk: n(m.dk), spo: m.spo ? 1 : 0, th: /^[a-z]{3,10}$/.test(m.th) ? m.th : 'preto', pt: n(m.pt),
        gn: m.gn === 'f' || m.gn === 'm' ? m.gn : '', bd, lg: /^[a-z]{2}$/.test(m.lg) ? m.lg : '', co: /^[A-Z]{2}$/.test(m.co) ? m.co : '', // gênero, aniversário, idioma, país
        ks: n(m.ks), kb: n(m.kb), ss: n(m.ss), sb: n(m.sb),
        kills: m.kills != null ? n(m.kills) : (p.kl | 0), // abates (o Godot mostra no perfil de quem você abre)
        bc: PFC.get(p.uh) || (/^[0-9a-fA-F]{6}$/.test(m.bc) ? m.bc.toLowerCase() : '') }; // cor das barras do perfil (RRGGBB); antes: sequência de abates / melhor, sequência no sparring / melhor
      if (!p.hid) others(id, Object.assign({ t: 'pi', id }, p.pi)); return;
    }
    if (m.t === 'ph') { // golpe de sparring: só vale se os dois aceitaram e estão perto; o servidor repassa só à vítima
      const now = Date.now(); if (now - (p.phW || 0) > 1000) { p.phW = now; p.phN = 0 } if (++p.phN > 8) return;
      const q = P.get(m.to | 0); if (!q || q === p || p.hid || q.hid) return;
      if (p.sparPending || q.sparPending) return; if (p.spar || q.spar) { const match = SPAR_MATCHES.get(String(p.spar || '')); if (!p.spar || p.spar !== q.spar || !match || !match.players.includes(q.id)) return }
      else if (!p.pi || !p.pi.spo || !q.pi || !q.pi.spo) return;
      if (!!p.in !== !!q.in) return; // um dentro de casa e o outro fora: não se alcançam
      if (p.in ? Math.hypot(p.ix - q.ix, p.iy - q.iy) > 110 : Math.hypot(p.x - q.x, p.y - q.y) > 110) return;
      q.phFrom = id; q.phT = now; sendTo(q.ws, { t: 'ph', from: id, d: num(m.d, 0, 2000) }); return;
    }
    if (m.t === 'pk') { // a vítima do sparring avisa quem a derrubou (só vale se levou golpe dele há pouco)
      const k = P.get(m.by | 0), now = Date.now(); if (!k || k === p || p.phFrom !== k.id || now - (p.phT || 0) > 15000) return;
      if (p.spar && (p.spar !== k.spar || p.hp > 0)) return;
      p.phFrom = 0; sendTo(k.ws, { t: 'pk', id, nm: p.nm });
      if (p.spar && p.spar === k.spar) finishSpar(p.spar, k.id, 'finished');
      return;
    }
    if (m.t === 'ip') { // posição DENTRO de uma casa (o 'u' não vem de lá): guardada só para gravar na conta se ele sair
      if (d.length > 300 || !p.ok) return;
      const x = Math.round(+m.x), y = Math.round(+m.y), r = m.r && Number.isFinite(+m.r.x) && Number.isFinite(+m.r.y) ? { x: Math.round(+m.r.x), y: Math.round(+m.r.y) } : null;
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return;
      p.il = { x, y, f: /^(Up|Down|Left|Right)$/.test(m.f) ? m.f : 'Down', r }; return;
    }
    if (m.t === 'u') {
      if (d.length > 400) return;
      /* v16 — dentro de casa o cliente continua mandando 'u': x,y = a PORTA (clientes antigos veem o jogador parado nela), in:1 + ix,iy = posição real no interior, ia = animação.
         Quem também está dentro desenha o jogador andando de verdade; quem está fora não o vê (ele "entrou"). */
      if (m.in == 1 && Number.isFinite(+m.ix) && Number.isFinite(+m.iy) && Math.abs(+m.ix) <= 1e6 && Math.abs(+m.iy) <= 1e6) {
        p.in = 1; p.ix = Math.round(+m.ix); p.iy = Math.round(+m.iy); p.ia = normAn(m.ia);
        p.il = { x: p.ix, y: p.iy, f: (/(Up|Down|Left|Right)$/.exec(p.ia) || [])[1] || 'Down', r: Number.isFinite(+m.x) && Number.isFinite(+m.y) ? { x: Math.round(+m.x), y: Math.round(+m.y) } : null }; // também serve para gravar na conta se ele sair
      } else { p.in = 0; p.il = null } // voltou ao mundo aberto
      p.x = num(m.x, -1e6, 1e6); p.y = num(m.y, -1e6, 1e6); p.nm = String(m.nm || '?').slice(0, 12);
      p.an = normAn(m.an); p.al = m.al == 1 ? 1 : .4;
      if (m.lv != null) { p.lv = num(m.lv, 1, 999) | 0; p.hp = num(m.hp, 0, 99999) | 0; p.hm = num(m.hm, 0, 99999) | 0; p.kl = num(m.kl, 0, 1e9) | 0 }
      p.b = num(m.b, 0, 999) | 0; p.h = num(m.h, 0, 999) | 0; p.s = p.role > 0 ? Math.round(num(m.s, 0.3, 1) * 100) / 100 : 0.6; /* tamanho do personagem (30%-100%): só admin/dono pode mudar; os outros ficam no padrão 60% */ p.sw = m.sw ? 1 : 0; p.mt = num(m.mt, 0, 9) | 0; /* 0 a pé · skin da montaria + 1 */ p.ct = typeof m.ct === 'number' && isFinite(m.ct) ? m.ct : undefined; p.cy = m.cy === 1 || m.cy === 2 ? m.cy : num(m.cy, 0, 99999) >= 10 ? num(m.cy, 0, 99999) | 0 : 0; p.ac = m.ac ? 1 : 0; p.fl = m.fl ? 1 : 0; p.ak = num(m.ak, 0, 1e9) | 0; p.ad = num(m.ad, 50, 1000) | 0; p.uT = Date.now(); if (!p.ok) { p.ok = 1; electHost() } else p.ok = 1; if (!p.hid) othersSame(p, JSON.stringify({ t: 'pu', p: pstate(p) }));
    } else if (m.t === 'k') {
      p.bs = PNG(m.bs) ? m.bs : null; p.hs = PNG(m.hs) ? m.hs : null;
      if (!p.hid) others(id, { t: 'k', id, bs: p.bs, hs: p.hs });
    } else if (m.t === 'kc') {
      p.c = COLS(m.c);
      if (!p.hid) others(id, { t: 'kc', id, c: p.c });
    } else if (m.t === 'q') {
      if (!m.e || typeof m.e !== 'object' || d.length > 20000) return;
      p.e = { h: m.e.h, s: m.e.s, d: m.e.d };
      if (!p.hid) others(id, { t: 'q', id, e: p.e });
    } else if (m.t === 'c' || m.t === 'cl') {
      const x = String(m.x || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100), now = Date.now();
      if (!x || p.muted || now - p.lastChat < 500) return; p.lastChat = now;
      const at = now, r = p.role | 0, local = m.t === 'cl', ch = local ? 'local' : 'global';
      if (!local) { CHAT.push({ nm: p.nm, x, r, at, ch }); if (CHAT.length > 60) CHAT.shift(); }
      const out = JSON.stringify({ t: 'c', id, nm: p.nm, x, r, at, ch });
      wss.clients.forEach(c => { if (!local || c.pid === id || canHearLocal(p, P.get(c.pid))) sendTo(c, out) });
    }
  });
  ws.on('close', () => { removeSparQueue(id); if (p.sparPending) cancelSparCountdown(p.sparPending); if (p.spar) finishSpar(p.spar, 0, 'disconnect'); if (p.svTm) clearTimeout(p.svTm); if (p.svD) { applySv(p, p.svD); p.svD = null } savePosOnLeave(p); if (p.acc && ACC[p.acc] && accDirty.has(String(p.acc))) saveACC(p.acc); /* saiu: grava a posição final no banco já, sem esperar o ciclo lento */ if (p.acc && ACTIVE_ACC.get(p.acc) === p) ACTIVE_ACC.delete(p.acc); { const g = p.gid, a = g && ACC[g]; if (a && !ACTIVE_ACC.has(g) && !accDirty.has(g) && !Object.keys(a.data || {}).length) delete ACC[g] } P.delete(id); others(id, { t: 'l', id }); if (id === HOST) electHost(); if (!P.size) DROPS.clear() });
  ws.on('error', () => { });
});

/* animação do jogador: aceita direção por nome (Run_Down, clientes antigos) ou número 0-3 (Run_2) e guarda SEMPRE por nome,
   que é o que todos os clientes (antigos e novos) sabem desenhar. Antes, o nome era descartado e virava Idle_2: o amigo deslizava parado. */
const AN_DIR = ['Up', 'Left', 'Down', 'Right'];
function normAn(a) {
  const m = /^(Idle|Run|Attack|Jump)_([0-3]|Up|Left|Down|Right)$/.exec(a);
  if (!m) return 'Idle_Down';
  return m[1] + '_' + (/^[0-3]$/.test(m[2]) ? AN_DIR[+m[2]] : m[2]);
}

const pstate = p => ({ id: p.id, ct: p.ct, ak: p.ak, ad: p.ad, x: p.x, y: p.y, nm: p.nm, an: p.an, al: p.al, b: p.b, h: p.h, s: p.s, sw: p.sw, mt: p.mt | 0, r: p.role, tp: p.ty | 0, lv: p.lv, hp: p.hp, hm: p.hm, kl: p.kl, cy: p.cy | 0, ac: p.ac | 0, fl: p.fl | 0, in: p.in ? 1 : undefined, ix: p.in ? p.ix : undefined, iy: p.in ? p.iy : undefined, ia: p.in ? p.ia : undefined });
setInterval(() => {
  for (const c of wss.clients) {
    const self = P.get(c.pid);
    if (!self || !self.ok) continue;
    const a = [...P.values()].filter(p => p.ok && !p.hid && String(p.spar || '') === String(self.spar || '') && !!p.in === !!self.in).map(pstate);
    sendTo(c, { t: 'st', p: a });
  }
}, 500); // sincronização completa (limpeza de quem saiu); o movimento vai por 'pu', na hora

Promise.all([initConfigDB().then(initHistoryDB), initAccountsDB(), initSpawnsDB(), initPfDB(), initNpcsDB(), initRolesDB()]).then(() => {
  srv.listen(PORT, () => {
    console.log('Graal Online em http://localhost:' + PORT);
    if (!ADMIN) console.log('AVISO: ADMIN_TOKEN não definido — só o localhost consegue salvar edições no servidor.');
  });
}).catch(e => { console.error('Falha ao iniciar PostgreSQL:', e); process.exit(1); });
