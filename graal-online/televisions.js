'use strict';

const crypto = require('node:crypto');
const { sourceUrl } = require('./television_media');
const RANGE = 480;
const MAX_SCALE = 10;
const ID = /^[a-f0-9]{20}$/;

module.exports = function createTelevisions({ players, send, authorized, media, save = () => {}, now = Date.now }) {
  const screens = new Map();
  const rates = new Map();
  let serial = 0;
  let savedAt = 0;
  let lastBroadcast = 0;
  const live = p => !!p && players.get(p.id) === p && p.ws.readyState === 1 && authorized(p);
  const admin = p => live(p) && p.role >= 1;
  const space = p => ({ inside: !!p.in, football: String(p.football || ''), spar: String(p.spar || '') });
  const point = p => ({ x: p.in ? p.ix : p.x, y: p.in ? p.iy : p.y });
  const same = (a, b) => a.inside === b.inside && a.football === b.football && a.spar === b.spar;
  const emit = (p, data) => send(p.ws, { t: 'television', ...data });
  const elapsed = tv => tv.startedAt ? (now() - tv.startedAt) / 1000 : 0;

  function state(p) {
    const position = point(p);
    const context = space(p);
    const list = [];
    for (const tv of screens.values()) {
      const visible = same(context, tv.space);
      const near = visible && Math.hypot(position.x - tv.x, position.y - tv.y) <= RANGE + 160 * tv.scale;
      if (!admin(p) && !near) continue;
      const offset = elapsed(tv);
      const segments = tv.session?.segments.filter(item => item.end > offset - 1).slice(0, 4) || [];
      list.push({ id: tv.id, name: tv.name, x: tv.x, y: tv.y, space: tv.space, scale: tv.scale,
        volume: tv.volume, radius: RANGE, visible, audible: near, epoch: tv.epoch,
        playing: tv.playing, loading: tv.loading, title: tv.title, live: !!tv.session?.live,
        offset, error: tv.error, source: admin(p) ? tv.source : '',
        key: near && tv.session ? tv.session.key : '', segments: near ? segments : [] });
    }
    return { op: 'state', version: 1, screens: list, rtt: Number.isFinite(p.ws.pingMs) ? p.ws.pingMs : 0 };
  }

  function dump() {
    savedAt = Math.max(now(), savedAt + 1);
    return { version: 1, savedAt, serial, screens: [...screens.values()]
      .filter(tv => !tv.space.football && !tv.space.spar)
      .map(tv => ({ id: tv.id, name: tv.name, x: tv.x, y: tv.y, space: tv.space, scale: tv.scale,
        volume: tv.volume, source: tv.source, title: tv.title })) };
  }

  function broadcast(persist = false) {
    if (persist) save(dump());
    for (const p of players.values()) if (live(p) && p.ok) emit(p, state(p));
    lastBroadcast = now();
  }

  function stop(tv) {
    tv.epoch++;
    tv.controller?.abort();
    tv.controller = null;
    if (tv.session) media.stop(tv.session.key);
    tv.session = null;
    tv.playing = false;
    tv.loading = false;
    tv.startedAt = 0;
  }

  function restore(data) {
    if (!Array.isArray(data?.screens)) return;
    serial = Number.isSafeInteger(data.serial) && data.serial >= 0 ? data.serial : 0;
    savedAt = Number.isSafeInteger(data.savedAt) ? data.savedAt : 0;
    for (const value of data.screens.slice(0, 8)) {
      if (!ID.test(value?.id) || !Number.isFinite(value.x) || !Number.isFinite(value.y) ||
          Math.abs(value.x) > 1e6 || Math.abs(value.y) > 1e6 || !Number.isFinite(value.scale) || value.scale < 0.5 || value.scale > MAX_SCALE ||
          !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 100 || value.space?.football || value.space?.spar) continue;
      let source = '';
      try { if (value.source) source = sourceUrl(value.source).url; } catch { }
      screens.set(value.id, { id: value.id, x: value.x, y: value.y, scale: value.scale, volume: value.volume,
        name: String(value.name || 'TV').replace(/[\r\n]/g, ' ').slice(0, 48),
        title: String(value.title || '').replace(/[\r\n]/g, ' ').slice(0, 120), source,
        space: { inside: !!value.space?.inside, football: '', spar: '' },
        session: null, controller: null, playing: false, loading: false, startedAt: 0, error: '', epoch: 0 });
    }
  }

  async function handle(p, message) {
    if (!live(p) || !message || typeof message.op !== 'string') return;
    const previous = rates.get(p.id) || { at: now(), count: 0 };
    if (now() - previous.at >= 1000) { previous.at = now(); previous.count = 0; }
    rates.set(p.id, previous);
    if (++previous.count > 12) return;
    if (message.op === 'get') return emit(p, state(p));
    if (!admin(p)) return emit(p, { op: 'error', message: 'Somente admin ou dono controla as TVs.' });
    try {
      if (message.op === 'place') {
        if (!p.ok || screens.size >= 8) throw new Error('Entre no mapa e mantenha até oito TVs.');
        const position = point(p);
        if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || Math.abs(position.x) > 1e6 || Math.abs(position.y) > 1e6) return;
        const id = crypto.randomBytes(10).toString('hex');
        screens.set(id, { id, name: 'TV ' + ++serial, ...position, space: space(p), scale: 1, volume: 65,
          source: '', title: '', session: null, controller: null, playing: false, loading: false, startedAt: 0, epoch: 0, error: '' });
        broadcast(true);
        return emit(p, { ...state(p), selected: id });
      }
      const tv = screens.get(message.id);
      if (!tv) throw new Error('Escolha uma TV.');
      if (message.op === 'remove') {
        stop(tv);
        screens.delete(tv.id);
      } else if (message.op === 'stop') {
        stop(tv);
        tv.error = '';
      } else if (message.op === 'move') {
        const position = point(p);
        if (!p.ok || !Number.isFinite(position.x) || !Number.isFinite(position.y) || Math.abs(position.x) > 1e6 || Math.abs(position.y) > 1e6) return;
        tv.x = position.x;
        tv.y = position.y;
        tv.space = space(p);
      } else if (message.op === 'size') {
        if (!Number.isFinite(message.scale) || message.scale < 0.5 || message.scale > MAX_SCALE) return;
        tv.scale = Math.round(message.scale * 10) / 10;
      } else if (message.op === 'volume') {
        if (!Number.isFinite(message.volume) || message.volume < 0 || message.volume > 100) return;
        tv.volume = Math.round(message.volume);
      } else if (message.op === 'play') {
        const source = sourceUrl(message.url || tv.source).url;
        for (const other of screens.values()) {
          if (other !== tv && (other.playing || other.loading)) stop(other);
        }
        stop(tv);
        tv.source = source;
        tv.error = '';
        tv.loading = true;
        const epoch = tv.epoch;
        const controller = new AbortController();
        tv.controller = controller;
        broadcast(true);
        let session;
        try { session = await media.open(source, controller.signal); }
        catch (error) {
          if (screens.get(tv.id) !== tv || tv.epoch !== epoch) return;
          tv.loading = false;
          tv.error = error.message;
          broadcast();
          return;
        }
        if (!admin(p) || screens.get(tv.id) !== tv || tv.epoch !== epoch) {
          media.stop(session.key);
          if (screens.get(tv.id) === tv && tv.epoch === epoch) { stop(tv); broadcast(); }
          return;
        }
        tv.session = session;
        tv.title = session.title;
        broadcast(true);
        return;
      } else return;
      broadcast(true);
    } catch (error) { emit(p, { op: 'error', message: error.message || 'Não foi possível alterar a TV.' }); }
  }

  function tick() {
    for (const tv of screens.values()) {
      if ((tv.space.football || tv.space.spar) && ![...players.values()].some(p => live(p) && same(space(p), tv.space))) {
        stop(tv);
        screens.delete(tv.id);
        broadcast(true);
        continue;
      }
      if (!tv.session) continue;
      const session = media.poll(tv.session.key);
      if (!session) { stop(tv); continue; }
      tv.session = session;
      if (session.error) { const message = session.error; stop(tv); tv.error = message; continue; }
      if (tv.loading && (session.segments.length >= 2 || session.finished && session.segments.length)) {
        tv.loading = false;
        tv.playing = true;
        tv.startedAt = now() + 2000;
      }
      const last = session.segments.at(-1);
      if (session.finished && !last) { stop(tv); tv.error = 'O vídeo não forneceu imagem reproduzível.'; }
      else if (tv.playing && session.finished && elapsed(tv) >= last.end) stop(tv);
    }
    for (const id of rates.keys()) if (!players.has(id)) rates.delete(id);
    if (now() - lastBroadcast >= 1000) broadcast();
  }

  function blocksMove(p, from, to) {
    const body = position => ({ x: position.x - 4.5, y: position.y - 3, w: 9, h: 7 });
    const before = body(from), after = body(to);
    const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const distance = (a, b) => (a.x + a.w / 2 - b.x - b.w / 2) ** 2 + (a.y + a.h / 2 - b.y - b.h / 2) ** 2;
    for (const tv of screens.values()) {
      if (!same(space(p), tv.space)) continue;
      const solid = { x: tv.x - 40 * tv.scale, y: tv.y - 7 * tv.scale, w: 80 * tv.scale, h: 7 * tv.scale };
      if (intersects(after, solid) && !(intersects(before, solid) && distance(after, solid) > distance(before, solid))) return true;
    }
    return false;
  }

  return { handle, tick, state, dump, restore, blocksMove, file: media.file,
    close() { for (const tv of screens.values()) stop(tv); } };
};
