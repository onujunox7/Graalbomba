'use strict';
const crypto = require('node:crypto');

// Lista de amigos + mensagens privadas (PM). Tudo é decidido pelo servidor:
// o cliente nunca recebe o id real da conta (acc), só um código público derivado dele.
module.exports = function createFriends({ players, send, authorized, online, save, now = Date.now }) {
  const MAX_FRIENDS = 100, REQ_TTL = 120000, PM_MAX = 200;
  const lists = new Map();      // acc -> Map(acc do amigo -> nome visto por último)
  const requests = new Map();   // acc de quem recebe -> Map(acc de quem pediu -> { nm, until })
  const rate = new Map(), pmRate = new Map();
  const pub = acc => crypto.createHash('sha256').update('amigo:' + acc).digest('hex').slice(0, 16);
  const live = p => !!p && players.get(p.id) === p && p.ws.readyState === 1 && authorized(p) && !!p.acc;
  const clean = s => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const name = p => clean(p && p.nm).slice(0, 24) || '?';
  const emit = (p, data) => { if (p && p.ws.readyState === 1) send(p.ws, { t: 'fr', ...data }); };
  const emitPm = (p, data) => { if (p && p.ws.readyState === 1) send(p.ws, { t: 'pm', ...data }); };
  const error = (p, message) => emit(p, { op: 'error', message });
  const mine = acc => { let l = lists.get(acc); if (!l) { l = new Map(); lists.set(acc, l); } return l; };
  const onlineP = acc => { const p = online(acc); return live(p) ? p : null; };
  const byPub = (map, code) => { for (const acc of map.keys()) if (pub(acc) === code) return acc; return null; };

  function persist() {
    const friends = {};
    for (const [acc, l] of lists) if (l.size) friends[acc] = [...l].map(([a, nm]) => ({ a, nm }));
    save({ friends, savedAt: now() });
  }
  function restore(data) {
    lists.clear();
    const f = data && typeof data.friends === 'object' && data.friends ? data.friends : {};
    for (const acc of Object.keys(f)) {
      if (!Array.isArray(f[acc])) continue;
      const l = new Map();
      for (const e of f[acc].slice(0, MAX_FRIENDS)) if (e && typeof e.a === 'string') l.set(e.a, clean(e.nm).slice(0, 24) || '?');
      if (l.size) lists.set(acc, l);
    }
  }
  function expire() {
    const t = now();
    for (const [to, m] of requests) {
      for (const [from, r] of m) if (r.until <= t) m.delete(from);
      if (!m.size) requests.delete(to);
    }
  }
  function view(p) {
    expire();
    const l = mine(p.acc);
    const friends = [...l].map(([acc, nm]) => {
      const o = onlineP(acc);
      if (o && o.nm && clean(o.nm).slice(0, 24) !== nm) l.set(acc, name(o));
      return { f: pub(acc), nm: o ? name(o) : nm, on: !!o, id: o ? o.id : null };
    }).sort((a, b) => (b.on - a.on) || a.nm.localeCompare(b.nm));
    const reqs = [...(requests.get(p.acc) || [])].map(([from, r]) => ({ f: pub(from), nm: r.nm }));
    return { op: 'state', friends, requests: reqs, limit: MAX_FRIENDS };
  }
  const state = p => emit(p, view(p));
  // Avisa os amigos que estão online que alguém entrou ou saiu.
  function presence(p) {
    for (const [acc, l] of lists) if (l.has(p.acc)) { const o = onlineP(acc); if (o) state(o); }
  }
  function limited(map, key, per, max) {
    const t = now(); let b = map.get(key);
    if (!b || t - b.at >= per) { b = { at: t, count: 0 }; map.set(key, b); }
    return ++b.count > max;
  }

  function handle(p, m) {
    if (!live(p) || !m || typeof m !== 'object') return;
    if (limited(rate, p.id, 1000, 8)) return;
    expire();
    const l = mine(p.acc);
    if (m.op === 'get') { if (!p.frOn) { p.frOn = 1; connect(p); } return state(p); }
    if (m.op === 'add') {
      const target = Number.isSafeInteger(m.id) ? players.get(m.id) : null;
      if (!live(target) || target.id === p.id || target.acc === p.acc || target.hid || p.hid) return error(p, 'Jogador indisponível.');
      if (l.has(target.acc)) return error(p, 'Esse jogador já é seu amigo.');
      if (l.size >= MAX_FRIENDS) return error(p, 'Sua lista de amigos está cheia.');
      // Se o outro já tinha pedido a amizade, adicionar é o mesmo que aceitar.
      const theirs = requests.get(p.acc);
      if (theirs && theirs.has(target.acc)) return accept(p, target.acc);
      let box = requests.get(target.acc); if (!box) { box = new Map(); requests.set(target.acc, box); }
      if (box.has(p.acc)) return error(p, 'Você já enviou um pedido para esse jogador.');
      if (box.size >= 10) return error(p, 'Esse jogador já tem muitos pedidos pendentes.');
      box.set(p.acc, { nm: name(p), until: now() + REQ_TTL });
      state(target);
      return emit(p, { op: 'notice', message: 'Pedido enviado para ' + name(target) + '.' });
    }
    if (m.op === 'accept' || m.op === 'decline') {
      const box = requests.get(p.acc) || new Map();
      const from = byPub(box, String(m.f || ''));
      if (!from) return error(p, 'O pedido expirou ou foi cancelado.');
      if (m.op === 'decline') { box.delete(from); state(p); return; }
      return accept(p, from);
    }
    if (m.op === 'remove') {
      const acc = byPub(l, String(m.f || ''));
      if (!acc) return error(p, 'Amigo não encontrado.');
      l.delete(acc); mine(acc).delete(p.acc);
      persist(); state(p); const o = onlineP(acc); if (o) state(o);
      return;
    }
    error(p, 'Ação inválida.');
  }
  function accept(p, from) {
    const box = requests.get(p.acc); if (box) box.delete(from);
    const other = onlineP(from);
    const mineL = mine(p.acc), theirL = mine(from);
    if (mineL.size >= MAX_FRIENDS || theirL.size >= MAX_FRIENDS) { state(p); return error(p, 'A lista de amigos está cheia.'); }
    mineL.set(from, other ? name(other) : (mineL.get(from) || '?'));
    theirL.set(p.acc, name(p));
    persist(); state(p); if (other) { state(other); emit(other, { op: 'notice', message: name(p) + ' aceitou seu pedido de amizade.' }); }
  }

  // PM: por código de amigo (f) ou por id de jogador online (id).
  function pm(p, m) {
    if (!live(p) || !m || typeof m !== 'object') return;
    if (m.op !== 'send') return;
    if (p.muted) return emitPm(p, { op: 'error', message: 'Você está silenciado.' });
    if (limited(pmRate, p.id, 10000, 6)) return emitPm(p, { op: 'error', message: 'Devagar! Muitas mensagens seguidas.' });
    const x = clean(m.x).slice(0, PM_MAX);
    if (!x) return;
    let target = null;
    if (Number.isSafeInteger(m.id)) target = players.get(m.id);
    else if (typeof m.f === 'string') { const acc = byPub(mine(p.acc), m.f); target = acc ? onlineP(acc) : null; }
    if (!live(target) || target.id === p.id || target.acc === p.acc) return emitPm(p, { op: 'error', message: 'Esse jogador não está online.', f: typeof m.f === 'string' ? m.f : undefined });
    const at = now();
    emitPm(target, { op: 'msg', f: pub(p.acc), id: p.id, nm: name(p), x, at, friend: mine(target.acc).has(p.acc) });
    emitPm(p, { op: 'sent', f: pub(target.acc), id: target.id, nm: name(target), x, at });
  }

  function connect(p) {
    if (!live(p)) return;
    const l = mine(p.acc); const n = name(p);
    // mantém o nome atualizado na lista dos amigos
    let changed = false;
    for (const [acc, fl] of lists) if (fl.get(p.acc) !== undefined && fl.get(p.acc) !== n) { fl.set(p.acc, n); changed = true; }
    if (changed) persist();
    void l; presence(p);
  }
  function disconnect(p) { if (p && p.acc) { rate.delete(p.id); pmRate.delete(p.id); setImmediate(() => presence(p)); } }

  return { handle, pm, restore, connect, disconnect, tick: expire };
};
