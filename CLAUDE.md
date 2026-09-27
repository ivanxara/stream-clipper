# Stream Clipper — notas para o Claude

Extensão Chrome/Edge/Brave (MV3, carregada "descompactada", sem build) que grava clips de lives
(YouTube, Twitch, Kick) e tem um editor para TikTok. O utilizador fala português de Portugal;
UI, comentários e respostas em PT-PT. Guia do utilizador: `LEIA-ME.txt` (manter atualizado).

## Ficheiros
- `content.js` — content script: painel, buffer de gravação do ecrã (MediaRecorder em segmentos
  de 8s, bitrate adaptado à resolução/FPS, reserva/fallback), fluxo do clique. Ao clicar abre logo o editor numa aba (`#pending`)
  — tem de ser no gesto do utilizador — e entrega o clip por postMessage quando fica pronto.
  Uma procura no vídeo descarta os segmentos da posição anterior e recomeça o buffer em `seeked`.
  ● REC = gravação manual: MediaRecorder próprio no mesmo `captureStream` (pause/resume nativos),
  no fim vai para o `handleClip` como 1 parte (`deliver()` é partilhado com os botões de duração).
- `server.js` — "modo live" (ponto verde): descarrega os últimos X s da própria live.
  - YouTube: API player com cliente **IOS** (`/youtubei/v1/player`, do content script = origem
    youtube.com). Segmentos DASH por `&sq=N` (fMP4 completos; tfdt = sq×dur). Posição via
    `yt-main.js` (mundo MAIN) → `movie_player.getCurrentTime()`. Só lives; vídeos normais usam
    o buffer (o utilizador pediu assim).
  - Twitch: GQL (Client-ID público) → posição = `EXT-X-TWITCH-ELAPSED-SECS` + segmentos da
    playlist live − buffer do player; clip vem do **VOD da live em curso** (fMP4 10s, espera
    até o VOD ter o fim).
  - Kick: API pública do canal → playlist HLS, variante de maior resolução e segmentos recentes;
    usa o buffer como reserva se a playlist não tiver o intervalo pedido.
  - Pedidos têm de sair da página (origem youtube.com/twitch.tv/kick.com): com origem
    `chrome-extension://` o Google responde "Sorry…/403" e a playlist da Twitch 403.
- `processor.html/js` — iframe da extensão: ffmpeg.wasm (`lib/`), junta segmentos
  (`handleClip` = buffer; `handleServer` = modo live, corte com `-copyts`, vídeo desde o keyframe
  e áudio cortado com `-seek_timestamp`). Guarda o último clip no IndexedDB.
- `editor.html/js/css` — editor (aba da extensão): corte no tempo + formatos Vertical (moldura
  9:16 com posições animadas), Streamer (em baixo: jogo **ou** imagem/vídeo da biblioteca com
  tamanho/posição), Desfocado e Original. Preferências em localStorage, guardadas a cada alteração:
  `sc.streamer`, `sc.cams` (câmara por canal; chave `channel` que o content.js manda com o clip),
  `sc.layout` (último formato), `sc.crop` (última moldura Vertical), `sc.textStyle`/`sc.texts`
  (estilo do próximo texto / textos "manter") e `sc.template` (último template, aplicado ao abrir).
  Textos: `st.texts`, desenhados no fim do `renderFrame` (entram na exportação); os handlers do
  resultado para textos estão em captura e fazem stopImmediatePropagation. Templates `v: 2` no
  IndexedDB `templates` = `snapshot()` (os antigos da Composição são ignorados). Disposição: original | resultado
  9:16 grande (edição direta: arrastar = enquadrar, roda = zoom) | opções; sem scroll. Atalhos no keydown. A antiga
  "Composição" (camadas/templates) foi removida a pedido. Exporta com **WebCodecs** (decode→canvas→
  encode H.264 annexb) e o ffmpeg só junta o som (AAC).
- `tiktok.js` — content script em tiktok.com: com `scTikTok` (chrome.storage) "ready" e página de
  upload, pede o MP4 ao editor por `chrome.runtime.sendMessage` (info + bocados de 8 MB em base64;
  só responde o editor com o mesmo id), mete-o no `input[type=file]` (DataTransfer), escreve a
  legenda (Draft.js → execCommand insertText) e, se o diálogo do editor pediu agendamento, clica
  «Schedule/Agendar» e escolhe dia (calendário, avança meses pela seta) e hora (colunas 00-23 / 00-55)
  com eventos de rato; confirma lendo os inputs. Nunca clica em Publicar. O diálogo (#ttDlg) é
  resolvido à mão (submit/cancel), não pelo evento «close» (não disparava no browser de testes).
  Seletores do TikTok são palpites tolerantes (não dá para testar com sessão) — cartão tem plano B.
- `mp4.js` — demuxer MP4 (validado contra ffprobe). `media.js` — importar para a biblioteca +
  `VideoTrackReader` (vídeo frame a frame em loop). `clipstore.js` — IndexedDB v2
  (`clips`, `media`, `templates`).
- `elements.js` — edição direta de `st.texts` e `st.images`: moldura no visor com movimento,
  escala proporcional pelos cantos, rotação, ordem das camadas (`z`), timeline com intervalos
  `in`/`out` em segundos da fonte, duplicar/apagar e histórico de elementos. `drawTexts` em
  `editor.js` desenha ambos os tipos por ordem, respeitando os tempos e a rotação, também na
  exportação. Imagens livres são guardadas na sessão e nos templates; os bitmaps são preparados
  antes de codificar. `tests/editor-elements.cjs <clip.mp4>` testa interações reais no Chrome e
  codificação H.264 (Playwright instalado, ou caminho em `PLAYWRIGHT_MODULE`).

## Armadilhas já descobertas
- WebCodecs: o `VideoDecoder.flush()` por hardware NÃO acaba se os frames de saída não forem
  tratados/fechados enquanto chegam (pool pequeno) → o "99% para sempre". O flush é bombeado e
  todas as esperas têm limite (`withTimeout`); sem saída 5 s → acaba com o último frame.
- O editor guarda o clip no IndexedDB ao abrir e tira o `#pending` do URL (refresh reabre-o);
  a edição (corte, ◆, textos) vai para `sc.session` de 2 em 2 s, chave nome|tamanho.
- ffmpeg.wasm: `ffprobe` devolve sempre -1 (ver o ficheiro de saída); `exec` devolve 0 no sucesso.
- `ff.writeFile` transfere o ArrayBuffer (fica "detached") → passar cópia (`buf.slice(0)`).
- `-ss` à saída com `-c copy` compara com o DTS: dar 0,5s de margem antes do keyframe.
- CSS do painel usa `all: unset` nos botões → `[hidden]` precisa de `display:none` explícito.
- Vídeos longos do YouTube (≈10h) dão 403 a meio do ficheiro sem PO token (por isso não há
  download direto de vídeos normais).

## Testar
- Não dá para carregar a extensão no browser de testes. O editor testa-se servindo a pasta em
  localhost e abrindo `editor.html?src=/caminho/clip.mp4` (modo DEV: expõe `window.__editor`;
  `chrome.downloads` pode ser simulado). Painel do browser escondido = viewport 0×0 → usar
  resize_window.
- ffmpeg-core.wasm corre no Node com `globalThis.self/location` simulados (bom para validar
  comandos de corte).
- Verificar sintaxe: `node --check` (scripts) e `node --input-type=module --check < f` (módulos).
