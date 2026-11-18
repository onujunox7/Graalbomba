'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const http = require('node:http');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { youtubeId } = require('./speaker_media');
const { getEncoder } = require('./television_encoder');

const MAX_SEGMENT = 8 * 1024 * 1024;
const KEY = /^[a-f0-9]{32}$/;
const PROVIDERS = {
  youtube: ['googlevideo.com', 'youtube.com'],
  twitch: ['ttvnw.net', 'twitch.tv', 'twitchcdn.net', 'cloudfront.net'],
  kick: ['kick.com', 'live-video.net', 'cloudfront.net'],
  vimeo: ['vimeocdn.com', 'akamaized.net', 'cloudfront.net'],
  dailymotion: ['dmcdn.net', 'dailymotion.com']
};

function sourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Cole o link de um vídeo ou canal.');
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error('Link de vídeo inválido.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('Use um link HTTPS de uma plataforma de vídeo.');
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (['youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    return { provider: 'youtube', url: 'https://www.youtube.com/watch?v=' + youtubeId(value) };
  }
  if ((host === 'twitch.tv' && /^\/(?:videos\/\d+|[a-zA-Z0-9_]{1,40}(?:\/clip\/[a-zA-Z0-9_-]+)?)\/?$/.test(url.pathname)) ||
      (host === 'clips.twitch.tv' && /^\/[a-zA-Z0-9_-]{1,150}\/?$/.test(url.pathname))) {
    return { provider: 'twitch', url: url.origin + url.pathname };
  }
  if (host === 'kick.com' && /^\/[a-zA-Z0-9_-]{1,60}(?:\/videos\/[a-fA-F0-9-]{20,50})?\/?$/.test(url.pathname)) {
    return { provider: 'kick', url: 'https://kick.com' + url.pathname };
  }
  if (host === 'vimeo.com' && /^\/\d+(?:\/[a-zA-Z0-9]+)?\/?$/.test(url.pathname)) {
    return { provider: 'vimeo', url: 'https://vimeo.com' + url.pathname };
  }
  if (host === 'dailymotion.com' && /^\/video\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) {
    return { provider: 'dailymotion', url: 'https://www.dailymotion.com' + url.pathname };
  }
  throw new Error('Use YouTube, Twitch, Kick, Vimeo ou Dailymotion.');
}

function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
      a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 ||
      a === 198 && [18, 19].includes(b));
  }
  // Global IPv6 unicast, including only the provider's resolved public addresses.
  return net.isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address);
}

async function validateMedia(value, provider) {
  const url = new URL(value);
  const domains = PROVIDERS[provider] || [];
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !domains.some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain))) {
    throw new Error('A plataforma retornou uma origem de vídeo incompatível.');
  }
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new Error('Origem de vídeo inválida.');
  return { url: url.href, addresses };
}

// The static Linux FFmpeg crashes in native hostname resolution on the runtime.
// A loopback CONNECT tunnel keeps TLS end-to-end and resolves/pins public CDN IPs in Node.
async function createMediaProxy(provider) {
  const sockets = new Set();
  let closed = false;
  const server = http.createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  server.maxConnections = 16;
  server.headersTimeout = 10000;
  server.on('connect', async (request, client, head) => {
    sockets.add(client);
    client.on('error', () => {});
    client.on('close', () => sockets.delete(client));
    try {
      const target = /^([a-zA-Z0-9.-]+):443$/.exec(request.url || '');
      if (!target) return client.destroy();
      const { addresses } = await validateMedia('https://' + target[1], provider);
      if (closed || client.destroyed) return client.destroy();
      const address = addresses.find(item => item.family === 4) || addresses[0];
      const upstream = net.connect({ host: address.address, port: 443 });
      sockets.add(upstream);
      upstream.setTimeout(10000, () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      client.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch { client.destroy(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      server.close();
    }
  };
}

function encodeArgs(input, directory, headers = {}, proxy, audio) {
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
  const sources = [{ url: input, headers }];
  if (audio) sources.push(audio);
  for (const source of sources) {
    args.push('-threads', '1', '-protocol_whitelist', 'http,https,tcp,tls,crypto,httpproxy',
      '-rw_timeout', '15000000', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3', '-re');
    if (proxy) args.push('-http_proxy', proxy);
    const agent = source.headers?.['User-Agent'];
    if (agent) args.push('-user_agent', String(agent).replace(/[\r\n]/g, '').slice(0, 512));
    args.push('-i', source.url);
  }
  args.push('-map', '0:v:0', '-map', audio ? '1:a:0' : '0:a:0?',
    '-vf', 'scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=16',
    '-c:v', 'libtheora', '-q:v', '7', '-g', '64', '-force_key_frames', 'expr:gte(t,n_forced*4)',
    '-c:a', 'libvorbis', '-ac', '2', '-ar', '44100', '-q:a', '2', '-threads', '1',
    '-f', 'segment', '-segment_time', '4', '-reset_timestamps', '1', '-segment_format', 'ogg',
    '-segment_list_size', '24', '-segment_list_type', 'csv', '-segment_list', path.join(directory, 'segments.csv'),
    path.join(directory, '%06d.ogv'));
  return args;
}

function readSegments(directory) {
  let content;
  try { content = fs.readFileSync(path.join(directory, 'segments.csv'), 'utf8'); } catch { return []; }
  const result = [];
  for (const line of content.split(/\r?\n/).slice(-26)) {
    const match = /^(\d{6})\.ogv,(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(line);
    if (!match) continue;
    const index = Number(match[1]), start = Number(match[2]), end = Number(match[3]);
    if (end <= start || end - start > 6) continue;
    try {
      const stat = fs.statSync(path.join(directory, match[1] + '.ogv'));
      if (stat.isFile() && stat.size > 0 && stat.size <= MAX_SEGMENT) result.push({ index, start, end, bytes: stat.size });
    } catch { }
  }
  return result;
}

module.exports = function createTelevisionMedia(directory) {
  const root = path.resolve(directory);
  fs.mkdirSync(root, { recursive: true });
  for (const name of fs.readdirSync(root)) {
    if (!/^tv-[a-f0-9]{32}$/.test(name)) continue;
    const stale = path.join(root, name);
    const stat = fs.lstatSync(stale);
    if (stat.isDirectory() && Date.now() - stat.mtimeMs > 120000) {
      fs.rmSync(stale, { recursive: true, force: true });
    }
  }
  const sessions = new Map();
  let workers = 0;

  async function open(value, signal) {
    const source = sourceUrl(value);
    if (workers >= 1) throw new Error('Uma TV está transmitindo. Desligue a atual para iniciar outra.');
    workers++;
    let reserved = true;
    const release = () => {
      if (!reserved) return;
      reserved = false;
      workers--;
      signal?.removeEventListener('abort', release);
    };
    signal?.addEventListener('abort', release, { once: true });
    let session;
    try {
      const downloader = require('youtube-dl-exec').constants.YOUTUBE_DL_PATH;
      const encoder = getEncoder();
      const { stdout } = await promisify(execFile)(downloader, [
        '--ignore-config', '--no-playlist', '--no-warnings', '--skip-download', '--dump-single-json',
        '--socket-timeout', '12', '--retries', '1', '--js-runtimes', 'node:' + process.execPath,
        '-f', 'bestvideo[height<=720][fps<=30][vcodec^=avc1]+bestaudio/bestvideo[height<=480][fps<=30]+bestaudio/best[height<=720][fps<=30]/best[height<=720]/best', source.url
      ], { timeout: 35000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal });
      if (signal?.aborted) throw new Error('Preparo cancelado.');
      const info = JSON.parse(stdout);
      const formats = Array.isArray(info.requested_formats) ? info.requested_formats : [info];
      const video = formats.find(format => format.vcodec && format.vcodec !== 'none') || info;
      const audioFormat = formats.find(format => format.acodec && format.acodec !== 'none' && format.url !== video.url);
      const { url: input } = await validateMedia(video.url, source.provider);
      const audio = audioFormat ? { url: (await validateMedia(audioFormat.url, source.provider)).url, headers: audioFormat.http_headers || info.http_headers } : null;
      if (signal?.aborted) throw new Error('Preparo cancelado.');
      const key = crypto.randomBytes(16).toString('hex');
      const folder = path.join(root, 'tv-' + key);
      fs.mkdirSync(folder);
      session = { key, directory: folder, title: String(info.title || 'Vídeo').replace(/[\r\n]/g, ' ').slice(0, 120),
        live: !!info.is_live, segments: [], finished: false, error: '', stopped: false, process: null, proxy: null, release, lastProgress: Date.now() };
      sessions.set(key, session);
      session.proxy = await createMediaProxy(source.provider);
      if (signal?.aborted) throw new Error('Preparo cancelado.');
      const args = encodeArgs(input, folder, video.http_headers || info.http_headers, session.proxy.url, audio);
      if (encoder.fast) args.splice(args.indexOf('-c:a'), 0, '-speed_level', '9');
      const child = spawn(encoder.file, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      session.process = child;
      child.stderr.resume();
      child.on('error', () => { session.error = 'O conversor de vídeo não iniciou.'; });
      child.on('close', code => {
        session.proxy.close();
        release();
        session.finished = true;
        if (code !== 0 && !session.stopped) session.error = 'A transmissão foi interrompida. Tente abrir o link novamente.';
      });
      return session;
    } catch (error) {
      release();
      if (session) stop(session.key);
      if (signal?.aborted) throw new Error('Preparo cancelado.');
      if (error.message?.startsWith('A plataforma') || error.message === 'Origem de vídeo inválida.' || error.message === 'Instale as dependências de vídeo do servidor.') throw error;
      throw new Error('Não foi possível abrir esse vídeo. Confira se o link é público e se a live está online.');
    }
  }

  function poll(key) {
    const session = sessions.get(key);
    if (!session || session.stopped) return null;
    const segments = readSegments(session.directory);
    if (segments.at(-1)?.index !== session.segments.at(-1)?.index) session.lastProgress = Date.now();
    session.segments = segments;
    const first = segments[0]?.index || 0;
    for (const name of fs.readdirSync(session.directory)) {
      const match = /^(\d{6})\.ogv$/.exec(name);
      if (match && Number(match[1]) < first) fs.unlinkSync(path.join(session.directory, name));
    }
    if (!session.finished && Date.now() - session.lastProgress > 45000) {
      session.error = 'A transmissão parou de enviar vídeo. Abra o link novamente.';
      session.process.kill();
    }
    return session;
  }

  function file(key, index) {
    const session = sessions.get(key);
    const segment = session?.segments.find(item => item.index === index);
    if (!KEY.test(key) || !segment || session.stopped) return null;
    return { path: path.join(session.directory, String(index).padStart(6, '0') + '.ogv'), size: segment.bytes };
  }

  function stop(key) {
    const session = sessions.get(key);
    if (!session) return;
    sessions.delete(key);
    session.stopped = true;
    session.release();
    session.proxy?.close();
    const clean = () => {
      if (path.dirname(session.directory) === root && path.basename(session.directory) === 'tv-' + key && KEY.test(key)) {
        void fs.promises.rm(session.directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
    };
    if (session.finished || !session.process) clean();
    else {
      session.process.once('close', clean);
      session.process.kill();
      const timer = setTimeout(() => { if (!session.finished) session.process.kill('SIGKILL'); }, 3000);
      timer.unref();
    }
  }

  return { open, poll, file, stop, close() { for (const key of sessions.keys()) stop(key); } };
};

Object.assign(module.exports, { sourceUrl, publicAddress, encodeArgs, readSegments, MAX_SEGMENT });
