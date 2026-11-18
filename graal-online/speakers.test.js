'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const createSpeakers = require('./speakers');
const { youtubeId } = require('./speaker_media');


test('limites de caixas e fila mantêm recursos e composição consistentes', async () => {
  const f=fixture();
  for(let i=0;i<16;i++) await f.place();
  await f.request(1,'place');
  assert.equal(f.state().boxes.length,16);
  const one=fixture();
  const id=await one.place();
  for(let i=0;i<20;i++) await one.request(1,'add',{id,url:'https://youtu.be/'+String(i).padStart(11,'0')});
  await one.request(1,'add',{id,url:'https://youtu.be/xxxxxxxxxxx'});
  assert.equal(one.state().boxes[0].tracks.length,20);
});

test('cache protege consumidores simultâneos e limpa arquivos sem referência depois da confirmação', async () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'speaker-lease-test-'));
  try {
    const id='aaaaaaaaaaa';
    const key=crypto.createHash('sha256').update('speaker-mp3-96-v1:'+id).digest('hex');
    fs.writeFileSync(path.join(dir,key+'.mp3'),'ID3');
    fs.writeFileSync(path.join(dir,key+'.json'),JSON.stringify({id,key,title:'Faixa',duration:10,bytes:3}));
    const media=require('./speaker_media')(dir);
    const a=media.resolve('https://youtu.be/'+id);
    const b=media.resolve('https://youtu.be/'+id);
    media.prune([]);
    assert.ok(media.file(key));
    await Promise.all([a,b]);
    await new Promise(resolve=>setImmediate(resolve));
    media.prune([]);
    assert.equal(media.file(key),null);
  } finally {
    if(path.dirname(dir)===os.tmpdir() && path.basename(dir).startsWith('speaker-lease-test-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('persistência escolhe backup mais recente e serializa gravações do banco', async () => {
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'speaker-store-test-'));
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const writes=[];
  const pool={async query(request){
    if(request.text.startsWith('SELECT'))return {rows:[{v:{savedAt:1,boxes:[]}}]};
    writes.push(JSON.parse(request.values[0]));
    if(writes.length===1)await gate;
    return {rows:[]};
  }};
  const store=require('./speaker_store')(pool,path.join(dir,'state.json'));
  try {
    store.save({savedAt:2,boxes:[{id:'first'}]});
    store.save({savedAt:3,boxes:[{id:'latest'}]});
    assert.equal((await store.load()).savedAt,3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'state.json'),'utf8')).boxes[0].id,'latest');
    release();
    await new Promise(resolve=>setTimeout(resolve,20));
    assert.deepEqual(writes.map(value=>value.savedAt),[2,3]);
  } finally {
    store.close();
    if(path.dirname(dir)===os.tmpdir() && path.basename(dir).startsWith('speaker-store-test-'))fs.rmSync(dir,{recursive:true,force:true});
  }
});


function fixture() {
  let time = 1000;
  let blocked = null;
  const players = new Map();
  const messages = new Map();
  const cache = new Map();
  const saves = [];
  for (let id = 1; id <= 4; id++) {
    players.set(id, { id, role: id === 1 ? 1 : 0, ok: true, allowed: true,
      ws: { id, readyState: 1 }, x: 100, y: 100, in: 0 });
    messages.set(id, []);
  }
  const media = {
    maxBytes: 24 * 1024 * 1024,
    async resolve(url) {
      if (blocked) await blocked.promise;
      const id = youtubeId(url);
      const key = crypto.createHash('sha256').update(id).digest('hex');
      const data = { id, key, title: 'Faixa ' + id, duration: 10, bytes: 12345 };
      cache.set(key, data);
      return data;
    },
    file: key => cache.has(key) ? { path: key, size: 12345 } : null,
    prune() {}
  };
  const speakers = createSpeakers({ players, media, now: () => time, save: data => saves.push(structuredClone(data)),
    authorized: p => p.allowed, send: (ws, data) => messages.get(ws.id).push(structuredClone(data)) });
  const request = (id, op, data = {}) => speakers.handle(players.get(id), { op, ...data });
  const state = (id = 1) => speakers.state(players.get(id));
  const latest = (id = 1) => messages.get(id).at(-1);
  async function place() { await request(1, 'place'); return latest().selected; }
  function hold() {
    let release;
    blocked = { promise: new Promise(resolve => { release = resolve; }) };
    return () => { blocked = null; release(); };
  }
  return { players, speakers, messages, saves, cache, request, state, latest, place, hold,
    advance(ms) { time += ms; speakers.tick(); } };
}

test('somente cargo reconhecido pelo servidor cria, move, remove ou controla caixas', async () => {
  const f = fixture();
  await f.request(2, 'place', { role: 2, x: 9999, y: 9999 });
  assert.equal(f.state().boxes.length, 0);
  const id = await f.place();
  assert.equal(f.state().boxes[0].x, 100);
  for (const op of ['remove', 'move', 'volume', 'add', 'pause', 'play']) await f.request(2, op, { id, volume: 0, url: 'https://youtu.be/aaaaaaaaaaa' });
  assert.equal(f.state().boxes.length, 1);
  assert.equal(f.state().boxes[0].volume, 65);
  f.players.get(1).x = 200;
  await f.request(1, 'move', { id, x: -99999 });
  assert.equal(f.state().boxes[0].x, 200);
  await f.request(1, 'remove', { id });
  assert.equal(f.state().boxes.length, 0);
});

test('proximidade usa posição real do interior e isola ambientes e partidas', async () => {
  const f = fixture();
  f.players.get(1).in = 1; f.players.get(1).ix = 30; f.players.get(1).iy = 40;
  const id = await f.place();
  assert.equal(f.state().boxes[0].y, 40);
  assert.equal(f.state(2).boxes.length, 0);
  f.players.get(2).in = 1; f.players.get(2).ix = 30; f.players.get(2).iy = 40;
  assert.equal(f.state(2).boxes[0].audible, true);
  f.players.get(2).football = 'private';
  assert.equal(f.state(2).boxes.length, 0);
  f.players.get(2).football = '';
  f.players.get(2).ix = 1000;
  f.advance(250);
  assert.equal(f.state(2).boxes.length, 0);
  assert.equal(f.state().boxes[0].id, id);
});

test('primeira música inicia, fila avança e quem chega depois recebe a posição atual', async () => {
  const f = fixture();
  const id = await f.place();
  await f.request(1, 'add', { id, url: 'https://youtu.be/aaaaaaaaaaa' });
  await f.request(1, 'add', { id, url: 'https://youtube.com/watch?v=bbbbbbbbbbb' });
  assert.equal(f.state().boxes[0].current.id, 'aaaaaaaaaaa');
  f.advance(4000);
  assert.equal(f.state(2).boxes[0].offset, 4);
  assert.equal(f.state(2).boxes[0].tracks, undefined);
  f.advance(7000);
  assert.equal(f.state().boxes[0].current.id, 'bbbbbbbbbbb');
  assert.equal(f.state().boxes[0].offset, 1);
  f.advance(105000);
  assert.equal(f.state().boxes[0].current.id, 'bbbbbbbbbbb');
  assert.equal(f.state().boxes[0].offset, 6);
});

test('volume, pausa, retomada e parada mantêm tempo e estado consistentes', async () => {
  const f = fixture();
  const id = await f.place();
  await f.request(1, 'add', { id, url: 'https://youtu.be/aaaaaaaaaaa' });
  f.advance(3000);
  await f.request(1, 'pause', { id });
  f.advance(9000);
  assert.equal(f.state().boxes[0].offset, 3);
  await f.request(1, 'volume', { id, volume: 0 });
  assert.equal(f.state().boxes[0].volume, 0);
  await f.request(1, 'volume', { id, volume: 101 });
  assert.equal(f.state().boxes[0].volume, 0);
  await f.request(1, 'play', { id });
  f.advance(1000);
  assert.equal(f.state().boxes[0].offset, 4);
  await f.request(1, 'stop', { id });
  assert.equal(f.state().boxes[0].offset, 0);
  assert.equal(f.state().boxes[0].playing, false);
});

test('remover caixa durante preparo não recria objeto e revogação impede inclusão', async () => {
  const f = fixture();
  const id = await f.place();
  let release = f.hold();
  const first = f.request(1, 'add', { id, url: 'https://youtu.be/aaaaaaaaaaa' });
  await f.request(1, 'remove', { id });
  release(); await first;
  assert.equal(f.state().boxes.length, 0);
  const secondId = await f.place();
  release = f.hold();
  const second = f.request(1, 'add', { id: secondId, url: 'https://youtu.be/aaaaaaaaaaa' });
  f.players.get(1).role = 0;
  release(); await second;
  f.players.get(1).role = 1;
  assert.equal(f.state().boxes[0].tracks.length, 0);
  assert.equal(f.state().boxes[0].loading, false);
});

test('parar durante preparo conserva música adicionada e respeita parada', async () => {
  const f = fixture();
  const id = await f.place();
  const release = f.hold();
  const add = f.request(1, 'add', { id, url: 'https://youtu.be/aaaaaaaaaaa' });
  await f.request(1, 'stop', { id });
  release(); await add;
  assert.equal(f.state().boxes[0].tracks.length, 1);
  assert.equal(f.state().boxes[0].playing, false);
});

test('salvamento restaura posição, volume e fila e elimina caixas de salas encerradas', async () => {
  const f = fixture();
  const id = await f.place();
  await f.request(1, 'add', { id, url: 'https://youtu.be/aaaaaaaaaaa' });
  await f.request(1, 'volume', { id, volume: 43 });
  const saved = f.speakers.dump();
  const restored = fixture();
  restored.speakers.restore(saved);
  assert.equal(restored.state().boxes[0].volume, 43);
  assert.equal(restored.state().boxes[0].tracks.length, 1);
  assert.equal(restored.state().boxes[0].playing, false);
  f.players.get(1).football = 'test-room';
  await f.request(1, 'move', { id });
  assert.equal(f.speakers.dump().boxes.length, 0);
  f.players.get(1).football = '';
  f.advance(250);
  assert.equal(f.state().boxes.length, 0);
});

test('links permitidos são normalizados e URLs arbitrárias nunca alcançam o conversor', async () => {
  assert.equal(youtubeId('https://youtu.be/jNQXAC9IVRw?si=tracking'), 'jNQXAC9IVRw');
  assert.equal(youtubeId('https://music.youtube.com/watch?v=jNQXAC9IVRw'), 'jNQXAC9IVRw');
  assert.equal(youtubeId('https://www.youtube.com/shorts/jNQXAC9IVRw'), 'jNQXAC9IVRw');
  for (const url of ['http://127.0.0.1/private', 'file:///secret', 'https://youtube.com.evil/watch?v=jNQXAC9IVRw',
    'https://user:password@youtube.com/watch?v=jNQXAC9IVRw', 'https://youtu.be/../../secret', 'https://youtube.com/playlist?list=x']) assert.throws(() => youtubeId(url));
  const f = fixture();
  const id = await f.place();
  await f.request(1, 'add', { id, url: 'http://127.0.0.1/private' });
  assert.equal(f.cache.size, 0);
});
