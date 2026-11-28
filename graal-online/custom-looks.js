'use strict';
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFile } = require('node:child_process');
const KINDS = ['head', 'body', 'shield', 'sword', 'hat'];
const MAX_PNG = 65536, MAX_LIBRARY_BYTES = 400000, MAX_PER_KIND = 8;
const FULL_REFUND_MS = 5 * 60 * 60 * 1000;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function prices(config = {}) {
  return Object.fromEntries(KINDS.map(k => [k, Number.isSafeInteger(config[k]) && config[k] >= 0 && config[k] <= 20000 ? config[k] : 0]));
}
function changePrice(config, kind, price) {
  if (!KINDS.includes(kind) || !Number.isSafeInteger(price) || price < 0 || price > 20000) fail('invalid_price');
  return { ...prices(config), [kind]: price };
}
function dimensions(kind, w, h) {
  return kind === 'head' ? w === 32 && h >= 128 && h <= 1024 :
    kind === 'body' ? w === 128 && h >= 224 && h <= 1024 :
    kind === 'sword' ? w === 128 && h === 96 : kind === 'hat' ? w === 192 && h === 48 : kind === 'shield' && w === 38 && h === 20;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
// Validate the complete PNG before persisting or charging. Inflation is bounded by dimensions.
function validate(kind, png, animation = null) {
  if (animation !== null) {
    if (!animation || !Number.isSafeInteger(animation.height) || animation.height < 1 || animation.height > 1024 || !Array.isArray(animation.delays) || !animation.delays.length || animation.delays.length > 32 || animation.delays.some(d=>!Number.isFinite(d)||d<0.02||d>600)) fail('invalid_png');
    animation = {height:animation.height,delays:[...animation.delays]};
  }
  if (!KINDS.includes(kind) || typeof png !== 'string' || png.length > 22 + Math.ceil(MAX_PNG / 3) * 4 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(png)) fail('invalid_png');
  const bytes = Buffer.from(png.slice(22), 'base64');
  if (bytes.length > MAX_PNG || bytes.length < 57 || bytes.toString('base64') !== png.slice(22) || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) fail('invalid_png');
  let at = 8, w = 0, h = 0, depth, color, ended = false, palette = false, compressed = [];
  while (at + 12 <= bytes.length) {
    const n = bytes.readUInt32BE(at), tag = bytes.toString('ascii', at + 4, at + 8), end = at + 12 + n;
    if (end > bytes.length || crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail('invalid_png');
    const data = bytes.subarray(at + 8, end - 4);
    if (at === 8 && tag !== 'IHDR') fail('invalid_png');
    if (tag === 'IHDR') {
      if (at !== 8 || n !== 13) fail('invalid_png');
      w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; color = data[9];
      const validDepth = {0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]};
      const logicalHeight = animation ? animation.height : h;
      if (!dimensions(kind,w,logicalHeight) || w*h>1048576 || (animation && h !== logicalHeight * animation.delays.length) || !validDepth[color]?.includes(depth) || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail('invalid_png');
    } else if (tag === 'PLTE') { if (!n || n > 768 || n % 3) fail('invalid_png'); palette = true; }
    else if (tag === 'IDAT') compressed.push(data);
    else if (tag === 'IEND') { if (n !== 0 || end !== bytes.length) fail('invalid_png'); ended = true; break; }
    else if (tag === 'acTL' || tag === 'fcTL' || tag === 'fdAT' || (tag[0] === tag[0].toUpperCase() && !['tRNS'].includes(tag))) fail('invalid_png');
    at = end;
  }
  if (!ended || !compressed.length || (color === 3 && !palette)) fail('invalid_png');
  const channels = {0:1,2:3,3:1,4:2,6:4}[color], row = Math.ceil(w * channels * depth / 8), expected = (row + 1) * h;
  let raw;
  try { raw = zlib.inflateSync(Buffer.concat(compressed), { maxOutputLength: expected }); } catch { fail('invalid_png'); }
  if (raw.length !== expected) fail('invalid_png');
  for (let y = 0; y < h; y++) if (raw[y * (row + 1)] > 4) fail('invalid_png');
  return { id: crypto.createHash('sha256').update(bytes).digest('hex'), png, ...(animation ? { animation } : {}) };
}
function gifInfo(kind, bytes) {
  if (bytes.length < 14 || bytes.length > MAX_PNG || !/^GIF8[79]a$/.test(bytes.toString('ascii',0,6))) fail('invalid_png');
  const w = bytes.readUInt16LE(6), h = bytes.readUInt16LE(8);
  if (!dimensions(kind,w,h)) fail('invalid_png');
  let at = 13 + ((bytes[10] & 128) ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0), delay = 0.1;
  const delays = [];
  const blocks = () => { while (at < bytes.length) { const n = bytes[at++]; if (!n) return; at += n; if (at > bytes.length) fail('invalid_png'); } fail('invalid_png'); };
  while (at < bytes.length) {
    const tag = bytes[at++];
    if (tag === 0x3b) { if (at !== bytes.length || !delays.length) fail('invalid_png'); return {height:h,delays}; }
    if (tag === 0x21) {
      const type = bytes[at++];
      if (type === 0xf9) {
        if (at + 6 > bytes.length || bytes[at] !== 4 || bytes[at+5] !== 0) fail('invalid_png');
        delay = Math.max(0.02, bytes.readUInt16LE(at+2) / 100 || 0.1); at += 6;
      } else blocks();
    } else if (tag === 0x2c) {
      if (at + 9 > bytes.length || bytes.readUInt16LE(at) + bytes.readUInt16LE(at+4) > w || bytes.readUInt16LE(at+2) + bytes.readUInt16LE(at+6) > h) fail('invalid_png');
      const flags = bytes[at+8]; at += 9;
      if (flags & 128) at += 3 * (1 << ((flags & 7) + 1));
      if (at >= bytes.length || bytes[at++] > 12) fail('invalid_png');
      blocks(); delays.push(delay); delay = 0.1;
      if (delays.length > 32 || delays.length * w * h > 1048576) fail('capacity');
    } else fail('invalid_png');
  }
  fail('invalid_png');
}
async function prepare(kind, data, metadata = null) {
  if (typeof data !== 'string' || !data.startsWith('data:image/gif;base64,')) return validate(kind,data,metadata);
  if (data.length > 22 + Math.ceil(MAX_PNG / 3) * 4 || !/^data:image\/gif;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) fail('invalid_png');
  const bytes = Buffer.from(data.slice(22),'base64');
  if (bytes.toString('base64') !== data.slice(22)) fail('invalid_png');
  const animation = gifInfo(kind,bytes);
  const png = await new Promise((resolve,reject) => {
    const child = execFile(require('ffmpeg-static'), ['-v','error','-ignore_loop','1','-i','pipe:0','-vf',`format=rgba,tile=1x${animation.delays.length}:color=0x00000000`,'-frames:v','1','-f','image2pipe','-c:v','png','pipe:1'],
      {timeout:5000,maxBuffer:MAX_PNG,windowsHide:true,encoding:'buffer'}, (error,output) => error ? reject(Object.assign(new Error('invalid_png'),{code:'invalid_png'})) : resolve(output));
    child.stdin.on('error',()=>{}); child.stdin.end(bytes);
  });
  const asset = validate(kind,'data:image/png;base64,'+png.toString('base64'),animation);
  asset.id = crypto.createHash('sha256').update(bytes).digest('hex');
  return asset;
}
function empty() { return { library: Object.fromEntries(KINDS.map(k => [k, []])), equipped: Object.fromEntries(KINDS.map(k => [k, ''])) }; }
function legacy(data = {}) {
  const state = empty();
  const parse = value => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
  const old = parse(data.graal_custom_v1), skin = parse(data.graal_skin_v2), equipment = parse(data.graal_equip_v1);
  const candidates = {head: old.h, body: old.b, sword: equipment.l?.s, shield: equipment.l?.d};
  let total = 0;
  for (const kind of KINDS) {
    for (const png of (Array.isArray(candidates[kind]) ? candidates[kind] : []).slice(0, MAX_PER_KIND)) {
      try {
        const asset = validate(kind, png);
        if (total + png.length > MAX_LIBRARY_BYTES || state.library[kind].some(a => a.id === asset.id)) continue;
        state.library[kind].push({ ...asset, name: kind + ' importado' }); total += png.length;
      } catch { /* Preserve unrelated account progress; malformed old images are ignored. */ }
    }
    const selected = kind === 'head' ? candidates.head?.[Number(skin.h) - 37] : kind === 'body' ? candidates.body?.[Number(skin.b) - 20] : equipment.e?.[kind === 'sword' ? 's' : 'd'];
    const asset = state.library[kind].find(a => a.png === selected);
    if (asset) state.equipped[kind] = asset.id;
  }
  return state;
}
function ensure(state) {
  const looks = state.looks ||= empty();
  for (const kind of KINDS) {
    looks.library[kind] ||= [];
    looks.equipped[kind] ||= '';
  }
  return looks;
}
function buy(state, request, config, prepared = null) {
  const asset = prepared || validate(request.kind, request.png), fee = prices(config)[request.kind];
  if (request.price !== fee) fail('shop_changed');
  const looks = ensure(state), items = looks.library[request.kind];
  if (items.some(a => a.id === asset.id)) fail('already_owned');
  if (items.length >= MAX_PER_KIND || JSON.stringify(looks).length + asset.png.length > MAX_LIBRARY_BYTES) fail('capacity');
  if (state.gl < fee) fail('insufficient_glims');
  items.push({ ...asset, name: String(request.name || request.kind).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 48), paid:fee, boughtAt:Date.now() });
  state.gl -= fee; looks.equipped[request.kind] = asset.id;
  return { kind: request.kind, asset: asset.id, price: fee };
}
function equip(state, request) {
  if (!KINDS.includes(request.kind) || typeof request.asset !== 'string') fail('invalid_request');
  const looks = ensure(state);
  if (request.asset && !looks.library[request.kind].some(a => a.id === request.asset)) fail('not_owned');
  looks.equipped[request.kind] = request.asset;
  return { kind: request.kind, asset: request.asset };
}
function owned(state, request) {
  if (!KINDS.includes(request.kind) || typeof request.asset !== 'string' || !request.asset) fail('invalid_request');
  const asset = state.looks?.library[request.kind]?.find(a=>a.id===request.asset);
  if (!asset) fail('not_owned');
  return asset;
}
function hasPurchase(asset) {
  return Number.isSafeInteger(asset.paid) && asset.paid>=0 && asset.paid<=20000 && Number.isSafeInteger(asset.boughtAt) && asset.boughtAt>0;
}
function quoteSale(state,request,now=Date.now()) {
  const asset=owned(state,request);
  if (!hasPurchase(asset)) fail('refund_unavailable');
  const fullUntil=asset.boughtAt+FULL_REFUND_MS;
  return {kind:request.kind,asset:asset.id,name:asset.name,paid:asset.paid,refund:now<fullUntil?asset.paid:Math.floor(asset.paid/2),fullUntil,quotedAt:now};
}
function sell(state,request,now=Date.now()) {
  const quote=quoteSale(state,request,now);
  if (request.refund!==quote.refund) fail('refund_changed');
  if (state.gl+quote.refund>1000000000) fail('capacity');
  const items=state.looks.library[request.kind];
  items.splice(items.findIndex(a=>a.id===request.asset),1);
  if (state.looks.equipped[request.kind]===request.asset) state.looks.equipped[request.kind]='';
  state.gl+=quote.refund;
  return {kind:request.kind,asset:request.asset,refund:quote.refund};
}
function selected(state) {
  const looks = state?.looks || empty();
  return Object.fromEntries(KINDS.map(k => [k, looks.library[k]?.find(a => a.id === looks.equipped[k])?.png || null]));
}
function animation(state) {
  const looks = state?.looks || empty();
  return Object.fromEntries(KINDS.map(k => [k, looks.library[k]?.find(a => a.id === looks.equipped[k])?.animation || null]));
}
module.exports = { KINDS, MAX_PNG, MAX_LIBRARY_BYTES, FULL_REFUND_MS, prices, changePrice, dimensions, validate, prepare, empty, legacy, buy, equip, owned, hasPurchase, quoteSale, sell, selected, animation };
