'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {playlistId,parsePlaylist,loadPlaylist}=require('./spotify_playlist');
const {selectYoutubeMatch}=require('./speaker_media');
const ID='0123456789ABCDEFGHIJKL';
const item=i=>({uri:'spotify:track:'+String(i).padStart(22,'0'),title:'Song '+i,subtitle:'Artist '+i,duration:200000});
const html=tracks=>'<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{state:{data:{entity:{id:ID,type:'playlist',name:'My playlist',trackList:tracks}}}}}})+'</script>';

test('links de playlist são canonicalizados e destinos estranhos não fazem requisições',async t=>{
  assert.equal(playlistId('https://open.spotify.com/playlist/'+ID+'?si=abc'),ID);
  assert.equal(playlistId('open.spotify.com/intl-pt/playlist/'+ID),ID);
  t.mock.method(globalThis,'fetch',()=>{throw Error('Unexpected network access');});
  for(const url of ['http://127.0.0.1/playlist/'+ID,'https://open.spotify.com.evil/playlist/'+ID,'file:///etc/passwd','https://x:y@open.spotify.com/playlist/'+ID,'https://open.spotify.com:1234/playlist/'+ID,'https://open.spotify.com/track/'+ID])await assert.rejects(loadPlaylist(url));
});

test('parser importa 40 nomes e artistas, remove duplicados e limita a 100',()=>{
  const tracks=Array.from({length:40},(_,i)=>item(i));
  const result=parsePlaylist(html([...tracks,tracks[0],{uri:'spotify:episode:'+ID,title:'Podcast',subtitle:'Artist',duration:200000}]),ID);
  assert.equal(result.tracks.length,40);
  assert.equal(result.tracks[0].duration,200);
  assert.equal(result.tracks[0].artist,'Artist 0');
  assert.equal(result.url,'https://open.spotify.com/playlist/'+ID);
  assert.equal(parsePlaylist(html(Array.from({length:120},(_,i)=>item(i))),ID).tracks.length,100);
  assert.throws(()=>parsePlaylist('<html>login</html>',ID));
  assert.throws(()=>parsePlaylist(html([]),ID));
});

test('download lê somente embed público com timeout e rejeita páginas muito grandes',async t=>{
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,'https://open.spotify.com/embed/playlist/'+ID);
    assert.equal(options.redirect,'error');assert.ok(options.signal);
    return new Response(html([item(1)]));
  });
  assert.equal((await loadPlaylist('https://open.spotify.com/playlist/'+ID)).tracks.length,1);
  t.mock.method(globalThis,'fetch',async()=>new Response('bad',{headers:{'content-length':String(3*1024*1024)}}));
  await assert.rejects(loadPlaylist('https://open.spotify.com/playlist/'+ID),/tamanho/);
});

test('correspondência prioriza título, artista e duração em vez de covers ou outro artista',()=>{
  const song={title:'Faint',artist:'Linkin Park',duration:162};
  const entries=[
    {id:'aaaaaaaaaaa',title:'Faint - Piano Cover Linkin Park',duration:162},
    {id:'bbbbbbbbbbb',title:'Faint - Different artist',duration:162},
    {id:'ccccccccccc',title:'Linkin Park - Faint (Official Music Video)',duration:168}
  ];
  assert.equal(selectYoutubeMatch(entries,song),'ccccccccccc');
  assert.throws(()=>selectYoutubeMatch([{id:'ddddddddddd',title:'Completely different',duration:10}],song),/correspondente/);
  assert.throws(()=>selectYoutubeMatch([{id:'eeeeeeeeeee',title:'Linkin Park - Faint full album',duration:3600}],song),/correspondente/);
});
