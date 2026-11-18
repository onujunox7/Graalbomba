'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MAX_AUDIO = 24 * 1024 * 1024;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeId(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Cole um link de vídeo do YouTube.');
  let url;
  try { const input = value.trim(); url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : 'https://' + input); } catch { throw new Error('Link do YouTube inválido.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new Error('Link do YouTube inválido.');
  const host = url.hostname.toLowerCase();
  let id = '';
  if (host === 'youtu.be' || host === 'www.youtu.be') id = url.pathname.replace(/\/+$/, '').slice(1);
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
    else id = /^\/(?:shorts|live|embed)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1] || '';
  }
  if (!VIDEO_ID.test(id)) throw new Error('Use o link de um vídeo específico do YouTube.');
  return id;
}

function run(binary, args, timeout, maxBuffer = 512 * 1024) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout, maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const reason = String(stderr || '');
        if (/live event|is_live|live stream/i.test(reason)) reject(new Error('Escolha um vídeo gravado para adicionar à caixa.'));
        else if (/unavailable|private|sign in|not available/i.test(reason)) reject(new Error('Esse vídeo não está disponível para reprodução no servidor.'));
        else if (/larger than|max.filesize/i.test(reason)) reject(new Error('A faixa ultrapassa o tamanho de áudio suportado.'));
        else if (error.code === 'ENOENT') reject(new Error('Instale as dependências de YouTube e FFmpeg no servidor.'));
        else if (error.killed) reject(new Error('O preparo da música excedeu o tempo limite. Tente novamente.'));
        else reject(new Error('Não foi possível preparar esse vídeo. Tente outro link público do YouTube.'));
        return;
      }
      resolve(stdout);
    });
  });
}

module.exports = function createSpeakerMedia(directory) {
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true });
  const pending = new Map();
  const leases = new Map();
  let workers = 0;

  function file(key) {
    if (!/^[a-f0-9]{64}$/.test(key)) return null;
    const result = path.join(root, key + '.mp3');
    try {
      const stat = fs.statSync(result);
      return stat.isFile() && stat.size > 0 && stat.size <= MAX_AUDIO ? { path: result, size: stat.size } : null;
    } catch { return null; }
  }

  function cached(id) {
    const key = crypto.createHash('sha256').update('speaker-mp3-96-v1:' + id).digest('hex');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(root, key + '.json'), 'utf8'));
      const audio = file(key);
      if (data.id === id && data.key === key && typeof data.title === "string" && Number.isFinite(data.duration) && data.duration > 0 && audio && data.bytes === audio.size) return data;
    } catch { }
    return null;
  }

  function prune(references) {
    const keep = new Set(references);
    for (const id of pending.keys()) keep.add(crypto.createHash('sha256').update('speaker-mp3-96-v1:' + id).digest('hex'));
    for (const id of leases.keys()) keep.add(crypto.createHash('sha256').update('speaker-mp3-96-v1:' + id).digest('hex'));
    let names;
    try { names = fs.readdirSync(root); } catch { return; }
    for (const name of names) {
      const match = /^([a-f0-9]{64})\.(mp3|json)$/.exec(name);
      if (match && !keep.has(match[1])) {
        try { fs.unlinkSync(path.join(root, name)); } catch { }
      }
    }
  }

  async function prepare(id) {
    if (workers >= 2) throw new Error('Duas músicas estão sendo preparadas. Aguarde e tente novamente.');
    workers++;
    let job;
    try {
      let downloader, ffmpeg;
      try {
        downloader = require('youtube-dl-exec').constants.YOUTUBE_DL_PATH;
        ffmpeg = require('ffmpeg-static');
      } catch { throw new Error('Instale as dependências de YouTube e FFmpeg no servidor.'); }
      if (!fs.existsSync(downloader) || !ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('Execute os scripts de instalação de YouTube e FFmpeg no servidor.');
      job = await fs.promises.mkdtemp(path.join(root, 'speaker-job-'));
      const result = await run(downloader, [
        '--ignore-config', '--no-playlist', '--no-progress', '--no-warnings', '--no-part',
        '--socket-timeout', '15', '--retries', '1', '--max-filesize', '48M',
        '--match-filter', '!is_live', '--js-runtimes', 'node:' + process.execPath,
        '-f', 'bestaudio/best', '-o', path.join(job, 'source.%(ext)s'),
        '--print', 'after_move:%(.{id,title,duration})j',
        'https://www.youtube.com/watch?v=' + id
      ], 180000);
      const metadata = JSON.parse(result.trim().split(/\r?\n/).findLast(line => line.startsWith('{')) || '{}');
      const names = await fs.promises.readdir(job);
      const source = names.find(name => /^source\.[a-z0-9]{1,8}$/i.test(name));
      if (metadata.id !== id || !source || !Number.isFinite(metadata.duration) || metadata.duration <= 0) throw new Error('O vídeo não forneceu uma faixa de áudio completa.');
      const input = path.join(job, source);
      if ((await fs.promises.stat(input)).size > 48 * 1024 * 1024) throw new Error('O vídeo ultrapassa o tamanho suportado.');
      const output = path.join(job, 'audio.mp3');
      const progress = await run(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
        '-vn', '-ac', '1', '-ar', '44100', '-c:a', 'libmp3lame', '-b:a', '96k',
        '-fs', String(MAX_AUDIO), '-progress', 'pipe:1', '-nostats', output
      ], 120000);
      const times = [...progress.matchAll(/^out_time_us=(\d+)\r?$/gm)];
      const duration = times.length ? Number(times.at(-1)[1]) / 1e6 : 0;
      const bytes = (await fs.promises.stat(output)).size;
      if (!duration || bytes >= MAX_AUDIO - 4096 || duration < metadata.duration - 2) throw new Error('A faixa ultrapassa o limite de 24 MB por música.');
      const cachedBytes = fs.readdirSync(root).filter(name => /^[a-f0-9]{64}\.mp3$/.test(name))
        .reduce((total, name) => total + fs.statSync(path.join(root, name)).size, 0);
      if (cachedBytes + bytes > 512 * 1024 * 1024) throw new Error('O cache de músicas está cheio. Remova faixas ou caixas que já não usa.');
      const key = crypto.createHash('sha256').update('speaker-mp3-96-v1:' + id).digest('hex');
      const data = { id, key, title: String(metadata.title || 'Música').replace(/[\r\n]/g, ' ').slice(0, 160), duration, bytes };
      await fs.promises.rename(output, path.join(root, key + '.mp3'));
      await fs.promises.writeFile(path.join(root, key + '.json'), JSON.stringify(data));
      return data;
    } finally {
      workers--;
      if (job && path.dirname(path.resolve(job)) === root && path.basename(job).startsWith('speaker-job-')) {
        await fs.promises.rm(job, { recursive: true, force: true });
      }
    }
  }

  async function resolve(value) {
    const id = youtubeId(value);
    leases.set(id, (leases.get(id) || 0) + 1);
    try {
      const saved = cached(id);
      if (saved) return saved;
      if (!pending.has(id)) {
        const task = prepare(id).finally(() => pending.delete(id));
        pending.set(id, task);
      }
      return await pending.get(id);
    } finally {
      // Os consumidores confirmam a inclusão na fila antes de liberar a limpeza do cache.
      setImmediate(() => {
        const remaining = (leases.get(id) || 1) - 1;
        if (remaining) leases.set(id, remaining);
        else leases.delete(id);
      });
    }
  }

  return { resolve, file, cached, prune, maxBytes: MAX_AUDIO };
};
module.exports.youtubeId = youtubeId;
module.exports.MAX_AUDIO = MAX_AUDIO;
