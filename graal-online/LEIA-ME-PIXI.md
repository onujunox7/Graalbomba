# Graal Classic com PixiJS

O desenho do canvas principal agora é feito pelo PixiJS v7 (WebGL). A lógica do jogo, o servidor, o multiplayer e o editor não mudaram.

Como funciona: `pixi-bridge.src.js` (já embutido no `public/index.html`) cria um `g` com a mesma API do Canvas2D, só que cada chamada vira um Sprite/Graphics do Pixi.

- O Pixi vem de `public/vendor/pixi.min.js` (se você colocar o arquivo lá) ou do CDN jsDelivr (pixi.js@7.4.2).
- Se o Pixi não carregar ou o WebGL falhar, o jogo volta sozinho pro Canvas2D antigo.
- Para comparar: abra o jogo com `?canvas2d=1` (renderer antigo). No console, `__PIXI_ON` diz se o Pixi está ativo.
