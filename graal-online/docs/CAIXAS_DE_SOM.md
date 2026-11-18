# Caixas de som no mapa

No **Painel admin → Som**, o admin ou dono pode colocar várias caixas, mover cada uma para a própria posição e removê-las. O servidor confirma a permissão e usa a posição real do personagem. Jogadores comuns apenas ouvem.

## Como usar

1. Entre no mapa como admin e vá ao local desejado.
2. Abra **Admin → Som → Colocar aqui**.
3. Cole o link de um vídeo público gravado do YouTube e toque em **Adicionar música**. O servidor prepara o áudio; a primeira música começa automaticamente.
4. Ajuste **Volume** de 0 a 100%. Use **Reproduzir**, **Pausar**, **Parar** e **Próxima** para controlar a caixa selecionada.
5. Adicione outros links à fila. Escolha uma faixa para reproduzi-la ou removê-la. A fila avança e se repete automaticamente.
6. Use o seletor de caixas para escolher qual controlar. **Mover aqui** leva essa caixa à posição atual do personagem; **Remover caixa** interrompe o áudio e retira a caixa do mapa para todos.

O volume diminui com a distância e zera a 320 pixels da caixa. Quem chega depois ou volta ao alcance ouve o ponto atual da música. A posição do personagem determina a escuta, inclusive ao usar a câmera livre de admin. Interiores e salas de futebol/Spar têm escuta separada. A música ambiente baixa enquanto uma caixa é ouvida e volta ao se afastar.

## Limites e persistência

- Até 16 caixas e 20 músicas por caixa.
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

No servidor: `node --test speakers.test.js speakers.integration.test.js speaker_install.test.js`. A integração usa HTTP/WebSocket reais com sessões de teste isoladas do banco e da hospedagem; testa proximidade, permissões, duas caixas e remoção. Os testes de instalação cobrem o erro real de Python ausente, preservação do executável anterior em falhas HTTP/checksum e compatibilidade com Windows. `speaker_fixture.js` fornece a infraestrutura de teste e pode usar FFmpeg para gerar uma amostra.

No Godot 4.3: cenas `tests/speakers_check.tscn`, `tests/speakers_online_check.tscn` e `tests/speakers_listener_check.tscn`. As duas últimas usam o fixture iniciado com `node speaker_fixture.js --serve`, `SPEAKER_PORT_FILE` no servidor de teste e `SPEAKER_TEST_PORT` nos clientes. O fixture aguarda primeiro um ouvinte e depois um admin. `SPEAKER_TEST_AUDIO_FILE` e `SPEAKER_TEST_AUDIO_DURATION` permitem fornecer uma amostra real. Use `--audio-driver Dummy` para testar o mixer sem emitir som no computador.

As provas desta alteração incluem download/conversão de um vídeo público, reprodução MP3 com sinal no mixer em dois clientes separados, volume, retorno ao ponto atual, remoção e bloqueio de comandos por jogador comum. Layout conferido em 288×512 e 512×288. Produção, aparelhos Android físicos e desempenho em escala não foram verificados. O acesso a vídeos depende da disponibilidade do YouTube no ambiente do servidor.
