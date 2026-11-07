/* Aetheria Online — cache seguro de recursos estáticos (v2).
 * Login, HTML, WebSocket, contas, mapas/config do servidor: sempre rede.
 * Somente /assets, /icons, /vendor e manifest entram no cache.
 */
const CACHE='aetheria-static-v2';
const PRECACHE=['/assets/aetheria-login-background.webp','/assets/bluechoco.png','/icons/icon-192.png','/icons/icon-512.png','/manifest.webmanifest'];
const STATIC=/^\/(?:assets|icons|vendor)\/|^\/manifest\.webmanifest$/;
self.addEventListener('install',event=>{
  event.waitUntil((async()=>{
    const cache=await caches.open(CACHE);
    await Promise.allSettled(PRECACHE.map(url=>cache.add(url)));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate',event=>{
  event.waitUntil((async()=>{
    const all=await caches.keys();
    await Promise.all(all.filter(k=>k.startsWith('aetheria-static-')&&k!==CACHE).map(k=>caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(!STATIC.test(url.pathname))return; // nunca fazer cache de login, contas, API, jogo HTML ou multiplayer
  event.respondWith((async()=>{
    const cache=await caches.open(CACHE);
    const cached=await cache.match(req);
    const refresh=fetch(req).then(res=>{
      if(res.ok&&res.type==='basic')cache.put(req,res.clone()).catch(()=>{});
      return res;
    });
    if(cached){event.waitUntil(refresh.catch(()=>{}));return cached;}
    try{return await refresh}catch(e){return Response.error()}
  })());
});
