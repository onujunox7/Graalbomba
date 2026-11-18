# Registro Codex

## 2026-11-17 — Publicação das caixas de som no GitHub

- Pedido: enviar os arquivos das caixas de som ao GitHub. Destino identificado pelo histórico do projeto: onujunox7/Graalbomba, branch main.
- Pre-check: checkout isolado e limpo da main em 9ede7f8f886555c108781b2e5bbc7b1d880ef546. Conteúdo de futebol, party e módulos econômicos conferido contra a versão local testada; diferenças encontradas nesses arquivos eram apenas terminações de linha. Hashes, tamanhos e cópias recuperáveis dos alvos existentes registrados em work/github-publish desta conversa.
- Alterações: server.js integra rotas de áudio HTTP/WebSocket, autorização, tick e restauração. Novos speakers.js, speaker_media.js e speaker_store.js implementam caixas por proximidade, volume, fila e vídeos públicos gravados do YouTube. Manifestos incluem youtube-dl-exec 3.1.19, ffmpeg-static 5.3.0 e Node >=22. Incluídos speaker_fixture.js, testes unitários/integração e docs/CAIXAS_DE_SOM.md.
- Validação anterior: 81 testes Node e as cenas Godot de áudio/futebol aprovados. Na instalação real, 13 testes Node, incluindo integração de futebol, e dois clientes Godot isolados (21 verificações de admin e 8 de ouvinte) aprovados; cena principal com 25 verificações aprovada. A publicação exige nova execução dos 82 testes Node no checkout final, verificação do diff e preservação dos demais arquivos rastreados.
- Cliente Godot atualizado permanece na pasta local Aetheria-v12-agua, fora deste repositório de servidor. APK não foi gerado. Nenhum binário de música, cache, segredo ou dado de jogadores faz parte deste envio.
- Riscos e pendências: push na main pode acionar o deploy configurado pelo proprietário. O ambiente de destino precisa de Node >=22, Python >=3.11 em Linux e acesso à instalação/execução de yt-dlp e FFmpeg. Deploy, áudio em produção e Android físico não verificados nesta etapa.

- Resultado final antes do envio: 82 testes Node aprovados no checkout a publicar, zero falhas, exit 0; server.js passou em node --check e git diff --check passou. A primeira execução encontrou EACCES de sockets no sandbox; repetição com acesso a rede local passou. Os 48 arquivos rastreados fora do escopo, incluindo dados binários, mantiveram seus hashes. Somente os 11 caminhos explicitamente listados entram no commit.
