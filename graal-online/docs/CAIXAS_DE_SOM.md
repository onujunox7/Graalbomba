# Caixas de som no mapa

No **Painel admin → Som**, o admin ou dono pode colocar várias caixas, mover cada uma para a própria posição e removê-las. O servidor confirma a permissão e usa a posição real do personagem. Jogadores comuns apenas ouvem.

## Como usar

1. Entre no mapa como admin e vá ao local desejado.
2. Abra **Admin → Som → Colocar aqui**.
3. Cole o link de um vídeo público gravado do YouTube e toque em **Adicionar música**. O servidor prepara o áudio; a primeira música começa automaticamente.
4. Ajuste **Volume** de 0 a 100%. Use **Tocar**, **Pausa**, **Parar** e **Próx.** para controlar a caixa selecionada.
5. Adicione outros links à fila. Escolha uma faixa para reproduzi-la ou removê-la. A fila avança e se repete automaticamente.
6. Use o seletor de caixas para escolher qual controlar. **Mover** leva essa caixa à posição atual do personagem; **x** ao lado da caixa interrompe o áudio e retira a caixa do mapa para todos.

O volume diminui com a distância e zera a 320 pixels da caixa. Quem chega depois ou volta ao alcance ouve o ponto atual da música. A posição do personagem determina a escuta, inclusive ao usar a câmera livre de admin. Interiores e salas de futebol/Spar têm escuta separada. A música ambiente baixa enquanto uma caixa é ouvida e volta ao se afastar.

## Limites e persistência

- Até 16 caixas e 100 músicas por caixa.
- Áudio MP3 mono, 44,1 kHz, 96 kbps; até 24 MB por faixa.
- Cache compartilhado de até 512 MB; até dois preparos simultâneos. Remover faixas sem outras referências libera cache.
- Vídeos gravados públicos: links watch, youtu.be, shorts, embed e music.youtube.com. Playlists, transmissões ao vivo, vídeos privados ou indisponíveis não são aceitos.
- Localização, volume, fila e faixa selecionada são salvos em PostgreSQL (`graal_kv`, chave `speakers`) com backup atômico em `DATA_DIR/graal-speakers.json`. Após reiniciar o servidor, as caixas voltam **pausadas**, com a faixa no início.
- Caixas em salas temporárias de futebol/Spar somem quando a sala fica vazia e não são restauradas após reiniciar.
- Arquivos de áudio ficam em `DATA_DIR/speaker-audio`. O servidor fornece somente arquivos gerados conhecidos por `/api/speaker/audio/<hash>.mp3`, com GET, HEAD e Range.

## Instalação e publicação

Servidor Node.js **22 ou superior**. As dependências `youtube-dl-exec@3.1.19` e `ffmpeg-static@5.3.0` constam de `package.json` e `package-lock.json`. O servidor necessita de acesso ao YouTube e de armazenamento gravável em `DATA_DIR`.

Em Linux x64/arm64 com glibc 2.17+, o `postinstall` do projeto executa `speaker_install.js`: instala o yt-dlp oficial autocontido de 2026.10.26 no caminho já usado pelo jogo. Essa versão inclui Python e funciona mesmo quando o buildpack remove Python da imagem de execução. O checksum SHA256 é conferido antes da substituição; o executável anterior é preservado se o download ou a verificação falhar. O Windows mantém o executável fornecido pela dependência, que já inclui Python. A etapa de instalação da dependência em Linux ainda requer Python 3.11+ no ambiente de build; a imagem que executa o jogo dispensa Python separado.

Na raiz do servidor, execute `npm install --no-audit --no-fund`. Os scripts de instalação baixam yt-dlp e FFmpeg. No npm 11, o manifesto autoriza os scripts somente nas versões especificadas; se o ambiente informar que foram bloqueados, use `npm install-scripts approve youtube-dl-exec ffmpeg-static` e depois `npm rebuild youtube-dl-exec ffmpeg-static`.

Publique juntos `server.js`, `speakers.js`, `speaker_media.js`, `speaker_store.js`, `speaker_install.js` e os manifestos. Instale as dependências no ambiente de destino com os scripts de instalação ativados, para executar o `postinstall` do projeto. A rota de áudio deve chegar ao mesmo serviço HTTP que atende o jogo, sem cache intermediário que preserve áudio removido. Recompile e distribua o cliente atualizado com `scripts/speakers.gd` e as mudanças em `main.gd`, `admin.gd`, `net.gd` e `music.gd`. O cliente consulta o estado periodicamente; não cria caixas locais em servidores antigos.

Esta alteração não publica o servidor, não reinicia serviços e não exporta APK.

## Validação

No servidor: `node --test speakers.test.js speakers.integration.test.js speaker_install.test.js spotify_playlist.test.js`. A integração usa HTTP/WebSocket reais com sessões de teste isoladas do banco e da hospedagem; testa proximidade, permissões, duas caixas e remoção. Os testes de instalação cobrem o erro real de Python ausente, preservação do executável anterior em falhas HTTP/checksum e compatibilidade com Windows. `speaker_fixture.js` fornece a infraestrutura de teste e pode usar FFmpeg para gerar uma amostra.

No Godot 4.3: cenas `tests/speakers_check.tscn`, `tests/speakers_online_check.tscn` e `tests/speakers_listener_check.tscn`. As duas últimas usam o fixture iniciado com `node speaker_fixture.js --serve`, `SPEAKER_PORT_FILE` no servidor de teste e `SPEAKER_TEST_PORT` nos clientes. O fixture aguarda primeiro um ouvinte e depois um admin. `SPEAKER_TEST_AUDIO_FILE` e `SPEAKER_TEST_AUDIO_DURATION` permitem fornecer uma amostra real. Use `--audio-driver Dummy` para testar o mixer sem emitir som no computador.

As provas desta alteração incluem download/conversão de um vídeo público, reprodução MP3 com sinal no mixer em dois clientes separados, volume, retorno ao ponto atual, remoção e bloqueio de comandos por jogador comum. Layout conferido em 288×512 e 512×288. Produção, aparelhos Android físicos e desempenho em escala não foram verificados. O acesso a vídeos depende da disponibilidade do YouTube no ambiente do servidor.


## Volume independente da JBL

Em **Configurações → Som**, **Volume do jogo** controla a música ambiente e os efeitos, incluindo espada, arco, bombas e sons de outros jogadores. **Volume da JBL** controla somente as caixas de som para quem ajusta. Os dois valores são salvos separadamente por jogador. Zerar o jogo mantém a JBL; zerar a JBL mantém o som do jogo. O controle do admin continua ajustando o volume compartilhado de cada caixa.

Este ajuste pertence ao cliente Godot. Reinicie o teste para carregar os scripts; no Android, gere e distribua um APK atualizado.


## Playlists do Spotify com áudio do YouTube

Em **Admin → Som**, selecione a caixa, cole o link de uma playlist pública do Spotify no mesmo campo de links e toque em **+** no campo de links. Os nomes e artistas entram na fila imediatamente. Se a fila estava vazia, a primeira música é preparada e começa a tocar. A importação acrescenta músicas à fila existente e ignora faixas Spotify já presentes.

A lista **Fila** mostra todas as entradas importadas, mesmo antes de preparar o áudio. Escolha uma faixa pelo nome e toque em **Tocar**; o nome e o artista aparecem na linha; a dica mostra o nome completo. **Próx.** e o fim de cada faixa avançam pela fila; ela se repete ao terminar.

Spotify fornece somente os metadados públicos da lista. O servidor busca versões no YouTube, comparando título, artista e duração, e usa o mesmo conversor/cache da JBL. Não utiliza conta, cookies, áudio ou previews do Spotify. Uma correspondência pode ser uma gravação diferente; não há garantia de todas as faixas estarem disponíveis no YouTube. Quando uma faixa não pode ser preparada, o admin recebe o erro e pode escolher outra ou adicionar um link de vídeo.

São até 100 músicas na fila de cada caixa, limitadas também às faixas exibidas pelo embed público do Spotify. A próxima música é preparada em segundo plano enquanto a atual toca. A primeira faixa e uma seleção fora da sequência ainda podem precisar de preparo. Permanecem os limites de dois preparos simultâneos, 24 MB por faixa e 512 MB de cache compartilhado. As entradas ainda não preparadas e as correspondências já encontradas são persistidas; depois de reiniciar, a caixa volta pausada.

A leitura usa a página pública de embed do Spotify com timeout e limite de tamanho. Playlists privadas não funcionam e mudanças no formato público podem exigir atualizar o importador. Links são canonicalizados para o host Spotify e somente IDs validados do YouTube chegam ao conversor.

O servidor conserva o protocolo de áudio anterior para ouvintes com cliente antigo. Para importar e selecionar as 40 músicas pelo novo painel, use o cliente atualizado; no Android isso exige recompilar/distribuir o APK. Os controles independentes de volume do jogo/JBL são preservados.


## Lista compacta da JBL

Cada música aparece em uma linha com nome e artista pequenos, e um **x** à direita para excluir a própria faixa. O clique não depende de qual outra faixa está selecionada. Clique no nome e em **Tocar** para reproduzir. A lista tem rolagem, com duas ou três linhas visíveis conforme a orientação. Nomes longos usam reticências e dica completa.

O **+** ao lado da caixa coloca outra caixa; **Mover** leva a selecionada para sua posição, e o **x** desse grupo retira a caixa do mapa. O **+** ao lado do campo de links adiciona o vídeo ou importa a playlist. Enter nesse campo também adiciona. A janela da aba Som é menor, com cabeçalho JBL e controles compactos.


## Troca antecipada das músicas

Enquanto a faixa atual toca, o servidor procura e converte a seguinte. O preparo em segundo plano preserva a reprodução, compartilha o mesmo trabalho quando o admin aperta Próx. e reserva capacidade para pedidos manuais. Falhas de antecipação não param a música atual e têm nova tentativa limitada.

O cliente atualizado também baixa e decodifica a próxima faixa antes do fim da atual, reaproveitando esse áudio na mudança. O limite adicional de pré-carregamento é de 48 MB no cliente; os downloads da música atual têm prioridade. Sair do alcance, excluir faixas e desconectar liberam os recursos e descartam respostas antigas. A rede ou um vídeo indisponível ainda podem impedir que a próxima fique pronta a tempo.

A antecipação no servidor beneficia clientes anteriores. Para antecipar também o download no aparelho, reinicie o cliente atualizado ou recompile/distribua o APK no Android.
