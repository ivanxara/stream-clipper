// Stream Clipper — editor de clips para TikTok.
// Corta no tempo e converte para 9:16 (moldura móvel, streamer, fundo desfocado), com textos e templates.
// A exportação usa o WebCodecs do browser (descodificar + codificar H.264 na GPU);
// o ffmpeg.wasm só junta o som no fim.
import { parseMp4 } from './mp4.js';
import { FFmpeg } from './lib/ffmpeg/index.js';
import { loadLastClip, loadClipById, saveLastClip, listRecentClips, loadRecentClip, saveRecentClip, touchRecentClip, loadEditorSession, saveEditorSession, listMedia, putMedia, deleteMedia, listTemplates, putTemplate, deleteTemplate} from './clipstore.js';
import { importMediaFile, inspectVideoFile, openMediaReader, usesFrameReader, isGif } from './media.js';
import { createElementEditor, elementVisible, orderedElements, cleanElements } from './elements.js';
import { createTracker, workSize, toPlanes, smoothPath, samplePath, LOST_SCORE } from './tracker.js';

const $ = (s) => document.querySelector(s);
const extURL = (p) => (globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL(p) : new URL(p, location.href).href);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };

const OUT_V = { w: 1080, h: 1920 };

const video = $('#src');
const sequenceVideo = $('#sequenceSrc');
const stage = $('#stage');
const overlay = $('#overlay');
const preview = $('#preview');
const pctx = preview.getContext('2d');
let elementEditor = null;
let previewZone = null;
let pendingTemplate = null;

const st = {
  blob: null, name: 'clip.mp4', buf: null, mp4: null,
  srcW: 16, srcH: 9, dur: 0,
  parts: [], activePart: 0,                            // faixa de vídeo: clips encostados (ver «timeline: modelo»)
  layout: 'streamer',
  framing: { blur: { scale: 1, ox: 0, oy: 0 }, original: { scale: 1, ox: 0, oy: 0 } },
  crop: { keys: [] },                                  // [{t, x, y, w}] (coordenadas 0..1 da fonte)
  // Streamer: câmara em cima; em baixo o jogo (bottom 'game') ou uma imagem/vídeo da biblioteca
  // ('media': scale 1 = encher a zona, ox/oy = desvio do centro em frações da zona).
  streamer: { split: 0.35, cam: null, game: null, bottom: 'game', mediaId: null, scale: 1, ox: 0, oy: 0 },
  library: [],      // itens da biblioteca (clipstore 'media')
  recentClips: [],
  recentId: '',
  images: [],
  audioTracks: [],
  audioSel: null,
  busy: false,
};

// Um só histórico para cortes/enquadramento do vídeo e elementos. A posição do
// cursor é guardada para restaurar o contexto, mas não cria uma ação por si só.
const editUndo = [], editRedo = [];
function videoSnapshot() {
  return {
    parts: structuredClone(st.parts), activePart: st.activePart,
    audioTracks: structuredClone(st.audioTracks), audioSel: st.audioSel,
    layout: st.layout, streamer: structuredClone(st.streamer), keys: structuredClone(st.crop.keys),
    framing: structuredClone(st.framing),
    cropDefault: loadJSON('sc.crop', null),
    cursor: currentTimelineTime(),
  };
}
const videoEditKey = ({ cursor, activePart, ...edit }) => JSON.stringify(edit);
function refreshEditButtons() { elementEditor?.refreshButtons(); }
function beginVideoEdit() { elementEditor?.commit(); return videoSnapshot(); }
function recordEdit(entry) {
  editUndo.push(entry);
  if (editUndo.length > 80) editUndo.shift();
  editRedo.length = 0;
  refreshEditButtons();
  saveSession();
}
function recordVideoEdit(before) {
  const after = videoSnapshot();
  if (videoEditKey(before) !== videoEditKey(after)) recordEdit({ kind: 'video', before, after });
}
function restoreVideoEdit(s) {
  video.pause();
  sequenceVideo.pause();
  st.parts = structuredClone(s.parts);
  st.activePart = clamp(s.activePart || 0, 0, Math.max(0, st.parts.length - 1));
  partSel = -1;
  st.audioTracks = structuredClone(s.audioTracks || []);
  st.audioSel = s.audioSel || null;
  st.streamer = structuredClone(s.streamer);
  st.framing = normalizeFraming(s.framing);
  st.crop.keys = structuredClone(s.keys);
  if (s.cropDefault) saveJSON('sc.crop', s.cropDefault);
  else try { localStorage.removeItem('sc.crop'); } catch {}
  setLayout(s.layout);
  placeRects();
  updateSplitUi();
  updateTimeline();
  seekTimelineTime(clamp(s.cursor, 0, timelineDuration()));
  renderAudioTracks();
  renderTextOpts();
  savePrefs();
  rememberCam();
  saveSession();
}
function editHistory(redo = false) {
  if (st.busy) return;
  elementEditor?.commit();
  const source = redo ? editRedo : editUndo, target = redo ? editUndo : editRedo;
  const entry = source.pop();
  if (!entry) return;
  if (entry.kind === 'video') restoreVideoEdit(redo ? entry.after : entry.before);
  else elementEditor?.undo(redo);
  target.push(entry);
  refreshEditButtons();
}
function resetEditHistory() { editUndo.length = editRedo.length = 0; refreshEditButtons(); }

// ---------- geometria ----------
// Cada região editável tem o aspeto (largura/altura) do sítio onde vai parar no resultado.
function regions() {
  if (st.layout === 'crop') return [{ id: 'crop', label: 'Moldura 9:16', aspect: 9 / 16 }];
  if (st.layout === 'streamer') {
    const ch = camH(OUT_V.h);
    const r = [{ id: 'cam', label: 'Cima', aspect: OUT_V.w / ch }];
    if (st.streamer.bottom !== 'media') r.push({ id: 'game', label: 'Baixo', aspect: OUT_V.w / (OUT_V.h - ch) });
    return r;
  }
  return [];
}

const camH = (H) => Math.round(H * st.streamer.split);
const libItem = (id) => st.library.find((m) => m.id === id);
const regionById = (id) => regions().find((r) => r.id === id);

// Altura normalizada de um retângulo {x,y,w} com o aspeto dado.
const rectH = (r, aspect) => (r.w * st.srcW) / aspect / st.srcH;

function fitRect(r, aspect) {
  let w = clamp(r.w, 0.04, 1);
  if (rectH({ w }, aspect) > 1) w = (aspect * st.srcH) / st.srcW;
  const h = rectH({ w }, aspect);
  return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w };
}

function defaultRect(id) {
  const reg = regionById(id);
  if (id === 'cam') return fitRect({ x: 0, y: 0, w: 0.3 }, reg.aspect);
  if (id === 'crop') {                                              // a última moldura usada
    try { const r = JSON.parse(localStorage.getItem('sc.crop')); if (r) return fitRect(r, reg.aspect); } catch {}
  }
  const full = fitRect({ x: 0, y: 0, w: 1 }, reg.aspect);          // o maior que cabe
  return fitRect({ ...full, x: (1 - full.w) / 2, y: (1 - rectH(full, reg.aspect)) / 2 }, reg.aspect);
}

const smooth = (u) => u * u * (3 - 2 * u);

// Posição da moldura no instante t (interpola entre as posições marcadas).
function cropAt(t) {
  const k = st.crop.keys;
  if (!k.length) return defaultRect('crop');
  if (t <= k[0].t) return k[0];
  if (t >= k[k.length - 1].t) return k[k.length - 1];
  let i = 1;
  while (k[i].t < t) i++;
  const a = k[i - 1], b = k[i];
  if (a.path && b.path) {
    // Posições do seguimento (muitas e seguidas): curva contínua (Catmull-Rom) — com o "ease" das
    // posições manuais a moldura travava em cada ◆.
    const p0 = k[i - 2]?.path ? k[i - 2] : a, p3 = k[i + 1]?.path ? k[i + 1] : b, u = (t - a.t) / (b.t - a.t);
    const cr = (q0, q1, q2, q3) => 0.5 * (2 * q1 + (-q0 + q2) * u + (2 * q0 - 5 * q1 + 4 * q2 - q3) * u * u + (-q0 + 3 * q1 - 3 * q2 + q3) * u * u * u);
    return { x: cr(p0.x, a.x, b.x, p3.x), y: cr(p0.y, a.y, b.y, p3.y), w: a.w + (b.w - a.w) * u };
  }
  const u = smooth((t - a.t) / (b.t - a.t));
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, w: a.w + (b.w - a.w) * u };
}

function rectFor(id, t) {
  if (drag?.id === id) return drag.rect;           // a ser arrastado agora
  if (id === 'crop') return cropAt(t);
  const s = st.streamer;
  if (!s[id]) s[id] = defaultRect(id);
  return s[id];
}

function outSize() {
  if (st.layout === 'original') {
    const scale = Math.min(1, 1920 / Math.max(st.srcW, st.srcH));
    return { w: Math.round((st.srcW * scale) / 2) * 2, h: Math.round((st.srcH * scale) / 2) * 2 };
  }
  return OUT_V;
}

// ---------- desenho (igual na pré-visualização e na exportação) ----------
const blurCanvas = new OffscreenCanvas(135, 240);
const bctx = blurCanvas.getContext('2d');

function drawSrc(ctx, src, sw, sh, r, aspect, dx, dy, dw, dh) {
  const h = rectH(r, aspect);
  ctx.drawImage(src, r.x * sw, r.y * sh, r.w * sw, h * sh, dx, dy, dw, dh);
}

// Imagem/vídeo na zona de baixo: tamanho relativo a encher a zona, deslocado do centro.
function drawMedia(ctx, m, dx, dy, dw, dh) {
  const s = st.streamer, k = Math.max(dw / m.w, dh / m.h) * s.scale;
  const w = m.w * k, h = m.h * k, cx = dx + dw / 2 + s.ox * dw, cy = dy + dh / 2 + s.oy * dh;
  ctx.save();
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.drawImage(m.img, 0, 0, m.w, m.h, cx - w / 2, cy - h / 2, w, h);
  ctx.restore();
}

// t = tempo da fonte (moldura/câmara); editTime = tempo da régua (textos e imagens).
function renderFrame(ctx, src, sw, sh, t, W, H, media, elementMedia, editTime = t) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (st.layout === 'original') {
    drawFramedVideo(ctx, src, sw, sh, W, H);
  } else if (st.layout === 'crop') {
    drawSrc(ctx, src, sw, sh, cropAt(t), 9 / 16, 0, 0, W, H);
  } else if (st.layout === 'streamer') {
    const ch = camH(H), cam = regionById('cam');
    drawSrc(ctx, src, sw, sh, rectFor('cam', t), cam.aspect, 0, 0, W, ch);
    if (st.streamer.bottom === 'media') {
      const m = media?.();
      if (m) drawMedia(ctx, m, 0, ch, W, H - ch);
    } else {
      drawSrc(ctx, src, sw, sh, rectFor('game', t), regionById('game').aspect, 0, ch, W, H - ch);
    }
  } else if (st.layout === 'blur') {
    // fundo: o vídeo a encher tudo, pequeno e desfocado; frente: o vídeo inteiro ao centro
    const bw = blurCanvas.width, bh = blurCanvas.height;
    const cover = Math.max(bw / sw, bh / sh);
    bctx.filter = 'blur(6px) brightness(0.6)';
    bctx.drawImage(src, (bw - sw * cover) / 2, (bh - sh * cover) / 2, sw * cover, sh * cover);
    bctx.filter = 'none';
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(blurCanvas, -W * 0.05, -H * 0.05, W * 1.1, H * 1.1);
    drawFramedVideo(ctx, src, sw, sh, W, H);
  }
  drawTexts(ctx, W, H, editTime, elementMedia);
}

function normalizeFraming(value) {
  return Object.fromEntries(['blur', 'original'].map(mode => {
    const f = value?.[mode];
    return [mode, { scale: Number.isFinite(f?.scale) ? clamp(f.scale, 1, 4) : 1,
      ox: Number.isFinite(f?.ox) ? clamp(f.ox, -2, 2) : 0,
      oy: Number.isFinite(f?.oy) ? clamp(f.oy, -2, 2) : 0 }];
  }));
}

// Amplia apenas o vídeo; os textos e as imagens livres mantêm a sua posição.
function framingBounds(W, H, sw = st.srcW, sh = st.srcH) {
  const f = st.framing[st.layout], w = W * f.scale;
  const h = (st.layout === 'blur' ? W * sh / sw : H) * f.scale;
  return { w, h, mx: Math.max(0, (w - W) / (2 * W)), my: Math.abs(h - H) / (2 * H) };
}
function drawFramedVideo(ctx, src, sw, sh, W, H) {
  const f = st.framing[st.layout], b = framingBounds(W, H, sw, sh);
  ctx.drawImage(src, 0, 0, sw, sh, (W - b.w) / 2 + clamp(f.ox, -b.mx, b.mx) * W,
    (H - b.h) / 2 + clamp(f.oy, -b.my, b.my) * H, b.w, b.h);
}
function setFraming(scale, ox, oy) {
  const f = st.framing[st.layout];
  f.scale = clamp(scale, 1, 4);
  const { w, h } = outSize(), b = framingBounds(w, h);
  f.ox = clamp(ox ?? f.ox, -b.mx, b.mx);
  f.oy = clamp(oy ?? f.oy, -b.my, b.my);
  syncFramingUi();
}
function syncFramingUi() {
  const f = st.framing[st.layout], input = $('#videoZoom');
  if (!f || !input) return;
  input.value = Math.round(f.scale * 100);
  $('#videoZoomValue').textContent = Math.round(f.scale * 100) + '%';
  for (const el of $('#videoFraming').querySelectorAll('button, input')) el.disabled = !st.mp4 || st.busy;
  $('#videoZoomOut').disabled ||= f.scale <= 1;
  $('#videoZoomIn').disabled ||= f.scale >= 4;
}
function renderFramingOpts(o) {
  o.innerHTML = `<div class="opt" id="videoFraming"><h2>Zoom do vídeo</h2>
    <label for="videoZoom">Aproximação <span class="mono" id="videoZoomValue"></span></label>
    <div class="videoZoomRow"><button class="btn small" id="videoZoomOut" aria-label="Diminuir zoom do vídeo">−</button>
      <input id="videoZoom" type="range" min="100" max="400" step="1" aria-label="Zoom do vídeo">
      <button class="btn small" id="videoZoomIn" aria-label="Aumentar zoom do vídeo">+</button></div>
    <button class="btn small" id="videoZoomReset">Repor enquadramento</button></div>`;
  const input = $('#videoZoom');
  let before = null;
  input.addEventListener('input', () => {
    if (!st.mp4 || st.busy) return;
    before ??= beginVideoEdit();
    setFraming(+input.value / 100);
  });
  input.addEventListener('change', () => { if (before) recordVideoEdit(before); before = null; });
  for (const [id, factor] of [['videoZoomOut', 1 / 1.1], ['videoZoomIn', 1.1], ['videoZoomReset', 0]]) {
    $('#' + id).addEventListener('click', () => {
      if (!st.mp4 || st.busy) return;
      const initial = beginVideoEdit();
      if (factor) setFraming(st.framing[st.layout].scale * factor);
      else setFraming(1, 0, 0);
      recordVideoEdit(initial);
    });
  }
  syncFramingUi();
}

// ---------- pré-visualização (resultado grande ao centro) ----------
const main = $('main');
const resultBox = $('#resultBox');
const resultView = $('#resultView');
const view = { z: 1, x: 0, y: 0 };      // zoom/deslocamento da vista do resultado (não entra no vídeo)

// A coluna do resultado tem a largura que o formato pede para a altura disponível.
function sizeResult() {
  const { w, h } = outSize();
  const maxW = main.clientWidth * (st.layout === 'original' ? 0.42 : 0.36);
  main.style.setProperty('--rw', Math.round(Math.min(maxW, (stage.clientHeight * w) / h)) + 'px');
  resultBox.style.setProperty('--ra', `${w} / ${h}`);
}
new ResizeObserver(() => { sizeResult(); placeRects(); }).observe(stage);

const sequenceFitCanvas = new OffscreenCanvas(16, 16);
function fittedSequenceSource(src) {
  if (sequenceFitCanvas.width !== st.srcW || sequenceFitCanvas.height !== st.srcH) {
    sequenceFitCanvas.width = st.srcW; sequenceFitCanvas.height = st.srcH;
  }
  const ctx = sequenceFitCanvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, st.srcW, st.srcH);
  const scale = Math.min(st.srcW / src.videoWidth, st.srcH / src.videoHeight);
  const w = src.videoWidth * scale, h = src.videoHeight * scale;
  ctx.drawImage(src, (st.srcW - w) / 2, (st.srcH - h) / 2, w, h);
  return sequenceFitCanvas;
}

// ---------- reprodução pela timeline ----------
// st.activePart = o clip da faixa de vídeo que está a tocar (ou onde está o cursor). O tempo da
// régua sai dele: início do clip na régua + (tempo do <video> − início do trecho). Nunca se procura
// o clip "pelo tempo da fonte": dois clips podem mostrar o mesmo trecho (duplicado), e antes o
// player voltava sempre ao 1.º — duplicar parecia dar dois bocados em vez de um clip seguido.
let sequenceURL = null, sequenceMediaId = null;
const activeVideo = () => (st.parts[st.activePart]?.mediaId ? sequenceVideo : video);
// tailTime: cursor parado depois do último clip; tailPlay: a tocar nesse bocado ({t0, from}).
let tailTime = null, tailPlay = null;
const isPlaying = () => !!tailPlay || !activeVideo().paused;
function currentTimelineTime() {
  if (tailPlay) return Math.min(timelineDuration(), tailPlay.from + (performance.now() - tailPlay.t0) / 1000);
  if (tailTime != null) return Math.min(tailTime, timelineDuration());
  const o = rangeOffsets()[st.activePart];
  if (!o) return 0;
  const el = o.mediaId ? sequenceVideo : video;
  return o.editStart + clamp((el.currentTime || 0) - o.start, 0, o.end - o.start);
}
// Mostra o clip i no instante src (tempo da fonte desse clip).
function showPart(i, src, autoplay = false) {
  const part = st.parts[i];
  if (!part) return;
  st.activePart = i;
  const t = clamp(src ?? part.start, part.start, Math.max(part.start, part.end - 0.001));
  if (part.mediaId) {
    const media = libItem(part.mediaId);
    if (!media?.blob) return;
    video.pause();
    if (sequenceMediaId !== part.mediaId) {
      sequenceVideo.pause();
      if (sequenceURL) URL.revokeObjectURL(sequenceURL);
      sequenceURL = URL.createObjectURL(media.sourceBlob || media.blob);
      sequenceVideo.src = sequenceURL;
      sequenceMediaId = part.mediaId;
    }
    video.hidden = true; sequenceVideo.hidden = false; overlay.hidden = true;
    const go = () => { sequenceVideo.currentTime = t; if (autoplay) sequenceVideo.play().catch(() => {}); };
    if (sequenceVideo.readyState >= 1) go(); else sequenceVideo.addEventListener('loadedmetadata', go, { once: true });
  } else {
    sequenceVideo.pause();
    sequenceVideo.hidden = true; video.hidden = false; overlay.hidden = false;
    if (Math.abs(video.currentTime - t) > 0.002) video.currentTime = t;
    if (autoplay) video.play().catch(() => {});
  }
  markActivePart();
}
function resetSequencePreview() {
  sequenceVideo.pause();
  sequenceVideo.removeAttribute('src');
  sequenceVideo.load();
  if (sequenceURL) URL.revokeObjectURL(sequenceURL);
  sequenceURL = null; sequenceMediaId = null;
  sequenceVideo.hidden = true; video.hidden = false; overlay.hidden = false;
}
function pausePlayback() {
  if (tailPlay) { tailTime = currentTimelineTime(); tailPlay = null; }
  video.pause(); sequenceVideo.pause();
}
// Entra no bocado depois do último clip: mostra o último frame e (se a tocar) arranca o relógio.
function enterTail(time, play) {
  const last = st.parts.length - 1;
  video.pause(); sequenceVideo.pause();
  if (last >= 0) showPart(last, st.parts[last].end - 0.001);
  tailTime = play ? null : time;
  tailPlay = play ? { t0: performance.now(), from: time } : null;
}
// Passa ao clip seguinte quando o atual acaba (sem seek se o seguinte continua o mesmo trecho,
// para não dar um soluço num corte "sem nada cortado").
function advancePlayback() {
  if (tailPlay) {
    if (currentTimelineTime() >= timelineDuration() - 0.001) { tailTime = timelineDuration(); tailPlay = null; }
    return;
  }
  const part = st.parts[st.activePart], el = activeVideo();
  // No fim natural do ficheiro o <video> pára sozinho (ended): também conta como "acabou o clip".
  if (!part || (el.paused && !el.ended) || tailTime != null) return;
  if (el.currentTime >= part.end - 0.02 || el.ended) {
    const next = st.parts[st.activePart + 1];
    if (!next) {
      if (tailLength() > 0.02) enterTail(editDuration(), true); else pausePlayback();
      return;
    }
    if (!next.mediaId && !part.mediaId && Math.abs(next.start - el.currentTime) < 0.06) { st.activePart++; markActivePart(); }
    else showPart(st.activePart + 1, next.start, true);
  } else if (el.currentTime < part.start - 0.1) el.currentTime = part.start;
}

// Também no timeupdate: se a aba não estiver a desenhar (rAF parado), a reprodução continua certa.
video.addEventListener('timeupdate', advancePlayback);
sequenceVideo.addEventListener('timeupdate', advancePlayback);
sequenceVideo.addEventListener('ended', advancePlayback);
video.addEventListener('ended', advancePlayback);

function loopPreview() {
  syncMediaTime();
  syncAudioPreview();
  advancePlayback();
  const part = st.parts[st.activePart], el = activeVideo();
  if (st.mp4 && el.readyState >= 2) {
    const { w, h } = outSize();
    const dpr = Math.min(2, devicePixelRatio || 1);
    // Com zoom na vista, desenha com mais resolução (até à da exportação) para não ficar desfocado.
    const pw = Math.min(w, Math.round(resultBox.clientWidth * dpr * view.z)), ph = Math.round((pw * h) / w);
    if (pw > 0 && (preview.width !== pw || preview.height !== ph)) { preview.width = pw; preview.height = ph; }
    const source = part?.mediaId ? fittedSequenceSource(el) : el;
    const sw = part?.mediaId ? st.srcW : el.videoWidth, sh = part?.mediaId ? st.srcH : el.videoHeight;
    renderFrame(pctx, source, sw, sh, part?.mediaId ? 0 : el.currentTime, preview.width, preview.height, () => previewMediaFor(st.streamer.mediaId), null, currentTimelineTime());
  }
  elementEditor?.update();
  updateSplitUi();
  syncFramingUi();
  if (st.layout === 'crop' || drag) placeRects();                                    // a moldura segue as posições
  updateHead();
  inlineText?.place();
  requestAnimationFrame(loopPreview);
}

// ---------- retângulos sobre o vídeo ----------
function videoBox() {
  const r = stage.getBoundingClientRect();
  const s = Math.min(r.width / st.srcW, r.height / st.srcH);
  const w = st.srcW * s, h = st.srcH * s;
  return { left: (r.width - w) / 2, top: (r.height - h) / 2, w, h };
}

let drag = null;

function buildRects() {
  overlay.innerHTML = '';
  if (!st.mp4) return;             // sem clip não há onde pôr as molduras
  for (const reg of regions()) {
    const el = document.createElement('div');
    el.className = 'rect ' + reg.id;
    el.dataset.id = reg.id;
    el.innerHTML = `<span class="tag">${reg.label}</span>` +
      ['nw', 'ne', 'sw', 'se'].map((c) => `<span class="grip ${c}" data-corner="${c}"></span>`).join('');
    el.addEventListener('pointerdown', (e) => startDrag(e, reg.id, e.target.dataset.corner || 'move'));
    overlay.appendChild(el);
  }
  placeRects();
}

function placeRects() {
  if (!st.mp4) return;
  const box = videoBox();
  for (const el of overlay.children) {
    const reg = regionById(el.dataset.id);
    if (!reg) continue;
    const r = drag && drag.id === reg.id ? drag.rect : rectFor(reg.id, video.currentTime);
    const h = rectH(r, reg.aspect);
    Object.assign(el.style, {
      left: box.left + r.x * box.w + 'px', top: box.top + r.y * box.h + 'px',
      width: r.w * box.w + 'px', height: h * box.h + 'px',
    });
  }
}

// Redimensiona por um canto (nw/ne/sw/se) mantendo o canto oposto fixo e a proporção.
function resizeFromCorner(r0, corner, dx, dy, aspect) {
  const sx = corner.includes('w') ? -1 : 1, sy = corner.includes('n') ? -1 : 1;
  const h0 = rectH(r0, aspect);
  const wPerH = (aspect * st.srcH) / st.srcW;           // largura normalizada por unidade de altura
  // Segue o eixo em que o rato se mexeu mais (convertido para largura).
  const a = sx * dx, b = sy * dy * wPerH;
  const dw = Math.abs(a) > Math.abs(b) ? a : b;
  const maxW = Math.min(
    sx > 0 ? 1 - r0.x : r0.x + r0.w,                     // não passa da borda do lado que cresce
    (sy > 0 ? 1 - r0.y : r0.y + h0) * wPerH,
  );
  const w = clamp(r0.w + dw, 0.04, Math.max(0.04, maxW));
  const h = rectH({ w }, aspect);
  return fitRect({ x: sx > 0 ? r0.x : r0.x + r0.w - w, y: sy > 0 ? r0.y : r0.y + h0 - h, w }, aspect);
}

function startDrag(e, id, mode) {
  if (e.button !== 0 || st.busy) return;
  e.preventDefault();
  e.stopPropagation();
  const before = beginVideoEdit();
  const reg = regionById(id);
  drag = { id, mode, reg, x0: e.clientX, y0: e.clientY, r0: { ...rectFor(id, video.currentTime) } };
  drag.rect = drag.r0;
  try { e.target.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => {
    const box = videoBox();
    const dx = (ev.clientX - drag.x0) / box.w, dy = (ev.clientY - drag.y0) / box.h;
    const r0 = drag.r0;
    drag.rect = drag.mode === 'move'
      ? fitRect({ x: r0.x + dx, y: r0.y + dy, w: r0.w }, reg.aspect)
      : resizeFromCorner(r0, drag.mode, dx, dy, reg.aspect);
    placeRects();
    if (id !== 'crop') setRect(id, drag.rect);
  };
  const up = (ev) => {
    e.target.removeEventListener('pointermove', move);
    e.target.removeEventListener('pointerup', up);
    e.target.removeEventListener('pointercancel', up);
    const done = drag;
    drag = null;
    if (ev.type === 'pointercancel') { restoreVideoEdit(before); return; }
    if (id === 'crop') updateCropKey(video.currentTime, done.rect); else rememberCam();
    placeRects();
    recordVideoEdit(before);
  };
  e.target.addEventListener('pointermove', move);
  e.target.addEventListener('pointerup', up);
  e.target.addEventListener('pointercancel', up);
}

function setRect(id, r) {
  st.streamer[id] = r;
}

// Arrastar/fazer zoom na moldura nunca cria uma posição sozinho (era assim que uma posição
// fixa se transformava numa animação só por se estar a meio do vídeo): ajusta sempre a posição
// já existente mais próxima do instante atual, ou cria a primeira se ainda não houver nenhuma.
function updateCropKey(t, r) {
  const k = st.crop.keys;
  if (!k.length) k.push({ t, ...r });
  else Object.assign(k.reduce((best, p) => Math.abs(p.t - t) < Math.abs(best.t - t) ? p : best), r);
  try { localStorage.setItem('sc.crop', JSON.stringify({ x: r.x, y: r.y, w: r.w })); } catch {}
  renderOpts();
  renderKeys();
}

// Ação explícita («+ Posição aqui»): cria uma posição nova no instante atual (ou atualiza uma já
// quase no mesmo instante) — é a única forma de começar a animar a moldura.
function addCropKeyAt(t, r) {
  const k = st.crop.keys;
  const near = k.find((p) => Math.abs(p.t - t) < 0.25);
  if (near) Object.assign(near, r);
  else { k.push({ t, ...r }); k.sort((a, b) => a.t - b.t); }
  try { localStorage.setItem('sc.crop', JSON.stringify({ x: r.x, y: r.y, w: r.w })); } catch {}
  renderOpts();
  renderKeys();
}

// ---------- timeline: modelo ----------
// A faixa de vídeo é uma lista de clips encostados (st.parts), como em qualquer editor:
//   {start, end}          trecho do vídeo principal (segundos da fonte)
//   {start, end, mediaId} trecho de um vídeo da biblioteca («+ Vídeo»)
// A posição na régua é só a ordem: o clip i começa onde acaba o i−1 (sem buracos; apagar fecha o
// espaço). Esticar as pontas de um clip recupera o que foi cortado. Textos, imagens e música vivem
// no tempo da régua (segundos do vídeo final), não da fonte.
const tl = $('#timeline');
const partLength = (p) => Math.max(0, p.end - p.start);
const partMax = (p) => (p.mediaId ? libItem(p.mediaId)?.dur || p.end : st.dur);
const partName = (p) => (p.mediaId ? libItem(p.mediaId)?.name || 'Vídeo' : 'Clip');
function getRanges() { return st.parts; }
function rangeOffsets() {
  let cursor = 0;
  return st.parts.map((p) => {
    const editStart = cursor;
    cursor += partLength(p);
    return { start: p.start, end: p.end, mediaId: p.mediaId, editStart, editEnd: cursor };
  });
}
function editDuration() { return st.parts.reduce((sum, p) => sum + partLength(p), 0); }
// Duração do vídeo final: os clips, ou mais, se um elemento «Ficheiro» (imagem/vídeo) com fim
// próprio for para lá do último clip — como num editor normal, o vídeo dura até à última coisa na
// timeline. Nesse bocado extra fica o último frame do clip parado por trás.
const mediaElementsEnd = () => st.images.reduce((end, e) => (e.out != null ? Math.max(end, e.out) : end), 0);
const timelineDuration = () => Math.max(editDuration(), mediaElementsEnd());
const tailLength = () => Math.max(0, timelineDuration() - editDuration());
// Instante da régua → clip e tempo da fonte.
function locate(time) {
  const offs = rangeOffsets();
  if (!offs.length) return null;
  const t = clamp(time, 0, offs.at(-1).editEnd);
  let i = offs.findIndex((o) => t < o.editEnd - 1e-6);
  if (i < 0) i = offs.length - 1;
  return { i, src: offs[i].start + clamp(t - offs[i].editStart, 0, offs[i].end - offs[i].start) };
}
// Tempo da fonte principal → régua (para os ◆ da moldura). Prefere o clip ativo (um trecho
// duplicado aparece mais do que uma vez).
function sourceToEdit(time, offs = rangeOffsets()) {
  const main = offs.filter((o) => !o.mediaId);
  if (!main.length) return 0;
  const active = offs[st.activePart];
  if (active && !active.mediaId && time >= active.start - 0.001 && time <= active.end + 0.001) return active.editStart + clamp(time - active.start, 0, active.end - active.start);
  const hit = main.find((o) => time >= o.start - 0.001 && time <= o.end + 0.001);
  if (hit) return hit.editStart + clamp(time - hit.start, 0, hit.end - hit.start);
  let best = main[0], bestDist = Infinity;
  for (const o of main) {
    const d = time < o.start ? o.start - time : time - o.end;
    if (d < bestDist) { bestDist = d; best = o; }
  }
  return time < best.start ? best.editStart : best.editEnd;
}

// Escala da timeline: píxeis por segundo (zoom). Fica fixa quando a duração muda — duplicar ou
// apagar um clip não "encolhe" tudo; a faixa cresce e aparece a barra de deslocamento.
const TRACK_LABEL_W = 102;
const tracksWrap = $('.tracksWrap'), tracksInner = $('#tracksInner');
let pxPerSec = 0;
const visibleLaneWidth = () => Math.max(120, tracksWrap.clientWidth - TRACK_LABEL_W - 10);
const fitPxPerSec = () => (visibleLaneWidth() - 24) / Math.max(1, timelineDuration());
const laneWidth = () => Math.max(visibleLaneWidth(), timelineDuration() * (pxPerSec || fitPxPerSec()) + 24);
const laneSpan = () => laneWidth() / (pxPerSec || fitPxPerSec());   // segundos que a faixa inteira representa
function applyTimelineScale() {
  if (!pxPerSec) pxPerSec = fitPxPerSec();
  tracksInner.style.width = `${TRACK_LABEL_W + laneWidth()}px`;
}
function zoomTimeline(factor, anchorClientX = null) {
  if (!st.mp4) return;
  const lane = tl.getBoundingClientRect();
  const anchorX = anchorClientX ?? lane.left + Math.min(lane.width, tracksWrap.clientWidth - TRACK_LABEL_W) / 2;
  const anchorTime = (anchorX - lane.left) / lane.width * laneSpan();
  const { lo, hi } = zoomRange();
  pxPerSec = clamp((pxPerSec || fitPxPerSec()) * factor, lo, hi);
  updateTimeline();
  const newLane = tl.getBoundingClientRect();
  tracksWrap.scrollLeft += (newLane.left + anchorTime / laneSpan() * newLane.width) - anchorX;
}
function fitTimeline() { pxPerSec = fitPxPerSec(); updateTimeline(); tracksWrap.scrollLeft = 0; }
// Barra de zoom (escala logarítmica): 0 = metade do "ver tudo", 100 = 400 px por segundo.
const zoomRange = () => { const fit = fitPxPerSec(); return { lo: fit * 0.5, hi: Math.max(fit * 0.6, 400) }; };
function syncZoomSlider() {
  const { lo, hi } = zoomRange(), z = clamp(pxPerSec || fitPxPerSec(), lo, hi);
  $('#tlZoom').value = String(Math.round(Math.log(z / lo) / Math.log(hi / lo) * 100));
}
const editPct = (time) => (time / laneSpan()) * 100 + '%';
const tAt = (clientX) => { const r = tl.getBoundingClientRect(); return clamp((clientX - r.left) / r.width * laneSpan(), 0, timelineDuration()); };
const pct = (sourceTime) => editPct(sourceToEdit(sourceTime));

// Faixas de música usam o relógio visível da timeline. O ficheiro nunca é
// alterado: start posiciona-o; trimStart/trimEnd escolhem a parte que se ouve.
const audioItem = () => st.audioTracks.find(track => track.id === st.audioSel);
const audioLength = track => Math.max(0, track.trimEnd - track.trimStart);
const audioEnd = track => Math.min(timelineDuration(), track.start + audioLength(track));
function normalizeAudioTracks() {
  const duration = timelineDuration();
  st.audioTracks = st.audioTracks.filter(track => track?.mediaId).map(track => {
    const media = libItem(track.mediaId), max = Math.max(.05, media?.dur || track.trimEnd || .05);
    track.trimStart = clamp(Number.isFinite(track.trimStart) ? track.trimStart : 0, 0, Math.max(0, max - .05));
    track.trimEnd = clamp(Number.isFinite(track.trimEnd) ? track.trimEnd : max, track.trimStart + .05, max);
    track.start = clamp(Number.isFinite(track.start) ? track.start : 0, 0, Math.max(0, duration - .05));
    track.volume = clamp(Number.isFinite(track.volume) ? track.volume : .35, 0, 2);
    track.fadeIn = clamp(Number.isFinite(track.fadeIn) ? track.fadeIn : 0, 0, audioLength(track) / 2);
    track.fadeOut = clamp(Number.isFinite(track.fadeOut) ? track.fadeOut : 0, 0, audioLength(track) / 2);
    track.muted = !!track.muted;
    return track;
  });
  if (!audioItem()) st.audioSel = null;
}

const audioPreview = new Map();
function disposeAudioPreview(id) {
  const p = audioPreview.get(id);
  if (!p) return;
  p.el.pause(); p.el.removeAttribute('src'); p.el.load(); URL.revokeObjectURL(p.url); audioPreview.delete(id);
}
function audioPreviewFor(track) {
  let p = audioPreview.get(track.id);
  if (p) return p;
  const media = libItem(track.mediaId);
  if (!media) return null;
  const el = new Audio(), url = URL.createObjectURL(media.sourceBlob || media.blob);
  Object.assign(el, { src: url, preload: 'auto' });
  p = { el, url, mediaId: media.id };
  audioPreview.set(track.id, p);
  return p;
}
function syncAudioPreview(force = false) {
  if (!st.mp4) return;
  const now = currentTimelineTime(), paused = !isPlaying();
  for (const track of st.audioTracks) {
    const p = audioPreviewFor(track);
    if (!p) continue;
    const local = track.trimStart + now - track.start, length = audioLength(track);
    const active = !st.busy && !track.muted && now >= track.start && now < track.start + length && local < track.trimEnd;
    if (!active) { p.el.pause(); continue; }
    const into = local - track.trimStart, left = track.trimEnd - local;
    let gain = track.volume;
    if (track.fadeIn > 0) gain *= clamp(into / track.fadeIn, 0, 1);
    if (track.fadeOut > 0) gain *= clamp(left / track.fadeOut, 0, 1);
    p.el.volume = clamp(gain, 0, 1);
    if (p.el.readyState && (force || p.el.seeking || Math.abs(p.el.currentTime - local) > (paused ? .025 : .2))) {
      try { p.el.currentTime = clamp(local, 0, p.el.duration || track.trimEnd); } catch {}
    }
    if (paused) p.el.pause(); else if (p.el.paused) p.el.play().catch(() => {});
  }
  for (const [id] of audioPreview) if (!st.audioTracks.some(track => track.id === id)) disposeAudioPreview(id);
}

// Só troca a classe "on" no bloco já existente, sem refazer o innerHTML da faixa. Chamado no
// meio de um arrastar: um renderAudioTracks() ali destruiria o próprio bloco que o pointerdown
// está a agarrar (fica sem parentElement) e o arrastar morre logo ali, sem erro visível.
function highlightAudioSelection() {
  $('#audioTracks')?.querySelectorAll('[data-audio]').forEach((b) => b.classList.toggle('on', b.dataset.audio === st.audioSel));
}
function selectAudio(id, showPanel = true, keepTracksDom = false) {
  st.audioSel = st.audioTracks.some(track => track.id === id) ? id : null;
  if (st.audioSel) elementEditor?.select(null);
  if (keepTracksDom) highlightAudioSelection(); else renderAudioTracks();
  updateTimelineTools();
  if (showPanel) renderTextOpts();
}
function removeAudio(id = st.audioSel) {
  const track = st.audioTracks.find(item => item.id === id);
  if (!track || st.busy) return;
  const before = beginVideoEdit();
  st.audioTracks = st.audioTracks.filter(item => item.id !== id);
  disposeAudioPreview(id);
  if (st.audioSel === id) st.audioSel = null;
  renderAudioTracks(); renderTextOpts(); updateTimelineTools(); recordVideoEdit(before);
}
function splitAudio() {
  const track = audioItem(), t = currentTimelineTime();
  if (!track || t <= track.start + .05 || t >= audioEnd(track) - .05) return false;
  const before = beginVideoEdit(), cut = track.trimStart + t - track.start;
  const right = { ...track, id: crypto.randomUUID(), start: t, trimStart: cut };
  track.trimEnd = cut;
  st.audioTracks.splice(st.audioTracks.indexOf(track) + 1, 0, right);
  st.audioSel = right.id;
  renderAudioTracks(); renderTextOpts(); recordVideoEdit(before);
  return true;
}
function renderAudioTracks() {
  const wrap = $('#audioTracks');
  if (!wrap) return;
  normalizeAudioTracks();
  const span = laneSpan() || 1, pctTime = time => clamp(time / span * 100, 0, 100);
  wrap.innerHTML = st.audioTracks.map(track => {
    const media = libItem(track.mediaId), end = audioEnd(track);
    return `<div class="audioTrackRow"><span class="trackLabel"><button class="audioMute" data-audio-mute="${esc(track.id)}" title="${track.muted ? 'Ativar' : 'Silenciar'} ${esc(media?.name || 'áudio')}">${track.muted ? '🔇' : '♪'}</button><span>${esc(media?.name || 'Áudio')}</span></span><div class="audioLane"><div class="audioBlock${track.id === st.audioSel ? ' on' : ''}${track.muted ? ' muted' : ''}" data-audio="${esc(track.id)}" style="left:${pctTime(track.start)}%;width:${Math.max(.2, pctTime(end - track.start))}%" role="button" tabindex="0" aria-label="${esc(media?.name || 'Áudio')}: ${fmt(track.start)} a ${fmt(end)}"><span class="audioGrip" data-audio-edge="in"></span><span class="audioWave">${esc(media?.name || 'Áudio')}</span><span class="audioGrip end" data-audio-edge="out"></span></div></div></div>`;
  }).join('');
}

$('#audioTracks').addEventListener('click', event => {
  const mute = event.target.closest('[data-audio-mute]');
  if (mute) {
    const track = st.audioTracks.find(item => item.id === mute.dataset.audioMute);
    if (!track) return;
    const before = beginVideoEdit(); track.muted = !track.muted; syncAudioPreview(true); renderAudioTracks(); recordVideoEdit(before); return;
  }
  const block = event.target.closest('[data-audio]');
  if (block) selectAudio(block.dataset.audio);
});
$('#audioTracks').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.dataset.audio) selectAudio(event.target.dataset.audio);
});
$('#audioTracks').addEventListener('pointerdown', event => {
  const block = event.target.closest('[data-audio]');
  if (!block || event.button !== 0 || st.busy) return;
  const track = st.audioTracks.find(item => item.id === block.dataset.audio);
  if (!track) return;
  event.preventDefault(); event.stopPropagation(); pausePlayback(); if (partSel >= 0) selectPart(-1); selectAudio(track.id, false, true);
  const before = beginVideoEdit(), initial = { ...track }, lane = block.parentElement.getBoundingClientRect();
  const edge = event.target.dataset.audioEdge, x0 = event.clientX, duration = timelineDuration(), span = laneSpan();
  block.setPointerCapture(event.pointerId);
  const move = ev => {
    const dt = (ev.clientX - x0) / lane.width * span;
    if (edge === 'in') {
      // Esticar para a esquerda só até ao início do ficheiro (trimStart nunca negativo): antes
      // continuava para lá dele e a faixa ficava com um trimStart negativo — posição e som errados.
      const next = clamp(initial.start + dt, Math.max(0, initial.start - initial.trimStart), initial.start + audioLength(initial) - .05);
      track.trimStart = initial.trimStart + next - initial.start; track.start = next;
    } else if (edge === 'out') {
      track.trimEnd = clamp(initial.trimEnd + dt, initial.trimStart + .05, libItem(track.mediaId)?.dur || initial.trimEnd);
    } else track.start = clamp(initial.start + dt, 0, Math.max(0, duration - .05));
    const endTime = audioEnd(track);
    block.style.left = `${clamp(track.start / span * 100, 0, 100)}%`;
    block.style.width = `${Math.max(.2, clamp((endTime - track.start) / span * 100, 0, 100))}%`;
    syncAudioPreview(true);
  };
  const end = ev => {
    block.removeEventListener('pointermove', move); block.removeEventListener('pointerup', end); block.removeEventListener('pointercancel', end);
    if (ev.type === 'pointercancel') Object.assign(track, initial);
    renderAudioTracks(); renderTextOpts(); recordVideoEdit(before);
  };
  block.addEventListener('pointermove', move); block.addEventListener('pointerup', end); block.addEventListener('pointercancel', end);
});

// ---------- timeline: interface ----------
// partSel = clip selecionado na faixa de vídeo (−1 = nenhum). É independente do clip a tocar.
let partSel = -1;
function updateTimelineTools() {
  const hasElement = !!elementEditor?.selected();
  const hasAudio = !!audioItem();
  const hasPart = partSel >= 0 && !!st.parts[partSel];
  const removeButton = $('#removeSegment');
  const canDeletePart = hasPart && st.parts.length > 1;
  removeButton.hidden = !(hasElement || hasAudio || hasPart);
  removeButton.disabled = st.busy || !(hasElement || hasAudio || canDeletePart);
  removeButton.querySelector('span').textContent = hasAudio ? 'Apagar áudio' : hasElement ? 'Apagar elemento' : 'Apagar clip';
  removeButton.title = hasAudio ? 'Apagar faixa de áudio (Delete)' : hasElement ? 'Apagar elemento selecionado (Delete)'
    : canDeletePart ? 'Apagar o clip selecionado — o resto encosta (Delete)' : 'É o único clip da faixa';
  removeButton.setAttribute('aria-label', removeButton.title);
  $('#setIn').title = hasAudio ? 'Cortar início do áudio no cursor (I)' : hasElement ? 'Marcar início do elemento selecionado (I)' : 'Cortar o início do clip no cursor (I)';
  $('#setOut').title = hasAudio ? 'Cortar fim do áudio no cursor (O)' : hasElement ? 'Marcar fim do elemento selecionado (O)' : 'Cortar o fim do clip no cursor (O)';
  $('#setIn').setAttribute('aria-label', $('#setIn').title);
  $('#setOut').setAttribute('aria-label', $('#setOut').title);
}
function selectPart(i, { seek = false } = {}) {
  partSel = st.parts[i] ? i : -1;
  if (partSel >= 0) {
    if (st.audioSel) { st.audioSel = null; renderAudioTracks(); }
    if (elementEditor?.selected()) elementEditor.select(null);
  }
  $('#ranges').querySelectorAll('.range').forEach((b) => b.classList.toggle('active', +b.dataset.index === partSel));
  if (seek && partSel >= 0) seekTimelineTime(rangeOffsets()[partSel].editStart);
  updateTimelineTools();
}
function markActivePart() {
  $('#ranges').querySelectorAll('.range').forEach((b) => b.classList.toggle('current', +b.dataset.index === st.activePart));
}

function niceStep(secondsPerTick) {
  return [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s >= secondsPerTick) || 600;
}
const fmtTick = (t) => { const m = Math.floor(t / 60), s = Math.round(t - m * 60); return `${m}:${String(s).padStart(2, '0')}`; };
function renderRuler() {
  const ruler = $('#elementRuler'), span = laneSpan(), pps = laneWidth() / span;
  if (!st.mp4) { ruler.innerHTML = ''; return; }
  const step = niceStep(70 / pps), minor = step / (step >= 10 ? 5 : 2);
  let html = '';
  for (let t = 0; t <= span + 1e-6; t += minor) {
    const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
    html += `<span class="tick${major ? ' major' : ''}" style="left:${(t / span) * 100}%">${major ? fmtTick(t) : ''}</span>`;
  }
  html += `<span class="rulerEnd" style="left:${(timelineDuration() / span) * 100}%" title="Fim do vídeo"></span>`;
  ruler.innerHTML = html;
}

function renderVideoTrack() {
  const wrap = $('#ranges');
  const offs = rangeOffsets();
  wrap.replaceChildren(...offs.map((o, i) => {
    const b = document.createElement('div');
    b.className = 'range' + (o.mediaId ? ' sequenceRange' : '') + (i === partSel ? ' active' : '') + (i === st.activePart ? ' current' : '');
    b.dataset.index = i;
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    const name = partName(st.parts[i]);
    b.title = `${name} ${i + 1}: ${fmt(o.editStart)} – ${fmt(o.editEnd)} (fonte ${fmt(o.start)} – ${fmt(o.end)}) · arrasta para mudar de sítio · puxa as pontas para cortar/recuperar`;
    b.setAttribute('aria-label', b.title);
    b.innerHTML = `<span class="segGrip in" data-seg-edge="in" title="Puxa para cortar ou recuperar o início"></span><span class="segLabel">${esc(name)} · ${fmt(o.end - o.start)}</span><span class="segGrip out" data-seg-edge="out" title="Puxa para cortar ou recuperar o fim"></span>`;
    return b;
  }));
  // Depois do último clip, se um ficheiro for mais longo: o último frame fica parado até ele acabar.
  const tail = tailLength();
  if (tail > 0.02) {
    const t = document.createElement('div');
    t.className = 'tailRange';
    t.style.left = editPct(editDuration());
    t.style.width = editPct(tail);
    t.title = `Último frame parado durante ${fmt(tail)} — um ficheiro na timeline vai até aqui`;
    t.textContent = 'Último frame';
    wrap.append(t);
  }
  layoutVideoTrack();
}
// Só mexe nas posições dos blocos que já existem (serve a meio de um arrastar sem destruir o nó
// agarrado — ver armadilha no CLAUDE.md). span fixo durante o gesto para a escala não saltar.
function layoutVideoTrack(span = laneSpan()) {
  const offs = rangeOffsets();
  $('#ranges').querySelectorAll('.range').forEach((b) => {
    const o = offs[+b.dataset.index];
    if (!o) return;
    b.style.left = `${(o.editStart / span) * 100}%`;
    b.style.width = `${((o.editEnd - o.editStart) / span) * 100}%`;
    const label = b.querySelector('.segLabel');
    if (label) label.textContent = `${partName(st.parts[+b.dataset.index])} · ${fmt(o.end - o.start)}`;
  });
}

function updateTimeline() {
  applyTimelineScale();
  st.activePart = clamp(st.activePart, 0, Math.max(0, st.parts.length - 1));
  if (partSel >= st.parts.length) partSel = -1;
  elementEditor?.renderTracks();
  renderAudioTracks();
  renderRuler();
  renderVideoTrack();
  renderKeys();
  for (const id of ['play', 'setIn', 'setOut', 'splitClip', 'addVideo', 'addAudio', 'tlZoomIn', 'tlZoomOut', 'tlFit', 'tlZoom']) $('#' + id).disabled = !st.mp4 || st.busy;
  syncZoomSlider();
  updateTimelineTools();
  const count = st.parts.length;
  $('#selInfo').textContent = st.mp4 ? `${count} clip${count === 1 ? '' : 's'} · ${timelineDuration().toFixed(1)}s` : '—';
}

let followPlayhead = true;
function updateHead() {
  const editTime = currentTimelineTime();
  $('#tracksHead').style.left = editPct(editTime);
  $('#time').textContent = fmt(editTime);
  const scrub = $('#scrubHandle');
  scrub.setAttribute('aria-valuemax', String(timelineDuration()));
  scrub.setAttribute('aria-valuenow', String(Math.round(editTime * 10) / 10));
  scrub.setAttribute('aria-valuetext', fmt(editTime));
  $('#play').textContent = isPlaying() ? '❚❚' : '▶';
  // A tocar, a vista acompanha o cursor quando ele sai do que se vê (como nos editores).
  if (isPlaying() && followPlayhead && st.mp4) {
    const x = (editTime / laneSpan()) * laneWidth() + TRACK_LABEL_W, left = tracksWrap.scrollLeft, w = tracksWrap.clientWidth;
    if (x > left + w - 30 || x < left + TRACK_LABEL_W) tracksWrap.scrollLeft = x - TRACK_LABEL_W - (w - TRACK_LABEL_W) * 0.2;
  }
}

// Clicar num clip seleciona-o e põe o cursor onde se clicou; arrastar o corpo muda-o de sítio
// (o bloco segue o rato e uma linha mostra onde vai ficar); arrastar uma ponta corta/recupera.
// Pointer capture no próprio bloco e, a meio do gesto, só layoutVideoTrack() (nunca re-render).
$('#ranges').addEventListener('pointerdown', (e) => {
  const block = e.target.closest('.range');
  if (!block || e.button !== 0 || st.busy || !st.mp4) return;
  e.preventDefault();
  e.stopPropagation();
  const i = +block.dataset.index, edge = e.target.dataset.segEdge;
  pausePlayback();
  selectPart(i);
  const before = beginVideoEdit(), initial = structuredClone(st.parts), offs0 = rangeOffsets();
  const span0 = laneSpan(), lane = tl.getBoundingClientRect(), secPerPx = span0 / lane.width, x0 = e.clientX;
  const playhead = currentTimelineTime();
  let moved = false, dropAt = i;
  const marker = $('#dropMarker');
  try { block.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => {
    const dx = ev.clientX - x0;
    if (!moved && Math.abs(dx) < 4) return;
    moved = true;
    const dt = dx * secPerPx;
    if (edge) {
      const p = st.parts[i], p0 = initial[i], o0 = offs0[i];
      if (edge === 'in') {
        // O início fica no mesmo sítio da régua; o que vem a seguir anda (encosta sempre).
        p.start = clamp(p0.start + dt, 0, p0.end - 0.1);
        showPart(i, p.start);
      } else {
        let end = clamp(p0.end + dt, p0.start + 0.1, partMax(p0));
        // Íman no cursor (Alt desliga).
        const editEnd = o0.editStart + (end - p0.start);
        if (!ev.altKey && Math.abs(editEnd - playhead) < 8 * secPerPx) end = clamp(p0.start + (playhead - o0.editStart), p0.start + 0.1, partMax(p0));
        p.end = end;
        showPart(i, p.end - 0.03);
      }
      layoutVideoTrack(span0);
    } else {
      block.style.transform = `translateX(${dx}px)`;
      block.classList.add('dragging');
      const centre = offs0[i].editStart + (offs0[i].editEnd - offs0[i].editStart) / 2 + dt;
      dropAt = offs0.filter((o, n) => n !== i && (o.editStart + o.editEnd) / 2 < centre).length;
      const rest = offs0.filter((o, n) => n !== i);
      let at = 0;
      for (let n = 0; n < dropAt; n++) at += rest[n].editEnd - rest[n].editStart;
      marker.hidden = false;
      marker.style.left = `${(at / span0) * 100}%`;
    }
  };
  const end = (ev) => {
    block.removeEventListener('pointermove', move);
    block.removeEventListener('pointerup', end);
    block.removeEventListener('pointercancel', end);
    if (block.hasPointerCapture(ev.pointerId)) block.releasePointerCapture(ev.pointerId);
    marker.hidden = true;
    block.style.transform = '';
    block.classList.remove('dragging');
    if (ev.type === 'pointercancel') { st.parts = initial; updateTimeline(); return; }
    if (!moved) {
      // Clique: cursor no sítio clicado dentro do clip.
      const o = offs0[i];
      seekTimelineTime(clamp((ev.clientX - lane.left) * secPerPx, o.editStart, Math.max(o.editStart, o.editEnd - 0.001)));
      return;
    }
    if (!edge && dropAt !== i) {
      const [part] = st.parts.splice(i, 1);
      st.parts.splice(dropAt, 0, part);
      partSel = dropAt;
      st.activePart = dropAt;
    }
    updateTimeline();
    if (!edge) seekTimelineTime(rangeOffsets()[partSel].editStart);
    recordVideoEdit(before);
  };
  block.addEventListener('pointermove', move);
  block.addEventListener('pointerup', end);
  block.addEventListener('pointercancel', end);
});
$('#ranges').addEventListener('keydown', (e) => {
  const block = e.target.closest('.range');
  if (block && e.key === 'Enter') { e.preventDefault(); selectPart(+block.dataset.index, { seek: true }); }
});
// Clicar/arrastar no fundo da faixa de vídeo (fora dos clips) mexe só no cursor.
tl.addEventListener('pointerdown', (e) => {
  if (!st.mp4 || e.button !== 0 || e.target.closest('.range, .kf')) return;
  startRulerDrag(e);
});

// Arrastar um ◆ muda o instante dessa posição (sem passar por cima das vizinhas); clique = ir para lá.
function dragKey(e, k, el) {
  e.preventDefault();
  e.stopPropagation();
  pausePlayback();
  const before = beginVideoEdit();
  seekTimelineTime(sourceToEdit(k.t));
  try { el.setPointerCapture(e.pointerId); } catch {}
  const keys = st.crop.keys, i = keys.indexOf(k);
  const lo = i > 0 ? keys[i - 1].t + 0.1 : 0, hi = i < keys.length - 1 ? keys[i + 1].t - 0.1 : st.dur;
  const x0 = e.clientX;
  let moved = false;
  el.classList.add('drag');
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;       // um clique não mexe no ◆
    moved = true;
    const l = locate(tAt(ev.clientX));
    if (!l || st.parts[l.i].mediaId) return;
    k.t = clamp(l.src, lo, hi);
    el.style.left = pct(k.t);
    showPart(l.i, k.t);                                       // vês a moldura nesse instante
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.classList.remove('drag');
    if (moved) { renderOpts(); renderKeys(); recordVideoEdit(before); }
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

function renderKeys() {
  const wrap = $('#keys');
  wrap.innerHTML = '';
  if (st.layout !== 'crop') return;
  for (const k of st.crop.keys) {
    const d = document.createElement('div');
    d.className = 'kf' + (k.path ? ' path' : '');
    d.style.left = pct(k.t);
    d.title = `Posição em ${fmt(k.t)} · arrasta para mudar o instante · botão direito apaga`;
    d.addEventListener('pointerdown', (e) => { if (e.button === 0) dragKey(e, k, d); else e.stopPropagation(); });
    const del = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const before = beginVideoEdit();
      st.crop.keys.splice(st.crop.keys.indexOf(k), 1);
      renderOpts();
      renderKeys();
      recordVideoEdit(before);
    };
    d.addEventListener('contextmenu', del);         // botão direito
    d.addEventListener('dblclick', del);
    wrap.appendChild(d);
  }
}

function seekTimelineTime(time) {
  if (time > editDuration() + 1e-3 && tailLength() > 0) {
    pausePlayback();
    enterTail(Math.min(time, timelineDuration()), false);
    elementEditor?.update();
    updateHead();
    return;
  }
  tailTime = null; tailPlay = null;
  const l = locate(time);
  if (!l) return;
  // A tocar e dentro do mesmo clip do vídeo principal, continua a tocar; senão pára.
  if (!(isPlaying() && l.i === st.activePart && !st.parts[l.i].mediaId)) pausePlayback();
  showPart(l.i, l.src);
  elementEditor?.update();
  updateHead();
}
function seekOnRuler(clientX) { seekTimelineTime(tAt(clientX)); }
function startRulerDrag(e) {
  if (!st.mp4 || st.busy || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  pausePlayback();
  const target = e.currentTarget;
  target.setPointerCapture(e.pointerId);
  seekOnRuler(e.clientX);
  const move = ev => seekOnRuler(ev.clientX);
  const end = () => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', end);
    target.removeEventListener('pointercancel', end);
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', end);
  target.addEventListener('pointercancel', end);
}
$('#elementRuler').addEventListener('pointerdown', startRulerDrag);
$('#scrubHandle').addEventListener('pointerdown', startRulerDrag);
$('#scrubHandle').addEventListener('keydown', e => {
  if (!st.mp4 || st.busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  pausePlayback();
  const step = e.shiftKey ? 1 : 1 / (st.mp4.fps || 30), current = currentTimelineTime();
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? timelineDuration() : current + (e.key === 'ArrowLeft' ? -step : step);
  seekTimelineTime(clamp(next, 0, timelineDuration()));
});
// Zoom da timeline: botões, Ctrl+roda (à volta do rato). A roda sozinha desloca (Shift = para os lados).
$('#tlZoomIn').addEventListener('click', () => zoomTimeline(1.5));
$('#tlZoomOut').addEventListener('click', () => zoomTimeline(1 / 1.5));
$('#tlFit').addEventListener('click', fitTimeline);
// Roda do rato em qualquer sítio da timeline = zoom à volta do rato (a "pinça" do trackpad chega
// como Ctrl+roda, também dá). Shift+roda = andar para os lados; Alt+roda = subir/descer nas faixas
// (quando há muitas). O deslizar horizontal do trackpad desloca normalmente.
tracksWrap.addEventListener('wheel', (e) => {
  if (!st.mp4) return;
  if (e.altKey) { e.preventDefault(); tracksWrap.scrollTop += e.deltaY; return; }
  if (e.shiftKey) { e.preventDefault(); tracksWrap.scrollLeft += e.deltaY || e.deltaX; return; }
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
  e.preventDefault();
  zoomTimeline(Math.exp(-clamp(e.deltaY, -120, 120) / 400), e.clientX);
}, { passive: false });
$('#tlZoom').addEventListener('input', (e) => {
  const { lo, hi } = zoomRange(), target = lo * Math.pow(hi / lo, +e.target.value / 100);
  zoomTimeline(target / (pxPerSec || fitPxPerSec()));
});
new ResizeObserver(() => { if (st.mp4) updateTimeline(); }).observe(tracksWrap);

// Cortar o clip debaixo do cursor no cursor (I = tira o que está antes, O = o que está depois).
function trimPartAtPlayhead(edge) {
  const l = locate(currentTimelineTime());
  if (!l) return;
  const p = st.parts[l.i];
  if (edge === 'in' ? l.src >= p.end - 0.1 : l.src <= p.start + 0.1) return;
  const before = beginVideoEdit();
  if (edge === 'in') p.start = l.src; else p.end = l.src;
  updateTimeline();
  showPart(l.i, edge === 'in' ? p.start : Math.max(p.start, p.end - 0.03));
  recordVideoEdit(before);
}
$('#setIn').addEventListener('click', () => {
  if (!st.mp4 || st.busy) return;
  if (audioItem()) {
    const track = audioItem(), t = currentTimelineTime();
    if (t < track.start || t >= audioEnd(track) - .05) return;
    const before = beginVideoEdit(); track.trimStart += t - track.start; track.start = t;
    renderAudioTracks(); renderTextOpts(); recordVideoEdit(before); return;
  }
  if (elementEditor?.selected()) { elementEditor.trimSelected('in'); return; }
  trimPartAtPlayhead('in');
});
$('#setOut').addEventListener('click', () => {
  if (!st.mp4 || st.busy) return;
  if (audioItem()) {
    const track = audioItem(), t = currentTimelineTime();
    if (t <= track.start + .05 || t > audioEnd(track)) return;
    const before = beginVideoEdit(); track.trimEnd = track.trimStart + t - track.start;
    renderAudioTracks(); renderTextOpts(); recordVideoEdit(before); return;
  }
  if (elementEditor?.selected()) { elementEditor.trimSelected('out'); return; }
  trimPartAtPlayhead('out');
});
// Dividir no cursor: o clip debaixo do cursor passa a dois, encostados.
function splitPart() {
  if (!st.mp4 || st.busy) return false;
  const l = locate(currentTimelineTime());
  if (!l) return false;
  const p = st.parts[l.i];
  if (l.src <= p.start + 0.1 || l.src >= p.end - 0.1) {
    setStatus('Coloca o cursor dentro de um clip, afastado das pontas, para o dividir.');
    return false;
  }
  const before = beginVideoEdit();
  st.parts.splice(l.i, 1, { ...p, end: l.src }, { ...p, start: l.src });
  partSel = l.i + 1;
  st.activePart = l.i + 1;
  updateTimeline();
  recordVideoEdit(before);
  return true;
}
// Duplicar: uma cópia inteira do clip logo a seguir a ele (o resto anda para a frente).
function duplicatePart(index = partSel >= 0 ? partSel : st.activePart) {
  if (!st.mp4 || st.busy) return;
  const p = st.parts[index];
  if (!p) return;
  const before = beginVideoEdit();
  st.parts.splice(index + 1, 0, { ...p });
  partSel = index + 1;
  updateTimeline();
  seekTimelineTime(rangeOffsets()[index + 1].editStart);
  recordVideoEdit(before);
  setStatus(`${partName(p)} duplicado a seguir ao original.`);
}
// Apagar: tira o clip e o resto encosta (sem buracos).
function deletePart(index = partSel) {
  if (!st.mp4 || st.busy || !st.parts[index]) return;
  if (st.parts.length < 2) { setStatus('É o único clip da faixa — para o encurtar, puxa as pontas.'); return; }
  const before = beginVideoEdit(), at = rangeOffsets()[index].editStart;
  st.parts.splice(index, 1);
  partSel = -1;
  updateTimeline();
  seekTimelineTime(Math.min(at, Math.max(0, timelineDuration() - 0.01)));
  recordVideoEdit(before);
}
function restoreFullVideo() {
  if (!st.mp4 || st.busy) return;
  const before = beginVideoEdit();
  st.parts = [{ start: 0, end: st.dur }, ...st.parts.filter((p) => p.mediaId)];
  partSel = -1;
  pausePlayback();
  updateTimeline();
  seekTimelineTime(0);
  recordVideoEdit(before);
}
function splitSelection() {
  if (audioItem()) {
    if (!splitAudio()) setStatus('Coloca o cursor dentro da música, afastado das pontas, para a dividir.');
  } else if (elementEditor?.selected()) {
    if (!elementEditor.splitSelected()) setStatus('Coloca o cursor dentro do elemento, afastado das pontas, para o dividir.');
  } else splitPart();
}
$('#splitClip').addEventListener('click', splitSelection);
$('#removeSegment').addEventListener('click', () => {
  if (audioItem()) removeAudio();
  else if (elementEditor?.selected()) elementEditor.remove();
  else deletePart();
});
const videoMenu = $('#videoContextMenu');
let videoMenuTarget = null;
function closeVideoMenu(restoreFocus = false) {
  videoMenu.hidden = true;
  if (videoMenu.contains(document.activeElement)) document.activeElement.blur();
  if (restoreFocus && videoMenuTarget) tl.querySelector('.range.active')?.focus();
  videoMenuTarget = null;
}
function showVideoMenu(e) {
  const target = e.target.closest('.range');
  if (!target || !st.mp4 || st.busy) return;
  e.preventDefault();
  e.stopPropagation();
  const index = +target.dataset.index, o = rangeOffsets()[index];
  if (!o) return;
  pausePlayback();
  selectPart(index);
  if (e.clientX) seekTimelineTime(clamp(tAt(e.clientX), o.editStart, Math.max(o.editStart, o.editEnd - 0.001)));
  videoMenuTarget = { index };
  const t = currentTimelineTime();
  const splitAction = videoMenu.querySelector('[data-video-action="split"]');
  splitAction.disabled = t <= o.editStart + .1 || t >= o.editEnd - .1;
  splitAction.title = splitAction.disabled ? 'Clica mais longe das pontas para dividir' : '';
  videoMenu.querySelector('[data-video-action="delete"]').disabled = st.parts.length < 2;
  videoMenu.querySelector('[data-video-action="openSegment"]').hidden = !!o.mediaId;
  videoMenu.querySelector('[data-video-action="restoreAll"]').hidden = !(st.parts.length > 1 || st.parts[0]?.start > .05 || st.parts[0]?.end < st.dur - .05);
  videoMenu.hidden = false;
  const rect = target.getBoundingClientRect(), x = e.clientX || rect.left + rect.width / 2, y = e.clientY || rect.bottom;
  videoMenu.style.left = `${clamp(x, 8, innerWidth - videoMenu.offsetWidth - 8)}px`;
  videoMenu.style.top = `${clamp(y, 8, innerHeight - videoMenu.offsetHeight - 8)}px`;
  videoMenu.querySelector('button:not([hidden]):not(:disabled)')?.focus();
}
tl.addEventListener('contextmenu', showVideoMenu);
tl.addEventListener('keydown', e => {
  if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) showVideoMenu(e);
});
videoMenu.addEventListener('click', e => {
  const action = e.target.closest('[data-video-action]')?.dataset.videoAction;
  const target = videoMenuTarget;
  if (!action || !target) return;
  closeVideoMenu();
  if (action === 'split') splitPart();
  else if (action === 'duplicate') duplicatePart(target.index);
  else if (action === 'openSegment') openSegmentInNewTab(st.parts[target.index]);
  else if (action === 'delete') deletePart(target.index);
  else if (action === 'restoreAll') restoreFullVideo();
  tl.querySelector('.range.active')?.focus();
});
videoMenu.addEventListener('keydown', e => {
  e.stopPropagation();
  if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeVideoMenu(true); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const buttons = [...videoMenu.querySelectorAll('button:not([hidden]):not(:disabled)')], index = buttons.indexOf(document.activeElement);
    buttons[(index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  }
});
document.addEventListener('pointerdown', e => { if (!videoMenu.contains(e.target)) closeVideoMenu(); });
document.addEventListener('scroll', () => closeVideoMenu(), true);
addEventListener('resize', () => closeVideoMenu());

$('#play').addEventListener('click', togglePlay);
function togglePlay() {
  if (!st.mp4) return;
  if (isPlaying()) { pausePlayback(); return; }
  // No fim do vídeo, o play recomeça do princípio.
  if (currentTimelineTime() >= timelineDuration() - 0.05) seekTimelineTime(0);
  if (tailTime != null) { enterTail(tailTime, true); return; }
  const part = st.parts[st.activePart];
  if (!part) return;
  showPart(st.activePart, activeVideo().currentTime, true);
}
const LAYOUT_KEYS = ['streamer', 'crop', 'blur', 'original'];
const seekBy = (dt) => {
  if (!st.mp4) return;
  pausePlayback();
  seekTimelineTime(clamp(currentTimelineTime() + dt, 0, timelineDuration()));
};
document.addEventListener('keydown', (e) => {
  if (e.target.closest('dialog, [role="menu"]')) return;
  if (marking && e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); stopMarking('Seguimento cancelado.'); return; }
  if (st.busy) return;
  const t = e.target;
  if (t.matches?.('input:not([type=range]), select, textarea') || t.isContentEditable) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'b') { e.preventDefault(); e.stopImmediatePropagation(); splitSelection(); return; }
  if ((e.ctrlKey || e.metaKey) && k === 'd' && partSel >= 0 && !elementEditor?.selected()) { e.preventDefault(); e.stopImmediatePropagation(); duplicatePart(); return; }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === 'delete' || k === 'backspace') && audioItem()) { e.preventDefault(); e.stopImmediatePropagation(); removeAudio(); return; }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && (k === 'delete' || k === 'backspace') && !elementEditor?.selected() && partSel >= 0) { e.preventDefault(); e.stopImmediatePropagation(); deletePart(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (t.type === 'range' && k.startsWith('arrow')) return;          // as setas mexem no controlo
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (k === 'i') $('#setIn').click();
  else if (k === 'o') $('#setOut').click();
  else if (k === 'k') { e.preventDefault(); togglePlay(); }
  else if (k === 'p' && !e.shiftKey && !e.repeat && st.mp4 && st.layout === 'crop' && !marking && !tracking) { e.preventDefault(); $('#addCropKey')?.click(); }
  else if (k === 'e') { e.preventDefault(); exportClip({ tiktok: e.shiftKey }); }   // sem isto o «E» ia parar à descrição
  else if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); seekBy((k === 'arrowleft' ? -1 : 1) / (st.mp4?.fps || 30)); }
  else if (k === 'j' || k === 'l') seekBy(k === 'j' ? -1 : 1);
  else if (k === 'escape') selectZone(null);
  else if (k === '+' || k === '=') zoomTimeline(1.5);
  else if (k === '-') zoomTimeline(1 / 1.5);
  else if (LAYOUT_KEYS[+k - 1]) setLayout(LAYOUT_KEYS[+k - 1]);
});
// Depois de clicar num botão/controlo, o teclado volta aos atalhos (o espaço não "clica" outra vez).
document.addEventListener('pointerup', () => {
  const a = document.activeElement;
  if (a?.matches?.('button, input[type=range]')) setTimeout(() => a.blur(), 0);
});

// ---------- painel de opções ----------
function setLayout(l, record = false) {
  const before = record && st.mp4 && !st.busy ? beginVideoEdit() : null;
  previewZone = null;
  st.layout = l;
  try { localStorage.setItem('sc.layout', l); } catch {}
  for (const b of document.querySelectorAll('.layout')) { b.classList.toggle('on', b.dataset.l === l); b.setAttribute('aria-pressed', b.dataset.l === l); }
  syncMediaTime();
  sizeResult();
  buildRects();
  renderOpts();
  renderTextOpts();
  renderKeys();
  if (before) recordVideoEdit(before);
}
for (const b of document.querySelectorAll('.layout')) b.addEventListener('click', () => setLayout(b.dataset.l, true));

function renderOpts() {
  const o = $('#opts');
  const hint = $('#hint');
  if (st.layout === 'crop') {
    const keys = st.crop.keys;
    // As posições em si já se veem e mexem na barra de baixo (◆): arrasta para mudar o instante,
    // clique vai para lá, botão direito/duplo clique apaga. A lista aqui era a mesma informação
    // duas vezes — só ficam os botões que não têm equivalente na timeline.
    o.innerHTML = `<div class="opt cropOpt">
      <h2>Moldura</h2>
      <div class="cropActions">
        <button id="addCropKey" class="btn small" aria-keyshortcuts="P" title="Posição aqui (P) — guarda a posição da moldura neste instante. Avança no vídeo e adiciona outra para animar." ${!st.mp4 || st.busy || marking || tracking ? 'disabled' : ''}>◆ Posição aqui <kbd>P</kbd></button>
        ${keys.length ? '<button id="clearKeys" class="btn small danger" title="Apagar todas as posições da moldura" aria-label="Apagar todas as posições da moldura">✕</button>' : ''}
      </div>
      ${tracking ? '<button id="trackStop" class="btn small danger">■ Parar</button>' : `<button id="trackStart" class="btn small primary" title="Marca um alvo no vídeo original para a moldura o seguir até ao fim do clip." ${marking ? 'disabled' : ''}>🎯 ${marking ? 'Marca no original…' : 'Seguir alvo'}</button>${marking ? ' <button id="trackCancel" class="btn small">Cancelar</button>' : ''}`}
    </div>`;
    o.querySelector('#trackStart')?.addEventListener('click', startMarking);
    o.querySelector('#trackCancel')?.addEventListener('click', () => stopMarking());
    o.querySelector('#trackStop')?.addEventListener('click', () => { trackAbort = true; });
    o.querySelector('#addCropKey').addEventListener('click', () => {
      const before = beginVideoEdit(), cur = cropAt(video.currentTime);
      addCropKeyAt(video.currentTime, { x: cur.x, y: cur.y, w: cur.w });
      recordVideoEdit(before);
    });
    o.querySelector('#clearKeys')?.addEventListener('click', () => { const before = beginVideoEdit(); keys.length = 0; renderOpts(); renderKeys(); recordVideoEdit(before); });
    hint.textContent = 'Seleciona a moldura para enquadrar · P adiciona posição.';
  } else if (st.layout === 'streamer') {
    renderStreamerOpts(o);
    hint.textContent = 'No resultado: arrasta a câmara ou a parte de baixo para enquadrar, roda do rato = zoom. No original também dá para mexer nas caixas.';
  } else if (st.layout === 'blur') {
    renderFramingOpts(o);
    hint.textContent = 'Arrasta o vídeo para enquadrar e usa a roda do rato ou o controlo de zoom para aproximar.';
  } else {
    renderFramingOpts(o);
    hint.textContent = 'Mantém o formato original. Amplia e arrasta o vídeo para enquadrar.';
  }
}

// ---------- streamer: imagem/vídeo da biblioteca em baixo ----------
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// As escolhas do modo Streamer ficam para o próximo clip.
function savePrefs() {
  const { split, bottom, mediaId, scale, ox, oy } = st.streamer;
  try { localStorage.setItem('sc.streamer', JSON.stringify({ split, bottom, mediaId, scale, ox, oy })); } catch {}
}
try { Object.assign(st.streamer, JSON.parse(localStorage.getItem('sc.streamer') || '{}')); } catch {}

// Tamanho que faz a imagem caber inteira (1 = encher a zona de baixo, cortando o que sobra).
function containScale(m) {
  const dw = OUT_V.w, dh = OUT_V.h - camH(OUT_V.h);
  return Math.min(dw / m.w, dh / m.h) / Math.max(dw / m.w, dh / m.h);
}

function libItemHtml(m) {
  const kind = isGif(m) ? 'GIF' : m.type === 'video' ? `▶ ${Math.round(m.dur || 0)}s` : 'img';
  return `<div class="it${m.id === st.streamer.mediaId ? ' on' : ''}" data-mid="${m.id}" title="${esc(m.name)} — clica para usar" style="background-image:url(${m.thumb})">` +
    `<span class="kind">${kind}</span><button class="del" data-del="${m.id}" title="Apagar da biblioteca">✕</button></div>`;
}

function renderStreamerOpts(o) {
  const s = st.streamer, media = s.bottom === 'media';
  o.innerHTML = `<div class="opt">
    <h2>Em baixo</h2>
    <div class="seg"><button data-b="game"${media ? '' : ' class="on"'}>🎮 Jogo</button><button data-b="media"${media ? ' class="on"' : ''}>🖼 Imagem / vídeo</button></div>
    ${media ? `
    <label>Tamanho <input id="mScale" type="range" min="0.2" max="2" step="0.01" value="${s.scale}"> <span class="mono" id="mScaleV">${Math.round(s.scale * 100)}%</span></label>
    <div class="row"><button class="btn small" data-fit="cover">Encher</button><button class="btn small" data-fit="contain">Inteiro</button><button class="btn small" id="mCenter">Centrar</button></div>
    <h2>Biblioteca <span class="sub">(vídeos e imagens guardados)</span></h2>
    <div class="lib">${st.library.filter(item => item.type !== 'audio' && !item.sequenceOnly).map(libItemHtml).join('')}<label class="add" title="Adicionar vídeos/imagens">+<input id="libAdd" type="file" accept="image/*,video/*" multiple hidden></label></div>` : ''}
  </div>`;

  o.querySelectorAll('[data-b]').forEach((b) => b.addEventListener('click', () => {
    const before = beginVideoEdit();
    s.bottom = b.dataset.b;
    savePrefs();
    buildRects();
    renderOpts();
    syncMediaTime();
    recordVideoEdit(before);
  }));
  if (!media) return;
  const setScale = setMediaScale;
  const scaleInput = o.querySelector('#mScale');
  let scaleBefore = null;
  scaleInput.addEventListener('pointerdown', () => { scaleBefore = beginVideoEdit(); });
  scaleInput.addEventListener('keydown', () => { if (!scaleBefore) scaleBefore = beginVideoEdit(); });
  scaleInput.addEventListener('input', (e) => setScale(+e.target.value));
  scaleInput.addEventListener('change', () => { if (scaleBefore) recordVideoEdit(scaleBefore); scaleBefore = null; });
  o.querySelectorAll('[data-fit]').forEach((b) => b.addEventListener('click', () => {
    const m = libItem(s.mediaId);
    if (!m) return;
    const before = beginVideoEdit();
    s.ox = s.oy = 0;
    setScale(b.dataset.fit === 'cover' ? 1 : containScale(m));
    recordVideoEdit(before);
  }));
  o.querySelector('#mCenter').addEventListener('click', () => { const before = beginVideoEdit(); s.ox = s.oy = 0; savePrefs(); recordVideoEdit(before); });
  o.querySelectorAll('.lib .it').forEach((it) => it.addEventListener('click', (e) => {
    if (e.target.closest('.del')) return;
    const before = beginVideoEdit();
    Object.assign(s, { mediaId: it.dataset.mid, scale: 1, ox: 0, oy: 0 });
    savePrefs();
    renderOpts();
    syncMediaTime();
    recordVideoEdit(before);
  }));
  o.querySelectorAll('.lib .del').forEach((b) => b.addEventListener('click', () => removeLibraryFile(b.dataset.del)));
  o.querySelector('#libAdd').addEventListener('change', (e) => addToLibrary([...e.target.files]));
}

// Arrastar a imagem/vídeo no Resultado muda a posição; a roda do rato muda o tamanho.
const mediaMode = () => st.layout === 'streamer' && st.streamer.bottom === 'media' && !!libItem(st.streamer.mediaId);
// Zona do resultado debaixo do rato: câmara/jogo/moldura (enquadra o clip) ou a imagem/vídeo.
function zoneAt(e) {
  const r = preview.getBoundingClientRect(), s = st.streamer;
  if (!st.mp4 || st.busy) return null;
  if (st.layout === 'crop') return { id: 'crop', r, h: 1 };
  if (st.framing[st.layout]) return { id: 'framing', r, h: 1 };
  if (st.layout !== 'streamer') return null;
  if ((e.clientY - r.top) / r.height < s.split) return { id: 'cam', r, h: s.split };
  if (s.bottom === 'media') return mediaMode() ? { id: 'media', r, h: 1 - s.split } : null;
  return { id: 'game', r, h: 1 - s.split };
}

function setZoneRect(id, r) {
  if (id === 'crop') updateCropKey(video.currentTime, r);
  else { setRect(id, r); rememberCam(); }
  placeRects();
}

function setMediaScale(v) {
  const s = st.streamer;
  s.scale = clamp(v, 0.2, 2);
  const inp = $('#mScale');
  if (inp) { inp.value = s.scale; $('#mScaleV').textContent = Math.round(s.scale * 100) + '%'; }
  savePrefs();
}

function setSplit(value) {
  const s = st.streamer;
  const centers = ['cam', 'game'].map(id => {
    const reg = regionById(id), r = s[id];
    return r && reg ? { id, x: r.x + r.w / 2, y: r.y + rectH(r, reg.aspect) / 2 } : null;
  }).filter(Boolean);
  s.split = clamp(value, .2, .5);
  for (const c of centers) {
    const aspect = regionById(c.id).aspect, r = fitRect(s[c.id], aspect);
    s[c.id] = fitRect({ ...r, x: c.x - r.w / 2, y: c.y - rectH(r, aspect) / 2 }, aspect);
  }
  placeRects(); updateSplitUi(); savePrefs(); rememberCam();
}

// ---------- resultado: vista (zoom/deslocar) e zona selecionada ----------
// A roda do rato faz zoom da VISTA (para ver pormenores) e arrastar sem nada selecionado desloca-a.
// Para mexer no enquadramento, clica-se primeiro numa zona (câmara/jogo/moldura…): aparece a
// moldura dela com pegas; aí arrastar dentro dela enquadra e as pegas (ou a roda dentro dela) fazem
// zoom do conteúdo. Esc ou clicar noutro sítio sem zona tira a seleção.
const ZONE_LABELS = { cam: 'Câmara', game: 'Jogo', media: 'Imagem / vídeo', crop: 'Moldura 9:16', framing: 'Enquadramento' };
function applyView() {
  const W = resultBox.clientWidth, H = resultBox.clientHeight;
  view.z = clamp(view.z, 1, 8);
  view.x = clamp(view.x, W - W * view.z, 0);
  view.y = clamp(view.y, H - H * view.z, 0);
  resultView.style.transform = view.z > 1.001 ? `translate(${view.x}px, ${view.y}px) scale(${view.z})` : '';
  resultBox.style.setProperty('--vz', view.z);
  resultBox.classList.toggle('zoomed', view.z > 1.001);
  $('#viewZoom').hidden = view.z <= 1.001;
  $('#viewZoomV').textContent = Math.round(view.z * 100) + '%';
}
function zoomView(factor, clientX, clientY) {
  const r = resultBox.getBoundingClientRect();
  const px = (clientX ?? r.left + r.width / 2) - r.left, py = (clientY ?? r.top + r.height / 2) - r.top;
  const z1 = clamp(view.z * factor, 1, 8), k = z1 / view.z;
  view.x = px - (px - view.x) * k;
  view.y = py - (py - view.y) * k;
  view.z = z1;
  applyView();
}
function resetView() { view.z = 1; view.x = view.y = 0; applyView(); }
$('#viewZoomIn').addEventListener('click', () => zoomView(1.4));
$('#viewZoomOut').addEventListener('click', () => zoomView(1 / 1.4));
$('#viewZoomReset').addEventListener('click', resetView);
new ResizeObserver(applyView).observe(resultBox);

function zoneValid(id) {
  if (!id || !st.mp4) return false;
  if (id === 'crop') return st.layout === 'crop';
  if (id === 'framing') return !!st.framing[st.layout];
  if (st.layout !== 'streamer') return false;
  if (id === 'cam') return true;
  if (id === 'game') return st.streamer.bottom !== 'media';
  return id === 'media' && mediaMode();
}
function selectZone(id) {
  previewZone = zoneValid(id) ? id : null;
  if (previewZone && elementEditor?.selected()) elementEditor.select(null);
  updateSplitUi();
}

function updateSplitUi() {
  const visible = st.layout === 'streamer' && !!st.mp4 && !st.busy && !st.textSel;
  const divider = $('#splitDivider'), frame = $('#zoneFrame');
  divider.hidden = !visible;
  divider.style.top = `${st.streamer.split * 100}%`;
  divider.setAttribute('aria-valuenow', Math.round(st.streamer.split * 100));
  $('#splitDividerValue').textContent = Math.round(st.streamer.split * 100) + '%';
  if (previewZone && !zoneValid(previewZone)) previewZone = null;
  frame.hidden = !previewZone || st.busy || !!st.textSel;
  if (frame.hidden) return;
  const s = st.streamer.split;
  const [top, height] = previewZone === 'cam' ? [0, s] : ['game', 'media'].includes(previewZone) ? [s, 1 - s] : [0, 1];
  frame.style.top = `${top * 100}%`;
  frame.style.height = `${height * 100}%`;
  frame.dataset.zone = previewZone;
  $('#zoneLabel').textContent = ZONE_LABELS[previewZone] + ' · arrasta para enquadrar';
}

$('#splitDivider').addEventListener('pointerdown', e => {
  if (e.button !== 0 || st.busy) return;
  const before = beginVideoEdit();
  e.preventDefault(); pausePlayback();
  const target = e.currentTarget, initial = structuredClone(st.streamer), r = preview.getBoundingClientRect();
  const startY = e.clientY;
  target.setPointerCapture(e.pointerId);
  const move = ev => {
    let value = initial.split + (ev.clientY - startY) / r.height;
    if (!ev.altKey) value = [.25, .4, .5].find(p => Math.abs(p - value) < .008) ?? value;
    setSplit(value);
  };
  const end = ev => {
    target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end);
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
    if (ev.type === 'pointercancel') { Object.assign(st.streamer, initial); setSplit(initial.split); }
    else recordVideoEdit(before);
  };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
});
$('#splitDivider').addEventListener('dblclick', () => { if (st.busy) return; const before = beginVideoEdit(); setSplit(Math.abs(st.streamer.split - .4) < .005 ? .5 : .4); recordVideoEdit(before); });
$('#splitDivider').addEventListener('keydown', e => {
  if (st.busy) return;
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
    e.preventDefault(); e.stopPropagation();
    const before = beginVideoEdit();
    setSplit(e.key === 'Home' ? .2 : e.key === 'End' ? .5 : st.streamer.split + (e.key === 'ArrowDown' ? 1 : -1) * (e.shiftKey ? .05 : .01));
    recordVideoEdit(before);
  }
});

// Zoom do conteúdo da zona selecionada (factor > 1 = mais perto).
function zoomZoneContent(id, factor, initial = null) {
  if (id === 'framing') { const f = initial?.framing || st.framing[st.layout]; setFraming(f.scale * factor, f.ox, f.oy); return; }
  if (id === 'media') { setMediaScale((initial?.scale ?? st.streamer.scale) * factor); return; }
  const aspect = regionById(id).aspect, r0 = initial?.rect || rectFor(id, video.currentTime), h0 = rectH(r0, aspect);
  const w = r0.w / factor, h = rectH({ w }, aspect);
  setZoneRect(id, fitRect({ x: r0.x + (r0.w - w) / 2, y: r0.y + (h0 - h) / 2, w }, aspect));
}
// Pegas da moldura da zona: puxar para fora = mais zoom, para dentro = menos.
$('#zoneFrame').addEventListener('pointerdown', e => {
  if (!e.target.dataset.corner || e.button !== 0 || st.busy || !previewZone) return;
  const before = beginVideoEdit(), z = previewZone;
  e.preventDefault(); e.stopPropagation(); pausePlayback();
  const target = e.target;
  const box = $('#zoneFrame').getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const dx = e.clientX - cx, dy = e.clientY - cy;
  const initial = { framing: z === 'framing' ? { ...st.framing[st.layout] } : null, scale: st.streamer.scale,
    rect: ['cam', 'game', 'crop'].includes(z) ? { ...rectFor(z, video.currentTime) } : null, streamer: structuredClone(st.streamer) };
  target.setPointerCapture(e.pointerId);
  const move = ev => {
    const factor = clamp(((ev.clientX - cx) * dx + (ev.clientY - cy) * dy) / (dx * dx + dy * dy), .1, 10);
    zoomZoneContent(z, factor, initial);
  };
  const end = ev => {
    target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end);
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
    if (ev.type === 'pointercancel') restoreVideoEdit(before);
    else recordVideoEdit(before);
  };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
});

preview.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const z = zoneAt(e), onSelected = z && z.id === previewZone;
  preview.classList.toggle('edit', !!onSelected);
  preview.classList.toggle('pan', !onSelected && view.z > 1.001);
  preview.classList.toggle('pick', !onSelected && view.z <= 1.001 && !!z);
  preview.title = onSelected ? 'Arrasta para enquadrar · roda = zoom da zona · Esc = largar'
    : z ? 'Clica para editar esta zona · roda = zoom da vista' + (view.z > 1.001 ? ' · arrasta para andar' : '')
    : 'Roda = zoom da vista';
});

preview.addEventListener('pointerdown', (e) => {
  if (!st.mp4 || st.busy || (e.button !== 0 && e.button !== 1)) return;
  const z = zoneAt(e);
  document.activeElement?.blur();
  e.preventDefault();
  try { preview.setPointerCapture(e.pointerId); } catch {}
  const x0 = e.clientX, y0 = e.clientY;
  let move, up;
  if (e.button === 0 && z && z.id === previewZone) {
    // Zona selecionada: arrastar enquadra (como antes).
    const before = beginVideoEdit(), s = st.streamer;
    const framingInitial = z.id === 'framing' ? { ...st.framing[st.layout] } : null;
    pausePlayback();
    if (framingInitial) {
      move = ev => setFraming(framingInitial.scale,
        framingInitial.ox + (ev.clientX - x0) / z.r.width,
        framingInitial.oy + (ev.clientY - y0) / z.r.height);
    } else if (z.id === 'media') {
      const ox0 = s.ox, oy0 = s.oy;
      move = (ev) => {
        s.ox = clamp(ox0 + (ev.clientX - x0) / z.r.width, -1.5, 1.5);
        s.oy = clamp(oy0 + (ev.clientY - y0) / (z.r.height * z.h), -1.5, 1.5);
      };
    } else {
      // Arrastar o conteúdo para a direita = a zona no original anda para a esquerda.
      const aspect = regionById(z.id).aspect, r0 = { ...rectFor(z.id, video.currentTime) }, h0 = rectH(r0, aspect);
      drag = { id: z.id, rect: r0 };
      move = (ev) => {
        const dx = (ev.clientX - x0) / z.r.width, dy = (ev.clientY - y0) / (z.r.height * z.h);
        drag.rect = fitRect({ x: r0.x - dx * r0.w, y: r0.y - dy * h0, w: r0.w }, aspect);
      };
    }
    up = (ev) => {
      if (framingInitial) {
        if (ev.type === 'pointercancel') setFraming(framingInitial.scale, framingInitial.ox, framingInitial.oy);
        else recordVideoEdit(before);
        return;
      }
      if (z.id === 'media') { savePrefs(); recordVideoEdit(before); return; }
      const r = drag.rect;
      drag = null;
      setZoneRect(z.id, r);
      recordVideoEdit(before);
    };
  } else {
    // Sem zona selecionada (ou outra zona / botão do meio): arrastar desloca a vista com zoom;
    // um clique simples seleciona a zona debaixo do rato.
    const vx0 = view.x, vy0 = view.y;
    let moved = false;
    move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      moved = true;
      if (view.z > 1.001) { view.x = vx0 + ev.clientX - x0; view.y = vy0 + ev.clientY - y0; applyView(); preview.classList.add('panning'); }
    };
    up = () => {
      preview.classList.remove('panning');
      if (!moved && e.button === 0 && !e.scDeselected) selectZone(z?.id ?? null);
    };
  }
  const finish = (ev) => {
    preview.removeEventListener('pointermove', move);
    preview.removeEventListener('pointerup', finish);
    preview.removeEventListener('pointercancel', finish);
    up(ev);
  };
  preview.addEventListener('pointermove', move);
  preview.addEventListener('pointerup', finish);
  preview.addEventListener('pointercancel', finish);
});
preview.addEventListener('dblclick', (e) => {
  if (e.defaultPrevented || !st.mp4) return;
  if (view.z > 1.001) resetView();
});

preview.addEventListener('wheel', (e) => {
  if (!st.mp4 || drag) return;
  e.preventDefault();
  const z = zoneAt(e), zoomIn = e.deltaY < 0;
  if (z && z.id === previewZone && !st.busy) {
    // Dentro da zona selecionada: zoom do conteúdo.
    const before = beginVideoEdit();
    zoomZoneContent(z.id, zoomIn ? 1.06 : 1 / 1.06);
    recordVideoEdit(before);
    return;
  }
  zoomView(zoomIn ? 1.15 : 1 / 1.15, e.clientX, e.clientY);
}, { passive: false });

// ---------- editar texto diretamente no resultado ----------
// Duplo clique num texto (ou Enter com ele selecionado, ou um texto novo): aparece uma caixa de
// escrita por cima dele, com a mesma letra/tamanho/alinhamento. O texto continua a ser desenhado
// pelo canvas (a caixa só mostra o cursor e a seleção), por isso vês logo o resultado final.
let inlineText = null;
function startInlineTextEdit(id, selectAll = false) {
  const t = st.texts.find((x) => x.id === id);
  if (!t || st.busy || !st.mp4) return;
  finishInlineTextEdit();
  pausePlayback();
  if (!elementVisible(t, currentTimelineTime(), timelineDuration())) seekTimelineTime(t.in ?? 0);
  if (st.textSel !== id) elementEditor.select(id);
  elementEditor.commit();
  const original = t.text;
  const ta = document.createElement('textarea');
  ta.className = 'inlineText';
  ta.value = t.text;
  ta.spellcheck = false;
  ta.setAttribute('aria-label', 'Texto (Esc ou clicar fora para terminar)');
  resultView.appendChild(ta);
  const place = () => {
    const W = preview.offsetWidth, H = preview.offsetHeight;            // sem o zoom da vista
    const px = Math.max(4, t.size * W), lh = px * 1.2, pad = t.style === 'box' ? px * 0.28 : px * 0.12;
    const maxW = W * 0.9 - pad * 2;
    const bw = t._box ? t._box.w * W - pad * 2 : 0, bh = t._box ? t._box.h * H - pad * 2 : lh;
    const cx = t.x * W, cy = t.y * H;
    const left = t.align === 'left' ? cx - bw / 2 : t.align === 'right' ? cx + bw / 2 - maxW : cx - maxW / 2;
    const top = cy - bh / 2;
    Object.assign(ta.style, {
      left: `${left}px`, top: `${top}px`, width: `${maxW}px`, height: `${Math.max(lh, bh)}px`,
      font: (FONTS[t.font] || FONTS.moderna)[1](px), lineHeight: `${lh}px`, textAlign: t.align || 'center',
      textTransform: t.uppercase ? 'uppercase' : 'none', caretColor: t.style === 'box' ? (isDark(t.color) ? '#fff' : '#000') : t.color,
      transformOrigin: `${cx - left}px ${cy - top}px`, transform: `rotate(${t.rotation || 0}deg)`,
    });
  };
  const finish = () => {
    if (inlineText?.ta !== ta) return;
    inlineText = null;
    if (!t.text.trim()) t.text = original.trim() ? original : 'Texto';
    ta.remove();
    elementEditor.setEditingText(false);
    elementEditor.commit();
    elementPanel = '';
    renderTextOpts();
  };
  ta.addEventListener('input', () => {
    t.text = ta.value;
    const side = $('#tText');
    if (side && side.value !== ta.value) side.value = ta.value;
    elementEditor.changed();
    place();
  });
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); ta.blur(); }
  });
  ta.addEventListener('blur', finish);
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());
  inlineText = { id, ta, place, finish };
  elementEditor.setEditingText(true);
  place();
  ta.focus();
  if (selectAll) ta.select(); else ta.setSelectionRange(ta.value.length, ta.value.length);
}
function finishInlineTextEdit() { inlineText?.finish(); }

// ---------- seguir alvo (formato Vertical) ----------
// 1) «Seguir alvo» → desenha-se um quadrado no vídeo original (à esquerda); 2) os frames desde o
// cursor até ao fim do clip são descodificados (WebCodecs) e o alvo é procurado em cada um
// (tracker.js); 3) o caminho, suavizado, vira posições ◆ da moldura (path: true → curva contínua).
// As posições ficam editáveis como as outras; se o alvo se perder, pára aí e diz onde.
let marking = false, tracking = false, trackAbort = false;
function startMarking() {
  if (!st.mp4 || st.busy || st.layout !== 'crop') return;
  pausePlayback();
  const l = locate(currentTimelineTime());
  if (!l || st.parts[l.i].mediaId || tailTime != null) { setStatus('Põe o cursor num clip do vídeo principal para seguir um alvo.'); return; }
  marking = true;
  overlay.classList.add('marking');
  renderOpts();
  setStatus('Desenha um quadrado à volta do que queres seguir, no vídeo original (à esquerda). Esc cancela.');
}
function stopMarking(message) {
  marking = false;
  overlay.classList.remove('marking');
  overlay.querySelector('.trackBox')?.remove();
  renderOpts();
  if (message) setStatus(message);
}
overlay.addEventListener('pointerdown', (e) => {
  if (!marking || e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const r = stage.getBoundingClientRect(), box = videoBox();
  const inside = (cx, cy) => ({ x: clamp(cx - r.left, box.left, box.left + box.w), y: clamp(cy - r.top, box.top, box.top + box.h) });
  const a = inside(e.clientX, e.clientY);
  let b = a;
  overlay.querySelector('.trackBox')?.remove();
  const el = document.createElement('div');
  el.className = 'trackBox';
  overlay.appendChild(el);
  try { overlay.setPointerCapture(e.pointerId); } catch {}
  const draw = () => Object.assign(el.style, { left: `${Math.min(a.x, b.x)}px`, top: `${Math.min(a.y, b.y)}px`, width: `${Math.abs(b.x - a.x)}px`, height: `${Math.abs(b.y - a.y)}px` });
  const move = (ev) => { b = inside(ev.clientX, ev.clientY); draw(); };
  const up = () => {
    overlay.removeEventListener('pointermove', move);
    overlay.removeEventListener('pointerup', up);
    overlay.removeEventListener('pointercancel', up);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    if (w < 10 || h < 10) { el.remove(); setStatus('Quadrado demasiado pequeno — arrasta para o desenhar à volta do alvo.'); return; }
    const target = { x: (Math.min(a.x, b.x) - box.left) / box.w, y: (Math.min(a.y, b.y) - box.top) / box.h, w: w / box.w, h: h / box.h };
    stopMarking();
    runTracking(target);
  };
  overlay.addEventListener('pointermove', move);
  overlay.addEventListener('pointerup', up);
  overlay.addEventListener('pointercancel', up);
});

// Descodifica [start, end] da fonte principal e chama onFrame(frame, t) por ordem; 'stop' pára.
// Cada frame é fechado logo a seguir (ver armadilha do flush por hardware no CLAUDE.md).
async function decodeRange(start, end, onFrame) {
  const { mp4, buf } = st, samples = mp4.samples, u8 = new Uint8Array(buf);
  let stop = false, error = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      const t = frame.timestamp / 1e6;
      try { if (!stop && t >= start - 1e-3 && t <= end + 1e-3 && onFrame(frame, t) === 'stop') stop = true; }
      catch (e) { error = e; stop = true; }
      finally { frame.close(); }
    },
    error: (e) => { error = e; stop = true; },
  });
  decoder.configure({ codec: mp4.codec, codedWidth: mp4.width, codedHeight: mp4.height, description: mp4.description });
  let i = 0;
  for (let k = 0; k < samples.length && samples[k].pts <= start + 1e-3; k++) if (samples[k].key) i = k;
  try {
    for (let n = 0; i < samples.length && !stop && !trackAbort; i++, n++) {
      const s = samples[i];
      if (s.dts > end + 0.5) break;
      while (decoder.decodeQueueSize > 6 && !stop && !trackAbort) await sleep(1);
      decoder.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.pts * 1e6), data: u8.subarray(s.offset, s.offset + s.size) }));
      if (n % 20 === 19) await sleep(0);                                  // deixa a página respirar
    }
    if (!stop && !trackAbort) await withTimeout(decoder.flush(), 15000, 'O descodificador não terminou.').catch(() => {});
  } finally { try { decoder.close(); } catch {} }
  if (error) throw error;
}

async function runTracking(target) {
  const l = locate(currentTimelineTime());
  if (!l) return;
  const part = st.parts[l.i], start = video.currentTime, end = part.end;
  if (end - start < 0.3) { setStatus('Falta vídeo neste clip depois do cursor para seguir o alvo.'); return; }
  const before = beginVideoEdit();
  tracking = true; trackAbort = false; st.busy = true;
  renderOpts();
  setProgress(0);
  const { w: W, h: H } = workSize(st.srcW, st.srcH, target.w * st.srcW, target.h * st.srcH);
  const canvas = new OffscreenCanvas(W, H), ctx = canvas.getContext('2d', { willReadFrequently: true });
  const planes = new Float32Array(W * H * 3), pts = [];
  let tracker = null, lastT = -1, lostSince = null, lostAt = null, lastUi = 0;
  const onFrame = (frame, t) => {
    if (t - lastT < 1 / 31) return;                                     // no máximo 30 frames por segundo
    lastT = t;
    ctx.drawImage(frame, 0, 0, W, H);
    toPlanes(ctx.getImageData(0, 0, W, H).data, W, H, planes);
    if (!tracker) {
      tracker = createTracker(planes, W, H, { x: target.x * W, y: target.y * H, w: target.w * W, h: target.h * H });
      const b = tracker.box();
      pts.push({ t, x: (b.x + b.w / 2) / W, y: (b.y + b.h / 2) / H });
      return;
    }
    const r = tracker.track(planes);
    if (r.score < LOST_SCORE) {
      lostSince ??= t;
      if (t - lostSince > 0.6) { lostAt = lostSince; return 'stop'; }   // perdeu-se mesmo (não é só um frame mau)
    } else {
      lostSince = null;
      pts.push({ t, x: r.cx / W, y: r.cy / H });
    }
    if (performance.now() - lastUi > 150) {
      lastUi = performance.now();
      const p = (t - start) / (end - start);
      setProgress(p);
      setStatus(`A seguir o alvo… ${Math.round(p * 100)}%`);
    }
  };
  let failed = null;
  try { await decodeRange(start, end, onFrame); } catch (e) { failed = e; }
  tracking = false; st.busy = false;
  setProgress(null);
  if (pts.length < 2) {
    renderOpts();
    setStatus(failed ? 'Não consegui seguir o alvo: ' + failed.message : 'Não consegui seguir o alvo — tenta um quadrado mais justo à volta dele.');
    return;
  }
  // Caminho suavizado (sem tremer) → posições ◆ de 0,4 em 0,4 s com o zoom atual da moldura.
  if (DEV) globalThis.__trackPts = pts;
  const cur = cropAt(start), h = rectH({ w: cur.w }, 9 / 16);
  const keysPath = samplePath(smoothPath(pts, 0.3), 0.4);
  const t0 = keysPath[0].t, t1 = keysPath.at(-1).t;
  st.crop.keys = st.crop.keys.filter((k) => k.t < t0 - 0.05 || k.t > t1 + 0.05);
  for (const p of keysPath) st.crop.keys.push({ t: p.t, ...fitRect({ x: p.x - cur.w / 2, y: p.y - h / 2, w: cur.w }, 9 / 16), path: true });
  st.crop.keys.sort((a, b) => a.t - b.t);
  renderOpts(); renderKeys(); placeRects();
  recordVideoEdit(before);
  seekTimelineTime(sourceToEdit(t0));
  const upTo = fmt(sourceToEdit(t1));
  setStatus(trackAbort ? `Seguimento parado em ${upTo}.`
    : lostAt != null ? `Seguido até ${upTo} — aí o alvo perdeu-se. Põe o cursor aí e usa «Seguir alvo» outra vez para continuar.`
    : `Alvo seguido até ao fim do clip (${keysPath.length} posições ◆). Podes afinar arrastando no resultado.`);
}

// --- câmara lembrada por canal (o mesmo streamer tem a câmara sempre no mesmo sítio) ---
let chanKey = '_last';
const camMemory = () => { try { return JSON.parse(localStorage.getItem('sc.cams') || '{}'); } catch { return {}; } };
function rememberCam() {
  const { cam, game, split } = st.streamer, all = camMemory();
  all[chanKey] = all._last = { cam, game, split };
  try { localStorage.setItem('sc.cams', JSON.stringify(all)); } catch {}
}
function restoreCam() {
  const all = camMemory(), v = all[chanKey] || all._last, s = st.streamer;
  s.cam = s.game = null;
  if (!v) return false;
  s.split = v.split || s.split;
  const ch = camH(OUT_V.h);
  if (v.cam) s.cam = fitRect(v.cam, OUT_V.w / ch);
  if (v.game) s.game = fitRect(v.game, OUT_V.w / (OUT_V.h - ch));
  return !!all[chanKey] && chanKey !== '_last';
}

// --- media na pré-visualização: imagens como ImageBitmap, vídeos como <video> em loop ---
const previewMedia = new Map();   // mediaId ou element:id -> leitor independente

function disposePreviewMedia(p) {
  if (!p) return;
  p.disposed = true;
  p.el?.pause();
  if (p.url) { p.el.removeAttribute('src'); p.el.load(); URL.revokeObjectURL(p.url); }
  p.reader?.close();
  if (p.kind === 'image') p.img?.close();
}

function previewMediaFor(id, element = null) {
  const key = element ? `element:${element.id}` : id;
  let p = previewMedia.get(key);
  if (!p) {
    const m = libItem(id);
    if (!m) return null;
    p = { kind: usesFrameReader(m) ? 'frames' : m.type, mediaId: id, elementId: element?.id };
    previewMedia.set(key, p);
    if (p.kind === 'frames') p.ready = openMediaReader(m).then(r => {
      if (p.disposed) { r.close(); return; } p.reader = r;
    }).catch(e => { p.error = e; setStatus(`Não consegui abrir «${m.name}»: ${e.message}`); });
    else if (m.type === 'image') p.ready = createImageBitmap(m.blob).then((b) => { if (p.disposed) b.close(); else p.img = b; }).catch((e) => { p.error = e; });
    else {
      const v = document.createElement('video');
      p.url = URL.createObjectURL(m.blob);
      Object.assign(v, { muted: true, loop: true, playsInline: true, preload: 'auto', src: p.url });
      p.el = v;
      v.addEventListener('loadeddata', syncMediaTime, { once: true });
    }
  }
  if (p.kind === 'frames') return p.img ? { img: p.img, w: p.img.displayWidth, h: p.img.displayHeight } : null;
  if (p.kind === 'image') return p.img ? { img: p.img, w: p.img.width, h: p.img.height } : null;
  return p.el.readyState >= 2 ? { img: p.el, w: p.el.videoWidth, h: p.el.videoHeight } : null;
}

// Cada elemento começa no seu instante de entrada e repete enquanto estiver visível.
function syncMediaTime(event) {
  for (const [key, p] of previewMedia) {
    const element = p.elementId && st.images.find(e => e.id === p.elementId && e.mediaId === p.mediaId);
    if ((p.elementId && !element) || !libItem(p.mediaId)) { disposePreviewMedia(p); previewMedia.delete(key); continue; }
    const now = currentTimelineTime(), playing = isPlaying();
    const active = !st.busy && (element ? elementVisible(element, now, timelineDuration()) : mediaMode() && key === st.streamer.mediaId);
    if (!active) { p.el?.pause(); continue; }
    const t = Math.max(0, now - (element?.in ?? 0));
    if (p.kind === 'frames') {
      if (p.reader && !p.pending && !p.error) {
        p.pending = p.reader.frameAt(t).then(f => { if (!p.disposed) p.img = f; })
          .catch(e => { if (!p.disposed) { p.error = e; setStatus('Não consegui ler o ficheiro: ' + e.message); } }).finally(() => { p.pending = null; });
      }
      continue;
    }
    if (p.kind !== 'video' || !p.el.duration) continue;
    const target = t % p.el.duration;
    const tolerance = !playing || event?.type === 'seeked' ? .015 : .15;
    if (!p.el.seeking && Math.abs(p.el.currentTime - target) > tolerance) p.el.currentTime = target;
    if (!playing) p.el.pause(); else if (p.el.paused) p.el.play().catch(() => {});
  }
}
video.addEventListener('seeked', syncMediaTime);
video.addEventListener('play', syncMediaTime);
video.addEventListener('pause', syncMediaTime);
video.addEventListener('seeked', () => syncAudioPreview(true));
video.addEventListener('play', () => syncAudioPreview(true));
video.addEventListener('pause', () => syncAudioPreview(true));
sequenceVideo.addEventListener('seeked', syncMediaTime);
sequenceVideo.addEventListener('play', syncMediaTime);
sequenceVideo.addEventListener('pause', syncMediaTime);
sequenceVideo.addEventListener('seeked', () => syncAudioPreview(true));
sequenceVideo.addEventListener('play', () => syncAudioPreview(true));
sequenceVideo.addEventListener('pause', () => syncAudioPreview(true));

let importingMedia = false;
async function addToLibrary(files) {
  if (st.busy || importingMedia) return [];
  importingMedia = true;
  renderTextOpts();
  const added = [];
  try {
    for (const f of files) {
      try {
        setStatus(`A adicionar «${f.name}» à biblioteca…`);
        const m = await importMediaFile(f, getFFmpeg);
        await putMedia(m);
        st.library.push(m);
        added.push(m);
        if (m.type !== 'audio' && !libItem(st.streamer.mediaId)) Object.assign(st.streamer, { mediaId: m.id, scale: 1, ox: 0, oy: 0 });
        savePrefs();
        renderOpts();
        renderTextOpts();
        syncMediaTime();
        setStatus(`«${m.name}» adicionado à biblioteca.`);
      } catch (e) {
        console.error(e);
        setStatus('Não consegui adicionar: ' + e.message);
      }
    }
  } finally { importingMedia = false; renderTextOpts(); }
  return added;
}

function setAppendSkeleton(visible, text = 'A preparar…') {
  const row = $('#appendSkeletonRow');
  row.hidden = !visible;
  row.setAttribute('aria-busy', String(visible));
  $('#appendSkeletonText').textContent = text;
}

async function loadVideoMetadata(file) {
  const el = document.createElement('video'), url = URL.createObjectURL(file);
  el.preload = 'metadata'; el.muted = true; el.src = url;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`«${file.name}» demorou demasiado a abrir.`)), 10000);
      el.onloadedmetadata = () => { clearTimeout(timer); resolve(); };
      el.onerror = () => { clearTimeout(timer); reject(new Error(`«${file.name}» não contém vídeo reproduzível.`)); };
    });
    return { dur: el.duration, w: el.videoWidth, h: el.videoHeight };
  } finally { el.removeAttribute('src'); el.load(); URL.revokeObjectURL(url); }
}

async function queueVideoFiles(files) {
  if (!st.mp4 || !files.length || st.busy || importingMedia) return;
  importingMedia = true;
  setAppendSkeleton(true, files.length === 1 ? 'A ler o vídeo…' : `A ler ${files.length} vídeos…`);
  $('#addVideo').disabled = $('#addAudio').disabled = true;
  try {
    for (const file of files) {
      setAppendSkeleton(true, `A ler ${file.name}…`);
      const meta = await loadVideoMetadata(file);
      if (!Number.isFinite(meta.dur) || meta.dur <= 0) throw new Error(`«${file.name}» não tem uma duração válida.`);
      const media = { id: 'm' + crypto.randomUUID(), name: file.name.replace(/\.[^.]+$/, ''), sourceName: file.name,
        type: 'video', blob: file, sourceBlob: file, dur: meta.dur, w: meta.w, h: meta.h, at: Date.now(), sequenceOnly: true };
      // Entra como um clip normal no fim da faixa de vídeo (pode ser arrastado, cortado, duplicado).
      const before = beginVideoEdit();
      st.library.push(media);
      st.parts.push({ mediaId: media.id, start: 0, end: media.dur });
      partSel = st.parts.length - 1;
      updateTimeline();
      recordVideoEdit(before);
      // O bloco aparece antes de copiar o Blob para IndexedDB. A persistência
      // continua em background e não atrasa a interação com a timeline.
      putMedia(media).then(() => saveSession()).catch(error => console.warn('guardar vídeo da sequência', error));
    }
    setStatus(`${files.length} vídeo${files.length === 1 ? '' : 's'} adicionado${files.length === 1 ? '' : 's'} imediatamente · o processamento fica para a exportação.`);
    seekTimelineTime(rangeOffsets()[st.parts.length - files.length]?.editStart ?? 0);
    saveSession();
  } finally {
    importingMedia = false; setAppendSkeleton(false); updateTimeline();
  }
}

// Antes de exportar: os clips de outros vídeos da faixa passam a fazer parte de UMA fonte (o vídeo
// principal seguido de cada ficheiro usado, inteiro). Os clips continuam na mesma ordem e com os
// mesmos cortes, agora como trechos dessa fonte — a timeline (e os elementos) não mudam.
async function materializeVideoFiles() {
  const mediaIds = [...new Set(st.parts.filter(p => p.mediaId).map(p => p.mediaId))];
  if (!st.mp4 || !mediaIds.length || st.busy || importingMedia) return;
  const files = mediaIds.map(id => libItem(id)?.sourceBlob || libItem(id)?.blob || null);
  if (files.some(file => !file)) throw new Error('Falta um vídeo da faixa. Apaga esse clip e volta a adicioná-lo.');
  const oldDuration = st.dur, oldState = videoSnapshot(), oldParts = structuredClone(st.parts);
  const oldElements = { texts: st.texts, images: st.images, audioTracks: st.audioTracks };
  importingMedia = true; st.busy = true; pausePlayback();
  setAppendSkeleton(true, files.length === 1 ? 'A preparar vídeo…' : `A preparar ${files.length} vídeos…`);
  for (const el of document.querySelectorAll('header, .bottom, .optsWrap, #stage')) el.inert = true;
  updateTimeline();
  let ff = null, fastJoin = false;
  const tempFiles = ['append-main.source', 'append-out.mp4', 'append-list.txt'];
  try {
    ff = await getFFmpeg();
    const media = [];
    for (let i = 0; i < files.length; i++) {
      const displayName = libItem(mediaIds[i])?.name || `vídeo ${i + 1}`;
      setStatus(`A preparar «${displayName}»…`);
      setAppendSkeleton(true, `A analisar ${displayName}…`);
      const item = await inspectVideoFile(files[i], getFFmpeg);
      if (item.type !== 'video') throw new Error(`«${displayName}» não contém vídeo.`);
      item.trimStart = 0; item.trimEnd = item.dur; item.fullClip = true;
      media.push(item);
    }
    setStatus(`A juntar ${media.length} vídeo${media.length === 1 ? '' : 's'} à faixa principal…`);
    setAppendSkeleton(true, 'A preparar a nova sequência…');
    await ff.writeFile('append-main.source', new Uint8Array(st.buf.slice(0)));
    const inputNames = ['append-main.source'];
    for (let i = 0; i < media.length; i++) {
      const name = `append-${i}.source`;
      tempFiles.push(name);
      await ff.writeFile(name, new Uint8Array(media[i].buffer.slice(0)));
      inputNames.push(name);
    }
    // Ficheiros vindos da mesma fonte costumam ter exatamente o mesmo formato: aí o ffmpeg só
    // remuxa os pacotes (não descodifica nem recodifica), o que é muito mais rápido.
    const compatible = st.mp4.codec?.startsWith('avc1') && media.every(item => item.copyReady && item.codec === st.mp4.codec &&
      item.w === st.srcW && item.h === st.srcH && Math.abs((item.fps || 0) - st.mp4.fps) < .1 &&
      item.hasAudio === st.mp4.hasAudio && (!item.hasAudio || item.audioCodec === 'aac'));
    let output = null;
    const expected = oldDuration + media.reduce((sum, item) => sum + item.dur, 0);
    if (compatible) {
      setAppendSkeleton(true, 'A juntar sem recodificar…');
      const list = inputNames.map(name => `file '${name}'`).join('\n') + '\n';
      await ff.writeFile('append-list.txt', new TextEncoder().encode(list));
      const code = await ff.exec(['-hide_banner', '-f', 'concat', '-safe', '0', '-i', 'append-list.txt', '-map', '0:v:0',
        ...(st.mp4.hasAudio ? ['-map', '0:a:0'] : []), '-c', 'copy', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', 'append-out.mp4'], 60000);
      if (code === 0) {
        const candidate = await ff.readFile('append-out.mp4');
        const buffer = candidate.buffer.slice(candidate.byteOffset, candidate.byteOffset + candidate.byteLength);
        try {
          const parsed = parseMp4(buffer);
          if (parsed.samples.length && Math.abs(parsed.duration - expected) <= Math.max(.5, expected * .02)) {
            output = new Uint8Array(buffer); fastJoin = true;
          }
        } catch {}
      }
    }
    if (!output) {
      setAppendSkeleton(true, 'A adaptar formatos e a juntar…');
      try { await ff.deleteFile('append-out.mp4'); } catch {}
      const args = ['-hide_banner'];
      inputNames.forEach(name => args.push('-i', name));
      const sources = [{ dur: oldDuration, hasAudio: st.mp4.hasAudio, trimStart: 0, trimEnd: oldDuration }, ...media];
      const fps = st.mp4.fps >= 45 ? 60 : Math.min(30, Math.max(24, Math.round(st.mp4.fps || 30)));
      const filters = [], concatInputs = [];
      sources.forEach((source, i) => {
        const trim = `trim=start=${source.trimStart.toFixed(3)}:end=${source.trimEnd.toFixed(3)}`;
        filters.push(`[${i}:v:0]${trim},setpts=PTS-STARTPTS,scale=${st.srcW}:${st.srcH}:force_original_aspect_ratio=decrease,pad=${st.srcW}:${st.srcH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`);
        if (source.hasAudio) filters.push(`[${i}:a:0]atrim=start=${source.trimStart.toFixed(3)}:end=${source.trimEnd.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
        else filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${source.dur.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
        concatInputs.push(`[v${i}][a${i}]`);
      });
      filters.push(`${concatInputs.join('')}concat=n=${sources.length}:v=1:a=1[vout][aout]`);
      args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-y', 'append-out.mp4');
      const code = await withTimeout(ff.exec(args), 600000, 'A junção dos vídeos demorou demasiado.');
      if (code !== 0) throw new Error('Não consegui juntar os vídeos.');
      output = await ff.readFile('append-out.mp4');
    }
    const joined = new Blob([output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength)], { type: 'video/mp4' });

    st.busy = false;
    for (const el of document.querySelectorAll('header, .bottom, .optsWrap, #stage')) el.inert = false;
    setAppendSkeleton(true, 'A atualizar a timeline…');
    await loadClip(joined, st.name, chanKey);
    // Onde começa cada ficheiro na fonte nova.
    const offset = new Map();
    let cursor = oldDuration;
    mediaIds.forEach((id, i) => { offset.set(id, cursor); cursor += media[i].dur; });
    st.parts = cleanParts(oldParts.map(p => p.mediaId
      ? { start: offset.get(p.mediaId) + p.start, end: Math.min(st.dur, offset.get(p.mediaId) + p.end) }
      : { start: p.start, end: p.end }));
    st.activePart = 0;
    st.framing = oldState.framing;
    st.streamer = oldState.streamer;
    st.crop.keys = oldState.keys;
    st.texts = oldElements.texts;
    st.images = oldElements.images;
    st.audioTracks = oldElements.audioTracks;
    st.audioSel = null;
    const unused = mediaIds.filter(id => libItem(id)?.sequenceOnly);
    if (unused.length) {
      st.library = st.library.filter(item => !unused.includes(item.id));
      await Promise.all(unused.map(id => deleteMedia(id).catch(() => {})));
    }
    resetSequencePreview();
    normalizeElementTimes();
    setLayout(oldState.layout);
    updateTimeline(); seekTimelineTime(0); renderTextOpts(); elementEditor.reset(); resetEditHistory();
    await saveSession();
    setStatus(`${media.length} vídeo${media.length === 1 ? '' : 's'} juntado${media.length === 1 ? '' : 's'} à fonte${fastJoin ? ' · junção rápida' : ''}`);
  } finally {
    importingMedia = false; st.busy = false;
    setAppendSkeleton(false);
    for (const el of document.querySelectorAll('header, .bottom, .optsWrap, #stage')) el.inert = false;
    if (ff) for (const name of tempFiles) { try { await ff.deleteFile(name); } catch {} }
    updateTimeline(); renderTextOpts();
  }
}

async function addAudioTracks(files) {
  if (!st.mp4 || !files.length) return;
  const added = await addToLibrary(files), start = clamp(currentTimelineTime(), 0, Math.max(0, timelineDuration() - .05));
  const before = beginVideoEdit();
  for (const media of added.filter(item => item.type === 'audio')) {
    const track = { id: crypto.randomUUID(), mediaId: media.id, start, trimStart: 0, trimEnd: media.dur, volume: .35, fadeIn: 0, fadeOut: 0, muted: false };
    st.audioTracks.push(track); st.audioSel = track.id;
  }
  normalizeAudioTracks(); renderAudioTracks(); renderTextOpts(); recordVideoEdit(before);
  if (added.length) setStatus(`${added.length} faixa${added.length === 1 ? '' : 's'} de áudio adicionada${added.length === 1 ? '' : 's'}.`);
}

$('#addVideo').addEventListener('click', () => $('#videoFiles').click());
$('#addAudio').addEventListener('click', () => $('#audioFiles').click());
$('#videoFiles').addEventListener('change', async event => {
  try { await queueVideoFiles([...event.target.files]); }
  catch (error) { console.error(error); setStatus('Não consegui adicionar o vídeo: ' + error.message); }
  event.target.value = '';
});
$('#audioFiles').addEventListener('change', async event => { await addAudioTracks([...event.target.files]); event.target.value = ''; });

async function replaceLibraryFile(id, file) {
  const previous = libItem(id);
  if (!previous || !file || st.busy || importingMedia) return;
  importingMedia = true;
  renderTextOpts();
  try {
    setStatus('A preparar o ficheiro…');
    const imported = await importMediaFile(file, getFFmpeg);
    const replacement = { ...imported, id, at: previous.at };
    // Só substitui depois da conversão e gravação completas. Mantém os IDs nos
    // elementos/templates, assim como a posição, os cortes, o tamanho e a rotação.
    await putMedia(replacement);
    st.library = st.library.map(m => m.id === id ? replacement : m);
    for (const [key, p] of previewMedia) {
      if (p.mediaId !== id) continue;
      disposePreviewMedia(p); previewMedia.delete(key);
    }
    renderOpts(); saveSession();
    setStatus('Ficheiro substituído.');
  } catch (e) { setStatus('Não consegui substituir: ' + e.message); }
  finally { importingMedia = false; renderTextOpts(); }
}

const libraryReady = (async () => {
  try {
    [st.library, st.templates, st.recentClips] = await Promise.all([listMedia(), listTemplates(), listRecentClips()]);
    navigator.storage?.persist?.();
    renderTemplates();
    renderRecentClips();
    const tpl = st.templates.find((t) => t.id === tplCur);    // abre com o último template escolhido
    if (tpl) applyTemplateSnap(tpl);
    else if (st.layout === 'streamer') { buildRects(); renderOpts(); }
    renderTextOpts();
  } catch (e) { console.warn('biblioteca', e); }
})();

// ---------- textos (por cima de tudo, em todos os formatos) ----------
// {id, text, x, y (centro do bloco, 0..1 do resultado), size (altura da letra / largura), color,
//  style: 'outline'|'box'|'plain', align: 'left'|'center'|'right', font}
const FONTS = {
  montserrat: ['Montserrat ExtraBold', (px) => `800 ${px}px "Montserrat", Arial, sans-serif`],
  anton: ['Anton', (px) => `400 ${px}px "Anton", Impact, sans-serif`],
  bebas: ['Bebas Neue', (px) => `400 ${px}px "Bebas Neue", Impact, sans-serif`],
  moderna: ['Moderna', (px) => `800 ${px}px "Segoe UI", system-ui, sans-serif`],
  classica: ['Clássica', (px) => `900 ${px}px "Arial Black", Arial, sans-serif`],
  impacto: ['Impacto', (px) => `${px}px Impact, "Arial Narrow Bold", sans-serif`],
};
const TEXT_PRESETS = [
  { id: 'subtitle', name: 'Subtítulo', sample: 'Aa', title: 'Legenda branca, forte e legível', values: { font: 'montserrat', size: 0.057, color: '#ffffff', style: 'outline', align: 'center', uppercase: false, y: 0.78 } },
  { id: 'box', name: 'Caixa', sample: 'Aa', title: 'Texto branco sobre caixa preta', values: { font: 'montserrat', size: 0.064, color: '#000000', style: 'box', align: 'center', uppercase: false, y: 0.76 } },
  { id: 'highlight', name: 'Destaque', sample: 'WOW', title: 'Palavra de impacto em amarelo', values: { font: 'anton', size: 0.084, color: '#ffe600', style: 'outline', align: 'center', uppercase: true, y: 0.56 } },
  { id: 'headline', name: 'Título', sample: 'WOW', title: 'Título condensado em maiúsculas', values: { font: 'bebas', size: 0.12, color: '#ffffff', style: 'outline', align: 'center', uppercase: true, y: 0.22 } },
];
const TEXT_COLORS = ['#ffffff', '#ffe600', '#ff3b5c', '#25f4ee', '#22c55e', '#000000'];
const TEXT_SIZE_PRESETS = [4, 6, 8, 10, 12, 16, 20, 25];   // sugestões do combo de tamanho (estilo Word)
const TEXT_STYLE_KEYS = ['size', 'color', 'style', 'align', 'font', 'uppercase'];
let textSeq = 0;

const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
st.texts = [];
st.textSel = null;
try { localStorage.removeItem('sc.texts'); } catch {}   // "manter nos próximos clips" foi removido: os templates já cobrem isto

const selText = () => st.texts.find((t) => t.id === st.textSel);
const isDark = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 110; };

// Guarda o estilo para o próximo texto.
function saveTexts() {
  const t = selText();
  if (t) saveJSON('sc.textStyle', Object.fromEntries(TEXT_STYLE_KEYS.map((k) => [k, t[k]])));
  elementEditor?.changed();
}

// Parte o texto em linhas (Enter = linha nova; linhas compridas passam para baixo sozinhas).
function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? line + ' ' + word : word;
      if (line && ctx.measureText(tryLine).width > maxW) { out.push(line); line = word; } else line = tryLine;
    }
    out.push(line);
  }
  return out;
}

function drawTexts(ctx, W, H, time, elementMedia) {
  for (const t of orderedElements(st)) {
    if (!elementVisible(t, time, timelineDuration())) { t._box = null; continue; }
    if (t.mediaId) {
      const m = elementMedia ? elementMedia.get(t.id) : previewMediaFor(t.mediaId, t);
      if (!m) { t._box = null; continue; }
      const w = t.size * W, h = w * m.h / m.w;
      ctx.save(); ctx.translate(t.x * W, t.y * H); ctx.rotate((t.rotation || 0) * Math.PI / 180);
      ctx.drawImage(m.img, -w / 2, -h / 2, w, h); ctx.restore();
      t._box = { x: t.x - w / W / 2, y: t.y - h / H / 2, w: w / W, h: h / H };
      continue;
    }
    const text = t.uppercase ? t.text.toLocaleUpperCase() : t.text;
    if (!text.trim()) { t._box = null; continue; }
    const px = Math.max(4, t.size * W), lh = px * 1.2, pad = t.style === 'box' ? px * 0.28 : px * 0.12;
    ctx.save();
    ctx.translate(t.x * W, t.y * H); ctx.rotate((t.rotation || 0) * Math.PI / 180); ctx.translate(-t.x * W, -t.y * H);
    ctx.font = (FONTS[t.font] || FONTS.moderna)[1](px);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const lines = wrapText(ctx, text, W * 0.9 - pad * 2);
    const widths = lines.map((l) => ctx.measureText(l).width);
    const bw = Math.max(...widths), bh = lines.length * lh;
    const cx = t.x * W, cy = t.y * H, left = cx - bw / 2, top = cy - bh / 2;
    const lineX = (w) => (t.align === 'left' ? left : t.align === 'right' ? left + bw - w : cx - w / 2);
    if (t.style === 'box') {
      ctx.fillStyle = t.color;
      lines.forEach((l, i) => {
        if (!l) return;
        ctx.beginPath();
        ctx.roundRect(lineX(widths[i]) - pad, top + i * lh - pad * 0.15, widths[i] + pad * 2, lh + pad * 0.3, px * 0.22);
        ctx.fill();
      });
    }
    lines.forEach((l, i) => {
      const x = lineX(widths[i]), y = top + lh * (i + 0.5);
      if (t.style === 'outline') {
        ctx.lineJoin = 'round';
        ctx.lineWidth = px * 0.16;
        ctx.strokeStyle = isDark(t.color) ? '#ffffff' : '#000000';
        ctx.strokeText(l, x, y);
      } else if (t.style === 'plain') {
        ctx.shadowColor = 'rgba(0,0,0,.65)';
        ctx.shadowBlur = px * 0.18;
        ctx.shadowOffsetY = px * 0.05;
      }
      ctx.fillStyle = t.style === 'box' ? (isDark(t.color) ? '#ffffff' : '#000000') : t.color;
      ctx.fillText(l, x, y);
    });
    ctx.restore();
    t._box = { x: (left - pad) / W, y: (top - pad) / H, w: (bw + pad * 2) / W, h: (bh + pad * 2) / H };
  }
}

// Os elementos novos abrangem todo o vídeo; null acompanha o fim do clip.
function addText() {
  if (st.busy) return;
  elementEditor?.commit();
  const d = { size: 0.075, color: '#ffffff', style: 'outline', align: 'center', font: 'montserrat', uppercase: false, ...loadJSON('sc.textStyle', {}) };
  let y = st.layout === 'streamer' ? st.streamer.split : 0.2;
  while (y < 0.9 && st.texts.some((t) => Math.abs(t.y - y) < 0.04)) y = Math.min(0.92, y + 0.09);
  const t = { id: 'T' + ++textSeq, text: 'Texto', x: 0.5, y, ...d, rotation: 0, z: elementEditor?.nextZ() || 0, in: 0, out: null };
  st.texts.push(t);
  elementEditor?.commit();
  selectText(t.id, false);
  startInlineTextEdit(t.id, true);        // escreve-se logo no vídeo, com o "Texto" selecionado
}

function selectText(id, focus) {
  if (id) elementPanel = '';
  if (id) { st.audioSel = null; renderAudioTracks(); }
  elementEditor.select(id, true);
  if (focus) { const ta = $('#tText'); ta?.focus(); ta?.select(); }
}

function syncTextSize() {
  const t = selText(), inp = $('#tSize');
  if (!t || !inp) return;
  inp.value = Math.round(t.size * 1000) / 10;
}

const ALIGN_ICONS = {
  left: '<svg viewBox="0 0 16 16"><path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8"/></svg>',
  center: '<svg viewBox="0 0 16 16"><path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8"/></svg>',
};

let elementPanel = '';
// Por omissão só a caixa de texto/lista de elementos fica visível; "Estilo e posição" começa
// fechado (a lista tem de caber sem scroll) e só fica aberto nos elementos em que o utilizador o abriu.
const expandedElementOptions = new Set();

async function removeLibraryFile(id) {
  if (st.busy || importingMedia) return;
  const m = libItem(id);
  if (!m) return;
  if (st.images.some(e => e.mediaId === id)) { setStatus('Remove primeiro do vídeo os elementos que usam este ficheiro.'); return; }
  if (st.parts.some(part => part.mediaId === id)) { setStatus('Remove primeiro este clip da faixa de vídeo.'); return; }
  if (st.audioTracks.some(track => track.mediaId === id)) { setStatus('Remove primeiro da timeline as faixas que usam este áudio.'); return; }
  if (st.templates.some(t => t.images?.some(e => e.mediaId === id) || t.audioTracks?.some(track => track.mediaId === id) || t.streamer?.mediaId === id)) {
    setStatus('Remove primeiro este ficheiro dos templates que o usam.'); return;
  }
  if (!confirm(`Apagar «${m.name}» da biblioteca?`)) return;
  try {
    await deleteMedia(id);
    st.library = st.library.filter(x => x.id !== id);
    for (const [key, p] of previewMedia) {
      if (p.mediaId !== id) continue;
      disposePreviewMedia(p); previewMedia.delete(key);
    }
    if (st.streamer.mediaId === id) { st.streamer.mediaId = null; savePrefs(); }
    renderOpts(); renderTextOpts();
    setStatus('Ficheiro apagado.');
  } catch (e) { setStatus('Não consegui apagar: ' + e.message); }
}

function imagePickerHtml() {
  const files = st.library.filter(item => item.type !== 'audio' && !item.sequenceOnly).sort((a, b) => b.at - a.at);
  return `<div class="hrow"><h3>Últimos ficheiros</h3><button id="uploadImage" class="btn small"${importingMedia ? ' disabled' : ''}>${importingMedia ? 'A carregar…' : 'Carregar ficheiro'}</button></div>
    <input id="imageFiles" type="file" accept="image/*,video/*,.gif,.mov,.mp4,.m4v,.mkv,.webm" multiple hidden>
    ${files.length ? `<div class="recentImages">${files.map((m) => `<div class="recentFile"><button class="recentImage" data-image-id="${esc(m.id)}" title="Adicionar ${esc(m.name)}"><img src="${esc(m.thumb)}" alt="" loading="lazy"><span>${isGif(m) ? 'GIF · ' : m.type === 'video' ? '▶ · ' : ''}${esc(m.name)}</span></button><button class="recentFileDelete" data-delete-media="${esc(m.id)}" title="Apagar ${esc(m.name)}" aria-label="Apagar ${esc(m.name)} da biblioteca">×</button></div>`).join('')}</div>` : ''}`;
}

function bindImagePicker(o) {
  o.querySelector('#uploadImage')?.addEventListener('click', () => o.querySelector('#imageFiles').click());
  o.querySelector('#imageFiles')?.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const button = o.querySelector('#uploadImage');
    button.disabled = true;
    button.textContent = 'A carregar…';
    await addToLibrary(files);
    renderTextOpts();
  });
  o.querySelectorAll('[data-image-id]').forEach((b) => b.addEventListener('click', () => {
    elementPanel = '';
    elementEditor.addImage(b.dataset.imageId);
  }));
  o.querySelectorAll('[data-delete-media]').forEach(b => b.addEventListener('click', () => removeLibraryFile(b.dataset.deleteMedia)));
}

function renderAudioOptions(o, track) {
  const media = libItem(track.mediaId), length = audioLength(track), fadeMax = Math.max(0, length / 2);
  o.innerHTML = `<div class="opt audioOptions">
    <div class="hrow"><h2>Música / áudio</h2><button id="closeAudioOptions" class="btn small" aria-label="Fechar ajustes de áudio">✕</button></div>
    <strong>${esc(media?.name || 'Áudio')}</strong>
    <span class="muted small">${fmt(track.start)} – ${fmt(audioEnd(track))} · ${fmt(length)}</span>
    <label>Volume <input id="audioVolume" type="range" min="0" max="200" step="1" value="${Math.round(track.volume * 100)}"><span id="audioVolumeValue" class="mono audioValue">${Math.round(track.volume * 100)}%</span></label>
    <label>Entrada suave <input id="audioFadeIn" type="range" min="0" max="${fadeMax}" step="0.1" value="${track.fadeIn}"><span id="audioFadeInValue" class="mono audioValue">${track.fadeIn.toFixed(1)}s</span></label>
    <label>Saída suave <input id="audioFadeOut" type="range" min="0" max="${fadeMax}" step="0.1" value="${track.fadeOut}"><span id="audioFadeOutValue" class="mono audioValue">${track.fadeOut.toFixed(1)}s</span></label>
    <div class="row"><button id="audioMutePanel" class="btn small">${track.muted ? 'Ativar som' : 'Silenciar'}</button><button id="audioDeletePanel" class="btn small danger">Apagar faixa</button></div>
  </div>`;
  const bindRange = (id, key, format, scale = 1) => {
    const input = o.querySelector('#' + id), value = o.querySelector('#' + id + 'Value');
    let before = null;
    input.addEventListener('input', () => {
      before ??= beginVideoEdit(); track[key] = +input.value * scale; value.textContent = format(track[key]); syncAudioPreview(true); saveSession();
    });
    input.addEventListener('change', () => { if (before) recordVideoEdit(before); before = null; });
  };
  bindRange('audioVolume', 'volume', value => `${Math.round(value * 100)}%`, .01);
  bindRange('audioFadeIn', 'fadeIn', value => `${value.toFixed(1)}s`);
  bindRange('audioFadeOut', 'fadeOut', value => `${value.toFixed(1)}s`);
  o.querySelector('#audioMutePanel').addEventListener('click', () => { const before = beginVideoEdit(); track.muted = !track.muted; syncAudioPreview(true); renderAudioTracks(); renderTextOpts(); recordVideoEdit(before); });
  o.querySelector('#audioDeletePanel').addEventListener('click', () => removeAudio(track.id));
  o.querySelector('#closeAudioOptions').addEventListener('click', () => selectAudio(null));
}

function renderTextOpts() {
  elementEditor?.renderTracks();
  const o = $('#textOpts'), audio = audioItem();
  if (audio) { renderAudioOptions(o, audio); return; }
  const t = elementPanel === 'image' ? null : selText();
  const selected = elementPanel === 'image' ? null : elementEditor?.selected();
  const presetButtons = t ? TEXT_PRESETS.map(preset => {
    const active = Object.entries(preset.values).filter(([key]) => key !== 'y').every(([key, value]) => t[key] === value);
    return `<button type="button" class="textPreset${active ? ' on' : ''}" data-text-preset="${preset.id}" aria-pressed="${active}" title="${preset.title}"><span class="presetPreview presetPreview--${preset.id}">${preset.sample}</span><span class="presetName">${preset.name}</span></button>`;
  }).join('') : '';
  const chips = orderedElements(st).reverse().map((x, i) => {
    const name = esc(x.mediaId ? (libItem(x.mediaId)?.name || 'Imagem') : x.text.split('\n')[0].slice(0, 40) || 'Texto ' + (i + 1));
    return `<div class="elementRow${x.id === st.textSel ? ' on' : ''}"><button class="elementSelect" data-tid="${x.id}" title="Selecionar">
      <span class="elementType" aria-hidden="true">${x.mediaId ? (libItem(x.mediaId)?.thumb ? `<img src="${esc(libItem(x.mediaId).thumb)}" alt="">` : '▧') : 'T'}</span>
      <span class="elementName">${name}</span>
    </button><button class="elementDelete" data-tdel="${x.id}" title="Apagar ${name}" aria-label="Apagar ${name}">✕</button></div>`;
  }).join('');
  o.innerHTML = `<div class="opt">
    <div class="elementHeader"><h2>Elementos</h2><div class="seg elementAdd"><button id="addText" title="Adicionar texto (T)">+ Texto</button><button id="showImages" class="${elementPanel === 'image' ? 'on' : ''}">+ Ficheiro</button></div></div>
    ${chips ? `<div class="elementList">${chips}</div>` : ''}
    ${elementPanel === 'image' ? `<div id="elementPicker" class="elementPicker">${imagePickerHtml()}</div>` : ''}
    ${t ? `<textarea id="tText" aria-label="Texto do elemento" rows="2" placeholder="Escreve aqui…">${esc(t.text)}</textarea>` : ''}
    ${selected ? `<details id="elementOptions" class="elementOptions"${expandedElementOptions.has(selected.id) ? ' open' : ''}><summary>${t ? 'Estilo e posição' : 'Ajustes do ficheiro'}</summary><div class="opt">
      ${t ? `<section class="textPresetGroup" aria-label="Presets de texto"><h3>Presets</h3><div class="textPresetGrid">${presetButtons}</div></section>` : ''}` : ''}
    ${selected?.mediaId ? `<label>Tamanho <input id="imageSize" type="range" min="0.03" max="2" step="0.01" value="${selected.size}"></label>` : ''}
    ${selected?.mediaId ? `<button id="replaceMedia" class="btn small"${importingMedia ? ' disabled' : ''}>${importingMedia ? 'A carregar…' : 'Substituir ficheiro'}</button><input id="replacementFile" type="file" accept="image/*,video/*,.mov,.mp4,.webm,.mkv,.avi,.gif" hidden>` : ''}
    ${t ? `
    <div class="row fontRow"><select id="tFont" title="Tipo de letra" aria-label="Tipo de letra">${Object.entries(FONTS).map(([k, [n]]) => `<option value="${k}"${t.font === k ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
    <div class="row tools">
      <div class="seg s3 icons">${['left', 'center', 'right'].map((a) => `<button data-talign="${a}" title="Alinhar ${{ left: 'à esquerda', center: 'ao centro', right: 'à direita' }[a]}"${t.align === a ? ' class="on"' : ''}>${ALIGN_ICONS[a]}</button>`).join('')}</div>
      <span class="sizeCombo"><span class="sizeLabel" aria-hidden="true">Tam.</span><input id="tSize" list="tSizeList" type="number" min="2" max="30" step="0.5" value="${Math.round(t.size * 1000) / 10}" title="Tamanho do texto" aria-label="Tamanho do texto"><datalist id="tSizeList">${TEXT_SIZE_PRESETS.map((v) => `<option value="${v}">`).join('')}</datalist></span>
      <button id="tUppercase" class="btn small uppercaseToggle${t.uppercase ? ' on' : ''}" aria-label="Maiúsculas" aria-pressed="${!!t.uppercase}" title="Alternar maiúsculas">Aa</button>
    </div>
    <div class="row swatches">${TEXT_COLORS.map((c) => `<button class="sw${c === t.color ? ' on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
      <label class="sw pick" title="Outra cor"><input id="tColor" type="color" value="${t.color}"></label></div>
    <div class="seg s3">${[['outline', 'Contorno'], ['box', 'Caixa'], ['plain', 'Simples']].map(([v, n]) => `<button data-tstyle="${v}"${t.style === v ? ' class="on"' : ''}>${n}</button>`).join('')}</div>` : ''}
    ${selected ? `<div class="row pos">
      <button class="btn small" id="elementCenter" title="Centrar no visor">Centrar</button>
      ${t ? `
      <button class="btn small" data-tpos="cx" title="Centrar na horizontal">↔</button>
      <button class="btn small" data-tpos="cy" title="Centrar na vertical">↕</button>
      <button class="btn small" data-tpos="top" title="Em cima">Cima</button>
      ${st.layout === 'streamer' ? '<button class="btn small" data-tpos="split" title="Na divisão câmara/jogo">Divisão</button>' : ''}
      <button class="btn small" data-tpos="bottom" title="Em baixo">Baixo</button>` : ''}
    </div>` : ''}
    ${selected ? `<label class="rotationRow">Rotação <input id="elementAngle" type="number" min="-360" max="360" step="1" value="${selected.rotation || 0}" aria-label="Rotação em graus">°</label>` : ''}
    ${selected ? '</div></details>' : ''}
  </div>`;

  o.querySelector('#addText')?.addEventListener('click', addText);
  o.querySelector('#showImages')?.addEventListener('click', () => { st.textSel = null; elementPanel = elementPanel === 'image' ? '' : 'image'; renderTextOpts(); });
  bindImagePicker(o);
  o.querySelector('#elementOptions')?.addEventListener('toggle', e => {
    if (!e.target.isConnected) return;
    if (e.target.open) expandedElementOptions.add(selected.id); else expandedElementOptions.delete(selected.id);
  });
  o.querySelector('#elementAngle')?.addEventListener('input', e => { selected.rotation = clamp(+e.target.value || 0, -360, 360); saveTexts(); });
  o.querySelector('#elementCenter')?.addEventListener('click', () => { elementEditor.commit(); selected.x = selected.y = .5; elementEditor.commit(); });
  o.querySelector('#imageSize')?.addEventListener('input', e => { selected.size = +e.target.value; saveTexts(); });
  o.querySelector('#replaceMedia')?.addEventListener('click', () => o.querySelector('#replacementFile').click());
  o.querySelector('#replacementFile')?.addEventListener('change', e => replaceLibraryFile(selected.mediaId, e.target.files[0]));
  o.querySelectorAll('[data-tid]').forEach((b) => b.addEventListener('click', () => selectText(b.dataset.tid, true)));
  o.querySelectorAll('[data-tdel]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); elementEditor?.removeById(b.dataset.tdel); }));
  if (!t) return;
  const ta = o.querySelector('#tText');
  ta.addEventListener('input', () => {
    t.text = ta.value;
    const chip = o.querySelector(`[data-tid="${t.id}"] .elementName`);
    if (chip) chip.textContent = t.text.split('\n')[0].slice(0, 18) || 'Texto';
    saveTexts();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); ta.blur(); }
  });
  const set = (props) => { Object.assign(t, props); saveTexts(); renderTextOpts(); };
  o.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => set({ color: b.dataset.color })));
  o.querySelector('#tColor').addEventListener('input', (e) => { t.color = e.target.value; saveTexts(); });
  o.querySelector('#tColor').addEventListener('change', () => renderTextOpts());
  o.querySelectorAll('[data-tstyle]').forEach((b) => b.addEventListener('click', () => set({ style: b.dataset.tstyle })));
  o.querySelectorAll('[data-talign]').forEach((b) => b.addEventListener('click', () => set({ align: b.dataset.talign })));
  o.querySelectorAll('[data-text-preset]').forEach((b) => b.addEventListener('click', () => {
    const preset = TEXT_PRESETS.find(x => x.id === b.dataset.textPreset);
    if (preset) set(preset.values);
  }));
  o.querySelector('#tUppercase').addEventListener('click', () => set({ uppercase: !t.uppercase }));
  o.querySelector('#tSize').addEventListener('input', (e) => { t.size = clamp(+e.target.value || 0, 2, 30) / 100; syncTextSize(); saveTexts(); });
  o.querySelector('#tFont').addEventListener('change', (e) => set({ font: e.target.value }));
  o.querySelectorAll('[data-tpos]').forEach((b) => b.addEventListener('click', () => {
    const halfH = (t._box?.h || 0.06) / 2, p = b.dataset.tpos;
    if (p === 'cx') t.x = 0.5;
    else if (p === 'cy') t.y = 0.5;
    else if (p === 'top') t.y = 0.06 + halfH;
    else if (p === 'bottom') t.y = 0.94 - halfH;
    else if (p === 'split') t.y = st.streamer.split;
    saveTexts();
  }));
}

// ---------- templates (barra de cima): guardam tudo o que está montado ----------
st.templates = [];
let tplCur = loadJSON('sc.template', '');

function renderRecentClips() {
  const sel = $('#recentSel'), current = st.recentId;
  sel.innerHTML = '<option value="">Recentes</option>' + st.recentClips.map((clip) => {
    const date = new Date(clip.at).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
    return `<option value="${esc(clip.id)}">${esc(clip.name)} · ${date}</option>`;
  }).join('');
  sel.value = st.recentClips.some((clip) => clip.id === current) ? current : '';
  sel.disabled = st.recentClips.length === 0 || st.busy;
}

$('#recentSel').addEventListener('change', async (event) => {
  const id = event.target.value;
  if (!id || st.busy) return;
  event.target.value = st.recentId || '';
  if (id === st.recentId) return;
  // Cada aba é um clip: um recente abre numa aba nova (ou nesta, se ainda estiver vazia).
  if (!st.mp4) { location.search = `?recent=${encodeURIComponent(id)}`; return; }
  const tab = window.open(`${extURL('editor.html')}?recent=${encodeURIComponent(id)}`, '_blank');
  if (!tab) setStatus('O browser bloqueou a nova aba — permite pop-ups para abrir o clip recente.');
});
async function openSegmentInNewTab(range) {
  if (!range || !st.blob || st.busy) return;
  const tab = window.open('', '_blank');
  if (!tab) { setStatus('O browser bloqueou a nova aba.'); return; }
  try {
    await saveSession();
    const recent = await saveRecentClip(st.blob, st.name, chanKey);
    st.recentId = recent.id;
    st.recentClips = await listRecentClips();
    renderRecentClips();
    const params = new URLSearchParams({
      recent: recent.id,
      branch: crypto.randomUUID(),
      start: String(range.start),
      end: String(range.end),
    });
    tab.location.replace(`${extURL('editor.html')}?${params}`);
  } catch (error) {
    tab.close();
    setStatus('Não consegui preparar o segmento: ' + error.message);
  }
}

// Elementos para templates/outro clip: já estão no tempo da régua (segundos do vídeo final).
// out = null quando o elemento vai até ao fim (acompanha o fim de qualquer clip).
function elementsInEditTime() {
  const duration = editDuration();
  // out = null só se acaba mesmo no fim dos clips (acompanha o fim de qualquer clip); um ficheiro
  // que acaba antes ou depois guarda o seu fim (e portanto a sua duração).
  const conv = ({ id, _box, ...e }) => ({ ...e, in: e.in ?? 0, out: e.out == null || Math.abs(e.out - duration) < 0.05 ? null : e.out });
  return { duration, texts: st.texts.map(conv), images: st.images.map(conv), audioTracks: st.audioTracks.map(({ id, ...track }) => ({ ...track })) };
}

// Encaixa o tempo de um elemento de um template de duração T num vídeo de duração D (ambos em
// segundos da régua). Antes deslocava tudo pela diferença das durações (ancorado ao fim): um
// template de 30 s num clip de 15 s punha os textos em tempos negativos, que ficavam com 0,1 s —
// apareciam na timeline (largura mínima do bloco) mas quase nunca no vídeo.
function fitTemplateTime(e, T, D) {
  const a = Math.max(0, e.in ?? 0), b = e.out ?? null;
  // Ficheiros (imagem/vídeo) com duração escolhida mantêm-na sempre, mesmo que o clip novo seja mais
  // curto: nunca se cortam nem encolhem — o vídeo final estica até eles acabarem.
  if (e.mediaId && b != null && Math.abs(b - T) >= 0.05) return { in: a, out: b };
  if (e.mediaId && b != null && a > 0.05) {
    const length = b - a;                                                // acaba no fim: fica no fim, com a mesma duração
    return length <= D ? { in: D - length, out: null } : { in: 0, out: length };
  }
  const toEnd = b == null || b >= T - 0.05;
  if (a <= 0.05 && toEnd) return { in: 0, out: null };                  // cobria o vídeo todo: cobre o novo todo
  // Só um bocado: fica com a MESMA duração. No mesmo sítio se couber; senão recua só o necessário
  // para acabar no fim do clip (um texto dos últimos segundos continua nos últimos segundos).
  const length = (toEnd ? T : b) - a;
  if (length >= D - 0.05) return { in: 0, out: null };
  if (a + length <= D) return { in: a, out: toEnd && Math.abs(a + length - D) < 0.05 ? null : a + length };
  return { in: D - length, out: null };
}

// Põe os elementos (textos, imagens, música) de um template ou do clip anterior no vídeo atual.
function placeElements(src, T) {
  const D = st.dur ? editDuration() : 0;
  const fit = (e) => {
    if (!(T > 0) || !(D > 0)) return { ...e };
    const r = fitTemplateTime(e, T, D);
    return { ...e, in: r.in, out: r.out };
  };
  st.texts = (src.texts || []).map((x) => ({ ...fit(x), id: 'T' + ++textSeq }));
  st.images = (src.images || []).map((x) => ({ ...fit(x), id: crypto.randomUUID() }));
  st.audioTracks = (src.audioTracks || []).map((track) => ({
    ...track, id: crypto.randomUUID(),
    start: T > 0 && D > 0 && track.start >= D - 0.5 ? track.start * D / T : track.start,
  }));
  st.audioSel = null;
  normalizeElementTimes();
}

function snapshot() {
  const s = st.streamer;
  const el = elementsInEditTime();
  return {
    v: 2, timeBase: 'edit', duration: el.duration, layout: st.layout,
    framing: structuredClone(st.framing),
    streamer: { split: s.split, bottom: s.bottom, mediaId: s.mediaId, scale: s.scale, ox: s.ox, oy: s.oy, cam: s.cam, game: s.game },
    crop: st.crop.keys.length ? cropAt(video.currentTime) : loadJSON('sc.crop', null),
    texts: el.texts,
    images: el.images,
    audioTracks: el.audioTracks,
  };
}

function renderTemplates() {
  const sel = $('#tplSel'), list = st.templates.filter((t) => t.v === 2).sort((a, b) => a.name.localeCompare(b.name));
  if (!list.some((t) => t.id === tplCur)) tplCur = '';
  sel.innerHTML = `<option value="">${list.length ? 'Templates' : 'Sem templates'}</option>` +
    list.map((t) => `<option value="${t.id}"${t.id === tplCur ? ' selected' : ''}>${esc(t.name)}</option>`).join('');
  const current = list.find(t => t.id === tplCur);
  sel.title = current?.name || 'Escolher template';
  $('#tplUpdate').disabled = !current || templateWorking;
  $('#tplUpdate').title = current ? `Guardar alterações em «${current.name}»` : 'Seleciona um template para atualizar';
  $('#tplUpdate').setAttribute('aria-label', $('#tplUpdate').title);
  if ($('#templatesDlg').open) renderTemplateList();
}

function applyTemplateSnap(t) {
  st.framing = normalizeFraming(t.framing);
  const s = st.streamer;
  Object.assign(s, t.streamer);
  const ch = camH(OUT_V.h);
  if (s.cam) s.cam = fitRect(s.cam, OUT_V.w / ch);
  if (s.game) s.game = fitRect(s.game, OUT_V.w / (OUT_V.h - ch));
  st.crop.keys = [];
  if (t.crop) saveJSON('sc.crop', t.crop);
  // Sem clip ainda (abrir o editor já com o último template): encaixa-se quando o clip chegar.
  pendingTemplate = st.dur > 0 ? null : t;
  placeElements(t, t.duration);
  st.textSel = null;
  savePrefs();
  rememberCam();
  saveTexts();
  setLayout(t.layout || 'streamer');
  syncMediaTime();
  syncAudioPreview(true);
  elementEditor?.reset();
  resetEditHistory();
}

$('#tplSel').addEventListener('change', (e) => {
  const t = st.templates.find((x) => x.id === e.target.value);
  tplCur = t ? t.id : '';
  saveJSON('sc.template', tplCur);
  renderTemplates();
  if (t) { applyTemplateSnap(t); showToast(`Template «${t.name}» aplicado.`); }
  e.target.blur();
});

let templateDeleteId = null, templateWorking = false;
const templateWithoutCaption = ({ caption, ...template }) => template;
function renderTemplateList() {
  const list = st.templates.filter(t => t.v === 2).sort((a, b) => a.name.localeCompare(b.name));
  $('#templateList').innerHTML = list.length ? list.map(t => `<div class="templateItem${t.id === tplCur ? ' on' : ''}" data-template-id="${esc(t.id)}">
    <input class="templateRename" aria-label="Nome de ${esc(t.name)}" maxlength="80" value="${esc(t.name)}">
    <div class="templateActions"><button class="btn small" data-template-action="apply">Utilizar template</button><button class="btn small" data-template-action="rename">Renomear</button><button class="btn small" data-template-action="duplicate">Duplicar</button><button class="btn small danger" data-template-action="delete">Apagar</button></div>
    ${templateDeleteId === t.id ? '<div class="templateConfirm"><span>Apagar este template?</span><button class="btn small danger" data-template-action="confirm-delete">Apagar</button><button class="btn small" data-template-action="cancel-delete">Cancelar</button></div>' : ''}
  </div>`).join('') : '<p class="muted">Ainda não tens templates. Guarda a edição atual para reutilizá-la.</p>';
}
function openTemplates(saveCurrent = false) {
  if (st.busy) return;
  templateDeleteId = null;
  $('#templateMessage').textContent = '';
  $('#templateName').value = '';
  renderTemplateList(); $('#templatesDlg').showModal();
  if (saveCurrent) { $('#templateName').focus(); $('#templateName').select(); }
}
let toastTimer = 0;
function showToast(message, type = 'success') {
  const region = $('#toastRegion'), toast = document.createElement('div'), icon = document.createElement('span'), text = document.createElement('span');
  clearTimeout(toastTimer);
  toast.className = `toast${type === 'error' ? ' error' : ''}`;
  icon.className = 'toastIcon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = type === 'error' ? '!' : '✓';
  text.textContent = message;
  toast.append(icon, text);
  region.replaceChildren(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 180);
  }, 3200);
}
async function templateMutation(action) {
  if (templateWorking || st.busy) return;
  templateWorking = true;
  const controls = [...document.querySelectorAll('#templatesDlg button, #templatesDlg input, .tpl button, .tpl select')].map(el => [el, el.disabled]);
  controls.forEach(([el]) => el.disabled = true);
  try {
    const message = await action();
    renderTemplates();
    if (message) showToast(message);
  } catch (e) {
    const message = 'Não consegui guardar a alteração: ' + e.message;
    $('#templateMessage').textContent = message;
    showToast(message, 'error');
  }
  finally { templateWorking = false; controls.forEach(([el, disabled]) => el.disabled = disabled); $('#tplUpdate').disabled = !tplCur; }
}
$('#tplUpdate').addEventListener('click', () => {
  const current = st.templates.find(t => t.id === tplCur);
  if (!current) return;
  templateMutation(async () => {
    const updated = { ...templateWithoutCaption(current), ...snapshot(), at: Date.now() };
    await putTemplate(updated);
    st.templates = st.templates.map(t => t.id === updated.id ? updated : t);
    return `Alterações guardadas em «${updated.name}».`;
  });
});
$('#tplSave').addEventListener('click', () => openTemplates(true));
$('#tplManage').addEventListener('click', () => openTemplates());
$('#templatesClose').addEventListener('click', () => $('#templatesDlg').close());
$('#templateSaveForm').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#templateName').value.trim();
  if (!name) { $('#templateName').focus(); return; }
  templateMutation(async () => {
    const same = st.templates.find(t => t.v === 2 && t.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (same) throw new Error('Já existe um template com esse nome. Escolhe outro nome ou usa «Atualizar».');
    const t = { ...snapshot(), id: crypto.randomUUID(), name, at: Date.now() };
    await putTemplate(t);
    st.templates = [...st.templates.filter(x => x.id !== t.id), t];
    tplCur = t.id; saveJSON('sc.template', tplCur);
    $('#templateName').value = '';
    $('#templatesDlg').close();
    return `Template «${name}» criado.`;
  });
});
$('#templateList').addEventListener('click', e => {
  const action = e.target.closest('[data-template-action]')?.dataset.templateAction;
  const row = e.target.closest('[data-template-id]');
  const t = st.templates.find(t => t.id === row?.dataset.templateId);
  if (!action || !t || templateWorking || st.busy) return;
  if (action === 'apply') {
    tplCur = t.id; saveJSON('sc.template', tplCur); applyTemplateSnap(t); renderTemplates();
    $('#templatesDlg').close(); showToast(`Template «${t.name}» aplicado.`); return;
  }
  if (action === 'delete' || action === 'cancel-delete') {
    templateDeleteId = action === 'delete' ? t.id : null;
    renderTemplateList();
    $('#templateList').querySelector(`[data-template-id="${t.id}"] [data-template-action="${action === 'delete' ? 'confirm-delete' : 'delete'}"]`)?.focus();
    return;
  }
  const name = row.querySelector('.templateRename').value.trim();
  templateMutation(async () => {
    if (action === 'confirm-delete') {
      await deleteTemplate(t.id);
      st.templates = st.templates.filter(x => x.id !== t.id);
      if (tplCur === t.id) { tplCur = ''; saveJSON('sc.template', ''); }
      templateDeleteId = null;
      return `Template «${t.name}» apagado.`;
    }
    let updated;
    if (action === 'rename') {
      if (!name) throw new Error('Escreve um nome.');
      if (st.templates.some(x => x.id !== t.id && x.v === 2 && x.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new Error('Já existe um template com esse nome.');
      updated = { ...templateWithoutCaption(t), name };
    } else if (action === 'duplicate') {
      let copyName = `${t.name} (cópia)`, n = 2;
      while (st.templates.some(x => x.name.toLocaleLowerCase() === copyName.toLocaleLowerCase())) copyName = `${t.name} (cópia ${n++})`;
      updated = { ...templateWithoutCaption(structuredClone(t)), id: crypto.randomUUID(), name: copyName, at: Date.now() };
    } else return;
    await putTemplate(updated);
    st.templates = [...st.templates.filter(x => x.id !== updated.id), updated];
    return action === 'rename' ? `Template «${updated.name}» renomeado.` : `Template «${updated.name}» duplicado.`;
  });
});

// ---------- carregar clip ----------
// Guarda o que se está a editar neste clip (corte, posições ◆, textos) para voltar após um refresh.
let sessionKey = '';
function saveSession() {
  if (!sessionKey) return;
  // v: 3 = faixa de vídeo como lista de clips e elementos no tempo da régua.
  const session = {
    key: sessionKey, v: 3, parts: st.parts, activePart: st.activePart, keys: st.crop.keys,
    framing: st.framing,
    texts: st.texts.map(({ id, _box, ...rest }) => rest),
    images: cleanElements(st.images),
    audioTracks: st.audioTracks.map(({ id, ...track }) => track),
    at: Date.now(),
  };
  saveJSON('sc.session', session);
  return saveEditorSession(sessionKey, session).catch((error) => console.warn('sessão', error));
}
setInterval(saveSession, 2000);
addEventListener('pagehide', saveSession);
// Ao limpar os guardados no menu da extensão, as abas abertas não voltam a gravar
// automaticamente a sessão que acabou de ser apagada.
addEventListener('storage', (event) => {
  if (event.key === 'sc.session' && event.newValue === null) sessionKey = '';
});
async function restoreSession() {
  const ss = await loadEditorSession(sessionKey) || loadJSON('sc.session', null);
  if (!ss || ss.key !== sessionKey) return false;
  st.framing = normalizeFraming(ss.framing);
  let parts = Array.isArray(ss.parts) ? ss.parts : null;
  if (ss.v !== 3) {
    // Formato antigo: corte global [start, end], parts podia ser null e os «+ Vídeo» ficavam à parte.
    const a = clamp(ss.start ?? 0, 0, st.dur), b = clamp(ss.end ?? st.dur, a, st.dur);
    parts = (parts?.length ? parts : [{ start: a, end: b }]).map((r) => ({ start: clamp(r.start, a, b), end: clamp(r.end, a, b) }));
    for (const clip of ss.sequenceClips || []) parts.push({ mediaId: clip.mediaId, start: clip.trimStart || 0, end: clip.trimEnd ?? clip.dur });
  }
  st.parts = cleanParts(parts);
  st.activePart = clamp(ss.activePart || 0, 0, Math.max(0, st.parts.length - 1));
  partSel = -1;
  st.crop.keys = (ss.keys || []).filter((k) => k.t <= st.dur);
  // No formato antigo os textos/imagens estavam em segundos da fonte: passam para a régua.
  const toEdit = (e) => (ss.v === 3 ? e : { ...e, in: sourceToEdit(e.in ?? 0), out: e.out == null ? null : sourceToEdit(e.out) });
  if (ss.texts) { st.texts = ss.texts.map((x) => ({ ...toEdit(x), id: 'T' + ++textSeq })); st.textSel = null; }
  st.images = (ss.images || []).map(x => ({ ...toEdit(x), id: crypto.randomUUID() }));
  st.audioTracks = (ss.audioTracks || []).map(track => ({ ...track, id: crypto.randomUUID() }));
  st.audioSel = null;
  normalizeAudioTracks();
  return true;
}

// Clips válidos: dentro da duração da fonte (ou do ficheiro da biblioteca), nunca vazios.
function cleanParts(parts) {
  const out = (parts || []).filter((p) => p && Number.isFinite(p.start) && Number.isFinite(p.end) && (!p.mediaId || libItem(p.mediaId)))
    .map((p) => {
      const max = p.mediaId ? libItem(p.mediaId).dur : st.dur, start = clamp(p.start, 0, max);
      return { ...(p.mediaId ? { mediaId: p.mediaId } : {}), start, end: clamp(p.end, start, max) };
    })
    .filter((p) => p.end - p.start > 0.05);
  return out.length ? out : [{ start: 0, end: st.dur }];
}

function normalizeElementTimes() {
  const D = timelineDuration();
  if (!D) return;
  for (const e of orderedElements(st)) {
    // Se o início ficou totalmente fora do novo clip (texto "mantido" ou template vindos de um
    // clip bem mais longo), o clamp simples abaixo encolhia-o para uma fração de segundo mesmo
    // no fim — "existe" no estado, mas impossível de ver a passar o vídeo normalmente. Nesse
    // caso extremo reancora-se ao início, preservando a duração pretendida em vez da posição.
    if ((e.in ?? 0) >= D) {
      const length = e.out != null ? clamp(e.out - e.in, .1, D) : D;
      e.in = 0;
      if (e.out != null) e.out = clamp(length, .1, D);
      continue;
    }
    e.in = clamp(e.in ?? 0, 0, Math.max(0, D - .1));
    if (e.out != null) e.out = clamp(e.out, Math.min(D, e.in + .1), D);
  }
  normalizeAudioTracks();
}

let clipLoadId = 0, clipURL = null;
async function loadClip(blob, name, channel, fromStore = false, initialRange = null, branchId = '') {
  await saveSession();
  const loadId = ++clipLoadId;
  // Os elementos que já estavam no editor (de outro clip) passam para o novo pela régua.
  const carried = st.dur > 0 ? elementsInEditTime() : null;
  let url = null;
  try {
    resetSequencePreview();
    setStatus('A abrir o clip…');
    const buf = await blob.arrayBuffer();
    const mp4 = parseMp4(buf);
    if (!mp4.samples.length || !Number.isFinite(mp4.duration) || mp4.duration <= 0) throw new Error('O clip não contém vídeo reproduzível.');
    if (loadId !== clipLoadId) return;
    url = URL.createObjectURL(blob);
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', loaded);
        video.removeEventListener('error', failed);
        error ? reject(error) : resolve();
      };
      const loaded = () => finish();
      const failed = () => finish(new Error('O browser não conseguiu reproduzir o clip.'));
      const timer = setTimeout(() => finish(new Error('O vídeo demorou demasiado a abrir.')), 15000);
      video.addEventListener('loadedmetadata', loaded);
      video.addEventListener('error', failed);
      video.src = url;
    });
    if (loadId !== clipLoadId) { URL.revokeObjectURL(url); return; }
    if (clipURL) URL.revokeObjectURL(clipURL);
    clipURL = url;
    setCaption('');
    Object.assign(st, { blob, name: name || 'clip.mp4', buf, mp4, srcW: mp4.width, srcH: mp4.height, dur: mp4.duration });
    st.parts = [{ start: 0, end: mp4.duration }];
    st.activePart = 0;
    partSel = -1;
    pxPerSec = 0;                                   // a timeline abre a mostrar o clip inteiro
    st.crop.keys = [];
    st.framing = normalizeFraming(st.templates.find(t => t.id === tplCur)?.framing);
    chanKey = channel || '_last';
    if (video.videoWidth) { st.srcW = video.videoWidth; st.srcH = video.videoHeight; }
    const known = restoreCam();                     // depois de saber o tamanho real do vídeo
    st.dur = Math.min(st.dur, video.duration || st.dur);
    st.parts = [{ start: 0, end: st.dur }];
    if (initialRange && Number.isFinite(initialRange.start) && Number.isFinite(initialRange.end)) {
      const rangeStart = clamp(initialRange.start, 0, st.dur);
      const rangeEnd = clamp(initialRange.end, rangeStart + 0.05, st.dur);
      if (rangeEnd - rangeStart > 0.05) st.parts = [{ start: rangeStart, end: rangeEnd }];
    }
    sessionKey = `${st.name}|${blob.size}${branchId ? `|branch:${branchId}` : ''}`;
    // Os clips virtuais da sessão referenciam a biblioteca persistida. Esperar por
    // ela evita perder a sequência quando o editor é recarregado muito depressa.
    await libraryReady;
    const resumed = await restoreSession();
    if (!resumed) {
      if (pendingTemplate) placeElements(pendingTemplate, pendingTemplate.duration);
      else if (carried) placeElements(carried, carried.duration);
    }
    pendingTemplate = null;
    normalizeElementTimes();
    // Guarda o clip (e o canal) para um refresh o voltar a abrir; tira o #pending do endereço.
    if (!fromStore) {
      saveLastClip(blob, st.name, channel).catch(() => {});
      saveRecentClip(blob, st.name, channel).then(async (recent) => {
        if (loadId !== clipLoadId) return;
        st.recentId = recent.id;
        st.recentClips = await listRecentClips();
        renderRecentClips();
      }).catch((error) => console.warn('recentes', error));
    }
    if (!fromStore && (location.hash || location.search)) {
      const devSource = DEV && new URLSearchParams(location.search).has('src') ? location.search : '';
      history.replaceState(null, '', location.pathname + devSource);
    }
    stage.classList.add('loaded');
    $('#fileName').textContent = st.name;
    $('#fileName').classList.remove('muted');
    $('#export').disabled = $('#exportTT').disabled = false;
    setLayout(st.layout);
    updateTimeline();
    seekTimelineTime(0);
    renderTextOpts();
    elementEditor?.reset();
    resetEditHistory();
    setStatus(`${st.srcW}×${st.srcH} · ${Math.round(mp4.fps)} fps · ${st.dur.toFixed(1)}s` + (known ? ' · câmara deste canal' : '') + (resumed ? ' · edição recuperada' : ''));
    setTimeout(() => getFFmpeg().catch(() => {}), 400);    // a exportação já o encontra carregado
  } catch (e) {
    if (url && url !== clipURL) URL.revokeObjectURL(url);
    if (loadId !== clipLoadId) return;
    console.error(e);
    if (!st.mp4) $('#drop').textContent = 'Não consegui abrir o clip: ' + e.message;
    if (clipURL) video.src = clipURL;
    setStatus('Não consegui abrir este ficheiro: ' + e.message);
  }
}

// Cada aba é um clip: com um clip já aberto, abrir outro (ficheiro, arrastar, recentes) vai para
// uma aba nova, em vez de misturar edições de clips diferentes na mesma aba.
async function openClipFile(file) {
  if (!file) return;
  if (!st.mp4) return loadClip(file, file.name);
  const tab = window.open('', '_blank');
  if (!tab) { setStatus('O browser bloqueou a nova aba — permite pop-ups para abrir outro clip.'); return; }
  try {
    const recent = await saveRecentClip(file, file.name, '');
    tab.location.replace(`${extURL('editor.html')}?recent=${encodeURIComponent(recent.id)}`);
  } catch (error) { tab.close(); setStatus('Não consegui abrir o clip: ' + error.message); }
}
$('#fileInput').addEventListener('change', (e) => { openClipFile(e.target.files[0]); e.target.value = ''; });
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  openClipFile(e.dataTransfer.files[0]);
});
addEventListener('resize', placeRects);

// O clip chega da aba da live (quem abriu o editor) por postMessage.
// #pending = o editor abriu no clique e o clip ainda está a ser preparado.
const editorParams = new URLSearchParams(location.search);
const openBlank = editorParams.has('blank');
const recentIdParam = editorParams.get('recent');
const branchIdParam = editorParams.get('branch') || '';
const initialRange = branchIdParam ? { start: Number(editorParams.get('start')), end: Number(editorParams.get('end')) } : null;
// #pending=<id>: o id do clique (o mesmo que o processador usa ao guardar o clip no IndexedDB).
const pendingId = location.hash.startsWith('#pending=') ? decodeURIComponent(location.hash.slice(9)) : '';
const pending = location.hash.startsWith('#pending') || !!recentIdParam;
const openedAt = Date.now();
if (pending) {
  $('#drop').textContent = recentIdParam ? 'A abrir o clip recente…' : 'A preparar o clip…';
  setStatus(recentIdParam ? 'A abrir o clip recente…' : 'A preparar o clip na aba da live…');
}
addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || (window.opener && ev.source !== window.opener)) return;
  if (m.__scEd === 'clip') { clipArrived = true; loadClip(m.blob, m.name, m.channel); }
  if (m.__scEd === 'progress' && !st.mp4 && !clipArrived && !clipFailed && m.text) {
    lastHeardAt = Date.now();
    $('#drop').textContent = 'A preparar o clip… · ' + m.text;
    setStatus(m.text);
  }
  if (m.__scEd === 'error' && !st.mp4) {
    clipFailed = true;
    $('#drop').textContent = 'O clip falhou: ' + m.message;
    setStatus('Falhou: ' + m.message);
  }
});
let clipArrived = false, clipFailed = false;
if (window.opener) window.opener.postMessage({ __scEd: 'ready' }, '*');
// Sem notícias da aba da live há muito tempo: diz ao utilizador onde ver o que se passa.
let lastHeardAt = Date.now();
if (pending && !recentIdParam) {
  const watchdog = setInterval(() => {
    if (st.mp4 || clipArrived || clipFailed) { clearInterval(watchdog); return; }
    const quiet = (Date.now() - lastHeardAt) / 1000;
    if (quiet < 45) return;
    $('#drop').textContent = window.opener
      ? `Sem notícias da aba da live há ${Math.round(quiet)} s. Olha para o painel do Clipper nessa aba: se mostrar um erro, tira o clip outra vez. Se a aba foi fechada ou recarregada, o clip perdeu-se.`
      : 'Esta aba não consegue falar com a aba da live (o site bloqueia). O clip abre aqui sozinho quando ficar pronto — ou vê em «Recentes».';
  }, 5000);
}
// Plano B, se a mensagem da aba da live não chegar: o processador também guarda o clip no
// IndexedDB. Com #pending espera-se por um clip mais recente do que esta aba; sem, abre o último.
(async () => {
  if (recentIdParam) {
    try {
      const clip = await loadRecentClip(recentIdParam);
      if (!clip?.blob) throw new Error('Este clip já não está disponível.');
      await touchRecentClip(recentIdParam);
      st.recentId = recentIdParam;
      return loadClip(clip.blob, clip.name, clip.channel, true, initialRange, branchIdParam);
    } catch (error) {
      $('#drop').textContent = 'Não consegui abrir o clip recente: ' + error.message;
      setStatus($('#drop').textContent);
      return;
    }
  }
  // Com id, espera pelo clip desse clique (até 15 min: um clip na fila ou a recodificar pode
  // demorar); sem id (versões antigas), aceita o último clip mais recente do que esta aba.
  const tries = openBlank ? 0 : !pending ? 1 : pendingId ? 900 : 180;
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, pending ? 1000 : 300));
    if (st.mp4 || srcParam || clipArrived || clipFailed) return;
    try {
      const c = pendingId ? await loadClipById(pendingId) : await loadLastClip();
      if (c?.blob && !st.mp4 && !clipArrived && (!pending || pendingId || c.at > openedAt - 1000)) return loadClip(c.blob, c.name, c.channel, true);
    } catch {}
  }
  if (pending && !st.mp4 && !clipArrived && !clipFailed) {
    $('#drop').textContent = 'O clip não chegou. Abre-o em «Recentes» ou tira outro clip.';
    setStatus($('#drop').textContent);
  }
})();
const DEV = location.protocol !== 'chrome-extension:';
const srcParam = DEV && new URLSearchParams(location.search).get('src');
if (srcParam) fetch(srcParam).then((r) => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.blob();
}).then((b) => loadClip(b, srcParam.split('/').pop())).catch((e) => {
  $('#drop').textContent = 'Não consegui carregar o clip: ' + e.message;
  setStatus($('#drop').textContent);
});

// ---------- exportar ----------
function setStatus(t) { $('#status').textContent = t; }
function setProgress(p) {
  $('#progress').hidden = p == null;
  if (p != null) $('#progress div').style.width = Math.round(p * 100) + '%';
}

async function pickEncoder(w, h, fps) {
  // ≈0,2 bit/píxel: 1080×1920 a 30 fps ≈ 12 Mbps, a 60 fps ≈ 20 Mbps (antes 12 Mbps fixos, pouco
  // para 60 fps — o TikTok ainda recomprime, por isso convém entregar-lhe boa qualidade).
  const bitrate = Math.round(clamp(w * h * fps * 0.2, 8_000_000, 20_000_000));
  const base = { width: w, height: h, framerate: fps, bitrate, avc: { format: 'annexb' }, latencyMode: 'quality' };
  for (const codec of ['avc1.64002a', 'avc1.640028', 'avc1.4d002a', 'avc1.42002a']) {
    for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
      const cfg = { ...base, codec, hardwareAcceleration };
      try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch {}
    }
  }
  throw new Error('Este browser não consegue codificar H.264 (WebCodecs).');
}

// Esperas com limite: se o browser/placa gráfica encravar, a exportação falha com uma mensagem
// (e dá para tentar outra vez) em vez de ficar parada para sempre.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(t));
}
function checkAbort() { if (st.abort) throw new Error('Exportação cancelada.'); }

async function encodeVideo(onProgress) {
  const assets = new Map(), cleanup = [];
  try {
    for (const element of st.images) {
      checkAbort();
      const m = libItem(element.mediaId);
      if (!m) throw new Error('Falta um ficheiro usado no vídeo. Volta a carregá-lo.');
      if (m.type === 'image' && !isGif(m)) {
        const bmp = await createImageBitmap(m.blob);
        cleanup.push(() => bmp.close());
        assets.set(element.id, async () => ({ img: bmp, w: bmp.width, h: bmp.height }));
      } else {
        // Cada elemento tem o seu leitor, mesmo que repita o mesmo ficheiro noutro instante.
        const reader = await openMediaReader(m);
        cleanup.push(() => reader.close());
        assets.set(element.id, async time => {
          const frame = await withTimeout(reader.frameAt(Math.max(0, time - (element.in ?? 0)) % reader.duration), 10000, `Não consegui ler «${m.name}».`);
          if (!frame) throw new Error(`Não consegui ler «${m.name}».`);
          return { img: frame, w: frame.displayWidth, h: frame.displayHeight };
        });
      }
    }
    return await encodeVideoFrames(onProgress, assets);
  } finally { for (const close of cleanup) close(); }
}

async function loadTextFonts() {
  if (!document.fonts?.load) return;
  const fonts = [...new Set(st.texts.filter(t => t.text?.trim()).map(t => t.font || 'moderna'))];
  await Promise.all(fonts.map(font => {
    const definition = FONTS[font] || FONTS.moderna;
    return document.fonts.load(definition[1](48), 'Aaáçõ').catch(() => []);
  }));
}

async function encodeVideoFrames(onProgress, assets) {
  await loadTextFonts();
  const { mp4, buf } = st;
  const { w: W, h: H } = outSize();
  const fps = mp4.fps >= 45 ? 60 : Math.min(30, Math.max(24, Math.round(mp4.fps)));
  const ranges = getRanges();
  if (!ranges.length) throw new Error('Não há segmentos para exportar.');
  const frameCounts = ranges.map(r => Math.max(1, Math.round((r.end - r.start) * fps)));
  const tailFrames = Math.round(tailLength() * fps);                     // depois do último clip (último frame parado)
  const total = frameCounts.reduce((sum, count) => sum + count, 0) + tailFrames;
  const samples = mp4.samples;

  const out = [];
  let encError = null;
  const encoder = new VideoEncoder({
    output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); out.push(b); },
    error: (e) => { encError = e; },
  });
  encoder.configure(await pickEncoder(W, H, fps));

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { alpha: false });
  // Imagem/vídeo de baixo (Streamer): imagem como ImageBitmap, vídeo lido frame a frame em loop.
  let media = null;          // async (t) => {img, w, h}
  const cleanup = [];
  const m = st.layout === 'streamer' && st.streamer.bottom === 'media' && libItem(st.streamer.mediaId);
  if (m?.type === 'image' && !isGif(m)) {
    const bmp = await createImageBitmap(m.blob);
    cleanup.push(() => bmp.close());
    media = async () => ({ img: bmp, w: bmp.width, h: bmp.height });
  } else if (m) {
    const r = await openMediaReader(m);
    cleanup.push(() => r.close());
    let last = null;
    media = async (t) => {
      // Se o vídeo da biblioteca encravar, repete o último frame em vez de parar tudo.
      const f = await withTimeout(r.frameAt(t % r.duration), 4000, 'vídeo da biblioteca').catch(() => null);
      if (f) last = { img: f, w: f.displayWidth, h: f.displayHeight };
      return last;
    };
  }

  let n = 0, decError = null;
  let lastOut = performance.now();          // última vez que algo avançou (para detetar encravanços)
  const editDur = timelineDuration(), offs = rangeOffsets();
  const emit = async (frame, sourceTime, editTime) => {
    checkAbort();
    const got = media && (await media(n / fps));
    const elementMedia = new Map();
    for (const element of st.images) {
      if (elementVisible(element, editTime, editDur)) elementMedia.set(element.id, await assets.get(element.id)(editTime));
    }
    renderFrame(ctx, frame, frame.displayWidth, frame.displayHeight, sourceTime, W, H, () => got, elementMedia, editTime);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((n * 1e6) / fps), duration: Math.round(1e6 / fps) });
    encoder.encode(vf, { keyFrame: n % (fps * 2) === 0 });
    vf.close();
    n++;
    lastOut = performance.now();
    if (n % 10 === 0) onProgress(n / total);
    if (encoder.encodeQueueSize > 12) await withTimeout(new Promise((r) => {
      const wait = () => (encoder.encodeQueueSize > 4 && !encError ? setTimeout(wait, 2) : r());
      wait();
    }), 15000, 'O codificador de vídeo parou de responder.');
  };
  const decoded = [];
  const decoder = new VideoDecoder({ output: (frame) => { decoded.push(frame); lastOut = performance.now(); }, error: (e) => { decError = e; } });
  const dcfg = { codec: mp4.codec, codedWidth: mp4.width, codedHeight: mp4.height, description: mp4.description };
  if (!(await VideoDecoder.isConfigSupported(dcfg)).supported) throw new Error('O browser não consegue descodificar este vídeo (' + mp4.codec + ').');
  decoder.configure(dcfg);

  const u8 = new Uint8Array(buf);
  try {
    for (let part = 0; part < ranges.length; part++) {
      const range = ranges[part], partFrames = frameCounts[part];
      decoder.reset();
      decoder.configure(dcfg);
      let i0 = 0;
      for (let i = 0; i < samples.length && samples[i].pts <= range.start + 1e-3; i++) if (samples[i].key) i0 = i;
      let partN = 0, prev = null;
      const handle = async (frame) => {
        const ts = frame.timestamp / 1e6;
        while (prev && partN < partFrames && range.start + partN / fps < ts) {
          await emit(prev, range.start + partN / fps, offs[part].editStart + partN / fps);
          partN++;
        }
        prev?.close();
        prev = frame;
      };
      for (let i = i0; ;) {
        while (decoded.length) await handle(decoded.shift());
        if (decError || encError) break;
        if (i >= samples.length || samples[i].dts > range.end + 1) break;
        if (decoder.decodeQueueSize > 6 || encoder.encodeQueueSize > 6) {
          if (performance.now() - lastOut > 8000) break;
          await sleep(1);
          continue;
        }
        const sample = samples[i++];
        decoder.decode(new EncodedVideoChunk({
          type: sample.key ? 'key' : 'delta', timestamp: Math.round(sample.pts * 1e6), data: u8.subarray(sample.offset, sample.offset + sample.size),
        }));
      }
      let flushed = false;
      decoder.flush().then(() => { flushed = true; }, (e) => { decError = decError || e; flushed = true; });
      while (!flushed && !decError) {
        if (decoded.length) { while (decoded.length) await handle(decoded.shift()); continue; }
        if (performance.now() - lastOut > 5000) break;
        await sleep(2);
      }
      while (decoded.length) await handle(decoded.shift());
      if (prev) {
        while (partN < partFrames) {
          await emit(prev, range.start + partN / fps, offs[part].editStart + partN / fps);
          partN++;
        }
        if (part === ranges.length - 1) {
          const videoEnd = offs[part].editEnd;
          for (let k = 0; k < tailFrames; k++) await emit(prev, range.end, videoEnd + k / fps);
        }
        prev.close();
      }
      if (!n) throw new Error('O vídeo não descodificou nenhum frame.');
      if (decError || encError) break;
    }
    await withTimeout(encoder.flush(), 20000, 'O codificador de vídeo não terminou.');
  } finally {
    for (const f of decoded) f.close();
    for (const c of cleanup) c();
    try { decoder.close(); } catch {}
    try { encoder.close(); } catch {}
  }
  if (encError) throw encError;
  if (decError && n < total * 0.9) throw decError;
  return { h264: new Blob(out), fps, frames: n };
}

let ffmpeg = null, ffmpegLoading = null;
async function getFFmpeg() {
  if (ffmpeg) return ffmpeg;
  if (!ffmpegLoading) ffmpegLoading = (async () => {
    const f = new FFmpeg();
    try {
      await f.load({ coreURL: extURL('lib/core/ffmpeg-core.js'), wasmURL: extURL('lib/core/ffmpeg-core.wasm') });
      return (ffmpeg = f);
    } catch (e) { f.terminate(); throw e; }
    finally { ffmpegLoading = null; }
  })();
  return ffmpegLoading;
}

// ---------- legenda + publicar no TikTok ----------
// O TikTok Studio abre logo no clique (carrega enquanto o vídeo é gerado). Quando o MP4 fica pronto,
// o tiktok.js (content script na página do TikTok) pede-o a esta aba por chrome.runtime, aos bocados
// (as mensagens só levam texto e têm limite de tamanho), e mete-o lá com a legenda.
const TT_UPLOAD = 'https://www.tiktok.com/tiktokstudio/upload?from=upload';
st.caption = '';
const lastCaption = () => loadJSON('sc.lastCaption', loadJSON('sc.caption', ''));
function setCaption(v) {
  st.caption = v;
  if ($('#ttCap').value !== v) $('#ttCap').value = v;
  $('#ttLastCaption').disabled = !lastCaption();
}
setCaption(st.caption);

// ---------- predefinições de legenda/hashtags (reaproveitar sem escrever de novo) ----------
const captionPresets = () => loadJSON('sc.captionPresets', []);
function renderCaptionPresets() {
  const wrap = $('#ttPresets'), list = captionPresets();
  wrap.innerHTML = list.map((p, i) => `<span class="capPreset">
    <button type="button" class="btn small" data-apply-preset="${i}" title="${esc(p.text)}">${esc(p.name)}</button>
    <button type="button" class="capPresetDel" data-del-preset="${i}" title="Apagar preset «${esc(p.name)}»" aria-label="Apagar preset ${esc(p.name)}">×</button>
  </span>`).join('');
  wrap.querySelectorAll('[data-apply-preset]').forEach((b) => b.addEventListener('click', () => {
    const p = list[+b.dataset.applyPreset];
    if (!p) return;
    const cur = $('#ttCap').value.trim();
    setCaption(cur ? `${cur}\n${p.text}` : p.text);
    $('#ttCap').focus();
  }));
  wrap.querySelectorAll('[data-del-preset]').forEach((b) => b.addEventListener('click', () => {
    list.splice(+b.dataset.delPreset, 1);
    saveJSON('sc.captionPresets', list);
    renderCaptionPresets();
  }));
}
renderCaptionPresets();
$('#ttPresetSaveBtn').addEventListener('click', () => {
  const name = $('#ttPresetName').value.trim(), text = $('#ttCap').value.trim();
  if (!name || !text) return;
  const list = captionPresets();
  list.push({ name, text });
  saveJSON('sc.captionPresets', list);
  $('#ttPresetName').value = '';
  renderCaptionPresets();
});
$('#ttPresetName').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#ttPresetSaveBtn').click(); } });

const ttSignal = (v) => { try { chrome.storage?.local?.set({ scTikTok: { ...v, at: Date.now() } }); } catch {} };
let ttTab = null, ttId = '', ttOut = null;
async function openTikTok() {
  ttId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  ttSignal({ state: 'pending', id: ttId });
  if (globalThis.chrome?.tabs?.create) {
    const tab = await chrome.tabs.create({ url: TT_UPLOAD, active: false });   // passa para a frente com o vídeo pronto
    ttTab = tab?.id ?? null;
  } else {
    window.open(TT_UPLOAD, '_blank');
  }
}
async function handToTikTok(blob, name, plan) {
  ttOut = { id: ttId, blob, name, caption: plan.caption, schedule: plan.when === 'at' ? { date: plan.date, time: plan.time } : null };
  ttSignal({ state: 'ready', id: ttId, name });
  if (ttTab != null) {
    try {
      const tab = await chrome.tabs.update(ttTab, { active: true });
      if (tab?.windowId != null) chrome.windows?.update(tab.windowId, { focused: true });
    } catch {                                        // a aba foi fechada entretanto: abre outra
      await chrome.tabs.create({ url: TT_UPLOAD, active: true });
    }
  }
  ttTab = null;
}

const blobToB64 = (b) => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).slice(String(r.result).indexOf(',') + 1));
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});
globalThis.chrome?.runtime?.onMessage?.addListener((m, sender, reply) => {
  const p = ttOut;
  if (!p || !m?.scTT || m.id !== p.id) return false;          // é para outra aba do editor
  if (m.scTT === 'info') { reply({ name: p.name, caption: p.caption, schedule: p.schedule, size: p.blob.size, type: p.blob.type }); return false; }
  if (m.scTT === 'chunk') { blobToB64(p.blob.slice(m.offset, m.offset + m.len)).then(reply, () => reply(null)); return true; }
  return false;
});

// ---------- diálogo «Publicar no TikTok» (preenche-se enquanto o vídeo é gerado) ----------
const ttDlg = $('#ttDlg');
const pad2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const TT_MIN_MS = 16 * 60 * 1000, TT_MAX_MS = 10 * 24 * 3600 * 1000;   // o TikTok aceita de 15 min a 10 dias

// Minutos de 5 em 5 (é o que o seletor do TikTok deixa escolher).
function roundTo5(d) { const r = new Date(d); r.setSeconds(0, 0); r.setMinutes(Math.ceil(r.getMinutes() / 5) * 5); return r; }

function setWhen(date) {
  const d = roundTo5(date);
  $('#ttDate').value = ymd(d);
  $('#ttTime').value = hm(d);
  checkWhen();
}
function whenDate() { return new Date(`${$('#ttDate').value}T${$('#ttTime').value || '00:00'}`); }
function checkWhen() {
  const at = ttDlg.dataset.when === 'at', d = whenDate(), dt = d - Date.now();
  const err = !at ? '' : isNaN(d) ? 'Escolhe o dia e a hora.' : dt > TT_MAX_MS ? 'O TikTok só deixa agendar até 10 dias.' : '';
  $('#ttErr').textContent = err;
  $('#ttWhenTxt').textContent = at && !err ? d.toLocaleString('pt-PT', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  const go = $('#ttGo');
  go.disabled = !!err;
  go.querySelector('.lbl').textContent = err ? 'Escolhe uma hora válida' : 'Abrir no TikTok';
  go.title = err || '';
  markQuick();
  return !err;
}

// Atalhos de horário: fica aceso o que corresponde ao dia/hora escolhidos (também se escritos à mão).
const REL_MIN = { '15m': 15, '30m': 30, '45m': 45, '1h': 60 };   // atalhos relativos a "agora"
let ttQuickRel = {};   // valor exato que cada atalho relativo pôs (não recalcula com o relógio a andar)
function quickTarget(q) {
  const d = new Date();
  if (REL_MIN[q]) { d.setTime(d.getTime() + REL_MIN[q] * 60e3); return roundTo5(d); }
  const [h, m] = q.slice(-5).split(':').map(Number);
  if (q.startsWith('tom')) d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d;
}
function markQuick() {
  const at = ttDlg.dataset.when === 'at', cur = `${$('#ttDate').value}T${$('#ttTime').value}`;
  for (const b of ttDlg.querySelectorAll('[data-q]')) {
    const q = b.dataset.q;
    const t = REL_MIN[q] ? ttQuickRel[q] : (() => { const d = quickTarget(q); return `${ymd(d)}T${hm(d)}`; })();
    b.classList.toggle('on', at && t === cur);
  }
  for (const b of ttDlg.querySelectorAll('[data-ql]')) {
    if (!lastPost) { b.classList.remove('on'); continue; }
    const d = lastQuickTarget(b.dataset.ql);
    b.classList.toggle('on', at && `${ymd(d)}T${hm(d)}` === cur);
  }
}
function setWhenMode(m) {
  ttDlg.dataset.when = m;
  for (const b of ttDlg.querySelectorAll('[data-when]')) b.classList.toggle('on', b.dataset.when === m);
  $('#ttAt').hidden = m !== 'at';
  checkWhen();
}
ttDlg.querySelectorAll('[data-when]').forEach((b) => b.addEventListener('click', () => setWhenMode(b.dataset.when)));
ttDlg.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
  const d = quickTarget(b.dataset.q);
  if (REL_MIN[b.dataset.q]) ttQuickRel[b.dataset.q] = `${ymd(d)}T${hm(d)}`;
  setWhenMode('at');
  setWhen(d);
}));
$('#ttDate').addEventListener('input', checkWhen);
$('#ttTime').addEventListener('input', checkWhen);
$('#ttCap').addEventListener('input', () => setCaption($('#ttCap').value));
$('#ttLastCaption').addEventListener('click', () => { setCaption(lastCaption()); $('#ttCap').focus(); });
$('#ttCap').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#ttGo').click(); } });

// ---------- "último clip": referência para espaçar o próximo sem fazer contas ----------
// A extensão nunca clica em Publicar/Agendar (é sempre o utilizador), por isso isto não é uma
// confirmação do TikTok — é a hora até onde a extensão conseguiu preencher sozinha da última vez
// (tiktok.js grava em chrome.storage.local quando chega ao fim sem erros).
let lastPost = null;   // { at: ms, name, mode }
function lastQuickTarget(q) { return roundTo5(new Date(lastPost.at + REL_MIN[q] * 60e3)); }
function renderLastPost() {
  const row = $('#ttLastRow');
  if (!lastPost) { row.hidden = true; return; }
  row.hidden = false;
  const when = new Date(lastPost.at).toLocaleString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('#ttLastTxt').textContent = `Último clip preenchido: ${when}` + (lastPost.name ? ` · ${lastPost.name}` : '');
}
function applyLastPost(v) {
  lastPost = v?.at ? v : null;
  renderLastPost();
  markQuick();
}
ttDlg.querySelectorAll('[data-ql]').forEach((b) => b.addEventListener('click', () => {
  if (!lastPost) return;
  setWhenMode('at');
  setWhen(lastQuickTarget(b.dataset.ql));
}));
try {
  chrome.storage?.local?.get('scLastTikTok', (s) => applyLastPost(s?.scLastTikTok));
  chrome.storage?.onChanged?.addListener((ch, area) => { if (area === 'local' && ch.scLastTikTok) applyLastPost(ch.scLastTikTok.newValue); });
} catch {}

// Abre o diálogo; resolve com {caption, when, date, time} ou null (cancelado).
function askTikTok() {
  const last = loadJSON('sc.ttWhen', { mode: 'at', time: '18:00' });
  setCaption(st.caption);
  // por omissão: a última hora usada, hoje se ainda der, senão amanhã
  const [h, m] = (last.time || '18:00').split(':').map(Number), d = new Date();
  d.setHours(h, m, 0, 0);
  if (d - Date.now() < TT_MIN_MS) d.setDate(d.getDate() + 1);
  setWhen(d);
  setWhenMode(last.mode === 'now' ? 'now' : 'at');
  $('#ttProg').textContent = 'A gerar o vídeo…';
  ttDlg.showModal();
  $('#ttCap').focus();
  return new Promise((resolve) => { ttFinish = resolve; });
}
// Fecho do diálogo tratado à mão (o evento «close» nem sempre chega a tempo).
let ttFinish = null;
function finishTikTok(ok) {
  const resolve = ttFinish;
  ttFinish = null;
  if (ttDlg.open) ttDlg.close(ok ? 'ok' : 'cancel');
  if (!resolve) return;
  if (!ok) return resolve(null);
  const plan = { caption: $('#ttCap').value, when: ttDlg.dataset.when, date: $('#ttDate').value, time: $('#ttTime').value };
  saveJSON('sc.ttWhen', { mode: plan.when, time: plan.time });
  setCaption(plan.caption);
  if (plan.caption.trim()) saveJSON('sc.lastCaption', plan.caption);
  resolve(plan);
}
ttDlg.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); if (checkWhen()) finishTikTok(true); });
$('#ttCancel').addEventListener('click', () => finishTikTok(false));
ttDlg.addEventListener('cancel', (e) => { e.preventDefault(); finishTikTok(false); });   // Esc

// Último MP4 exportado (para «Guardar cópia no PC» depois de o mandar para o TikTok).
let lastExport = null;
$('#saveCopy').addEventListener('click', async () => {
  if (!lastExport) return;
  await save(lastExport.blob, lastExport.name);
  $('#saveCopy').hidden = true;
  setStatus('Cópia guardada: ' + lastExport.name);
});

// Corte "sem perdas": quando não há nenhuma edição real (formato Original, sem zoom/
// deslocamento, sem textos/imagens, um único troço), corta com o ffmpeg em modo cópia
// (-c copy) em vez de passar pelo WebCodecs. Fica byte-a-byte igual ao original (em vez de
// reencodificar a um bitrate fixo) e é muito mais rápido, já que não decodifica nem
// recodifica frame a frame.
function canCopyExport() {
  if (st.layout !== 'original') return false;
  if (!st.mp4?.codec?.startsWith('avc1')) return false;   // só faz sentido para H.264
  const f = st.framing.original;
  if (Math.abs(f.scale - 1) > 1e-3 || Math.abs(f.ox) > 1e-3 || Math.abs(f.oy) > 1e-3) return false;
  if (st.texts.length || st.images.length || st.audioTracks.length) return false;
  return getRanges().length === 1;
}

async function copyExportClip(onProgress) {
  const [range] = getRanges();
  let key = 0;
  for (const s of st.mp4.samples) if (s.key && s.pts <= range.start + 0.05) key = s.pts;
  const ss = Math.max(0, key - 0.5);   // margem do DTS (ver armadilhas em CLAUDE.md)
  const ff = await getFFmpeg();
  const log = [];
  const onLog = ({ message }) => { log.push(message); if (log.length > 40) log.shift(); };
  ff.on('log', onLog);
  try {
    onProgress?.(0.05);
    await ff.writeFile('src.mp4', new Uint8Array(st.buf.slice(0)));   // cópia: o ffmpeg transfere o buffer
    const args = ['-hide_banner', '-i', 'src.mp4', '-ss', ss.toFixed(3), '-to', range.end.toFixed(3),
      '-c', 'copy', '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', 'out.mp4'];
    checkAbort();
    const code = await withTimeout(ff.exec(args), 60000, 'O ffmpeg encravou a cortar o clip.').catch((e) => {
      try { ff.terminate(); } catch {}
      ffmpeg = null;
      throw e;
    });
    onProgress?.(1);
    if (code !== 0) throw new Error('ffmpeg falhou: ' + log.slice(-3).join(' | '));
    const data = await ff.readFile('out.mp4');
    return new Blob([data.buffer], { type: 'video/mp4' });
  } finally {
    ff.off('log', onLog);
    for (const f of ['src.mp4', 'out.mp4']) { try { await ff.deleteFile(f); } catch {} }
  }
}

async function exportClip({ tiktok = false } = {}) {
  if (st.busy || !st.mp4) return;
  if (importingMedia) { setStatus('Espera que os ficheiros acabem de carregar antes de exportar.'); return; }
  if (st.parts.some(p => p.mediaId)) {
    try {
      setStatus('A preparar os vídeos adicionais para exportar…');
      await materializeVideoFiles();
    } catch (error) {
      console.error(error);
      setStatus('Não consegui preparar os vídeos adicionais: ' + (error.message || error));
      return;
    }
  }
  st.busy = true;
  for (const el of document.querySelectorAll('header, .bottom, .optsWrap, #stage')) el.inert = true;
  pausePlayback();
  $('#export').disabled = $('#exportTT').disabled = true;
  $('#saveCopy').hidden = true;
  st.abort = false;
  $('#cancelExp').hidden = false;
  const t0 = performance.now();
  // TikTok: o diálogo abre já; a aba do TikTok Studio abre quando se confirma (e carrega em paralelo).
  const plan = tiktok ? askTikTok() : null;
  const opened = plan?.then((p) => (p ? openTikTok().then(() => true, (e) => { console.warn('tiktok', e); return true; }) : false));
  try {
    setProgress(0);
    if (!tiktok && canCopyExport()) {
      // Sem edições reais: corta sem recodificar (qualidade idêntica ao original, sem passar pelo WebCodecs).
      setStatus('A cortar o clip…');
      const blob = await copyExportClip((p) => { setProgress(p); setStatus(`A cortar o clip… ${Math.round(p * 100)}%`); });
      checkAbort();
      setProgress(1);
      const name = st.name.replace(/\.(mp4|webm)$/i, '') + '_corte.mp4';
      lastExport = { blob, name };
      await save(blob, name);
      setStatus(`Guardado: ${name} (${((performance.now() - t0) / 1000).toFixed(1)}s · sem recodificar)`);
      return;
    }
    setStatus('A preparar…');
    const ffP = getFFmpeg();   // carrega em paralelo
    setStatus('A gerar o vídeo…');
    const v = await encodeVideo((p) => {
      setProgress(p * 0.9);
      setStatus(`A gerar o vídeo… ${Math.round(p * 100)}%`);
      $('#ttProg').textContent = `A gerar o vídeo… ${Math.round(p * 100)}%`;
    });

    setStatus('A juntar o som…');
    const ff = await ffP;
    const log = [];
    const onLog = ({ message }) => { log.push(message); if (log.length > 40) log.shift(); };
    ff.on('log', onLog);
    const tempAudioFiles = [];
    try {
      await ff.writeFile('v.h264', new Uint8Array(await v.h264.arrayBuffer()));
      const args = ['-hide_banner', '-framerate', String(v.fps), '-i', 'v.h264'];
      const filters = [], mixLabels = [];
      let inputIndex = 1;
      if (st.mp4.hasAudio) {
        await ff.writeFile('src.mp4', new Uint8Array(st.buf.slice(0)));   // cópia: o ffmpeg transfere o buffer
        args.push('-i', 'src.mp4');
        const labels = [];
        getRanges().forEach((r, i) => {
          filters.push(`[1:a:0]atrim=start=${r.start.toFixed(3)}:end=${r.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
          labels.push(`[a${i}]`);
        });
        filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[amain]`);
        mixLabels.push('[amain]');
        inputIndex++;
      }
      for (const [i, track] of st.audioTracks.filter(item => !item.muted && item.volume > 0).entries()) {
        const media = libItem(track.mediaId);
        if (!media?.blob) throw new Error('Falta um ficheiro de áudio usado na timeline.');
        const fileName = `music${i}.src`;
        await ff.writeFile(fileName, new Uint8Array(await (media.sourceBlob || media.blob).arrayBuffer()));
        tempAudioFiles.push(fileName);
        args.push('-i', fileName);
        const length = Math.max(.05, Math.min(audioLength(track), timelineDuration() - track.start));
        const chain = [`[${inputIndex}:a:0]atrim=start=${track.trimStart.toFixed(3)}:end=${(track.trimStart + length).toFixed(3)}`, 'asetpts=PTS-STARTPTS', `volume=${track.volume.toFixed(3)}`];
        if (track.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${Math.min(track.fadeIn, length / 2).toFixed(3)}`);
        if (track.fadeOut > 0) {
          const fade = Math.min(track.fadeOut, length / 2);
          chain.push(`afade=t=out:st=${Math.max(0, length - fade).toFixed(3)}:d=${fade.toFixed(3)}`);
        }
        if (track.start > 0) chain.push(`adelay=delays=${Math.round(track.start * 1000)}:all=1`);
        filters.push(`${chain.join(',')}[music${i}]`);
        mixLabels.push(`[music${i}]`);
        inputIndex++;
      }
      if (mixLabels.length > 1) filters.push(`${mixLabels.join('')}amix=inputs=${mixLabels.length}:duration=longest:normalize=0:dropout_transition=0,alimiter=limit=.95,apad,atrim=duration=${(v.frames / v.fps).toFixed(3)}[aout]`);
      else if (mixLabels.length === 1) filters.push(`${mixLabels[0]}apad,atrim=duration=${(v.frames / v.fps).toFixed(3)}[aout]`);
      if (filters.length) args.push('-filter_complex', filters.join(';'));
      args.push('-map', '0:v:0');
      if (mixLabels.length) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
      args.push('-c:v', 'copy', '-movflags', '+faststart', '-y', 'out.mp4');
      checkAbort();
      const code = await withTimeout(ff.exec(args), 90000, 'O ffmpeg encravou a juntar o som.').catch((e) => {
        try { ff.terminate(); } catch {}
        ffmpeg = null;
        throw e;
      });
      if (code !== 0) throw new Error('ffmpeg falhou: ' + log.slice(-3).join(' | '));
      const data = await ff.readFile('out.mp4');
      setProgress(1);
      const name = st.name.replace(/\.(mp4|webm)$/i, '') + (st.layout === 'original' ? '_corte' : '_tiktok') + '.mp4';
      const blob = new Blob([data.buffer], { type: 'video/mp4' });
      lastExport = { blob, name };
      if (tiktok) {
        // Para o TikTok não se descarrega nada (evita a janela «Guardar como» por cima do diálogo);
        // há o botão «Guardar cópia no PC». Se cancelar, guarda-se só depois de o diálogo fechar.
        $('#ttProg').textContent = '✓ Vídeo pronto — falta só confirmares.';
        if (ttDlg.open) setStatus('Vídeo pronto · à espera que confirmes o TikTok…');
        const p = await plan;
        if (p && (await opened)) {
          await handToTikTok(blob, name, p);
          setStatus(`Enviado para o TikTok Studio: ${name}`);
          $('#saveCopy').hidden = false;
        } else {
          await save(blob, name);
          setStatus(`Guardado: ${name} (TikTok cancelado)`);
        }
      } else {
        await save(blob, name);
        setStatus(`Guardado: ${name} (${((performance.now() - t0) / 1000).toFixed(1)}s)`);
      }
    } finally {
      ff.off('log', onLog);
      for (const f of ['v.h264', 'src.mp4', 'out.mp4', ...tempAudioFiles]) { try { await ff.deleteFile(f); } catch {} }
    }
  } catch (e) {
    console.error(e);
    setStatus(st.abort ? 'Exportação cancelada. Podes exportar outra vez.' : 'Falhou: ' + (e.message || e) + ' — carrega em Exportar para tentar outra vez.');
    setProgress(null);
    if (tiktok) {
      finishTikTok(false);
      if (ttId) ttSignal({ state: 'error', id: ttId, message: e.message || String(e) });
    }
  } finally {
    st.busy = false;
    for (const el of document.querySelectorAll('header, .bottom, .optsWrap, #stage')) el.inert = false;
    elementEditor.renderTracks();
    $('#cancelExp').hidden = true;
    $('#export').disabled = $('#exportTT').disabled = false;
  }
}
$('#cancelExp').addEventListener('click', () => {
  st.abort = true;
  setStatus('A cancelar…');
  if (ttDlg.open) finishTikTok(false);
});
$('#export').addEventListener('click', () => exportClip());
$('#exportTT').addEventListener('click', () => exportClip({ tiktok: true }));
$('#editorHelp').addEventListener('click', () => $('#helpDlg').showModal());

async function save(blob, name) {
  const url = URL.createObjectURL(blob);
  try {
    if (globalThis.chrome?.downloads) {
      await chrome.downloads.download({ url, filename: 'StreamClips/' + name, saveAs: false });
    } else {
      Object.assign(document.createElement('a'), { href: url, download: name }).click();
    }
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
}

// Para testes fora da extensão.
elementEditor = createElementEditor({ st, video, preview,
  timelineDuration,
  timelineScale: laneSpan,
  now: currentTimelineTime,
  seek: (t) => { pausePlayback(); seekTimelineTime(t); },
  pause: pausePlayback,
  onEditText: (e) => startInlineTextEdit(e.id),
  onCommit: () => recordEdit({ kind: 'element' }),
  onUndo: editHistory,
  canUndo: () => editUndo.length > 0,
  canRedo: () => editRedo.length > 0,
  renderPanel: () => { elementPanel = ''; renderTextOpts(); },
  onSelection: () => {
    if (elementEditor?.selected()) {
      if (st.audioSel) { st.audioSel = null; renderAudioTracks(); }
      if (partSel >= 0) selectPart(-1);
      if (previewZone) selectZone(null);
    }
    updateTimelineTools();
  },
  save: () => {
    const t = selText();
    if (t) saveJSON('sc.textStyle', Object.fromEntries(TEXT_STYLE_KEYS.map(k => [k, t[k]])));
    saveSession();
  },
  addText, mediaItem: libItem, fmt,
});
if (DEV) globalThis.__editor = { st, runTracking, exportClip, setLayout, updateCropKey, addCropKeyAt, addToLibrary, queueVideoFiles, materializeVideoFiles, addAudioTracks, libItem, previewMedia, addText, selectText, selectAudio, snapshot, applyTemplateSnap, elementEditor, renderFrame, encodeVideo, saveSession, updateTimeline, sourceToEdit, locate, currentTimelineTime, seekTimelineTime, splitPart, duplicatePart, deletePart, zoomTimeline, editDuration, timelineDuration, askTikTok, finishTikTok };

chrome.storage?.onChanged?.addListener(async (changes, area) => {
  if (area !== 'local' || (!changes.templatesChangedAt && !changes.savedChangedAt && !changes.libraryChangedAt)) return;
  try {
    if (changes.templatesChangedAt) {
      tplCur = '';
      st.templates = await listTemplates();
      renderTemplates();
    }
    if (changes.savedChangedAt) {
      sessionKey = '';
      st.recentClips = await listRecentClips();
      renderRecentClips();
    }
    if (changes.libraryChangedAt) {
      st.library = await listMedia();
      renderOpts();
      renderTextOpts();
      updateTimeline();
      syncAudioPreview(true);
    }
  } catch (error) { console.warn('atualização dos guardados', error); }
});

// Abre no último formato usado (a primeira vez: Streamer).
let lastLayout = null;
try { lastLayout = localStorage.getItem('sc.layout'); } catch {}
setLayout(LAYOUT_KEYS.includes(lastLayout) ? lastLayout : 'streamer');
updateTimeline();
requestAnimationFrame(loopPreview);
