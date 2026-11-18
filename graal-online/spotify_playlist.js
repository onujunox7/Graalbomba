'use strict';
const MAX_TRACKS=100;
const MAX_HTML=2*1024*1024;
const text=value=>String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,120);

function playlistId(value) {
  if(typeof value!=='string'||value.length>2048)return null;
  let url;
  try {const input=value.trim();url=new URL(/^https?:\/\//i.test(input)?input:'https://'+input);}catch{return null;}
  if(url.hostname.toLowerCase()!=='open.spotify.com')return null;
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port)throw new Error('Use o link público completo da playlist do Spotify.');
  const match=/^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})\/?$/.exec(url.pathname);
  if(!match)throw new Error('Cole o link de uma playlist pública do Spotify.');
  return match[1];
}

function parsePlaylist(html,id) {
  const match=/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if(!match)throw new Error('Não foi possível ler essa playlist pública do Spotify.');
  let entity;
  try {entity=JSON.parse(match[1]).props?.pageProps?.state?.data?.entity;}catch{throw new Error('A playlist do Spotify retornou dados inválidos.');}
  if(entity?.type!=='playlist'||entity.id!==id||!Array.isArray(entity.trackList))throw new Error('Essa playlist não está disponível publicamente no Spotify.');
  const seen=new Set(),tracks=[];
  for(const item of entity.trackList) {
    const trackId=/^spotify:track:([A-Za-z0-9]{22})$/.exec(item?.uri||'')?.[1];
    const title=text(item?.title),artist=text(item?.subtitle);
    const duration=Number(item?.duration)/1000;
    if(!trackId||seen.has(trackId)||!title||!artist||!Number.isFinite(duration)||duration<=0||duration>86400)continue;
    seen.add(trackId);
    tracks.push({id:trackId,title,artist,duration});
    if(tracks.length===MAX_TRACKS)break;
  }
  if(!tracks.length)throw new Error('A playlist não contém músicas públicas que possam ser importadas.');
  return {id,title:text(entity.name)||'Playlist Spotify',url:'https://open.spotify.com/playlist/'+id,tracks};
}

async function loadPlaylist(value) {
  const id=playlistId(value);
  if(!id)throw new Error('Cole o link de uma playlist pública do Spotify.');
  try {
    const response=await fetch('https://open.spotify.com/embed/playlist/'+id,{signal:AbortSignal.timeout(20000),redirect:'error'});
    if(!response.ok||!response.body)throw new Error('A playlist precisa estar pública e disponível no Spotify.');
    if(Number(response.headers.get('content-length'))>MAX_HTML){await response.body.cancel();throw new Error('A playlist ultrapassa o tamanho de importação suportado.');}
    const parts=[];let bytes=0;
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>MAX_HTML)throw new Error('A playlist ultrapassa o tamanho de importação suportado.');parts.push(Buffer.from(chunk));}
    return parsePlaylist(Buffer.concat(parts).toString('utf8'),id);
  }catch(error){
    if(error.name==='TimeoutError'||error.name==='AbortError')throw new Error('O Spotify demorou para responder. Tente importar novamente.');
    if(error instanceof TypeError)throw new Error('Não foi possível acessar a playlist pública do Spotify.');
    throw error;
  }
}

module.exports={playlistId,parsePlaylist,loadPlaylist,MAX_TRACKS};
