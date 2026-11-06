/* Service worker mínimo: o jogo precisa do servidor (WebSocket + contas), então NADA é guardado em cache.
   Ele existe para o navegador/PWABuilder reconhecer o site como app instalável. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<meta charset="utf-8"><body style="background:#14161c;color:#fff;font:16px sans-serif;text-align:center;padding:40px">Sem conexão com o servidor do Graal.<br>Verifique a internet e tente de novo.</body>',
    { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
