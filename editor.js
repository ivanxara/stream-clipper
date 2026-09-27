// Stream Clipper — editor de clips para TikTok.
// Corta no tempo e converte para 9:16 (moldura móvel, streamer, fundo desfocado), com textos e templates.
// A exportação usa o WebCodecs do browser (descodificar + codificar H.264 na GPU);
// o ffmpeg.wasm só junta o som no fim.
import { parseMp4 } from './mp4.js';
import { FFmpeg } from './lib/ffmpeg/index.js';
import { loadLastClip, saveLastClip, listRecentClips, loadRecentClip, saveRecentClip, touchRecentClip, loadEditorSession, saveEditorSession, listMedia, putMedia, deleteMedia, listTemplates, putTemplate, deleteTemplate} from './clipstore.js';
import { importMediaFile, openMediaReader, usesFrameReader, isGif } from './media.js';
import { createElementEditor, elementVisible, orderedElements, cleanElements } from './elements.js';

const $ = (s) => document.querySelector(s);
const extURL = (p) => (globalThis.chrome?.runtime?.getURL ? chrome.runtime.getURL(p) : new URL(p, location.href).href);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (t) => { const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };

const OUT_V = { w: 1080, h: 1920 };

const video = $('#src');
const stage = $('#stage');
const overlay = $('#overlay');
const preview = $('#preview');
const pctx = preview.getContext('2d');
let elementEditor = null;
let previewZone = null;
let pendingTemplateDuration = null;

const st = {
  blob: null, name: 'clip.mp4', buf: null, mp4: null,
  srcW: 16, srcH: 9, dur: 0, start: 0, end: 0,
  parts: null, activePart: 0, rippleCuts: [],
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
  busy: false,
};

// Um só histórico para cortes/enquadramento do vídeo e elementos. A posição do
// cursor é guardada para restaurar o contexto, mas não cria uma ação por si só.
const editUndo = [], editRedo = [];
function videoSnapshot() {
  return {
    start: st.start, end: st.end, parts: structuredClone(st.parts), activePart: st.activePart,
    rippleCuts: structuredClone(st.rippleCuts),
    layout: st.layout, streamer: structuredClone(st.streamer), keys: structuredClone(st.crop.keys),
    framing: structuredClone(st.framing),
    cropDefault: loadJSON('sc.crop', null),
    cursor: video.currentTime || 0,
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
  Object.assign(st, { start: s.start, end: s.end, parts: structuredClone(s.parts), activePart: s.activePart, rippleCuts: structuredClone(s.rippleCuts || []) });
  st.streamer = structuredClone(s.streamer);
  st.framing = normalizeFraming(s.framing);
  st.crop.keys = structuredClone(s.keys);
  if (s.cropDefault) saveJSON('sc.crop', s.cropDefault);
  else try { localStorage.removeItem('sc.crop'); } catch {}
  video.currentTime = clamp(s.cursor, 0, st.dur);
  setLayout(s.layout);
  placeRects();
  updateSplitUi();
  updateTimeline();
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
  const a = k[i - 1], b = k[i], u = smooth((t - a.t) / (b.t - a.t));
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

function renderFrame(ctx, src, sw, sh, t, W, H, media, elementMedia) {
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
  drawTexts(ctx, W, H, t, elementMedia);
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

// A coluna do resultado tem a largura que o formato pede para a altura disponível.
function sizeResult() {
  const { w, h } = outSize();
  const maxW = main.clientWidth * (st.layout === 'original' ? 0.42 : 0.36);
  main.style.setProperty('--rw', Math.round(Math.min(maxW, (stage.clientHeight * w) / h)) + 'px');
  resultBox.style.setProperty('--ra', `${w} / ${h}`);
}
new ResizeObserver(() => { sizeResult(); placeRects(); }).observe(stage);

function loopPreview() {
  syncMediaTime();
  if (st.mp4 && video.readyState >= 2) {
    const { w, h } = outSize();
    const dpr = Math.min(2, devicePixelRatio || 1);
    const pw = Math.min(w, Math.round(resultBox.clientWidth * dpr)), ph = Math.round((pw * h) / w);
    if (pw > 0 && (preview.width !== pw || preview.height !== ph)) { preview.width = pw; preview.height = ph; }
    renderFrame(pctx, video, video.videoWidth, video.videoHeight, video.currentTime, preview.width, preview.height, () => previewMediaFor(st.streamer.mediaId));
  }
  elementEditor?.update();
  updateSplitUi();
  syncFramingUi();
  if (!video.paused) {
    const ranges = getRanges();
    let i = ranges.findIndex(r => video.currentTime >= r.start && video.currentTime < r.end);
    if (i < 0) {
      const next = ranges.find(r => r.start > video.currentTime);
      video.currentTime = next ? next.start : ranges[0]?.start || st.start;
    } else if (video.currentTime >= ranges[i].end - 0.01) {
      video.currentTime = ranges[i + 1]?.start ?? ranges[0]?.start ?? st.start;
    }
  }
  if (st.layout === 'crop' || drag) placeRects();                                    // a moldura segue as posições
  updateHead();
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
    if (id === 'crop') setCropKey(video.currentTime, done.rect); else rememberCam();
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

// Mexer na moldura num instante cria (ou atualiza) uma posição nesse instante.
function setCropKey(t, r) {
  const k = st.crop.keys;
  const near = k.find((p) => Math.abs(p.t - t) < 0.25);
  if (near) Object.assign(near, r);
  else k.push({ t, ...r });
  k.sort((a, b) => a.t - b.t);
  try { localStorage.setItem('sc.crop', JSON.stringify({ x: r.x, y: r.y, w: r.w })); } catch {}
  renderOpts();
  renderKeys();
}

// ---------- barra de tempo ----------
const tl = $('#timeline');
function sourceToEdit(time) {
  let removed = 0;
  for (const cut of [...(st.rippleCuts || [])].sort((a, b) => a.start - b.start)) {
    if (time < cut.start) break;
    if (time < cut.end) return cut.start - removed;
    removed += cut.end - cut.start;
  }
  return time - removed;
}
function editToSource(time) {
  let removed = 0;
  for (const cut of [...(st.rippleCuts || [])].sort((a, b) => a.start - b.start)) {
    const seam = cut.start - removed;
    if (time < seam) break;
    removed += cut.end - cut.start;
  }
  return time + removed;
}
const editDuration = () => sourceToEdit(st.dur);
const editPct = (time) => (editDuration() ? (time / editDuration()) * 100 : 0) + '%';
const tAt = (clientX) => { const r = tl.getBoundingClientRect(); return clamp((clientX - r.left) / r.width, 0, 1) * editDuration(); };
const pct = (sourceTime) => editPct(sourceToEdit(sourceTime));

function getRanges() {
  const parts = st.parts?.length ? st.parts : [{ start: st.start, end: st.end }];
  return parts.map(r => ({ start: Math.max(st.start, r.start), end: Math.min(st.end, r.end) }))
    .filter(r => r.end - r.start > 0.05);
}
function rangeOccurrences(ranges, index) {
  const range = ranges[index];
  if (!range) return { count: 0, position: -1 };
  const matches = ranges.map((other, i) => ({ other, i }))
    .filter(({ other }) => Math.abs(other.start - range.start) < 0.01 && Math.abs(other.end - range.end) < 0.01)
    .map(({ i }) => i);
  return { count: matches.length, position: matches.indexOf(index) };
}

function updateTimelineTools() {
  const hasElement = !!elementEditor?.selected();
  const removeButton = $('#removeSegment');
  removeButton.hidden = hasElement ? false : getRanges().length < 2;
  removeButton.disabled = st.busy || (!hasElement && getRanges().length < 2);
  removeButton.querySelector('span').textContent = hasElement ? 'Apagar elemento' : 'Remover';
  removeButton.querySelector('.menuChevron').hidden = hasElement;
  removeButton.title = hasElement ? 'Apagar elemento selecionado (Delete)' : 'Remover segmento selecionado';
  removeButton.setAttribute('aria-label', removeButton.title);
  removeButton.setAttribute('aria-haspopup', hasElement ? 'false' : 'menu');
  $('#setIn').title = hasElement ? 'Marcar início do elemento selecionado (I)' : 'Marcar início (I)';
  $('#setIn').setAttribute('aria-label', hasElement ? 'Marcar início do elemento (I)' : 'Marcar início (I)');
  $('#setOut').title = hasElement ? 'Marcar fim do elemento selecionado (O)' : 'Marcar fim (O)';
  $('#setOut').setAttribute('aria-label', hasElement ? 'Marcar fim do elemento (O)' : 'Marcar fim (O)');
  $('#splitClip').title = hasElement ? 'Dividir elemento no cursor (Ctrl+B)' : 'Dividir segmento (Ctrl+B)';
  $('#splitClip').setAttribute('aria-label', hasElement ? 'Dividir elemento (Ctrl+B)' : 'Dividir segmento (Ctrl+B)');
}

function selectPartAt(t) {
  const ranges = getRanges();
  if (!ranges.length) return;
  const active = ranges[st.activePart];
  if (active && t >= active.start && t <= active.end) return active;
  let i = ranges.findIndex(r => t >= r.start && t <= r.end);
  if (i < 0) i = ranges.reduce((best, r, n) => {
    const distance = Math.min(Math.abs(t - r.start), Math.abs(t - r.end));
    return distance < best.distance ? { index: n, distance } : best;
  }, { index: 0, distance: Infinity }).index;
  st.activePart = i;
  return ranges[i];
}

function updateTimeline() {
  elementEditor?.renderTracks();
  const ranges = getRanges(), wrap = $('#ranges');
  st.activePart = clamp(st.activePart, 0, Math.max(0, ranges.length - 1));
  const gaps = [], marks = [];
  const addGap = (start, end) => {
    const removed = document.createElement('button');
    removed.type = 'button';
    removed.className = 'cutGap';
    removed.style.left = pct(start);
    removed.style.width = `${Math.max(0, (sourceToEdit(end) - sourceToEdit(start)) / (editDuration() || 1) * 100)}%`;
    removed.dataset.start = start;
    removed.dataset.end = end;
    removed.title = `Repor trecho removido: ${fmt(start)} – ${fmt(end)}`;
    removed.setAttribute('aria-label', removed.title);
    const gapWidth = editDuration() ? (sourceToEdit(end) - sourceToEdit(start)) / editDuration() * tl.clientWidth : 0;
    removed.textContent = gapWidth >= 78 ? '↶ Repor trecho' : '↶';
    removed.addEventListener('pointerdown', e => e.stopPropagation());
    removed.addEventListener('click', e => { e.stopPropagation(); restoreGap(start, end); });
    gaps.push(removed);
  };
  const addRippleMarker = cut => {
    const marker = document.createElement('button');
    marker.type = 'button';
    marker.className = 'cutGap rippleCut';
    const position = parseFloat(pct(cut.start));
    marker.style.left = position >= 100 ? 'calc(100% - 16px)' : position <= 0 ? '0%' : `calc(${position}% - 8px)`;
    marker.style.width = '16px';
    marker.style.marginLeft = '-8px';
    marker.dataset.start = cut.start;
    marker.dataset.end = cut.end;
    marker.title = `Repor espaço fechado: ${fmt(cut.start)} – ${fmt(cut.end)}`;
    marker.setAttribute('aria-label', marker.title);
    marker.textContent = '↶';
    marker.addEventListener('pointerdown', e => e.stopPropagation());
    marker.addEventListener('click', e => { e.stopPropagation(); restoreGap(cut.start, cut.end); });
    gaps.push(marker);
  };
  const addRemovedInterval = (start, end) => {
    let cursor = start;
    for (const cut of [...st.rippleCuts].sort((a, b) => a.start - b.start)) {
      if (cut.end <= cursor || cut.start >= end) continue;
      if (cut.start - cursor > 0.05) addGap(cursor, cut.start);
      addRippleMarker(cut);
      cursor = Math.max(cursor, cut.end);
    }
    if (end - cursor > 0.05) addGap(cursor, end);
  };
  if (ranges.length && ranges[0].start - st.start > 0.05) addRemovedInterval(st.start, ranges[0].start);
  for (let i = 1; i < ranges.length; i++) {
    const previous = ranges[i - 1], next = ranges[i], gap = next.start - previous.end;
    if (gap > 0.05) {
      addRemovedInterval(previous.end, next.start);
    } else {
      const marker = document.createElement('span');
      marker.className = 'splitMarker';
      marker.style.left = pct(previous.end);
      marker.title = `Divisão entre segmentos ${i} e ${i + 1}`;
      marker.setAttribute('aria-hidden', 'true');
      marks.push(marker);
    }
  }
  if (ranges.length && st.end - ranges.at(-1).end > 0.05) addRemovedInterval(ranges.at(-1).end, st.end);
  const clips = ranges.map((r, i) => {
    const occurrence = rangeOccurrences(ranges, i), repeated = occurrence.count > 1;
    const range = document.createElement('button');
    range.type = 'button';
    range.className = 'range' + (i === st.activePart ? ' active' : '') + (repeated && occurrence.position > 0 ? ' duplicate' : '');
    range.style.left = pct(r.start);
    range.style.width = `${Math.max(0, (sourceToEdit(r.end) - sourceToEdit(r.start)) / (editDuration() || 1) * 100)}%`;
    if (repeated) {
      const height = Math.min(10, 30 / occurrence.count);
      range.style.top = `${2 + occurrence.position * height}px`;
      range.style.height = `${height}px`;
    }
    const copyLabel = repeated ? (occurrence.position ? ` · cópia ${occurrence.position + 1}/${occurrence.count}` : ` · origem de ${occurrence.count} ocorrências`) : '';
    range.title = `Segmento ${i + 1}${copyLabel}: ${fmt(sourceToEdit(r.start))} – ${fmt(sourceToEdit(r.end))} · ordem de exportação ${i + 1}`;
    range.setAttribute('aria-label', range.title);
    range.setAttribute('aria-pressed', String(i === st.activePart));
    range.textContent = `${i + 1} · ${fmt(r.end - r.start)}`;
    range.addEventListener('pointerdown', e => e.stopPropagation());
    range.addEventListener('click', e => {
      e.stopPropagation();
      st.activePart = i;
      elementEditor?.select(null);
      video.pause();
      video.currentTime = e.detail === 0 ? r.start : clamp(editToSource(tAt(e.clientX)), r.start, r.end);
      updateTimeline();
    });
    return range;
  });
  wrap.replaceChildren(...gaps, ...clips, ...marks);
  $('#hIn').style.left = pct(st.start);
  $('#hOut').style.left = pct(st.end);
  for (const id of ['play', 'setIn', 'setOut', 'splitClip']) $('#' + id).disabled = !st.mp4 || st.busy;
  updateTimelineTools();
  const duration = ranges.reduce((sum, r) => sum + r.end - r.start, 0);
  $('#selInfo').textContent = st.mp4 ? `${ranges.length} segmento${ranges.length === 1 ? '' : 's'} · ${duration.toFixed(1)}s` : '—';
}

function updateHead() {
  const editTime = sourceToEdit(video.currentTime || 0);
  $('#head').style.left = editPct(editTime);
  $('#time').textContent = fmt(editTime);
  const scrub = $('#scrubHandle');
  scrub.setAttribute('aria-valuemax', String(editDuration()));
  scrub.setAttribute('aria-valuenow', String(Math.round(editTime * 10) / 10));
  scrub.setAttribute('aria-valuetext', fmt(editTime));
  $('#play').textContent = video.paused ? '▶' : '❚❚';
}

// Arrastar um ◆ muda o instante dessa posição (sem passar por cima das vizinhas); clique = ir para lá.
function dragKey(e, k, el) {
  e.preventDefault();
  e.stopPropagation();
  video.pause();
  const before = beginVideoEdit();
  video.currentTime = k.t;
  try { el.setPointerCapture(e.pointerId); } catch {}
  const keys = st.crop.keys, i = keys.indexOf(k);
  const lo = i > 0 ? keys[i - 1].t + 0.1 : 0, hi = i < keys.length - 1 ? keys[i + 1].t - 0.1 : st.dur;
  const x0 = e.clientX;
  let moved = false;
  el.classList.add('drag');
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;       // um clique não mexe no ◆
    moved = true;
    k.t = clamp(editToSource(tAt(ev.clientX)), lo, hi);
    el.style.left = pct(k.t);
    video.currentTime = k.t;                                  // vês a moldura nesse instante
    $('#time').textContent = fmt(k.t);
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
    d.className = 'kf';
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

function dragHandle(which) {
  return (e) => {
    if (!st.mp4 || st.busy || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const before = beginVideoEdit();
    try { e.target.setPointerCapture(e.pointerId); } catch {}
    const move = (ev) => {
      const t = editToSource(tAt(ev.clientX));
      if (which === 'in') st.start = clamp(t, 0, st.end - 0.5);
      else st.end = clamp(t, st.start + 0.5, st.dur);
      video.currentTime = which === 'in' ? st.start : st.end;
      updateTimeline();
    };
    const up = () => { e.target.removeEventListener('pointermove', move); e.target.removeEventListener('pointerup', up); e.target.removeEventListener('pointercancel', up); recordVideoEdit(before); };
    e.target.addEventListener('pointermove', move);
    e.target.addEventListener('pointerup', up);
    e.target.addEventListener('pointercancel', up);
  };
}
$('#hIn').addEventListener('pointerdown', dragHandle('in'));
$('#hOut').addEventListener('pointerdown', dragHandle('out'));
tl.addEventListener('pointerdown', (e) => {
  if (!st.mp4) return;
  try { tl.setPointerCapture(e.pointerId); } catch {}
  const seek = (ev) => {
    const sourceTime = editToSource(tAt(ev.clientX)), range = selectPartAt(sourceTime);
    if (!range) return;
    video.currentTime = sourceTime < range.start ? range.start : sourceTime > range.end ? range.end : sourceTime;
    updateTimeline();
  };
  seek(e);
  const up = () => { tl.removeEventListener('pointermove', seek); tl.removeEventListener('pointerup', up); };
  tl.addEventListener('pointermove', seek);
  tl.addEventListener('pointerup', up);
});

function seekToTime(time) {
  const previousPart = st.activePart;
  video.currentTime = clamp(time, 0, st.dur);
  selectPartAt(video.currentTime);
  if (st.activePart !== previousPart) updateTimeline();
  elementEditor?.update();
  updateHead();
}
function seekOnRuler(clientX) { seekToTime(editToSource(tAt(clientX))); }
function startRulerDrag(e) {
  if (!st.mp4 || st.busy || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  video.pause();
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
  video.pause();
  const step = e.shiftKey ? 1 : 1 / (st.mp4.fps || 30), current = sourceToEdit(video.currentTime);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? editDuration() : current + (e.key === 'ArrowLeft' ? -step : step);
  seekToTime(editToSource(clamp(next, 0, editDuration())));
});

$('#setIn').addEventListener('click', () => {
  if (!st.mp4 || st.busy) return;
  if (elementEditor?.selected()) { elementEditor.trimSelected('in'); return; }
  const before = beginVideoEdit(); st.start = clamp(video.currentTime, 0, st.end - 0.5); updateTimeline(); recordVideoEdit(before);
});
$('#setOut').addEventListener('click', () => {
  if (!st.mp4 || st.busy) return;
  if (elementEditor?.selected()) { elementEditor.trimSelected('out'); return; }
  const before = beginVideoEdit(); st.end = clamp(video.currentTime, st.start + 0.5, st.dur); updateTimeline(); recordVideoEdit(before);
});
function splitPart() {
  if (!st.mp4 || st.busy) return;
  const ranges = getRanges(), r = ranges[st.activePart], t = video.currentTime;
  if (!r || t <= r.start + 0.15 || t >= r.end - 0.15) {
    setStatus('Coloca o cursor dentro do segmento, afastado das pontas, para o dividir.');
    return;
  }
  const before = beginVideoEdit();
  st.parts = ranges.map(x => ({ ...x }));
  st.parts.splice(st.activePart, 1, { start: r.start, end: t }, { start: t, end: r.end });
  st.activePart++;
  updateTimeline();
  recordVideoEdit(before);
}
function duplicatePart(index = st.activePart) {
  if (!st.mp4 || st.busy) return;
  const ranges = getRanges(), range = ranges[index];
  if (!range) return;
  const before = beginVideoEdit();
  st.parts = ranges.map(part => ({ ...part }));
  st.parts.splice(index + 1, 0, { ...range });
  st.activePart = index + 1;
  updateTimeline();
  recordVideoEdit(before);
  setStatus('Segmento duplicado a seguir ao original na exportação.');
}
function deletePart() {
  if (!st.mp4 || st.busy) return;
  const ranges = getRanges();
  if (ranges.length < 2) return;
  const before = beginVideoEdit();
  st.parts = ranges.map(x => ({ ...x }));
  st.parts.splice(st.activePart, 1);
  st.activePart = Math.min(st.activePart, st.parts.length - 1);
  if (!getRanges().some(r => video.currentTime >= r.start && video.currentTime < r.end)) video.currentTime = getRanges()[st.activePart].start;
  updateTimeline();
  recordVideoEdit(before);
}
function rippleDeletePart() {
  if (!st.mp4 || st.busy) return;
  const ranges = getRanges(), r = ranges[st.activePart];
  if (ranges.length < 2 || !r) return;
  if (rangeOccurrences(ranges, st.activePart).count > 1) return deletePart();
  const before = beginVideoEdit();
  st.parts = ranges.map(x => ({ ...x }));
  st.parts.splice(st.activePart, 1);
  st.rippleCuts = [...st.rippleCuts, { start: r.start, end: r.end }].sort((a, b) => a.start - b.start);
  st.activePart = Math.min(st.activePart, st.parts.length - 1);
  if (!getRanges().some(x => video.currentTime >= x.start && video.currentTime < x.end)) video.currentTime = getRanges()[st.activePart].start;
  updateTimeline();
  recordVideoEdit(before);
}
function restoreGap(start, end) {
  if (!st.mp4 || st.busy || end - start <= 0.05) return;
  const ranges = getRanges();
  if (ranges.some(r => Math.min(end, r.end) - Math.max(start, r.start) > 0.01)) return;
  const before = beginVideoEdit();
  st.rippleCuts = st.rippleCuts.filter(cut => Math.abs(cut.start - start) > 0.01 || Math.abs(cut.end - end) > 0.01);
  st.parts = [...ranges, { start, end }].sort((a, b) => a.start - b.start);
  st.activePart = st.parts.findIndex(r => r.start === start && r.end === end);
  video.pause();
  video.currentTime = start + Math.min(0.05, (end - start) / 2);
  updateTimeline();
  recordVideoEdit(before);
}
function restoreFullVideo() {
  if (!st.mp4 || st.busy) return;
  const before = beginVideoEdit();
  st.start = 0;
  st.end = st.dur;
  st.parts = null;
  st.activePart = 0;
  st.rippleCuts = [];
  video.pause();
  video.currentTime = 0;
  updateTimeline();
  recordVideoEdit(before);
}
function splitSelection() {
  if (elementEditor?.selected()) {
    if (!elementEditor.splitSelected()) setStatus('Coloca o cursor dentro do elemento, afastado das pontas, para o dividir.');
  } else splitPart();
}
$('#splitClip').addEventListener('click', splitSelection);
const videoMenu = $('#videoContextMenu');
let videoMenuTarget = null;
function closeVideoMenu(restoreFocus = false) {
  videoMenu.hidden = true;
  $('#removeSegment').setAttribute('aria-expanded', 'false');
  if (videoMenu.contains(document.activeElement)) document.activeElement.blur();
  if (restoreFocus && videoMenuTarget) {
    if (videoMenuTarget.kind === 'toolbar') $('#removeSegment').focus();
    else {
      const selector = videoMenuTarget.kind === 'gap' ? '.cutGap' : '.range.active';
      tl.querySelector(selector)?.focus();
    }
  }
  videoMenuTarget = null;
}
function showRemoveMenu(e) {
  if (!st.mp4 || st.busy || elementEditor?.selected() || getRanges().length < 2) return;
  e.preventDefault();
  e.stopPropagation();
  videoMenuTarget = { kind: 'toolbar' };
  videoMenu.querySelector('[data-video-action="split"]').hidden = true;
  videoMenu.querySelector('[data-video-action="duplicate"]').hidden = true;
  videoMenu.querySelector('[data-video-action="openSegment"]').hidden = true;
  videoMenu.querySelector('[data-video-action="delete"]').hidden = false;
  videoMenu.querySelector('[data-video-action="rippleDelete"]').hidden = rangeOccurrences(getRanges(), st.activePart).count > 1;
  videoMenu.querySelector('[data-video-action="restore"]').hidden = true;
  videoMenu.querySelector('[data-video-action="restoreAll"]').hidden = true;
  videoMenu.hidden = false;
  const rect = $('#removeSegment').getBoundingClientRect();
  videoMenu.style.left = `${clamp(rect.left, 8, innerWidth - videoMenu.offsetWidth - 8)}px`;
  videoMenu.style.top = `${clamp(rect.bottom, 8, innerHeight - videoMenu.offsetHeight - 8)}px`;
  $('#removeSegment').setAttribute('aria-expanded', 'true');
  videoMenu.querySelector('button:not([hidden]):not(:disabled)')?.focus();
}
$('#removeSegment').addEventListener('click', e => {
  if (elementEditor?.selected()) elementEditor.remove();
  else showRemoveMenu(e);
});
function showVideoMenu(e) {
  const target = e.target.closest('.range, .cutGap');
  if (!target || !st.mp4 || st.busy) return;
  e.preventDefault();
  e.stopPropagation();
  const rect = target.getBoundingClientRect();
  if (target.classList.contains('cutGap')) {
    videoMenuTarget = { kind: 'gap', start: +target.dataset.start, end: +target.dataset.end };
  } else {
    const index = [...document.querySelectorAll('#ranges .range')].indexOf(target);
    const range = getRanges()[index];
    if (!range) return;
    videoMenuTarget = { kind: 'segment', index };
    st.activePart = index;
    elementEditor?.select(null);
    video.pause();
    video.currentTime = clamp(e.clientX ? editToSource(tAt(e.clientX)) : range.start, range.start, range.end);
    updateTimeline();
  }
  const gap = videoMenuTarget.kind === 'gap';
  const range = !gap && getRanges()[videoMenuTarget.index];
  const splitAction = videoMenu.querySelector('[data-video-action="split"]');
  splitAction.hidden = gap;
  splitAction.disabled = gap || !range || video.currentTime <= range.start + .15 || video.currentTime >= range.end - .15;
  splitAction.title = splitAction.disabled && !gap ? 'Clica mais longe das pontas para dividir' : '';
  videoMenu.querySelector('[data-video-action="duplicate"]').hidden = gap;
  videoMenu.querySelector('[data-video-action="openSegment"]').hidden = gap;
  videoMenu.querySelector('[data-video-action="delete"]').hidden = gap || getRanges().length < 2;
  videoMenu.querySelector('[data-video-action="rippleDelete"]').hidden = gap || getRanges().length < 2 || rangeOccurrences(getRanges(), videoMenuTarget.index).count > 1;
  videoMenu.querySelector('[data-video-action="restore"]').hidden = !gap;
  videoMenu.querySelector('[data-video-action="restoreAll"]').hidden = gap || !(st.parts?.length || st.start > .05 || st.end < st.dur - .05);
  videoMenu.hidden = false;
  $('#removeSegment').setAttribute('aria-expanded', 'false');
  const x = e.clientX || rect.left + rect.width / 2, y = e.clientY || rect.bottom;
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
  else if (action === 'openSegment') openSegmentInNewTab(getRanges()[target.index]);
  else if (action === 'delete') deletePart();
  else if (action === 'rippleDelete') rippleDeletePart();
  else if (action === 'restore') restoreGap(target.start, target.end);
  else if (action === 'restoreAll') restoreFullVideo();
  if (target.kind === 'toolbar') $('#removeSegment').focus();
  else tl.querySelector('.range.active')?.focus();
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
  if (video.paused) {
    const r = selectPartAt(video.currentTime);
    updateTimeline();
    if (!r || video.currentTime < r.start || video.currentTime >= r.end - 0.05) video.currentTime = r?.start ?? st.start;
    video.play();
  } else video.pause();
}
const LAYOUT_KEYS = ['streamer', 'crop', 'blur', 'original'];
const seekBy = (dt) => {
  const ranges = getRanges();
  if (!ranges.length) return;
  let offset = 0, found = false;
  for (const r of ranges) {
    const start = sourceToEdit(r.start), end = sourceToEdit(r.end);
    const length = end - start;
    if (video.currentTime >= r.start && video.currentTime <= r.end) { offset += clamp(sourceToEdit(video.currentTime) - start, 0, length); found = true; break; }
    offset += length;
  }
  if (!found && video.currentTime < ranges[0].start) offset = 0;
  const total = ranges.reduce((sum, r) => sum + sourceToEdit(r.end) - sourceToEdit(r.start), 0);
  let target = clamp(offset + dt, 0, total);
  for (const r of ranges) {
    const start = sourceToEdit(r.start), len = sourceToEdit(r.end) - start;
    if (target <= len) { video.pause(); video.currentTime = editToSource(start + target); selectPartAt(video.currentTime); updateTimeline(); return; }
    target -= len;
  }
};
document.addEventListener('keydown', (e) => {
  if (e.target.closest('dialog, [role="menu"]')) return;
  if (st.busy) return;
  const t = e.target;
  if (t.matches?.('input:not([type=range]), select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'b') { e.preventDefault(); e.stopImmediatePropagation(); splitSelection(); return; }
  if (e.shiftKey && k === 'delete' && !elementEditor?.selected()) { e.preventDefault(); e.stopImmediatePropagation(); rippleDeletePart(); return; }
  if (!e.ctrlKey && !e.metaKey && !e.altKey && k === 'delete' && !elementEditor?.selected()) { e.preventDefault(); e.stopImmediatePropagation(); deletePart(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (t.type === 'range' && k.startsWith('arrow')) return;          // as setas mexem no controlo
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (k === 'i') $('#setIn').click();
  else if (k === 'o') $('#setOut').click();
  else if (k === 'k') { e.preventDefault(); togglePlay(); }
  else if (k === 'e') { e.preventDefault(); exportClip({ tiktok: e.shiftKey }); }   // sem isto o «E» ia parar à descrição
  else if (k === 'arrowleft' || k === 'arrowright') { e.preventDefault(); seekBy((k === 'arrowleft' ? -1 : 1) / (st.mp4?.fps || 30)); }
  else if (k === 'j' || k === 'l') seekBy(k === 'j' ? -1 : 1);
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
    o.innerHTML = `<div class="opt">
      <h2>Posições da moldura</h2>
      <div class="keylist">${keys.length ? keys.map((k, i) => `<div class="k"><span class="mono">${fmt(k.t)}</span><button data-go="${i}" title="Ir para aqui">↦</button><button data-del="${i}" title="Apagar">✕</button></div>`).join('')
        : '<span class="muted">Sem posições: a moldura fica ao centro.</span>'}</div>
      ${keys.length ? '<button id="clearKeys" class="btn small danger">Apagar posições</button>' : ''}
    </div>`;
    o.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => { const before = beginVideoEdit(); keys.splice(+b.dataset.del, 1); renderOpts(); renderKeys(); recordVideoEdit(before); }));
    o.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { video.currentTime = keys[+b.dataset.go].t; }));
    o.querySelector('#clearKeys')?.addEventListener('click', () => { const before = beginVideoEdit(); keys.length = 0; renderOpts(); renderKeys(); recordVideoEdit(before); });
    hint.textContent = 'No resultado: arrasta para enquadrar, roda do rato = zoom. Para a moldura se mover: vai a outro instante e arrasta outra vez (◆).';
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
    <div class="lib">${st.library.map(libItemHtml).join('')}<label class="add" title="Adicionar vídeos/imagens">+<input id="libAdd" type="file" accept="image/*,video/*" multiple hidden></label></div>` : ''}
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
  if (id === 'crop') setCropKey(video.currentTime, r);
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

function updateSplitUi() {
  const visible = st.layout === 'streamer' && !!st.mp4 && !st.busy && !st.textSel;
  const divider = $('#splitDivider'), frame = $('#splitBottomFrame');
  divider.hidden = !visible;
  divider.style.top = `${st.streamer.split * 100}%`;
  divider.setAttribute('aria-valuenow', Math.round(st.streamer.split * 100));
  $('#splitDividerValue').textContent = Math.round(st.streamer.split * 100) + '%';
  frame.hidden = !visible || !['game', 'media'].includes(previewZone) || (st.streamer.bottom === 'media' && !mediaMode());
  frame.style.top = `${st.streamer.split * 100}%`;
}

$('#splitDivider').addEventListener('pointerdown', e => {
  if (e.button !== 0 || st.busy) return;
  const before = beginVideoEdit();
  e.preventDefault(); video.pause(); previewZone = 'cam';
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
$('#splitBottomFrame').addEventListener('pointerdown', e => {
  if (!e.target.dataset.corner || e.button !== 0 || st.busy) return;
  const before = beginVideoEdit();
  e.preventDefault(); video.pause();
  const target = e.target, z = st.streamer.bottom === 'media' ? 'media' : 'game';
  const box = $('#splitBottomFrame').getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
  const dx = e.clientX - cx, dy = e.clientY - cy, initial = structuredClone(st.streamer);
  const aspect = z === 'game' ? regionById('game').aspect : null, r0 = z === 'game' ? { ...rectFor('game', video.currentTime) } : null;
  target.setPointerCapture(e.pointerId);
  const move = ev => {
    const factor = clamp(((ev.clientX - cx) * dx + (ev.clientY - cy) * dy) / (dx * dx + dy * dy), .1, 10);
    if (z === 'media') setMediaScale(initial.scale * factor);
    else {
      const w = r0.w / factor, h = rectH({ w }, aspect), h0 = rectH(r0, aspect);
      setZoneRect('game', fitRect({ w, x: r0.x + (r0.w - w) / 2, y: r0.y + (h0 - h) / 2 }, aspect));
    }
  };
  const end = ev => {
    target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end);
    if (target.hasPointerCapture(e.pointerId)) target.releasePointerCapture(e.pointerId);
    if (ev.type === 'pointercancel') { Object.assign(st.streamer, initial); renderOpts(); placeRects(); savePrefs(); rememberCam(); }
    else recordVideoEdit(before);
  };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
});

preview.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const z = zoneAt(e);
  preview.classList.toggle('edit', !!z);
  preview.title = z ? 'Arrasta para mover · roda do rato = zoom' : '';
});

preview.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const z = zoneAt(e);
  if (!z) return;
  document.activeElement?.blur();
  const before = beginVideoEdit();
  previewZone = z.id;
  updateSplitUi();
  e.preventDefault();
  try { preview.setPointerCapture(e.pointerId); } catch {}
  const x0 = e.clientX, y0 = e.clientY, s = st.streamer;
  let move;
  const framingInitial = z.id === 'framing' ? { ...st.framing[st.layout] } : null;
  if (framingInitial) {
    video.pause();
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
  const up = (ev) => {
    preview.removeEventListener('pointermove', move);
    preview.removeEventListener('pointerup', up);
    preview.removeEventListener('pointercancel', up);
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
  preview.addEventListener('pointermove', move);
  preview.addEventListener('pointerup', up);
  preview.addEventListener('pointercancel', up);
});

preview.addEventListener('wheel', (e) => {
  const z = zoneAt(e);
  if (!z || drag) return;
  e.preventDefault();
  const before = beginVideoEdit();
  const zoomIn = e.deltaY < 0;
  if (z.id === 'framing') {
    setFraming(st.framing[st.layout].scale * (zoomIn ? 1.06 : 1 / 1.06));
    recordVideoEdit(before); return;
  }
  if (z.id === 'media') { setMediaScale(st.streamer.scale * (zoomIn ? 1.06 : 1 / 1.06)); recordVideoEdit(before); return; }
  // Zoom à volta do centro da zona (zona mais pequena no original = mais zoom).
  const aspect = regionById(z.id).aspect, r0 = rectFor(z.id, video.currentTime), h0 = rectH(r0, aspect);
  const w = r0.w * (zoomIn ? 1 / 1.06 : 1.06), h = rectH({ w }, aspect);
  setZoneRect(z.id, fitRect({ x: r0.x + (r0.w - w) / 2, y: r0.y + (h0 - h) / 2, w }, aspect));
  recordVideoEdit(before);
}, { passive: false });

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
    const active = !st.busy && (element ? elementVisible(element, video.currentTime, st.dur) : mediaMode() && key === st.streamer.mediaId);
    if (!active) { p.el?.pause(); continue; }
    const t = Math.max(0, video.currentTime - (element?.in ?? st.start));
    if (p.kind === 'frames') {
      if (p.reader && !p.pending && !p.error) {
        p.pending = p.reader.frameAt(t).then(f => { if (!p.disposed) p.img = f; })
          .catch(e => { if (!p.disposed) { p.error = e; setStatus('Não consegui ler o ficheiro: ' + e.message); } }).finally(() => { p.pending = null; });
      }
      continue;
    }
    if (p.kind !== 'video' || !p.el.duration) continue;
    const target = t % p.el.duration;
    const tolerance = video.paused || event?.type === 'seeked' ? .015 : .15;
    if (!p.el.seeking && Math.abs(p.el.currentTime - target) > tolerance) p.el.currentTime = target;
    if (video.paused) p.el.pause(); else if (p.el.paused) p.el.play().catch(() => {});
  }
}
video.addEventListener('seeked', syncMediaTime);
video.addEventListener('play', syncMediaTime);
video.addEventListener('pause', syncMediaTime);

let importingMedia = false;
async function addToLibrary(files) {
  if (st.busy || importingMedia) return;
  importingMedia = true;
  renderTextOpts();
  try {
    for (const f of files) {
      try {
        setStatus(`A adicionar «${f.name}» à biblioteca…`);
        const m = await importMediaFile(f, getFFmpeg);
        await putMedia(m);
        st.library.push(m);
        if (!libItem(st.streamer.mediaId)) Object.assign(st.streamer, { mediaId: m.id, scale: 1, ox: 0, oy: 0 });
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
}

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

(async () => {
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
//  style: 'outline'|'box'|'plain', align: 'left'|'center'|'right', font, keep}
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
const TEXT_STYLE_KEYS = ['size', 'color', 'style', 'align', 'font', 'uppercase'];
let textSeq = 0;

const loadJSON = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const saveJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
st.texts = loadJSON('sc.texts', []).map((t) => ({ ...t, id: 'T' + ++textSeq }));   // os marcados "manter"
st.textSel = null;

const selText = () => st.texts.find((t) => t.id === st.textSel);
const isDark = (hex) => { const n = parseInt(hex.slice(1), 16); return ((n >> 16) * 299 + ((n >> 8) & 255) * 587 + (n & 255) * 114) / 1000 < 110; };

// Guarda o estilo (para o próximo texto) e os textos marcados para manter.
function saveTexts() {
  const t = selText();
  if (t) saveJSON('sc.textStyle', Object.fromEntries(TEXT_STYLE_KEYS.map((k) => [k, t[k]])));
  saveJSON('sc.texts', st.texts.filter((x) => x.keep).map(({ id, _box, ...rest }) => rest));
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
    if (!elementVisible(t, time, st.dur)) { t._box = null; continue; }
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
  const t = { id: 'T' + ++textSeq, text: 'Texto', x: 0.5, y, keep: false, ...d, rotation: 0, z: elementEditor?.nextZ() || 0, in: 0, out: null };
  st.texts.push(t);
  elementEditor?.commit();
  selectText(t.id, true);
}

function selectText(id, focus) {
  if (id) elementPanel = '';
  elementEditor.select(id, true);
  if (focus) { const ta = $('#tText'); ta?.focus(); ta?.select(); }
}

function syncTextSize() {
  const t = selText(), inp = $('#tSize');
  if (!t || !inp) return;
  inp.value = t.size;
  $('#tSizeV').textContent = Math.round(t.size * 1000) / 10;
}

const ALIGN_ICONS = {
  left: '<svg viewBox="0 0 16 16"><path d="M2 3h12M2 6.5h8M2 10h12M2 13.5h8"/></svg>',
  center: '<svg viewBox="0 0 16 16"><path d="M2 3h12M4 6.5h8M2 10h12M4 13.5h8"/></svg>',
  right: '<svg viewBox="0 0 16 16"><path d="M2 3h12M6 6.5h8M2 10h12M6 13.5h8"/></svg>',
};

let elementPanel = '';
const expandedElementOptions = new Set();

async function removeLibraryFile(id) {
  if (st.busy || importingMedia) return;
  const m = libItem(id);
  if (!m) return;
  if (st.images.some(e => e.mediaId === id)) { setStatus('Remove primeiro do vídeo os elementos que usam este ficheiro.'); return; }
  if (st.templates.some(t => t.images?.some(e => e.mediaId === id) || t.streamer?.mediaId === id)) {
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
  const files = [...st.library].sort((a, b) => b.at - a.at);
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

function renderTextOpts() {
  elementEditor?.renderTracks();
  const o = $('#textOpts'), t = elementPanel ? null : selText();
  const selected = elementPanel ? null : elementEditor?.selected();
  const presetButtons = t ? TEXT_PRESETS.map(preset => {
    const active = Object.entries(preset.values).filter(([key]) => key !== 'y').every(([key, value]) => t[key] === value);
    return `<button type="button" class="textPreset${active ? ' on' : ''}" data-text-preset="${preset.id}" aria-pressed="${active}" title="${preset.title}"><span class="presetPreview presetPreview--${preset.id}">${preset.sample}</span><span class="presetName">${preset.name}</span></button>`;
  }).join('') : '';
  const chips = orderedElements(st).reverse().map((x, i) =>
    `<div class="elementRow${x.id === st.textSel ? ' on' : ''}"><button class="elementSelect" data-tid="${x.id}" title="Selecionar"><span class="elementType" aria-hidden="true">${x.mediaId ? (libItem(x.mediaId)?.thumb ? `<img src="${esc(libItem(x.mediaId).thumb)}" alt="">` : '▧') : 'T'}</span><span class="elementName">${esc(x.mediaId ? (libItem(x.mediaId)?.name || 'Imagem') : x.text.split('\n')[0].slice(0, 40) || 'Texto ' + (i + 1))}</span></button></div>`).join('');
  o.innerHTML = `<div class="opt">
    <div class="hrow"><h2>Elementos</h2><button id="addElement" class="btn small" aria-expanded="${!!elementPanel}" aria-controls="elementPicker">+ Adicionar elemento</button></div>
    ${elementPanel ? `<div id="elementPicker" class="elementPicker">
      <div class="seg"><button id="addText" title="Adicionar texto (T)">Texto <kbd>T</kbd></button><button id="showImages" class="${elementPanel === 'image' ? 'on' : ''}">Ficheiro</button></div>
      ${elementPanel === 'image' ? imagePickerHtml() : ''}
    </div>` : ''}
    ${chips ? `<div class="elementList">${chips}</div>` : ''}
    ${t ? `<textarea id="tText" aria-label="Texto do elemento" rows="2" placeholder="Escreve aqui…">${esc(t.text)}</textarea>` : ''}
    ${t ? `<section class="textPresetGroup" aria-label="Presets de texto"><h3>Presets para clips</h3><div class="textPresetGrid">${presetButtons}</div></section>` : ''}
    ${selected ? `<details id="elementOptions" class="elementOptions"${expandedElementOptions.has(selected.id) ? ' open' : ''}><summary>${t ? 'Estilo e posição' : 'Ajustes do ficheiro'}</summary><div class="opt">
      <label>Rotação <input id="elementAngle" type="number" min="-360" max="360" step="1" value="${selected.rotation || 0}"> °</label>
      <button id="elementCenter" class="btn small">Centrar no visor</button>` : ''}
    ${selected?.mediaId ? `<label>Tamanho <input id="imageSize" type="range" min="0.03" max="2" step="0.01" value="${selected.size}"></label>` : ''}
    ${selected?.mediaId ? `<button id="replaceMedia" class="btn small"${importingMedia ? ' disabled' : ''}>${importingMedia ? 'A carregar…' : 'Substituir ficheiro'}</button><input id="replacementFile" type="file" accept="image/*,video/*,.mov,.mp4,.webm,.mkv,.avi,.gif" hidden>` : ''}
    ${t ? `
    <div class="row swatches">${TEXT_COLORS.map((c) => `<button class="sw${c === t.color ? ' on' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
      <label class="sw pick" title="Outra cor"><input id="tColor" type="color" value="${t.color}"></label></div>
    <div class="seg s3">${[['outline', 'Contorno'], ['box', 'Caixa'], ['plain', 'Simples']].map(([v, n]) => `<button data-tstyle="${v}"${t.style === v ? ' class="on"' : ''}>${n}</button>`).join('')}</div>
    <label>Tamanho <input id="tSize" type="range" min="0.02" max="0.25" step="0.001" value="${t.size}"> <span class="mono" id="tSizeV">${Math.round(t.size * 1000) / 10}</span></label>
    <div class="row tools">
      <div class="seg s3 icons">${['left', 'center', 'right'].map((a) => `<button data-talign="${a}" title="Alinhar ${{ left: 'à esquerda', center: 'ao centro', right: 'à direita' }[a]}"${t.align === a ? ' class="on"' : ''}>${ALIGN_ICONS[a]}</button>`).join('')}</div>
      <button id="tUppercase" class="btn small uppercaseToggle${t.uppercase ? ' on' : ''}" aria-label="Maiúsculas" aria-pressed="${!!t.uppercase}" title="Alternar maiúsculas">Aa</button>
      <select id="tFont" title="Letra">${Object.entries(FONTS).map(([k, [n]]) => `<option value="${k}"${t.font === k ? ' selected' : ''}>${n}</option>`).join('')}</select>
    </div>
    <div class="row pos">
      <button class="btn small" data-tpos="cx" title="Centrar na horizontal">↔</button>
      <button class="btn small" data-tpos="cy" title="Centrar na vertical">↕</button>
      <button class="btn small" data-tpos="top" title="Em cima">Cima</button>
      ${st.layout === 'streamer' ? '<button class="btn small" data-tpos="split" title="Na divisão câmara/jogo">Divisão</button>' : ''}
      <button class="btn small" data-tpos="bottom" title="Em baixo">Baixo</button>
    </div>
    <label class="check"><input id="tKeep" type="checkbox"${t.keep ? ' checked' : ''}> Manter nos próximos clips</label>` : ''}
    ${selected ? '</div></details>' : ''}
  </div>`;

  o.querySelector('#addElement').addEventListener('click', () => { elementPanel = elementPanel ? '' : 'choose'; renderTextOpts(); });
  o.querySelector('#addText')?.addEventListener('click', addText);
  o.querySelector('#showImages')?.addEventListener('click', () => { st.textSel = null; elementPanel = 'image'; renderTextOpts(); });
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
  o.querySelector('#tSize').addEventListener('input', (e) => { t.size = +e.target.value; syncTextSize(); saveTexts(); });
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
  o.querySelector('#tKeep').addEventListener('change', (e) => { t.keep = e.target.checked; saveTexts(); });
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
  await saveSession();
  history.replaceState(null, '', `${location.pathname}?recent=${encodeURIComponent(id)}`);
  event.target.disabled = true;
  try {
    const clip = await loadRecentClip(id);
    if (!clip?.blob) throw new Error('Este clip já não está disponível.');
    await touchRecentClip(id);
    st.recentId = id;
    await loadClip(clip.blob, clip.name, clip.channel, true);
    st.recentClips = await listRecentClips();
    renderRecentClips();
  } catch (error) {
    setStatus('Não consegui abrir o clip recente: ' + error.message);
    event.target.value = '';
  } finally { event.target.disabled = false; }
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

function snapshot() {
  const s = st.streamer;
  return {
    v: 2, duration: st.dur, layout: st.layout,
    framing: structuredClone(st.framing),
    streamer: { split: s.split, bottom: s.bottom, mediaId: s.mediaId, scale: s.scale, ox: s.ox, oy: s.oy, cam: s.cam, game: s.game },
    crop: st.crop.keys.length ? cropAt(video.currentTime) : loadJSON('sc.crop', null),
    texts: st.texts.map(({ id, _box, ...rest }) => rest),
    images: cleanElements(st.images),
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
  st.texts = (t.texts || []).map((x) => ({ ...x, id: 'T' + ++textSeq }));
  st.images = (t.images || []).map(x => ({ ...x, id: crypto.randomUUID() }));
  pendingTemplateDuration = null;
  if (Number.isFinite(t.duration) && t.duration > 0) {
    if (st.dur > 0) offsetElementTimes(t.duration, st.dur);
    else pendingTemplateDuration = t.duration;
  }
  normalizeElementTimes();
  st.textSel = null;
  savePrefs();
  rememberCam();
  saveTexts();
  setLayout(t.layout || 'streamer');
  syncMediaTime();
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
  const session = {
    key: sessionKey, start: st.start, end: st.end, parts: st.parts, activePart: st.activePart, rippleCuts: st.rippleCuts, keys: st.crop.keys,
    framing: st.framing,
    texts: st.texts.map(({ id, _box, ...rest }) => rest),
    images: cleanElements(st.images),
    at: Date.now(),
  };
  saveJSON('sc.session', session);
  return saveEditorSession(sessionKey, session).catch((error) => console.warn('sessão', error));
}
setInterval(saveSession, 2000);
addEventListener('pagehide', saveSession);
async function restoreSession() {
  const ss = await loadEditorSession(sessionKey) || loadJSON('sc.session', null);
  if (!ss || ss.key !== sessionKey) return false;
  st.framing = normalizeFraming(ss.framing);
  st.start = clamp(ss.start, 0, st.dur);
  st.end = clamp(ss.end, st.start + 0.5, st.dur);
  st.parts = Array.isArray(ss.parts) ? ss.parts.filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end - r.start > 0.05)
    .map(r => ({ start: clamp(r.start, st.start, st.end), end: clamp(r.end, st.start, st.end) }))
    .filter(r => r.end - r.start > 0.05) : null;
  if (!st.parts?.length) st.parts = null;
  st.activePart = clamp(ss.activePart || 0, 0, Math.max(0, (st.parts?.length || 1) - 1));
  st.rippleCuts = Array.isArray(ss.rippleCuts) ? ss.rippleCuts.filter(c => Number.isFinite(c.start) && Number.isFinite(c.end) && c.start >= 0 && c.end - c.start > 0.05 && c.end <= st.dur).map(c => ({ start: c.start, end: c.end })) : [];
  st.crop.keys = (ss.keys || []).filter((k) => k.t <= st.dur);
  if (ss.texts) { st.texts = ss.texts.map((x) => ({ ...x, id: 'T' + ++textSeq })); st.textSel = null; }
  st.images = (ss.images || []).map(x => ({ ...x, id: crypto.randomUUID() }));
  return true;
}

function normalizeElementTimes() {
  if (!st.dur) return;
  for (const e of orderedElements(st)) {
    e.in = clamp(e.in ?? 0, 0, Math.max(0, st.dur - .1));
    if (e.out != null) e.out = clamp(e.out, Math.min(st.dur, e.in + .1), st.dur);
  }
}

function offsetElementTimes(fromDuration, toDuration) {
  const offset = toDuration - fromDuration;
  for (const e of orderedElements(st)) {
    e.in = (e.in ?? 0) + offset;
    if (e.out != null) e.out += offset;
  }
  normalizeElementTimes();
}

let clipLoadId = 0, clipURL = null;
async function loadClip(blob, name, channel, fromStore = false, initialRange = null, branchId = '') {
  await saveSession();
  const loadId = ++clipLoadId;
  let url = null;
  try {
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
    st.start = 0;
    st.end = mp4.duration;
    st.parts = null;
    st.activePart = 0;
    st.rippleCuts = [];
    st.crop.keys = [];
    st.framing = normalizeFraming(st.templates.find(t => t.id === tplCur)?.framing);
    chanKey = channel || '_last';
    if (video.videoWidth) { st.srcW = video.videoWidth; st.srcH = video.videoHeight; }
    const known = restoreCam();                     // depois de saber o tamanho real do vídeo
    st.dur = Math.min(st.dur, video.duration || st.dur);
    st.end = st.dur;
    if (initialRange && Number.isFinite(initialRange.start) && Number.isFinite(initialRange.end)) {
      const rangeStart = clamp(initialRange.start, 0, st.dur);
      const rangeEnd = clamp(initialRange.end, rangeStart + 0.05, st.dur);
      if (rangeEnd - rangeStart > 0.05) { st.start = rangeStart; st.end = rangeEnd; }
    }
    sessionKey = `${st.name}|${blob.size}${branchId ? `|branch:${branchId}` : ''}`;
    const resumed = await restoreSession();
    if (pendingTemplateDuration != null) {
      if (!resumed) offsetElementTimes(pendingTemplateDuration, st.dur);
      pendingTemplateDuration = null;
    }
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

$('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadClip(f, f.name); });
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragover'); });
stage.addEventListener('dragleave', () => stage.classList.remove('dragover'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) loadClip(f, f.name);
});
addEventListener('resize', placeRects);

// O clip chega da aba da live (quem abriu o editor) por postMessage.
// #pending = o editor abriu no clique e o clip ainda está a ser preparado.
const editorParams = new URLSearchParams(location.search);
const recentIdParam = editorParams.get('recent');
const branchIdParam = editorParams.get('branch') || '';
const initialRange = branchIdParam ? { start: Number(editorParams.get('start')), end: Number(editorParams.get('end')) } : null;
const pending = location.hash === '#pending' || !!recentIdParam;
const openedAt = Date.now();
if (pending) {
  $('#drop').textContent = recentIdParam ? 'A abrir o clip recente…' : 'A preparar o clip…';
  setStatus(recentIdParam ? 'A abrir o clip recente…' : 'A preparar o clip na aba da live…');
}
addEventListener('message', (ev) => {
  const m = ev.data;
  if (!m || (window.opener && ev.source !== window.opener)) return;
  if (m.__scEd === 'clip') loadClip(m.blob, m.name, m.channel);
  if (m.__scEd === 'error' && !st.mp4) {
    $('#drop').textContent = 'O clip falhou: ' + m.message;
    setStatus('Falhou: ' + m.message);
  }
});
if (window.opener) window.opener.postMessage({ __scEd: 'ready' }, '*');
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
  for (let i = 0; i < (pending ? 120 : 1); i++) {
    await new Promise((r) => setTimeout(r, pending ? 1000 : 300));
    if (st.mp4 || srcParam) return;
    try {
      const c = await loadLastClip();
      if (c?.blob && !st.mp4 && (!pending || c.at > openedAt - 1000)) return loadClip(c.blob, c.name, c.channel, true);
    } catch {}
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
  const base = { width: w, height: h, framerate: fps, bitrate: w * h > 1.5e6 ? 12_000_000 : 8_000_000, avc: { format: 'annexb' }, latencyMode: 'quality' };
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
  const total = frameCounts.reduce((sum, count) => sum + count, 0);
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
  const emit = async (frame, sourceTime) => {
    checkAbort();
    const got = media && (await media(n / fps));
    const elementMedia = new Map();
    for (const element of st.images) {
      if (elementVisible(element, sourceTime, st.dur)) elementMedia.set(element.id, await assets.get(element.id)(sourceTime));
    }
    renderFrame(ctx, frame, frame.displayWidth, frame.displayHeight, sourceTime, W, H, () => got, elementMedia);
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
          await emit(prev, range.start + partN / fps);
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
          await emit(prev, range.start + partN / fps);
          partN++;
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
  const err = !at ? '' : isNaN(d) ? 'Escolhe o dia e a hora.' : dt < TT_MIN_MS ? 'Tem de ser pelo menos daqui a 15 minutos.' : dt > TT_MAX_MS ? 'O TikTok só deixa agendar até 10 dias.' : '';
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
let ttQuick1h = '';                      // o valor que o «+1 hora» pôs (muda com o relógio)
function quickTarget(q) {
  const d = new Date();
  if (q === '1h') { d.setTime(d.getTime() + 3600e3); return roundTo5(d); }
  const [h, m] = q.slice(-5).split(':').map(Number);
  if (q.startsWith('tom')) d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d;
}
function markQuick() {
  const at = ttDlg.dataset.when === 'at', cur = `${$('#ttDate').value}T${$('#ttTime').value}`;
  for (const b of ttDlg.querySelectorAll('[data-q]')) {
    const q = b.dataset.q;
    const t = q === '1h' ? ttQuick1h : (() => { const d = quickTarget(q); return `${ymd(d)}T${hm(d)}`; })();
    b.classList.toggle('on', at && t === cur);
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
  if (b.dataset.q === '1h') ttQuick1h = `${ymd(d)}T${hm(d)}`;
  setWhenMode('at');
  setWhen(d);
}));
$('#ttDate').addEventListener('input', checkWhen);
$('#ttTime').addEventListener('input', checkWhen);
$('#ttCap').addEventListener('input', () => setCaption($('#ttCap').value));
$('#ttLastCaption').addEventListener('click', () => { setCaption(lastCaption()); $('#ttCap').focus(); });
$('#ttCap').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#ttGo').click(); } });

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
  if (st.texts.length || st.images.length) return false;
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
  st.busy = true;
  for (const el of document.querySelectorAll('header, .bottom, .optsWrap, #stage')) el.inert = true;
  video.pause();
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
    try {
      await ff.writeFile('v.h264', new Uint8Array(await v.h264.arrayBuffer()));
      const args = ['-hide_banner', '-framerate', String(v.fps), '-i', 'v.h264'];
      if (st.mp4.hasAudio) {
        await ff.writeFile('src.mp4', new Uint8Array(st.buf.slice(0)));   // cópia: o ffmpeg transfere o buffer
        const filters = [], labels = [];
        getRanges().forEach((r, i) => {
          filters.push(`[1:a:0]atrim=start=${r.start.toFixed(3)}:end=${r.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
          labels.push(`[a${i}]`);
        });
        filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1[aout]`);
        args.push('-i', 'src.mp4', '-filter_complex', filters.join(';'), '-map', '0:v:0', '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k');
      } else {
        args.push('-map', '0:v:0');
      }
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
      for (const f of ['v.h264', 'src.mp4', 'out.mp4']) { try { await ff.deleteFile(f); } catch {} }
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
  timelineDuration: editDuration,
  toTimelineTime: sourceToEdit,
  fromTimelineTime: editToSource,
  onCommit: () => recordEdit({ kind: 'element' }),
  onUndo: editHistory,
  canUndo: () => editUndo.length > 0,
  canRedo: () => editRedo.length > 0,
  renderPanel: () => { elementPanel = ''; renderTextOpts(); },
  onSelection: updateTimelineTools,
  save: () => {
    const t = selText();
    if (t) saveJSON('sc.textStyle', Object.fromEntries(TEXT_STYLE_KEYS.map(k => [k, t[k]])));
    saveJSON('sc.texts', st.texts.filter(x => x.keep).map(({ id, _box, ...rest }) => rest));
    saveSession();
  },
  addText, mediaItem: libItem, fmt,
});
if (DEV) globalThis.__editor = { st, exportClip, setLayout, setCropKey, addToLibrary, libItem, previewMedia, addText, selectText, snapshot, applyTemplateSnap, elementEditor, renderFrame, encodeVideo, saveSession, updateTimeline, sourceToEdit, editToSource, editDuration, askTikTok, finishTikTok };

// Abre no último formato usado (a primeira vez: Streamer).
let lastLayout = null;
try { lastLayout = localStorage.getItem('sc.layout'); } catch {}
setLayout(LAYOUT_KEYS.includes(lastLayout) ? lastLayout : 'streamer');
updateTimeline();
requestAnimationFrame(loopPreview);
