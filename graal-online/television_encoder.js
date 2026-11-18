'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

// FFmpeg 8 exposes Theora speed_level for CPU-constrained video encoding.
const RELEASE = 'autobuild-2026-11-18-12-39';
const VERSION = 'n8.1.3-36-ge22a4510c9';
const ASSETS = {
  x64: { platform: 'linux64', sha256: 'ebb9f19f7242b788704f0bf23fe959c90f7a4e5e72a554b0bf029012372cf215' },
  arm64: { platform: 'linuxarm64', sha256: 'b381f2a67cfb96ed7117566c851b7b1d80bf8d3ad1598301c86d6bf556b8d2a0' }
};
const DIRECTORY = path.join(__dirname, 'node_modules', '.aetheria-tv');
const BINARY = path.join(DIRECTORY, 'ffmpeg');

function getEncoder() {
  if (process.platform !== 'linux') return { file: require('ffmpeg-static'), fast: false };
  if (!fs.existsSync(BINARY)) throw new Error('Instale as dependências de vídeo do servidor.');
  return { file: BINARY, fast: true };
}

async function checksum(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function install() {
  if (process.platform !== 'linux') return false;
  const asset = ASSETS[process.arch];
  if (!asset) throw new Error('Arquitetura sem encoder de vídeo compatível.');
  const manifest = path.join(DIRECTORY, 'source.json');
  try {
    const info = JSON.parse(await fs.promises.readFile(manifest, 'utf8'));
    if (info.release === RELEASE && info.archiveSha256 === asset.sha256 && await checksum(BINARY) === info.binarySha256) return false;
  } catch { }
  await fs.promises.mkdir(DIRECTORY, { recursive: true });
  const job = await fs.promises.mkdtemp(path.join(DIRECTORY, 'install-'));
  const name = 'ffmpeg-' + VERSION + '-' + asset.platform + '-lgpl-8.1';
  const url = 'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/' + RELEASE + '/' + name + '.tar.xz';
  let output;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok || !response.body) throw new Error('Download do encoder de vídeo falhou.');
    const archive = path.join(job, 'encoder.tar.xz');
    output = await fs.promises.open(archive, 'wx');
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 160 * 1024 * 1024) throw new Error('Encoder de vídeo ultrapassou o tamanho permitido.');
      hash.update(chunk);
      await output.writeFile(chunk);
    }
    await output.close();
    output = null;
    if (hash.digest('hex') !== asset.sha256) throw new Error('Checksum inválido do encoder de vídeo.');
    await promisify(execFile)('tar', ['-xJf', archive, '--strip-components=2', '-C', job, name + '/bin/ffmpeg'], { timeout: 180000, windowsHide: true });
    const extracted = path.join(job, 'ffmpeg');
    await fs.promises.chmod(extracted, 0o755);
    const { stdout } = await promisify(execFile)(extracted, ['-hide_banner', '-h', 'encoder=libtheora'], { timeout: 15000, windowsHide: true });
    if (!stdout.includes('speed_level')) throw new Error('Encoder de vídeo sem modo rápido Theora.');
    const binarySha256 = await checksum(extracted);
    await fs.promises.rename(extracted, BINARY);
    const data = { release: RELEASE, source: url, license: 'LGPL-2.1-or-later', archiveSha256: asset.sha256, binarySha256 };
    await fs.promises.writeFile(manifest + '.tmp', JSON.stringify(data));
    await fs.promises.rename(manifest + '.tmp', manifest);
    return true;
  } finally {
    if (output) await output.close();
    if (path.dirname(job) === DIRECTORY && path.basename(job).startsWith('install-')) {
      await fs.promises.rm(job, { recursive: true, force: true });
    }
  }
}

module.exports = { getEncoder, install };

if (require.main === module) {
  install().then(changed => {
    if (changed) console.log('Encoder rápido de vídeo instalado.');
  }).catch(error => { console.error('Instalação do vídeo: ' + error.message); process.exitCode = 1; });
}
