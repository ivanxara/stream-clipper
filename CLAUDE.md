# Stream Clipper — notas para o Claude

Extensão Chrome/Edge/Brave (MV3, carregada "descompactada", sem build) que grava clips de lives
(YouTube, Twitch, Kick) e tem um editor para TikTok. O utilizador fala português de Portugal;
UI, comentários e respostas em PT-PT. Guia do utilizador: `LEIA-ME.txt` (manter atualizado).

## Ficheiros
- `content.js` — content script: painel, buffer de gravação do ecrã, fluxo do clique.
  **Buffer contínuo**: UM MediaRecorder por "run" (`videoKeyFrameIntervalDuration: 1000`, timeslice
  250 ms), lido em streaming por `webmbuf.js` (parser EBML: cabeçalho + cada SimpleBlock com tempo
  absoluto/keyframe). Um clip = `buildParts()`: WebM reconstruído a partir do último keyframe de
  vídeo antes do início pedido, tempos a partir de 0, sem juntas. Antes eram MediaRecorders de 8 s
  colados por relógio — cada junta dava um salto/pausa (o "clip travado"). Run nova só quando a
  resolução muda (evento `resize` do vídeo; a antiga fica para clips que a atravessem → 2 partes,
  o processador recodifica se os tamanhos diferirem) ou se o browser ignorar o intervalo de
  keyframes (`maintainBuffer`, 12 s sem keyframe). Relógio da página ↔ tempo do WebM: `run.offset`
  (menor atraso de chegada). `state.holds` > 0 (clips à espera) impede o `prune()`.
  Ao clicar abre logo o editor numa aba (`#pending=<clipId>`) — tem de ser no gesto do utilizador — e
  entrega o clip por postMessage quando fica pronto; o processador também o guarda no IndexedDB
  com esse id (`loadClipById`), e o editor espera por ele até 15 min (antes eram 2 min e aceitava
  "o último clip", que com a fila podia ser o de outro clique). O processador não tem limite fixo
  de tempo: só falha se ficar 90 s sem dar sinal (progresso do ffmpeg).
  Um salto real na posição (≥2s; pequenos reajustes do player, tipo voltar ao direto, são ignorados)
  descarta as runs da posição anterior e recomeça o buffer logo no `seeking` (instantâneo,
  não espera pelo `seeked`).
  ● REC = gravação manual: MediaRecorder próprio no mesmo `captureStream` (pause/resume nativos),
  no fim vai para o `handleClip` como 1 parte (`deliver()` é partilhado com os botões de duração).
  Clicar num botão de duração enquanto outro clip ainda está a processar não bloqueia: `clip()`
  guarda logo as runs (e um hold) e abre logo o editor (tem de ser no gesto), e só entra em `clipQueue` se
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
  IndexedDB `templates` = `snapshot()` (os antigos da Composição são ignorados).
  Tempos dos elementos no template: `timeBase: 'edit'` = segundos da RÉGUA (`elementsInEditTime()`,
  `out: null` = até ao fim), não da fonte. Ao aplicar (ou ao abrir outro clip com elementos já
  montados), `placeElements()` → `fitTemplateTime(e, T, D)`: um texto que cobria o vídeo todo cobre
  o novo todo; um que durava só um bocado mantém EXATAMENTE a duração — no mesmo instante se couber,
  senão recua só o necessário para acabar no fim do clip (nunca proporcional, a pedido).
  Antes deslocava tudo por `D − T` (ancorado ao fim): template de 30 s num clip de 15 s punha textos
  em tempos negativos → 0,1 s, visíveis na timeline (largura mínima do bloco) mas não no vídeo.
  Blocos que não entram no vídeo final (`exportedLength` ≈ 0 ou ficheiro em falta) ficam com a
  classe `unseen` (tracejado + title a explicar). Disposição: original | resultado
  9:16 grande | opções; sem scroll. Atalhos no keydown. A antiga
  "Composição" (camadas/templates) foi removida a pedido. Exporta com **WebCodecs** (decode→canvas→
  encode H.264 annexb) e o ffmpeg só junta o som (AAC).
  **Resultado (vista):** `#resultView` (canvas + molduras) leva `view = {z, x, y}` como transform;
  a roda = zoom da VISTA (`zoomView`, não entra no vídeo), arrastar sem zona selecionada = deslocar,
  duplo clique = `resetView`. Para enquadrar: clique simples numa zona → `selectZone(id)`
  (`previewZone`: cam/game/media/crop/framing) mostra `#zoneFrame` com pegas de zoom nos cantos;
  só então arrastar dentro dela enquadra e a roda dentro dela faz zoom do conteúdo
  (`zoomZoneContent`). Esc larga. A barra do elemento e `#viewZoom` ficam fora do `#resultView`
  (não escalam); pegas usam `scale: calc(1 / var(--vz))`. Com zoom o canvas desenha com mais
  resolução (até à da exportação). elements.js marca `ev.scDeselected` quando o clique só tirou a
  seleção de um elemento (o editor não seleciona zona nesse clique); a roda só redimensiona o
  elemento selecionado.
  **Texto no resultado:** `startInlineTextEdit(id)` (duplo clique, Enter, ou «+ Texto») põe uma
  `textarea.inlineText` transparente por cima (mesma letra/tamanho/alinhamento/rotação, posição
  a partir de `t._box`); o canvas continua a desenhar o texto, a caixa só dá cursor e seleção.
  `elementEditor.setEditingText(true)` esconde a moldura enquanto se escreve.
  **Seguir alvo (Vertical):** «🎯 Seguir alvo» → `startMarking` (`#overlay.marking`, desenha-se um
  quadrado no ORIGINAL) → `runTracking(box)`: `decodeRange` descodifica com WebCodecs do cursor até
  ao fim do clip (cada frame fechado logo no output), `tracker.js` procura o alvo frame a frame
  (≤30 fps) e o caminho suavizado (`smoothPath`) vira posições ◆ de 0,4 em 0,4 s com `path: true`
  (substituem as que estavam nesse intervalo). Entre posições `path` o `cropAt` usa Catmull-Rom
  (com o "ease" das manuais a moldura travava em cada ◆); na timeline são ◆ amarelos pequenos
  (`.kf.path`). Se a confiança ficar < `LOST_SCORE` mais de 0,6 s, pára aí e diz onde (melhor do
  que seguir outra coisa). «■ Parar» → `trackAbort`. Tudo num só passo de desfazer.
  `tracker.js`: correlação normalizada em 3 planos (Y, Cb, Cr, média 0 por plano = forma) ×
  semelhança da cor média medida só DENTRO do quadrado marcado (a margem de 10% do modelo muda de
  cor com o fundo). Lições: só cinzento → um alvo vermelho confundia-se com barras do mesmo brilho;
  cor em absoluto na correlação → uma zona lisa da mesma cor ganhava ao próprio alvo. Modelo
  adapta-se (score > 0,6) sem largar o original. Testes: `tests/tracker.cjs` (sintético).
  Posições da moldura Vertical (`st.crop.keys`): arrastar/zoom nunca cria uma posição sozinho
  (`updateCropKey` — ajusta sempre a mais próxima do instante atual, ou cria a 1ª se não houver
  nenhuma); só o botão «◆ Posição aqui» cria uma nova de propósito (`addCropKeyAt`), como no
  CapCut/Premiere. Antes, qualquer arrasto longe de uma posição existente criava outra — bastava
  estar a meio do vídeo para uma moldura "fixa" virar sem querer uma animação.
  **Timeline (modelo de editor normal, desde 2026-09-30):** `st.parts` é SEMPRE uma lista de clips
  encostados — `{start, end}` (vídeo principal) ou `{start, end, mediaId}` («+ Vídeo», ficheiro
  da biblioteca). A posição na régua é só a ordem (`rangeOffsets()`); não há buracos, "Repor
  trecho", ripple cuts nem corte global In/Out (`st.start/end`/`rippleCuts`/`sequenceClips`
  foram removidos). Apagar encosta o resto; puxar as pontas corta/recupera (`partMax`); duplicar
  insere uma cópia inteira a seguir; I/O cortam o clip debaixo do cursor. **Textos, imagens e música
  estão em segundos da régua** (vídeo final), não da fonte — `renderFrame(..., editTime)` e o
  export usam o tempo da régua para os elementos e o da fonte só para moldura/câmara. Reprodução:
  `st.activePart` = clip a tocar; `currentTimelineTime()` sai dele; `advancePlayback()` (rAF e
  `timeupdate`) passa ao seguinte por índice — nunca procurar o clip pelo tempo da fonte (com um
  duplicado o player voltava sempre ao 1.º: era o "duplicar dá dois bocados"). `showPart(i, src)`
  troca entre `#src` e `#sequenceSrc`. `partSel` = clip selecionado (≠ clip a tocar). Escala:
  `pxPerSec` (zoom; fixo quando a duração muda; barra `#tlZoom` logarítmica, botões −/+, roda do rato
  em qualquer sítio da timeline; Shift+roda = para os lados, Alt+roda = vertical; barra horizontal
  fina e sempre com lugar reservado — `overflow-x: scroll` + `scrollbar-gutter`), `laneSpan()` = segundos que a faixa inteira
  representa — todas as percentagens (clips, elementos, música, cursor, régua) usam `laneSpan`, e
  `#tracksInner` tem largura em px (a `.tracksWrap` desloca na horizontal). Arrastar um clip /
  as pontas: pointer capture no bloco e só `layoutVideoTrack()` a meio (nunca re-render).
  Exportar com clips de outros ficheiros: `materializeVideoFiles()` junta a fonte principal +
  cada ficheiro inteiro e remapeia os clips para trechos da fonte nova (a timeline não muda).
  Sessão `v: 3`; sessões antigas são convertidas (`cleanParts`, elementos via `sourceToEdit`).
  **Duração do vídeo final = `timelineDuration()` = max(clips, fim dos elementos «Ficheiro» com
  `out` próprio)** (`editDuration()` = só os clips). Se um ficheiro for além do último clip, o
  vídeo estica (`tailLength()`): na timeline aparece `.tailRange` «Último frame», a pré-visualização
  usa um relógio próprio (`tailTime`/`tailPlay`, `enterTail`) com o último frame parado, e a
  exportação repete o último frame (`tailFrames`) e acrescenta silêncio (`apad`). Nos templates,
  ficheiros com fim próprio guardam a duração (`fitTemplateTime`: nunca cortados nem encolhidos
  num clip mais curto; `out: null` só se acabavam mesmo no fim dos clips). Vídeos/GIFs novos entram
  no cursor com a duração original do ficheiro (`addImage` em elements.js); imagens paradas cobrem
  o vídeo todo. No fim natural do ficheiro o `<video>` fica `ended`+`paused` — `advancePlayback`
  trata `ended` como fim do clip (senão a reprodução não passava para o bocado extra).
  **Cada aba = um clip:** abrir ficheiro/arrastar/«Recentes» com um clip já aberto abre uma aba nova
  (`openClipFile`, via `saveRecentClip` + `?recent=`).
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
- `webmbuf.js` — content script (antes do content.js): `createParser(onBlock)` lê o WebM do
  MediaRecorder em bocados (Cluster/Segment de tamanho desconhecido, SimpleBlock e BlockGroup,
  faixas por TrackType — no Chrome o vídeo é a faixa 2) e `buildWebm(header, blocks, base)`
  reconstrói um WebM (Cluster novo em cada keyframe de vídeo). Testado em `tests/buffer-fallback.cjs`.
- `mp4.js` — demuxer MP4 (validado contra ffprobe). `media.js` — importar para a biblioteca +
  `VideoTrackReader` (vídeo frame a frame em loop). `clipstore.js` — IndexedDB v2
  (`clips`, `media`, `templates`).
- `elements.js` — edição direta de `st.texts` e `st.images`: moldura no visor com movimento,
  escala proporcional pelos cantos, rotação, ordem das camadas (`z`), timeline com intervalos
  `in`/`out` em segundos da régua (vídeo final), duplicar/apagar e histórico de elementos. `duplicate()` põe a
  cópia logo a seguir à original no tempo (nunca sobreposta; antes ficava exatamente em cima,
  só deslocada uns pixels no ecrã — parecia ter falhado). `drawTexts` em
  `editor.js` desenha ambos os tipos por ordem, respeitando os tempos e a rotação, também na
  exportação. Imagens livres são guardadas na sessão e nos templates; os bitmaps são preparados
  antes de codificar. Arrastar a etiqueta de uma camada verticalmente na timeline (drag-and-drop
  nativo, não pointer capture — ver armadilha abaixo) troca o `z` com a camada onde larga.
  `tests/editor-elements.cjs <clip.mp4>` testa interações reais no Chrome e
  codificação H.264 (Playwright instalado, ou caminho em `PLAYWRIGHT_MODULE`).
- O editor tem atalhos visíveis «+ Vídeo» e «+ Música». «+ Vídeo» acrescenta logo um clip
  `{mediaId, start, end}` ao fim de `st.parts` (metadados nativos para a timeline e a
  pré-visualização; overlays continuam em Elementos). Só ao exportar `materializeVideoFiles` junta
  os ficheiros: se codec/resolução/FPS/áudio forem compatíveis usa concat demuxer + `-c copy`; caso
  contrário recodifica. Durante leitura/consolidação mostra `#appendSkeletonRow` animado;
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
- Buffer no browser de testes: uma página em localhost com um `<video>` longo (um vídeo curto em
  `loop` dispara "seeks" a cada volta e reinicia o buffer), `window.chrome` simulado e o content.js
  injetado com `window.__capture = {...}` no fim (como em `tests/capture-browser.cjs`); o processador
  pode ser um HTML que simula `chrome.runtime.getURL` e importa `/processor.js`. O browser de testes
  abre `window.open` na mesma aba (perde a página da live) — simular `window.open` e abrir depois
  `editor.html#pending=<id>` testa o caminho pelo IndexedDB.
- Playwright existe em `~/AppData/Local/npm-cache/_npx/420ff84f11983ee5/node_modules/playwright`
  (usar em `PLAYWRIGHT_MODULE`). `tests/editor-elements.cjs` e `tests/editor-media.cjs` passam com um
  clip de ≥30 s (gerar com ffmpeg-core: testsrc2 + sine). `tests/editor-alpha.cjs` falha no Node com
  "memory access out of bounds" do ffmpeg (já antes de 2026-09-30).
