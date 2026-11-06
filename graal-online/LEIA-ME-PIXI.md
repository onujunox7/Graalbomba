# Graal Classic com PixiJS

O desenho do canvas principal agora é feito pelo PixiJS v7 (WebGL). A lógica do jogo, o servidor, o multiplayer e o editor não mudaram.

Como funciona: `pixi-bridge.src.js` (já embutido no `public/index.html`) cria um `g` com a mesma API do Canvas2D, só que cada chamada vira um Sprite/Graphics do Pixi.

- O Pixi vem de `public/vendor/pixi.min.js` (se você colocar o arquivo lá) ou do CDN jsDelivr (pixi.js@7.4.2).
- Se o Pixi não carregar ou o WebGL falhar, o jogo volta sozinho pro Canvas2D antigo.
- Para comparar: abra o jogo com `?canvas2d=1` (renderer antigo). No console, `__PIXI_ON` diz se o Pixi está ativo.

## Cobertura da API (v18)
A ponte agora cobre tudo que o jogo usa do Canvas2D no canvas principal:
- `createRadialGradient` (vinheta vermelha de HP baixo / dano). Antes dava erro no modo Pixi. A textura do gradiente é feita uma vez e o alfa vai no sprite, então a vinheta pulsando não cria textura nova a cada quadro.
- `setLineDash` + `lineDashOffset` (retângulo tracejado animado de copiar/recortar no editor). Antes saía como linha sólida.
- `quadraticCurveTo` e `bezierCurveTo` (o jogo ainda não usa, mas a API fica completa).

Para rodar sem CDN, coloque `pixi.min.js` (v7.4.x) em `public/vendor/`.
