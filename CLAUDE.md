# Stream Clipper — notas para o Claude

Extensão Chrome/Edge/Brave (MV3, carregada "descompactada", sem build) que grava clips de lives
(YouTube, Twitch, Kick) e tem um editor para TikTok. O utilizador fala português de Portugal;
UI, comentários e respostas em PT-PT. Guia do utilizador: `LEIA-ME.txt` (manter atualizado).

## Ficheiros
- `content.js` — content script: painel, buffer de gravação do ecrã (MediaRecorder em segmentos
  de 8s, bitrate adaptado à resolução/FPS, reserva/fallback), fluxo do clique. Ao clicar abre logo o editor numa aba (`#pending`)
  — tem de ser no gesto do utilizador — e entrega o clip por postMessage quando fica pronto.
  Um salto real na posição (≥2s; pequenos reajustes do player, tipo voltar ao direto, são ignorados)
  descarta os segmentos da posição anterior e recomeça o buffer logo no `seeking` (instantâneo,
  não espera pelo `seeked`).
  ● REC = gravação manual: MediaRecorder próprio no mesmo `captureStream` (pause/resume nativos),
  no fim vai para o `handleClip` como 1 parte (`deliver()` é partilhado com os botões de duração).
  Clicar num botão de duração enquanto outro clip ainda está a processar não bloqueia: `clip()`
  agarra logo o buffer e abre logo o editor (tem de ser no gesto), e só entra em `clipQueue` se
  `state.busy`; `runClip()` processa um de cada vez e puxa o próximo da fila no fim. Só a gravação
  manual (● REC / +continuar) continua a bloquear enquanto um clip processa.
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
  `sc.layout` (último formato), `sc.crop` (última moldura Vertical), `sc.textStyle` (estilo do
  próximo texto), `sc.template` (último template, aplicado ao abrir)
  e `sc.captionPresets` (hashtags reutilizáveis no diálogo do TikTok — `renderCaptionPresets()`;
  aplicar um preset acrescenta ao que já está escrito, não substitui).
  A lista de Elementos tem um ✕ por linha (`removeById`, em `elements.js`) para apagar sem
  selecionar primeiro. Só a caixa de texto fica sempre visível; tudo o resto (presets, cor,
  estilo, tamanho, alinhamento, letra, posição) está dentro do "Estilo e posição"/"Ajustes do
  ficheiro", que começa fechado (`expandedElementOptions` regista quem o utilizador abriu de
  propósito). O tamanho do texto (`#tSize`) é um `input[type=number][list=...]` — escreve-se um
  número ou escolhe-se da `datalist`, como a caixa de tamanho de letra do Word; guarda-se em
  `t.size` a dividir por 100 (mostrado ampliado ×100, ex.: 0.075 → "7.5"). "Centrar no visor"
  vive na mesma linha que os atalhos de posição (Cima/Divisão/Baixo), não sozinho no topo. A
  coluna do nome nas faixas (elementos/áudio/vídeo) é `position: sticky; left: 0` — fica visível
  ao fazer scroll
  horizontal na timeline (`.tracksWrap` tem overflow-x implícito por só declarar `overflow-y`).
  Textos: `st.texts`, desenhados no fim do `renderFrame` (entram na exportação); os handlers do
  resultado para textos estão em captura e fazem stopImmediatePropagation. Templates `v: 2` no
  IndexedDB `templates` = `snapshot()` (os antigos da Composição são ignorados). Disposição: original | resultado
  9:16 grande (edição direta: arrastar = enquadrar, roda = zoom) | opções; sem scroll. Atalhos no keydown. A antiga
  "Composição" (camadas/templates) foi removida a pedido. Exporta com **WebCodecs** (decode→canvas→
  encode H.264 annexb) e o ffmpeg só junta o som (AAC).
  Posições da moldura Vertical (`st.crop.keys`): arrastar/zoom nunca cria uma posição sozinho
  (`updateCropKey` — ajusta sempre a mais próxima do instante atual, ou cria a 1ª se não houver
  nenhuma); só o botão «◆ Posição aqui» cria uma nova de propósito (`addCropKeyAt`), como no
  CapCut/Premiere. Antes, qualquer arrasto longe de uma posição existente criava outra — bastava
  estar a meio do vídeo para uma moldura "fixa" virar sem querer uma animação.
  **A régua principal posiciona os segmentos pela ordem de exportação (`getRanges()`, por
  índice em `st.parts`), não pela ordem cronológica da fonte** — `rangeOffsets()` é a única fonte
  de verdade (cursor acumulado por segmento, na ordem do array); `sourceToEdit`/`editToSource`
  usam-no por baixo. Entre dois segmentos array-adjacentes que ainda seguem a ordem cronológica da
  fonte, mantém-se o espaço do que foi cortado (ripple cuts) — o "↶ Repor trecho" continua a fazer
  sentido aí. Entre dois fora de ordem (arrastados), encostam-se sem espaço nenhum: não há "corte"
  para repor entre troços que nunca foram vizinhos na fonte. `.range` tem `draggable`; arrastar
  chama `reorderPart()` (drag-and-drop nativo, nunca `updateTimeline()` a meio do arrasto — ver
  armadilha abaixo). `restoreGap()` reinsere no índice de onde saiu (nunca re-ordena o array
  todo, para não desfazer um arrasto manual feito noutro sítio). Segmentos duplicados
  (`duplicatePart`) ganham cada um o seu lugar sequencial na régua (deixou de haver o
  empilhamento vertical de antes). `activeSourceToEdit()` (usada só para a posição do cursor)
  prefere a ocorrência de `st.activePart` quando ela contém o tempo atual — necessário para
  desambiguar duplicados, já que o mesmo tempo de origem pode estar em mais do que um segmento;
  `loopPreview` mantém `st.activePart` a acompanhar o segmento a tocar durante a reprodução, por
  causa disto.
  Bug encontrado 2026-09-29: `trackDrag()` (arrastar o bloco de um elemento na timeline) media a
  posição/largura durante o próprio arrasto com `e.in / st.dur` (fração do tempo da FONTE) em vez
  de `toTimelineTime(e.in) / duration` (fração da posição na RÉGUA) — os dois só coincidem quando
  a régua é 1:1 com a fonte. Com segmentos cortados/reordenados, o bloco "teleportava-se" a meio
  do arrasto (o valor de `e.in`/`e.out` ficava certo, só o desenho durante o arrasto é que
  divergia). Corrigido para usar `toTimelineTime` como o resto da função já fazia.
- `tiktok.js` — content script em tiktok.com: com `scTikTok` (chrome.storage) "ready" e página de
  upload, pede o MP4 ao editor por `chrome.runtime.sendMessage` (info + bocados de 8 MB em base64;
  só responde o editor com o mesmo id), mete-o no `input[type=file]` (DataTransfer), escreve a
  legenda (Draft.js → execCommand insertText) e, se o diálogo do editor pediu agendamento, clica
  «Schedule/Agendar» e escolhe dia (calendário, avança meses pela seta) e hora (colunas 00-23 / 00-55)
  com eventos de rato; confirma lendo os inputs. Nunca clica em Publicar. O diálogo (#ttDlg) é
  resolvido à mão (submit/cancel), não pelo evento «close» (não disparava no browser de testes).
  Seletores do TikTok são palpites tolerantes (não dá para testar com sessão) — cartão tem plano B.
  Quando chega ao fim sem erros (agendamento preenchido ou vídeo+legenda prontos para publicar já),
  grava `scLastTikTok` (chrome.storage.local: `{at, name, mode}`) — não é confirmação do TikTok
  (nunca se clica em Publicar/Agendar), só até onde a extensão conseguiu preencher sozinha. O diálogo
  do editor lê isto para a secção "Último clip preenchido" (+15m/30m/1h a partir daí, em vez de agora)
  — pensado para agendar clips seguidos sem se sobreporem.
- `mp4.js` — demuxer MP4 (validado contra ffprobe). `media.js` — importar para a biblioteca +
  `VideoTrackReader` (vídeo frame a frame em loop). `clipstore.js` — IndexedDB v2
  (`clips`, `media`, `templates`).
- `elements.js` — edição direta de `st.texts` e `st.images`: moldura no visor com movimento,
  escala proporcional pelos cantos, rotação, ordem das camadas (`z`), timeline com intervalos
  `in`/`out` em segundos da fonte, duplicar/apagar e histórico de elementos. `duplicate()` põe a
  cópia logo a seguir à original no tempo (nunca sobreposta; antes ficava exatamente em cima,
  só deslocada uns pixels no ecrã — parecia ter falhado). `drawTexts` em
  `editor.js` desenha ambos os tipos por ordem, respeitando os tempos e a rotação, também na
  exportação. Imagens livres são guardadas na sessão e nos templates; os bitmaps são preparados
  antes de codificar. Arrastar a etiqueta de uma camada verticalmente na timeline (drag-and-drop
  nativo, não pointer capture — ver armadilha abaixo) troca o `z` com a camada onde larga.
  `tests/editor-elements.cjs <clip.mp4>` testa interações reais no Chrome e
  codificação H.264 (Playwright instalado, ou caminho em `PLAYWRIGHT_MODULE`).
- O editor tem atalhos visíveis «+ Vídeo» e «+ Música». «+ Vídeo» cria imediatamente clips virtuais
  em `st.sequenceClips`, usando apenas os metadados nativos para a timeline e a pré-visualização
  (overlays continuam em Elementos). Só ao exportar `materializeVideoFiles` consolida a sequência:
  se codec/resolução/FPS/áudio forem compatíveis usa concat demuxer + `-c copy`; caso contrário
  recodifica, respeitando `trimStart/trimEnd` e splits. Durante leitura/consolidação mostra
  `#appendSkeletonRow` animado na timeline;
  música usa `st.audioTracks` (`start`, `trimStart/trimEnd`, `volume`, fades, mute), tem faixa compacta,
  pré-escuta sincronizada e é misturada com o som original pelo ffmpeg no fim da exportação. Áudio,
  tal como os elementos, fica na sessão e nos templates. `media.js` também importa ficheiros só de áudio.

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
- Nunca fazer `wrap.innerHTML = …` (re-render) a meio de um arrastar que ainda vai usar o
  elemento agarrado — nem por pointer capture (`getBoundingClientRect`, `setPointerCapture`,
  `addEventListener` para o `move`/`end`) nem por drag-and-drop nativo (`draggable`, `dragstart` →
  `drop`). No caso do pointer capture, o elemento fica destacado, `getBoundingClientRect()` passa
  a devolver tudo a 0 (não faz throw) e a divisão por essa largura dá `Infinity` — o arrastar salta
  logo para a ponta e fica ali preso, sem erro nenhum na consola. Foi o caso do arrastar das faixas
  de áudio (`selectAudio` chamava `renderAudioTracks()` antes de o `pointerdown` calcular `lane`):
  agora usa `highlightAudioSelection()` (só troca a classe `on`) enquanto o arrastar está a
  começar, e só volta a fazer o render completo no fim (`pointerup`/`pointercancel`). No
  drag-and-drop nativo (reordenar camadas em `elements.js`, reordenar segmentos em `editor.js`),
  o browser pode simplesmente cancelar o gesto a meio se o nó de origem desaparecer — por isso
  esses dois só voltam a chamar `renderTracks()`/`updateTimeline()` no `drop`/`dragend`, nunca no
  `dragover`.
- `normalizeElementTimes()`: um texto "mantido" ou de um template vindo de um clip bem mais longo
  pode ter `in` muito além do `st.dur` do clip novo. Um clamp simples (`in = min(in, dur-0.1)`)
  encolhe-o para uma fração de segundo mesmo no fim — existe em `st.texts` e na timeline, mas
  impossível de ver a passar o vídeo normalmente. Quando `in >= st.dur` reancora-se a 0,
  preservando a duração pretendida (`out - in`) em vez de a espremer contra a borda.

## Testar
- Não dá para carregar a extensão no browser de testes. O editor testa-se servindo a pasta em
  localhost e abrindo `editor.html?src=/caminho/clip.mp4` (modo DEV: expõe `window.__editor`;
  `chrome.downloads` pode ser simulado). Painel do browser escondido = viewport 0×0 → usar
  resize_window.
- ffmpeg-core.wasm corre no Node com `globalThis.self/location` simulados (bom para validar
  comandos de corte).
- Verificar sintaxe: `node --check` (scripts) e `node --input-type=module --check < f` (módulos).
