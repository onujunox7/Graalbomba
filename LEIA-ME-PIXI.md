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

## Mapa (v19)
Quando um chunk do mapa sai do cache (limite de 20/24 chunks) ou o cache é resetado, a textura dele na GPU agora é liberada junto (`__PIXI_FORGET`). Antes só o canvas era descartado e a textura do Pixi ficava presa em memória.

## Conversão de formas, culling e quadros parados (v20)
Tudo dentro da ponte (`pixi-bridge.src.js`, já embutida no `index.html`); a lógica do jogo não mudou.
- **Formas viram sprites, não `Graphics`.** `fill()` e `stroke()` (sombras elípticas, caixas arredondadas do HUD, linhas, bordas) antes geravam um `Graphics` refeito todo quadro. Agora o contorno é rasterizado uma vez em branco e fica em cache (chave = geometria relativa, sem posição nem cor); a cor vai no `tint` do sprite. Uma sombra em movimento só troca a posição. Retângulos usam sprite branco com tint, e `strokeRect` alinhado vira 4 tiras. Só caem no `Graphics`: formas maiores que 200 px e o tracejado animado do editor.
- **Culling.** Imagem, texto, retângulo ou forma totalmente fora do canvas não cria sprite nem textura.
- **Atualização só quando necessário.** Cada quadro tem uma assinatura (textura, posição, escala, alfa e cor de cada item, mais as máscaras de recorte). Se for igual à do quadro anterior e nenhuma textura mudou de conteúdo, o Pixi não remonta a cena nem renderiza. Com `?prof=1` o medidor mostra `puladas` (quadros pulados por segundo).
- **Textura que muda de conteúdo** (canvas do editor, tocos de árvore, chunks editados) marca o quadro como sujo e força o redesenho.

### O que ainda é Canvas2D (de propósito)
Canvases auxiliares que só servem de textura ou de painel: minimapa, miniaturas e pré-visualizações do editor, painel de colisão, montagem do personagem (`CPOOL`), chunks do mapa e rótulos. O Pixi desenha o resultado deles no canvas principal.

### Correção v21: player ficava preso na pose de andar
A assinatura de quadro da v20 usava `texture.uid`, que o Pixi real não garante ter. Sem a textura na assinatura, o quadro "parado" (player no centro da tela, mesma posição) parecia igual ao quadro "andando" e era pulado. Agora cada textura recebe um id próprio (`__id`). Verificado no navegador (Chromium headless) rodando o jogo com um Pixi simulado sem `uid`: andar, parar e atacar saem iguais ao Canvas2D.

## v22+: editor de mapa mais fluido
- O mapa era salvo (JSON de todas as edições + localStorage, síncrono) a cada pincelada/carimbo; agora salva 350 ms depois da última edição (e na hora ao sair da aba ou exportar).
- O minimapa deixou de ser refeito inteiro a cada edição (no máximo a cada 300 ms).
- A pré-carga de chunks estava desligada no editor: andar com a câmera montava cada chunk novo de uma vez (17–36 ms de trava). Agora ela roda também no editor, com margem maior.
- No editor o loop é limitado a ~125 quadros/s (com FPS ilimitado + VSync off ele girava a milhares por segundo e atrapalhava o mouse).

## v24: zoom e tamanho da telinha no editor
- No canto superior direito do canvas (só no editor): 🔍 − / + muda quanto do mapa aparece (50% a 300%; Ctrl + roda do mouse também), 🖥 − / + muda o tamanho da telinha na tela (40% a 100%). As escolhas ficam salvas no navegador.
- `VH` deixou de ser constante (agora varia só no editor); grade e colisão desenham a área visível inteira em qualquer zoom.

## v25: colisão entre bichos com grade espacial
- A colisão corpo a corpo (`bodyHit`) varria TODOS os monstros a cada passo de cada monstro (O(n²)). Agora, com 40+ bichos, usa uma grade espacial refeita no começo de cada `update()` (`skgBuild`), e só olha as células vizinhas. Com menos de 40, ou se a lista `SK` mudar, usa a varredura antiga.
- Medido (update() por quadro, monstros andando): 200 monstros 1,05 → 0,41 ms; 400 monstros 3,57 → 0,74 ms. Conferido contra a varredura antiga em 24.000 consultas: 0 diferenças.
- Medição do desenho com Pixi real (7.4.2): com 150 monstros são ~1 ms de `draw()`, ~0,8 ms de `paint()` e 1 chamada de GPU por quadro, então a ponte PixiCtx não é o gargalo.

## v26: movimento suave (60/144 Hz)
- **Interpolação de rede.** Jogadores remotos e monstros (no cliente que não é o anfitrião) guardam os últimos snapshots do servidor (10/s) e são desenhados ~130 ms no passado, interpolando linearmente entre dois snapshots. Antes o personagem "perseguia" a última posição e acelerava/freava a cada pacote. Salto > 96 px (teleporte/respawn) não interpola.
- **Câmera suave.** `update()` segue o jogador com amortecimento exponencial `1-exp(-dt*k)` (`CAMS.k`, padrão 16), independente do FPS. Teletransporte, troca de mundo/interior, mudança de zoom ou salto > 160 px encaixam a câmera na hora. `window.__CAMSNAP=1` força o encaixe.
- Movimento e animações já usavam `dt`. Para passar de 60 FPS em monitor de 144 Hz, use a configuração de FPS (Sem limite ou travar em 144).
- Ajustes: `INTERP_DELAY` (mais baixo = menos atraso, mais tremida) e `CAMS.k` (maior = câmera mais colada).

### v26.1: menos atraso nos jogadores remotos
- Cliente envia posição a 20/s (antes 10/s) e o servidor repassa a 20/s (`setInterval` de 50 ms). **Precisa trocar o `server.js` também.**
- `INTERP_DELAY` agora é adaptativo: ~1,25× o intervalo real entre pacotes (≈72 ms com servidor a 20/s; ≈135 ms se o servidor ainda estiver a 10/s). Antes era fixo em 130 ms.

### v26.2: remoto não "desliza"
- A animação (Idle/Run/Attack) do jogador remoto agora vem do mesmo snapshot usado para a posição, não do pacote mais recente. Antes ele voltava a Idle (ou começava a correr) ~70 ms antes/depois de realmente parar/andar, e parecia deslizar de pé.
