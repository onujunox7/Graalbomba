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

### v26.3: carimbo de tempo do remetente
- O cliente envia `ct` (seu `performance.now()`) junto da posição; o servidor repassa. Quem recebe interpola pela hora em que a posição foi medida (com um deslocamento de relógio estimado por mínimo móvel), em vez da hora em que o pacote chegou. Isso tira o jitter de rede/timer, que dava ritmo irregular e aparência de deslizar. Com servidor antigo (sem `ct`) volta ao comportamento anterior. **Precisa trocar o `server.js`.**

### v26.4: ataque do amigo na velocidade certa
- O cliente envia `ak` (contador de golpes) e `ad` (duração do golpe em ms). O remoto reinicia a animação de espada a cada golpe novo e a toca na mesma velocidade do golpe original (a duração varia com o ritmo dos cliques, de 110 a 200 ms). Antes ela rodava sempre em 300 ms e, clicando rápido, o estado "Attack" nunca mudava e a animação travava no último quadro. **Precisa trocar o `server.js`.**

### v26.5: golpe do amigo não repete o início
- O estado "Attack" entrava um pacote antes do contador de golpe `ak`, então a animação reiniciava duas vezes seguidas. Agora o ataque só começa quando os dois chegam juntos (um reinício só). Só o cliente mudou.

### v26.6: buffer de jitter adaptativo
- O atraso da interpolação agora é `intervalo + 1,2 × pior atraso de chegada recente + 12 ms` (entre 65 e 220 ms), medido com o carimbo `ct`; muda no máximo ±2 ms por pacote. Quando faltava pacote na hora de desenhar, o remoto extrapolava devagar e depois "puxava", dando a sensação de lento/deslizando. Extrapolação agora a 75% da velocidade, até 100 ms.
- Diagnóstico no console: `__ID()` (atraso atual, ms) e `__SNAP.u` (quantas vezes faltou pacote).

### v26.7: câmera clássica por padrão
- A câmera volta a ficar travada no jogador (como no Graal Classic). A câmera suave da v26 continua disponível: abra com `?cam=suave` ou rode `__CAM('suave')` no console (`__CAM('classica')` volta). A escolha fica salva no navegador.
- Movimento do jogador (início/parada instantâneos, diagonal na velocidade cheia por eixo, deslizar na parede) já era assim e não foi alterado.

### v26.8: fim do atraso alto (o `__ID()` marcava 220 ms)
- **Bug:** o servidor mandava o estado de todos a cada 50 ms, repetindo o último dado conhecido quando não tinha pacote novo. O cliente tratava cada repetição como ponto novo (mesma posição, 1 ms depois), o que gerava paradas na interpolação e inflava a medida de jitter até o teto de 220 ms.
- **Cliente:** pacotes repetidos/antigos (mesmo `ct`) são ignorados; o jitter e o intervalo são medidos por jogador, só com pacotes novos; atraso = intervalo + pior atraso recente + 10 ms (65 a 220 ms).
- **Servidor:** cada `u` recebido é repassado na hora aos outros (`pu`), sem esperar o próximo ciclo de 50 ms. O `st` completo continua, mas a cada 500 ms, só para sincronizar e limpar quem saiu. **Precisa trocar o `server.js`.**

### A+D juntos (v26.9)
- Segurando A e D ao mesmo tempo (ou ← e →) e andando para cima/baixo (W/S), o personagem olha para a DIREITA (também ao atacar nessa hora). Só teclado; o joystick não muda.

### W+S juntos + A (v26.9)
- Segurando W e S ao mesmo tempo e apertando A (ou ↑ ↓ ←), o personagem anda para a ESQUERDA olhando para BAIXO (também ao atacar). Só teclado.

### Velocidade igual em todas as direções (v26.9)
- `DIAG` (perto de `SPD`): 1 = diagonal com a mesma distância/s das retas, mas cada eixo anda só 0,707 e a diagonal PARECE mais lenta; 1,4142 = velocidade cheia por eixo (Graal clássico), mas a diagonal anda 41% mais longe. Está em 1,2 (meio-termo). Ajuste esse número.
- **Bug da parede:** em `move()`, quando um eixo batia na parede na diagonal, o outro eixo recebia o resto do passo (até 1,41× mais rápido ao deslizar). O bônus passava da velocidade normal. Agora (`SLD` = SPD·dt) o eixo livre completa só até a velocidade NORMAL de andar reto: deslizar na parede = mesma velocidade de andar livre (125 px/s), nem mais lento nem mais rápido. Para voltar à diagonal rápida, `DIAG=1.4142`.

### A+D / W+S sozinhos (v26.9)
- Só A+D (ou ← →): o personagem faz a animação de andar para a DIREITA, mas fica parado. Só W+S (ou ↑ ↓): animação de andar para BAIXO, parado. Não vira a animação de "empurrar". Se A+D vier junto com W ou S, ele anda (como já era). Só teclado.

### Grama alta sem lentidão (v26.9)
- O player andava a 70% da velocidade em cima da grama alta (mapa `GR`). Agora o fator `gm` no andar é sempre 1: velocidade normal em qualquer chão. (Para voltar, troque `const gm=1` por `GR&&GR[...]?.7:1`.)

### Animação de empurrar mais lenta (v26.9)
- Cada quadro de "empurrar" durava 0,1 s; agora `PUSH_FT` = 0,18 s (perto de `PUSHT`). Aumente para ficar ainda mais lenta.

### Colisão do boneco maior (v26.9)
- `HB_P` (caixa de colisão do player) foi de `[6,2.5,.5]` (12×5 px) para `[6.5,3.5,.5]` (13×7 px): +2 px de altura nos pés e +1 px de largura (braços). A faixa de corte de arbusto (`cutFront`) e a caixa de "saí de cima da bomba" (`bombOverP`) acompanham. Ajuste `HB_P` para mais ou menos.

### Pés maiores de lado (v26.9)
- Olhando para esquerda/direita E para baixo o player usa `HB_PS` = `[6.5,4.5,-.5]` (13×9 px, de y-4 até y+5, ou seja +2 px nos pés); só de costas (olhando para cima) continua `HB_P`. Se a caixa maior já estiver dentro de uma parede ao virar, usa a menor até sair (sem empurrão/pulo).

### Balão de chat parado (v26.9)
- O balão (e o "digitando...") era posicionado no topo da cabeça do quadro atual, que balança na animação de andar, então tremia. Agora a altura usa o ponto mais alto da cabeça nas últimas ~1,5–3 s (`stabOff`): fica fixo andando/atacando e ainda acompanha troca de chapéu/skin. Vale para você e para os outros jogadores.

### Balão de chat menor (v26.9)
- Letra do balão de 8 px para 6 px (`BUB_FS`, perto de `stabOff`) e contorno um pouco mais fino. Mude `BUB_FS` para ajustar.

### Balão "digitando…" menor e pulando (v26.9)
- `typ()`: balão de 22×11 para 15×8 px (`TYP_W`/`TYP_H`), pontinhos menores. O balão dá um pulinho (até 2 px) e os 3 pontos pulam em sequência (antes só mudavam de brilho).

### Fonte Lilita One no nick e no chat (v26.9)
- Carregada do Google Fonts (junto da Fredoka). `window.__FN` guarda a família e `window.fnt(px)` monta a fonte do canvas (sem "bold", a Lilita One só tem peso normal; devolve a fonte reserva até `window.__FNOK` = 1, assim os textos em cache do Pixi não ficam presos na fonte errada). Usada em: nickname sobre os personagens, balão de fala, caixa de digitar do chat, mensagens do chat na tela e histórico do chat global (CSS no fim do `<style>` inicial). Se não carregar (sem internet), cai para Fredoka/Verdana. O resto do jogo continua em Fredoka. Para vender sem CDN, ponha o arquivo da fonte em `public/vendor/` e um `@font-face`.

### Espada: alcance até a ponta da lâmina (v26.9)
- **Bug:** o alcance da espada era só `SWORD_GAP` (4 px) além do corpo, bem menor que a lâmina desenhada; encostar um pouco abaixo da ponta não dava dano nem cortava arbusto.
- **Agora:** o alcance vai da base até a ponta da lâmina. `SWORD_FR` guarda a distância do centro do jogador até a ponta (px do quadro do sprite, medida na folha: Direita 48, Esquerda 42, Baixo 33, Cima 63) e é multiplicada por `GS`, então acompanha o tamanho do personagem. `SWORD_TRIM` (2 px) tira um tiquinho da ponta: encostar logo abaixo dela já acerta. `swordReach(FV)` devolve o alcance e é usado por monstros, sparring (`swordCovers`) e arbustos (`cutFront`). Continua só de frente (`SWORD_HALF_W` = 7 px de cada lado do eixo; do lado ou atrás não acerta).
- Ajuste: aumente `SWORD_FR`/diminua `SWORD_TRIM` para alcançar mais; o contrário para alcançar menos.

### (v26.8) Espada: só acerta de frente e bem grudada
- **Bug:** a espada acertava monstro/arbusto encostado do lado do jogador. Monstros: a caixa do golpe começava no centro do jogador e ainda somava o raio do alvo (vão de ~13 px na frente e ±14 px para os lados). Arbustos: cortava qualquer um com o centro a menos de 22 px de um ponto 16 px à frente (até ~24 px de vão, sem olhar lado nenhum).
- **Agora (monstros e outros jogadores no sparring):** o alvo tem de estar à frente, com o centro a no máximo `SWORD_HALF_W` (7 px) do eixo do golpe e vão de no máximo `SWORD_GAP` (4 px) entre os corpos. Quem está do lado ou atrás não leva dano.
- **Agora (arbustos):** `cutFront()` testa uma faixa fina de `SWORD_GAP` px logo na frente da caixa dos pés (largura `BUSH_HALF_W`, 4 px para cada lado); só corta se pelo menos `BUSH_MIN_OV` (3 px) do arbusto entrar na faixa, então raspar a quina não corta.
- Ajuste em `public/index.html`: `SWORD_GAP`, `SWORD_HALF_W` (perto de `swordCovers`) e `BUSH_HALF_W`, `BUSH_MIN_OV` (perto de `cutFront`). Aumente `SWORD_GAP` se ficar apertado demais.

## Cores do corpo (índice de cor, igual Graal Online)
O body usa 5 cores-chave (as mesmas dos 20 bodies e dos que você envia): pele `#ffad6b`, casaco `#fffffe` (ou `#ffffff`), mangas `#ff0000`, sapatos `#ce1829` e cinto `#0000ff`. O preto é o contorno e nunca muda.
- No painel **Personagem e equipamento (C)** há 5 seletores de cor (Pele, Casaco, Mangas, Sapatos, Cinto) e o botão **↺ Cores padrão**. A escolha fica salva em `graal_skin_v2` (campo `c`) e vai junto com a conta.
- Por baixo: `gTint()` troca só essas cores e guarda uma folha recolorida de 128px por body+paleta (cache de 48). O `gCompose`, o Pixi e os equipamentos não mudaram.
- Multiplayer: as cores vão numa mensagem leve `kc` (o servidor valida 5 itens `#rrggbb`/null e repassa), sem reenviar as imagens de skin. Quem entra depois já recebe as cores de quem está online.
- Pixels que não são cor-chave (ex.: o verde do body 12) não mudam.

## v26.10: painéis Admin e Personagem no estilo "Céu & Nuvens"
Só `public/index.html` mudou (CSS novo `#skui` + HTML/JS dos dois painéis). Todos os IDs e `data-a`/`data-k` foram mantidos, então a lógica, o servidor e o multiplayer são os mesmos.
- **Painel admin (🛡):** cabeçalho azul arrastável (dá para empurrar o painel para o canto sem bloquear o jogo), abas **Aviso / Fotos / Jogadores / Cargos** (Cargos só para o dono; a aba Fotos abre sozinha quando há foto aguardando), contador vermelho de fotos pendentes, busca de jogador por nome ou #id, avatar com inicial, selo de dono/admin, status colorido (aguardando/aprovada/recusada), botões em pílula (verde = aprovar, vermelho = expulsar/banir, amarelo = cargo), contador de caracteres no aviso e mensagem de status que some sozinha em 6 s.
- **Personagem e equipamento (C / V):** fundo desfocado (clicar fora ou Esc fecha), preview num gramado, layout em duas colunas (some para uma coluna no celular), seções em cartões (Aparência, Cores do corpo, Imagens próprias, Equipamento), cores como bolinhas, slider de tamanho estilizado, equipamento em linhas com ícone (🎩 ⚔️ 🛡️) e botões de enviar / baixar modelo / apagar. Telas baixas (celular deitado) ganham uma versão compacta.

### v26.11: Configurações em retângulo grande, com abas e a sua foto de fundo
- O painel ⚙ agora tem o formato do Perfil (980×660, cabeçalho, abas, cartões, mesmo tema de cores do Perfil) e clicar fora fecha. Abas: **🚀 Desempenho** (sem limite, travar FPS, VSync, contador), **🕹 Controles** (joystick e lista de teclas), **🎨 Aparência** (esconder nomes e fundo) e **⚡ Atalhos** (os botões que ficavam no menu, inclusive o 🛡 admin).
- **Fundo:** usa a foto que você enviou no Perfil (a sua, não a dos outros). Em Aparência dá para desligar e ajustar o escurecimento (`graal_cfg_bg`, `graal_cfg_bgd`). Sem foto, usa só a cor do tema. Mudou a foto ou o tema no Perfil, o painel acompanha (evento `pfbg`; o Perfil expõe `window.__PFX`).
- Celular deitado: versão compacta (cartões em 2 colunas, cabeçalho menor).

## v26.11: painel de personagem com o fundo do Perfil
O painel "Personagem e equipamento" (tecla C, ou botão de editar no Perfil) agora usa o mesmo tema de cores e a mesma foto de fundo do Perfil, com o mesmo escurecimento (o controle "Escurecer" do Perfil). Sem foto, usa só a cor do tema. Trocar o tema ou a foto no Perfil atualiza o painel na hora.

## v26.12: zoom de pinça (celular)
Com dois dedos na tela do jogo, afastar os dedos aproxima a câmera e juntar afasta (de 50% a 250%). O zoom é contínuo e fica salvo no aparelho. O botão 🔍 continua funcionando: ao tocar nele, volta aos níveis fixos. O gesto é ignorado no editor de mapa, e o toque que sobra depois da pinça não abre perfil de jogador por engano.

## v26.13: botões embaixo do HUD de vida
Chat 💬, Configurações ⚙, Minimapa 🗺 e Tela cheia ⛶ agora ficam numa fileira logo abaixo do card de vida (nível, corações, MP e vigor), no canto superior esquerdo, e acompanham o tamanho do HUD (A−/A+). Saíram do canto inferior direito e do menu de Configurações (o Zoom 🔍 e os outros continuam no menu).

## v26.14: topo da tela reorganizado
- **Login com Discord** saiu do topo e agora fica em Configurações, na aba "👤 Conta" (entrar, avatar, nome, sair e o status do salvamento na nuvem).
- **Contador de FPS** (o que ficava no centro do topo) foi para o canto inferior esquerdo. Continua ligando em Configurações > Desempenho.
- **Barra do topo** (centro): botões − 🔍% + de zoom para todos (🔍 ainda alterna entre os níveis fixos). Só para admin aparecem também 👾 Spawns de monstros e 📂 Tileset (o tileset abre o editor de mapa já com o painel de tilesets; não existe no celular).
- No editor de mapa a barra some (o editor tem os próprios botões).

## v26.15: zoom nítido (50% ou menos / mais)
- **Problema:** a arte é 1 px de mundo = 1 px de sprite e é desenhada com NEAREST na escala `RS*Z` (RS do canvas × zoom). Com zoom, isso ficava fracionado (ex.: 3×0,75 = 2,25; 3×0,5 = 1,5), então uns pixels saíam largos e outros finos: serrilhado, tremida ao andar e visual "pixelado".
- **Agora:** `fit()` escolhe `RS = k/Z` com `k` inteiro (k ≈ pixels de tela por pixel de mundo). Assim `RS*Z` é sempre inteiro e todo pixel de mundo tem o mesmo tamanho; o navegador só reamostra o canvas para a tela de forma suave (bilinear, o "sharp bilinear"). Com zoom 100% nada muda.
- O tamanho do canvas continua perto da resolução da tela (limites: RS máx. 4 no PC / 2 no celular e 4096 px de largura), então não pesa mais.
- `lab()` (zoom) chama `fit()` 120 ms depois da última mudança, então a pinça não redimensiona o canvas a cada quadro.
- Modo de qualidade baixa (`pix`) e editor de mapa continuam como antes.

### v26.15b: − e + do topo mudam o tamanho do HUD
Os botões − e + da barra do topo (ao lado do 🔍) agora diminuem/aumentam o HUD (mesma função dos botões A−/A+ e das teclas - e +), e não mais o zoom da câmera. O 🔍 continua alternando os níveis de zoom (e a pinça no celular).

## v26.15c: gráficos melhorados (Configurações > Aparência > Gráficos, ligado por padrão)
- **Menos pixelado fora da tela cheia:** o canvas agora é desenhado ~1,5x maior que a área na tela (sempre com `RS*zoom` inteiro) e o navegador reduz suave. Antes, em janela, a escala ficava quase 1:1 e os pixels saíam desiguais/blocados. Limites: RS máx. 4 no PC / 2 no celular e 4096 px de largura (o modo de qualidade baixa continua em RS 1).
- **Sombras suaves** (`shd`): borda clara + miolo mais escuro, em vez de uma elipse chapada.
- **Acabamento:** vinheta leve nas bordas + um tom quente bem discreto por cima do mapa (script no fim do `index.html`, não aparece no editor de mapa).
- Desligando a opção volta ao visual antigo (sombra chapada, sem vinheta, canvas sem o 1,5x). Ajuste a força em `rgba(10,8,30,.34)` (vinheta) e `rgba(255,226,170,.045)` (tom quente).

### v26.15d: celular sem pixelar com zoom < 100%
- **Causa:** no celular o RS era limitado a 2 (e 1 no modo de qualidade baixa, ainda com `image-rendering:pixelated`). Numa tela de ~2500 px com zoom 70% o canvas ficava com ~870 px e era esticado ~3x.
- **Agora:** o limite é um orçamento de pixels do canvas (celular ~3 MP, PC ~9 MP, qualidade baixa ~1,3 MP) e RS continua `k/zoom` com `k` inteiro. Ex. (844×390 @3x): zoom 70% = canvas 1780 px (antes ~870), zoom 50/100/150% = 2492 px. O modo de qualidade baixa agora usa suavização do navegador, sem `pixelated`. Se algum celular fraco engasgar, baixe o `3e6` em `fit()`.

## v26.16: player e tileset mais bonitos (junto de "Gráficos melhorados")
- **Player:** o quadro composto do personagem (`gCompose`) agora ganha uma versão com Scale2x/EPX (`gEpx`, feita uma vez por quadro e guardada no `CPOOL`) e é desenhada com 2x de detalhe e suavização em `gBlit`: diagonais e cantos mais lisos, sem borrar. Vale para você e para os outros jogadores (e para o preview do perfil).
- **Tileset:** o atlas `IM.gt` passa uma vez por `saturate(1.14) contrast(1.07) brightness(1.015)` (`gtSrc()`, usado em `WCanvas.build/fillRect`). Navegador sem `ctx.filter` usa o atlas original. Para o tileset mudar depois de ligar/desligar a opção, recarregue a página (os chunks do mapa já montados ficam como estavam). Ajuste os números em `gtSrc()`.
- Desligar "Gráficos melhorados" volta ao desenho antigo do player (e, após recarregar, do tileset).

## v26.17: Configurações > Aparência > "Qualidade de imagem"
- **Filtragem de texturas:** *Misto (padrão)* = mapa nítido + personagem suavizado (Scale2x); *Nearest* = tudo em pixels nítidos, sem suavização; *Linear* = mapa e personagem interpolados (mais macio). Chave `graal_tf`; lida em `window.__TF` a cada quadro (muda na hora). Linear só suaviza o mapa (chunks) e o personagem; sprites de atlas continuam nearest para não "sangrar" a borda do vizinho.
- **Bloom:** Desativado / Baixo / Alto (`graal_bloom`, `window.__BLOOM`). No Pixi: `PixiCtx.bloom()` renderiza a cena em 1/4 de resolução, deixa passar só as partes claras (matriz de cor 3x-2), desfoca (`BlurFilter`) e soma (ADD) por cima; se der erro ele se desliga sozinho e avisa no console. Sem Pixi (Canvas2D): mesma ideia com `ctx.filter` + `lighter` (precisa de navegador com `ctx.filter`). Ajuste o limiar na matriz (`-2`) e a força em `s2.alpha`.
- **Filtragem anisotrópica:** só informativa ("Controlada pelo jogo"). O jogo é 2D e não usa mipmaps, então não há o que ajustar.

## v26.18: ciclo de dia, tarde e noite
- Script próprio perto do fim do `index.html` (`window.DN`): por cima do mapa vai uma cor que muda ao longo do dia (noite azul-escura → amanhecer rosado → dia sem filtro → tarde laranja → entardecer arroxeado → noite). À noite fica um círculo de luz em volta do jogador (um gradiente radial de textura estável, então não pesa no Pixi). O HUD (DOM) não escurece; dentro de casas (`INT.loc/view==='i'`) e no editor de mapa o ciclo não aparece.
- **Configurações > Aparência > Dia e noite:** Automático (ciclo do jogo; um dia dura `DN_DAY` = 24 min e é igual para todos pelo relógio, sem servidor), Hora real do aparelho, Sempre dia / tarde / noite, Desligado (`graal_dn`). Ao mudar de período no automático aparece um aviso rápido (🌇 Tarde). O texto no painel mostra o período atual.
- **Tarde (v26.19):** laranja mais forte e feixes de luz diagonais vindos do canto superior direito (`beams()`, textura pré-renderizada, só o alfa pulsa devagar). Pico entre t=.72 e .78.
- **Dia (v26.19/21):** feixes de luz só em alguns cantos (`mkDay()`: faixa larga no canto superior esquerdo, fraca no superior direito, bolinhas de luz no inferior direito), entre t=.32 e .64.
- **Minimapa-sol (v26.21):** o minimapa redondo ganhou 12 raios girando (cor muda por período), aro com progresso do período, e uma pílula embaixo com rostinho de sol + hora do jogo (HH:MM) + `→ próximo período mm:ss`. À noite o rosto dorme. Feito por script no bloco do ciclo (`#hMini`), sem mexer no desenho do mapa. Só aparece quando o minimapa (M) está ligado.
- **Feixes de luz (v26.22):** presos ao MAPA (coordenadas do mundo, andam com o cenário e respeitam o zoom). O mundo é dividido em células de `CS`=720 px; cada célula, por hash fixo, tem ou não um feixe e/ou um bolsão de bolinhas de luz, sempre nos mesmos lugares. Dia: feixes amarelo-claros (t=.32 a .64, ~28% das células); tarde: dourado/laranja (t=.60 a .86, ~42%). Texturas criadas uma vez (`mkBeamTex`, `mkBokehTex`); só o alfa pulsa. A tinta (`dnTint`) e os feixes (`beams`) são independentes.
- **Minimapa-sol (v26.27):** o minimapa redondo é o centro de um sol pixel art suavizado (128x128, bordas com antialias, `render`, ~1,2 ms/quadro, **60 fps** via requestAnimationFrame; pausa com a aba escondida ou minimapa desligado; em `lowq` 1 quadro a cada 2). 12 raios largos de ponta arredondada (alternando longos e curtos, quase retos) que giram e respiram, sombreados em 3 tons; corpo com aro liso e degradê (sem pontilhado). Entre o sol e o mapa há uma borda dupla (`--rim` escura + `--rim2` clara fina) na cor do período. Atenção: o CSS original `#hud .mini canvas` (fundo azul, borda branca, redondo) também atingia o canvas do sol; `.sr` agora zera esses estilos. Paleta `PAL` por período e halo suave (`.sh`). Dentro do mapa, no alto: rostinho + hora do jogo, pequenos e só com contorno (`.sp`); logo abaixo, `→ próximo período mm:ss` também só com contorno (`.sb`); o nome do mapa (`.ml`) fica escondido. Montado por script em `#hMini`; só aparece com o minimapa (M) ligado. Tamanho: `--mw` (108k px; 82k no celular).
- Ajuste as cores/horas na tabela `KF` (`[t, r, g, b, alfa]`, t de 0 a 1) e a duração em `DN_DAY`. Console: `DN.mode='noite'`, `DN.phase()`.
