'use strict';

const crypto = require('node:crypto');
const { youtubeId } = require('./speaker_media');
const RANGE = 320;
const MAX_BOXES = 16;
const MAX_TRACKS = 20;

module.exports = function createSpeakers({ players, send, authorized, media, save = () => {}, now = Date.now }) {
  const boxes = new Map();
  const sent = new Map();
  const rates = new Map();
  let revision = 1;
  let serial = 0;
  let savedAt = 0;

  const live = p => !!p && players.get(p.id) === p && p.ws.readyState === 1 && authorized(p);
  const admin = p => live(p) && p.role >= 1;
  const emit = (p, data) => { if (p?.ws.readyState === 1) send(p.ws, { t: 'speaker', ...data }); };
  const error = (p, message) => emit(p, { op: 'error', message });
  const space = p => ({ inside: !!p.in, football: String(p.football || ''), spar: String(p.spar || '') });
  const position = p => ({ x: p.in ? p.ix : p.x, y: p.in ? p.iy : p.y });
  const sameSpace = (a, b) => a.inside === b.inside && a.football === b.football && a.spar === b.spar;
  const progress = box => box.offset + (box.playing ? Math.max(0, now() - box.startedAt) / 1000 : 0);
  const track = box => box.tracks[box.index] || null;

  function snapshot(p) {
    const point = position(p);
    const context = space(p);
    const result = [];
    for (const box of boxes.values()) {
      const visible = sameSpace(context, box.space);
      const near = visible && Math.hypot(point.x - box.x, point.y - box.y) <= RANGE + 64;
      if (!admin(p) && !near) continue;
      const current = track(box);
      const data = {
        id: box.id, name: box.name, x: box.x, y: box.y, space: box.space,
        volume: box.volume, radius: RANGE, visible, audible: near, playing: box.playing,
        offset: progress(box), epoch: box.epoch, loading: box.loading,
        current: current ? { ...current, file: '/api/speaker/audio/' + current.key + '.mp3' } : null
      };
      if (admin(p)) data.tracks = box.tracks.map(t => ({ ...t }));
      result.push(data);
    }
    return { op: 'state', version: 1, revision, boxes: result, rtt: Number.isFinite(p.ws.pingMs) ? p.ws.pingMs : 0 };
  }

  function dump() {
    savedAt = Math.max(now(), savedAt + 1);
    return { version: 1, savedAt, serial, boxes: [...boxes.values()]
      .filter(b => !b.space.football && !b.space.spar)
      .map(b => ({ id: b.id, name: b.name, x: b.x, y: b.y, space: b.space, volume: b.volume, tracks: b.tracks, index: b.index })) };
  }

  function changed(persist = true) {
    revision++;
    if (persist) {
      try { save(dump()); } catch { for (const p of players.values()) if (admin(p)) error(p, 'A alteração está ativa, mas o salvamento precisa ser verificado.'); }
    }
  }

  function cleanTrack(value) {
    return value && /^[A-Za-z0-9_-]{11}$/.test(value.id) && /^[a-f0-9]{64}$/.test(value.key) &&
      typeof value.title === 'string' && Number.isFinite(value.duration) && value.duration > 0 &&
      Number.isFinite(value.bytes) && value.bytes > 0 && value.bytes <= media.maxBytes;
  }

  function restore(data) {
    if (!Array.isArray(data?.boxes)) return;
    serial = Number.isSafeInteger(data.serial) && data.serial >= 0 ? data.serial : 0;
    savedAt = Number.isSafeInteger(data.savedAt) && data.savedAt > 0 ? data.savedAt : 0;
    for (const value of data.boxes.slice(0, MAX_BOXES)) {
      if (!value || !/^[a-f0-9]{20}$/.test(value.id) || !Number.isFinite(value.x) || !Number.isFinite(value.y) ||
          Math.abs(value.x) > 1e6 || Math.abs(value.y) > 1e6 || !Number.isFinite(value.volume) || value.volume < 0 || value.volume > 100 ||
          !Array.isArray(value.tracks) || value.space?.football || value.space?.spar) continue;
      const tracks = value.tracks.filter(cleanTrack).slice(0, MAX_TRACKS);
      boxes.set(value.id, { id: value.id, name: String(value.name || 'Caixa').replace(/[\r\n]/g, ' ').slice(0, 48),
        x: value.x, y: value.y, space: { inside: !!value.space?.inside, football: '', spar: '' },
        volume: value.volume, tracks, index: Math.max(0, Math.min(tracks.length - 1, value.index | 0)),
        offset: 0, startedAt: 0, playing: false, epoch: 0, loading: false });
    }
    changed(false);
  }

  function prune() {
    media.prune?.([...boxes.values()].flatMap(b => b.tracks.map(t => t.key)));
  }

  function start(box, index, offset = 0) {
    box.index = index;
    box.offset = Math.max(0, Math.min(offset, box.tracks[index].duration - 0.01));
    box.startedAt = now();
    box.playing = true;
    box.epoch++;
  }

  async function play(box, id, actor, offset) {
    const index = box.tracks.findIndex(t => t.id === id);
    if (index < 0) throw new Error('Escolha uma música da fila.');
    if (box.loading) throw new Error('Aguarde o preparo da música.');
    const requestedOffset = offset ?? (index === box.index && !box.playing ? box.offset : 0);
    if (media.file(box.tracks[index].key)) {
      start(box, index, requestedOffset);
      changed();
      return;
    }
    box.index = index;
    box.offset = requestedOffset;
    box.playing = false;
    box.loading = true;
    box.epoch++;
    const epoch = box.epoch;
    changed();
    try {
      const prepared = await media.resolve('https://www.youtube.com/watch?v=' + id);
      if (boxes.get(box.id) !== box || (actor && !admin(actor))) return;
      if (!cleanTrack(prepared) || prepared.id !== id) throw new Error('A música preparada é inválida.');
      box.tracks[index] = prepared;
      if (box.epoch === epoch) start(box, index, requestedOffset);
    } finally {
      if (boxes.get(box.id) === box) { box.loading = false; changed(); }
    }
  }

  async function handle(p, m) {
    if (!live(p)) return;
    const time = now();
    let rate = rates.get(p.id);
    if (!rate || time - rate.at >= 1000) { rate = { at: time, n: 0 }; rates.set(p.id, rate); }
    if (++rate.n > 30) return;
    if (m.op === 'get') return emit(p, snapshot(p));
    if (!admin(p)) return error(p, 'Somente admin ou dono controla as caixas de som.');
    try {
      if (m.op === 'place') {
        if (!p.ok) throw new Error('Entre no mapa para colocar a caixa.');
        if (boxes.size >= MAX_BOXES) throw new Error('O mapa já tem 16 caixas. Remova uma para colocar outra.');
        const point = position(p);
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e6 || Math.abs(point.y) > 1e6) return;
        const id = crypto.randomBytes(10).toString('hex');
        boxes.set(id, { id, name: 'Caixa ' + ++serial, ...point, space: space(p), volume: 65,
          tracks: [], index: 0, offset: 0, startedAt: 0, playing: false, epoch: 0, loading: false });
        changed();
        emit(p, { ...snapshot(p), selected: id });
        return;
      }
      const box = boxes.get(m.id);
      if (!box) throw new Error('Escolha uma caixa existente.');
      if (m.op === 'remove') {
        boxes.delete(box.id);
        changed();
        prune();
      } else if (m.op === 'move') {
        const point = position(p);
        if (!p.ok || !Number.isFinite(point.x) || !Number.isFinite(point.y) || Math.abs(point.x) > 1e6 || Math.abs(point.y) > 1e6) return;
        box.x = point.x; box.y = point.y; box.space = space(p);
        changed();
      } else if (m.op === 'volume') {
        if (!Number.isInteger(m.volume) || m.volume < 0 || m.volume > 100) return;
        if (box.volume !== m.volume) { box.volume = m.volume; changed(); }
      } else if (m.op === 'pause' || m.op === 'stop') {
        box.offset = m.op === 'stop' ? 0 : progress(box);
        box.playing = false;
        box.startedAt = 0;
        box.epoch++;
        changed();
      } else if (m.op === 'add') {
        const id = youtubeId(m.url);
        if (box.tracks.some(t => t.id === id)) throw new Error('Essa música já está na fila.');
        if (box.loading) throw new Error('Aguarde o preparo da música.');
        if (box.tracks.length >= MAX_TRACKS) throw new Error('A caixa comporta 20 músicas. Remova uma faixa para adicionar outra.');
        const first = box.tracks.length === 0;
        const epoch = box.epoch;
        box.loading = true;
        changed(false);
        try {
          const prepared = await media.resolve(m.url);
          if (boxes.get(box.id) !== box || !admin(p)) return;
          if (!cleanTrack(prepared) || prepared.id !== id) throw new Error('A música preparada é inválida.');
          box.tracks.push(prepared);
          if (first && box.epoch === epoch) start(box, 0);
        } finally {
          if (boxes.get(box.id) === box) { box.loading = false; changed(); }
          prune();
        }
      } else if (m.op === 'play' || m.op === 'next') {
        if (!box.tracks.length) throw new Error('Adicione uma música primeiro.');
        const id = m.op === 'next' ? box.tracks[(box.index + 1) % box.tracks.length].id : (m.track || track(box).id);
        if (!(box.playing && track(box)?.id === id && m.op === 'play')) await play(box, id, p);
      } else if (m.op === 'remove_track') {
        if (box.loading) throw new Error('Aguarde o preparo da música.');
        const index = box.tracks.findIndex(t => t.id === m.track);
        if (index < 0) return;
        const current = index === box.index;
        box.tracks.splice(index, 1);
        if (index < box.index) box.index--;
        if (current) {
          box.index = Math.min(index, box.tracks.length - 1);
          box.offset = 0; box.epoch++;
          if (!box.tracks.length) { box.index = 0; box.playing = false; }
          else if (box.playing) {
            box.playing = false;
            await play(box, box.tracks[box.index].id, p, 0);
          }
        }
        changed();
        prune();
      } else return;
      if (live(p)) emit(p, snapshot(p));
    } catch (e) {
      if (live(p)) error(p, e.message || 'Não foi possível alterar a caixa.');
    }
  }

  function tick() {
    for (const box of boxes.values()) {
      if ((box.space.football || box.space.spar) && ![...players.values()].some(p => live(p) && sameSpace(space(p), box.space))) {
        boxes.delete(box.id); changed(); prune(); continue;
      }
      const current = track(box);
      if (!box.playing || box.loading || !current || progress(box) < current.duration) continue;
      let remaining = progress(box) % box.tracks.reduce((sum, t) => sum + t.duration, 0);
      let index = box.index;
      while (remaining >= box.tracks[index].duration) {
        remaining -= box.tracks[index].duration;
        index = (index + 1) % box.tracks.length;
      }
      void play(box, box.tracks[index].id, null, remaining).catch(() => { box.playing = false; changed(); });
    }
    for (const p of players.values()) {
      if (!live(p)) continue;
      const data = snapshot(p);
      const signature = revision + ':' + p.role + ':' + data.boxes.map(b => b.id + b.visible + b.audible).join(',');
      const previous = sent.get(p.id);
      if (!previous || previous.signature !== signature || now() - previous.time >= 4000) {
        emit(p, data);
        sent.set(p.id, { signature, time: now() });
      }
    }
    for (const id of sent.keys()) if (!players.has(id)) { sent.delete(id); rates.delete(id); }
  }

  return { handle, tick, restore, dump, state: snapshot, file: media.file, maxAudioBytes: media.maxBytes };
};
module.exports.RANGE = RANGE;
