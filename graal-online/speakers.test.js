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
  for(let i=0;i<100;i++){if(i%25===0)one.advance(1000);await one.request(1,'add',{id,url:'https://youtu.be/'+String(i).padStart(11,'0')});}
  await one.request(1,'add',{id,url:'https://youtu.be/xxxxxxxxxxx'});
  assert.equal(one.state().boxes[0].queue.length,100);
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


function fixture(playlistTracks=[{id:'A'.repeat(22),title:'First song',artist:'First artist',duration:10},{id:'B'.repeat(22),title:'Second song',artist:'Second artist',duration:10}]) {
  let time = 1000;
  let blocked = null;
  const players = new Map();
  const messages = new Map();
  const cache = new Map();
  const saves = [];
  const preparations = [];
  for (let id = 1; id <= 4; id++) {
    players.set(id, { id, role: id === 1 ? 1 : 0, ok: true, allowed: true,
      ws: { id, readyState: 1 }, x: 100, y: 100, in: 0 });
    messages.set(id, []);
  }
  const media = {
    maxBytes: 24 * 1024 * 1024,
    async resolve(url) {
      preparations.push(youtubeId(url));
      if (blocked) await blocked.promise;
      const id = youtubeId(url);
      const key = crypto.createHash('sha256').update(id).digest('hex');
      const data = { id, key, title: 'Faixa ' + id, duration: 10, bytes: 12345 };
      cache.set(key, data);
      return data;
    },
    async matchSpotify(song){return media.resolve('https://youtu.be/'+(song.title==='Second song'?'bbbbbbbbbbb':'aaaaaaaaaaa'));},
    file: key => cache.has(key) ? { path: key, size: 12345 } : null,
    prune() {}
  };
  const speakers = createSpeakers({ players, media, loadPlaylist:async()=>{if(blocked)await blocked.promise;return {title:'Test playlist',tracks:playlistTracks};}, now: () => time, save: data => saves.push(structuredClone(data)),
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
  return { players, speakers, messages, saves, cache, preparations, request, state, latest, place, hold,
    advance(ms) { time += ms; speakers.tick(); } };
}

test('prepara a próxima durante a atual e avança sem aguardar outra conversão',async()=>{
  const f=fixture(),id=await f.place();
  await f.request(1,'add',{id,url:'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL'});
  const epoch=f.state().boxes[0].epoch;
  const release=f.hold();f.advance(1000);
  await new Promise(resolve=>setImmediate(resolve));
  const during=f.state().boxes[0];
  assert.equal(f.preparations.length,2,'A próxima deve começar a preparar antes do fim da atual');
  assert.equal(during.playing,true);assert.equal(during.loading,false);assert.equal(during.epoch,epoch);
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state().boxes[0].next.id,'bbbbbbbbbbb');
  f.advance(9000);
  assert.equal(f.state().boxes[0].current.id,'bbbbbbbbbbb');
  assert.equal(f.state().boxes[0].playing,true);assert.equal(f.state().boxes[0].loading,false);
  assert.equal(f.preparations.length,2,'Avanço não deve iniciar outro download da mesma faixa');
});

test('próxima durante preparo reutiliza o trabalho e parada não reinicia áudio',async()=>{
  const f=fixture(),id=await f.place();
  await f.request(1,'add',{id,url:'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL'});
  const release=f.hold();f.advance(1000);
  await new Promise(resolve=>setImmediate(resolve));
  const next=f.request(1,'next',{id});
  await f.request(1,'stop',{id});
  release();await next;
  assert.equal(f.preparations.length,2);
  assert.equal(f.state().boxes[0].playing,false);
  assert.equal(f.state().boxes[0].offset,0);
});

test('excluir a próxima durante pré-carregamento não a recoloca na fila',async()=>{
  const f=fixture(),id=await f.place();
  await f.request(1,'add',{id,url:'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL'});
  const release=f.hold();f.advance(1000);
  await f.request(1,'remove_track',{id,track:'spotify:'+'B'.repeat(22)});
  release();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state().boxes[0].queue.length,1);
  assert.equal(f.state().boxes[0].current.id,'aaaaaaaaaaa');
  assert.equal(f.state().boxes[0].playing,true);
});

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

test('playlist carrega os nomes de 40 faixas sem baixar todas e mantém protocolo anterior',async()=>{
  const songs=Array.from({length:40},(_,i)=>({id:String(i).padStart(22,'0'),title:'Song '+i,artist:'Artist '+i,duration:10}));
  const f=fixture(songs),id=await f.place();
  await f.request(1,'add',{id,url:'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL'});
  const box=f.state().boxes[0];
  assert.equal(box.queue.length,40);
  assert.equal(box.queue[0].title,'Song 0 — Artist 0');
  assert.equal(box.current_entry,'spotify:'+songs[0].id);
  assert.equal(box.current.id,'aaaaaaaaaaa');
  assert.equal(box.current.title,'Song 0 — Artist 0');
  assert.equal(box.tracks.length,1);
  assert.equal(f.cache.size,1);
  assert.equal(f.state(2).boxes[0].queue,undefined);
  assert.equal(f.state(2).boxes[0].tracks,undefined);
  assert.equal(f.state().version,1);
});

test('seleção e avanço usam a entrada da playlist e persistem músicas ainda não preparadas',async()=>{
  const f=fixture(),id=await f.place();
  await f.request(1,'add',{id,url:'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL'});
  const saved=f.speakers.dump();
  saved.boxes[0].tracks.push(structuredClone(saved.boxes[0].tracks[1]));
  const restored=fixture();restored.speakers.restore(saved);
  assert.equal(restored.state().boxes[0].queue.length,2);
  assert.equal(restored.state().boxes[0].queue[1].ready,false);
  await f.request(1,'play',{id,track:'spotify:'+'B'.repeat(22)});
  assert.equal(f.state().boxes[0].current.id,'bbbbbbbbbbb');
  assert.equal(f.state().boxes[0].current_entry,'spotify:'+'B'.repeat(22));
  await f.request(1,'play',{id,track:'spotify:'+'A'.repeat(22)});
  f.advance(11000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state().boxes[0].current_entry,'spotify:'+'B'.repeat(22));
  assert.equal(f.state().boxes[0].playing,true);
});

test('importação não substitui fila existente e não duplica músicas da mesma playlist',async()=>{
  const f=fixture(),id=await f.place();
  await f.request(1,'add',{id,url:'https://youtu.be/ccccccccccc'});
  await f.request(1,'add',{id,url:'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL'});
  assert.equal(f.state().boxes[0].current.id,'ccccccccccc');
  assert.equal(f.state().boxes[0].queue.length,3);
  await f.request(1,'add',{id,url:'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL'});
  assert.equal(f.state().boxes[0].queue.length,3);
  assert.ok(f.latest().message.includes('já estão na fila'));
  await f.request(1,'remove_track',{id,track:'spotify:'+'B'.repeat(22)});
  assert.equal(f.state().boxes[0].queue.length,2);
});

test('parar durante importação impede início automático e revogar cargo impede inclusão',async()=>{
  const f=fixture(),id=await f.place();let release=f.hold();
  const pending=f.request(1,'add',{id,url:'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL'});
  await f.request(1,'stop',{id});release();await pending;
  assert.equal(f.state().boxes[0].queue.length,2);
  assert.equal(f.state().boxes[0].playing,false);
  assert.equal(f.cache.size,0);
  const g=fixture(),other=await g.place();release=g.hold();
  const blocked=g.request(1,'add',{id:other,url:'https://open.spotify.com/playlist/0123456789ABCDEFGHIJKL'});
  g.players.get(1).role=0;release();await blocked;g.players.get(1).role=1;
  assert.equal(g.state().boxes[0].queue.length,0);
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
