// Edição direta e timeline dos elementos. As coordenadas são relativas ao resultado.
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
export const elementVisible = (e, time, duration) => time >= (e.in ?? 0) && time < (e.out ?? (duration || Infinity));
export const orderedElements = (st) => [...st.texts, ...st.images].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));
export const cleanElements = (items) => items.map(({ _box, ...e }) => ({ ...e }));

// Os tempos dos elementos (in/out) estão em segundos da RÉGUA (vídeo final). now()/seek() são o
// cursor da timeline; timelineScale() = segundos que a largura inteira da faixa representa (zoom).
export function createElementEditor({ st, video, preview, renderPanel, save, addText, mediaItem, fmt, onCommit, onUndo, canUndo, canRedo, onSelection, onEditText,
  timelineDuration = () => st.dur, timelineScale = timelineDuration, now = () => video.currentTime, seek = (t) => { video.pause(); video.currentTime = t; }, pause = () => video.pause(),
  exportedLength = (start, end) => end - start }) {
  const $ = s => document.querySelector(s);
  const frame = $('#elementFrame'), toolbar = $('#elementToolbar'), tracks = $('#elementTracks');
  const undoStack = [], redoStack = [];
  let editingText = false, baseline, timer, gesture = false, trackSignature = '', guideX = false, guideY = false;
  const all = () => orderedElements(st);
  const selected = () => all().find(e => e.id === st.textSel);
  const state = () => JSON.stringify({ texts: cleanElements(st.texts), images: cleanElements(st.images) });
  const nextZ = () => Math.max(0, ...all().map(e => e.z || 0)) + 1;
  const label = e => e.mediaId ? mediaItem(e.mediaId)?.name || 'Ficheiro indisponível' : e.text || 'Texto';
  const D = () => timelineDuration();
  const times = e => ({ start: clamp(e.in ?? 0, 0, D()), end: clamp(e.out ?? D(), 0, D()) });
  function buttons() {
    $('#elementUndo').disabled = !(canUndo ? canUndo() : undoStack.length) || st.busy;
    $('#elementRedo').disabled = !(canRedo ? canRedo() : redoStack.length) || st.busy;
  }
  function commit() {
    clearTimeout(timer);
    const now = state();
    if (baseline !== now) {
      undoStack.push(baseline); if (undoStack.length > 80) undoStack.shift();
      redoStack.length = 0; baseline = now;
      onCommit?.();
    }
    buttons(); save(); renderTracks();
  }
  function changed() {
    clearTimeout(timer); timer = setTimeout(commit, 400);
    renderTracks();
  }
  function reset() {
    clearTimeout(timer); undoStack.length = redoStack.length = 0; baseline = state();
    renderTracks(); buttons();
  }
  function history(redo = false) {
    if (st.busy || gesture) return;
    commit();
    const source = redo ? redoStack : undoStack, dest = redo ? undoStack : redoStack;
    if (!source.length) return;
    dest.push(state()); Object.assign(st, JSON.parse(source.pop())); baseline = state();
    if (!selected()) st.textSel = null;
    save(); renderPanel(); renderTracks(); update(); buttons(); onSelection?.();
  }
  function select(id, seekTo = false) {
    st.textSel = id;
    const e = selected();
    if (e && seekTo && D() && !elementVisible(e, now(), D())) seek(Math.min(times(e).start, Math.max(0, D() - 0.001)));
    renderPanel(); renderTracks(); update(); buttons(); onSelection?.();
  }
  function remove() {
    if (!selected() || st.busy) return;
    commit();
    st.texts = st.texts.filter(e => e.id !== st.textSel);
    st.images = st.images.filter(e => e.id !== st.textSel);
    st.textSel = null; commit(); renderPanel(); update(); onSelection?.();
  }
  // Apagar diretamente na lista, sem ter de selecionar primeiro (botão ✕ de cada linha).
  function removeById(id) {
    if (st.busy || !all().some(e => e.id === id)) return;
    const wasSelected = st.textSel === id;
    commit();
    st.texts = st.texts.filter(e => e.id !== id);
    st.images = st.images.filter(e => e.id !== id);
    if (wasSelected) st.textSel = null;
    commit(); renderPanel(); update();
    if (wasSelected) onSelection?.();
  }
  function trimSelected(edge, time = now()) {
    const e = selected(); if (!e || st.busy) return false;
    const { start, end } = times(e), min = Math.min(.1, D());
    commit();
    if (edge === 'in') e.in = clamp(time, 0, end - min);
    else e.out = clamp(time, start + min, D());
    commit(); renderPanel(); update();
    return true;
  }
  function splitSelected(time = now()) {
    const e = selected(); if (!e || st.busy) return false;
    const { start, end } = times(e), min = Math.min(.1, D());
    if (time <= start + min || time >= end - min) return false;
    commit();
    const right = { ...cleanElements([e])[0], id: crypto.randomUUID(), in: time };
    e.out = time;
    (e.mediaId ? st.images : st.texts).push(right);
    st.textSel = right.id;
    commit(); renderPanel(); renderTracks(); update(); buttons(); onSelection?.();
    return true;
  }
  // A cópia fica logo a seguir à original na timeline (nunca em cima dela), como em qualquer
  // editor de vídeo. Só sobrepõe no caso raro em que o elemento já ocupa o clip todo e não há
  // espaço livre antes nem depois.
  function duplicate() {
    const e = selected(); if (!e || st.busy) return;
    commit();
    const { start, end } = times(e), length = Math.max(.1, end - start), dur = D();
    let copyIn;
    if (end + .05 < dur) copyIn = end;
    else if (start - length > -.05) copyIn = Math.max(0, start - length);
    else copyIn = start;
    const copyOut = e.out != null ? Math.min(dur, copyIn + length) : null;
    const copy = { ...cleanElements([e])[0], id: crypto.randomUUID(), in: copyIn, out: copyOut, x: clamp(e.x + .035, 0, 1), y: clamp(e.y + .035, 0, 1), z: nextZ() };
    (e.mediaId ? st.images : st.texts).push(copy); commit(); select(copy.id, true);
  }
  function addImage(id, props = {}) {
    const m = mediaItem(id); if (!m || !['image', 'video', 'gif'].includes(m.type) || st.busy) return;
    commit();
    // Vídeos e GIFs entram no cursor com a duração original do ficheiro (não ocupam o clip todo);
    // se forem mais longos do que o resto do vídeo, o vídeo final estica até eles acabarem.
    // Imagens paradas continuam a cobrir o vídeo inteiro.
    const timed = (m.type === 'video' || m.type === 'gif') && m.dur > 0;
    const start = timed ? clamp(now(), 0, Math.max(0, D() - 0.1)) : 0;
    const e = { id: crypto.randomUUID(), mediaId: id, x: .5, y: .5, size: .4, rotation: 0, z: nextZ(), in: start, out: timed ? start + m.dur : null, ...props };
    st.images.push(e); commit(); select(e.id, true);
  }
  function hit(ev) {
    const r = preview.getBoundingClientRect();
    for (const e of all().reverse()) {
      if (!e._box || !elementVisible(e, now(), D())) continue;
      const a = -(e.rotation || 0) * Math.PI / 180;
      const dx = ev.clientX - r.left - e.x * r.width, dy = ev.clientY - r.top - e.y * r.height;
      const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(x) <= e._box.w * r.width / 2 + 4 && Math.abs(y) <= e._box.h * r.height / 2 + 4) return e;
    }
  }
  function update() {
    const e = selected(), b = e?._box;
    const visible = !!(e && b && elementVisible(e, now(), D()) && !st.busy && !editingText);
    frame.hidden = toolbar.hidden = !visible;
    if (visible) {
      Object.assign(frame.style, { left: `${e.x * 100}%`, top: `${e.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%`, transform: `translate(-50%, -50%) rotate(${e.rotation || 0}deg)` });
      frame.setAttribute('aria-label', `Mover ${label(e)}`);
      // A barra fica fora da vista com zoom (não escala com ela): posição relativa ao seu contentor.
      const box = toolbar.offsetParent.getBoundingClientRect(), selection = frame.getBoundingClientRect();
      const barWidth = toolbar.offsetWidth, barHeight = toolbar.offsetHeight;
      const maxLeft = Math.max(8, box.width - barWidth - 8);
      const left = clamp(selection.left + selection.width / 2 - box.left - barWidth / 2, 8, maxLeft);
      // Deixa espaço para a pega de rotação acima da moldura.
      let top = selection.top - box.top - barHeight - 43;
      if (top < 8) top = selection.bottom - box.top + 12;
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${clamp(top, 8, Math.max(8, box.height - barHeight - 8))}px`;
    }
    $('#elementGuideX').hidden = !guideX;
    $('#elementGuideY').hidden = !guideY;
    $('#elementGuideY').style.top = `${guideY * 100}%`;
    $('#tracksHead').hidden = !D();
  }
  function startGesture(ev, e, mode) {
    if (ev.button !== 0 || st.busy || !e?._box) return;
    ev.preventDefault(); ev.stopImmediatePropagation(); pause(); commit();
    select(e.id); document.activeElement?.blur(); gesture = true;
    const target = ev.currentTarget; target.setPointerCapture(ev.pointerId);
    const r = preview.getBoundingClientRect(), initial = { ...e }, b = { ...e._box };
    const x0 = ev.clientX, y0 = ev.clientY, a = (e.rotation || 0) * Math.PI / 180;
    const center = { x: r.left + e.x * r.width, y: r.top + e.y * r.height };
    const startAngle = Math.atan2(y0 - center.y, x0 - center.x);
    const sx = mode.includes('w') ? -1 : 1, sy = mode.includes('n') ? -1 : 1;
    const vx = sx * b.w * r.width, vy = sy * b.h * r.height;
    const rx = vx * Math.cos(a) - vy * Math.sin(a), ry = vx * Math.sin(a) + vy * Math.cos(a);
    const anchorX = center.x - rx / 2, anchorY = center.y - ry / 2;
    const move = event => {
      if (mode === 'move') {
        e.x = clamp(initial.x + (event.clientX - x0) / r.width, 0, 1);
        e.y = clamp(initial.y + (event.clientY - y0) / r.height, 0, 1);
        guideX = !event.altKey && Math.abs(e.x - .5) < .015;
        const lines = st.layout === 'streamer' ? [.5, 1 / 3, 2 / 3, st.streamer.split] : [.5, 1 / 3, 2 / 3];
        guideY = !event.altKey && lines.find(y => Math.abs(e.y - y) < .015);
        if (guideX) e.x = .5; if (guideY) e.y = guideY;
      } else if (mode === 'rotate') {
        let degrees = initial.rotation || 0;
        degrees += (Math.atan2(event.clientY - center.y, event.clientX - center.x) - startAngle) * 180 / Math.PI;
        e.rotation = event.shiftKey ? Math.round(degrees / 15) * 15 : Math.round(degrees);
      } else {
        const scale = ((event.clientX - anchorX) * rx + (event.clientY - anchorY) * ry) / (rx * rx + ry * ry);
        e.size = clamp(initial.size * scale, e.mediaId ? .03 : .02, e.mediaId ? 2 : .25);
        const actual = e.size / initial.size;
        e.x = clamp((anchorX + rx * actual / 2 - r.left) / r.width, 0, 1);
        e.y = clamp((anchorY + ry * actual / 2 - r.top) / r.height, 0, 1);
      }
      update();
    };
    const end = event => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end);
      if (target.hasPointerCapture(ev.pointerId)) target.releasePointerCapture(ev.pointerId);
      if (event.type === 'pointercancel') Object.assign(e, initial);
      gesture = guideX = guideY = false; commit(); renderPanel(); update();
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
  }
  preview.addEventListener('pointerdown', ev => {
    const e = hit(ev);
    if (e) startGesture(ev, e, 'move');
    else if (selected()) { select(null); ev.scDeselected = true; }   // o editor não trata este clique como "selecionar zona"
  }, true);
  frame.addEventListener('pointerdown', ev => startGesture(ev, selected(), ev.target.dataset.handle || 'move'));
  // Editar o texto: diretamente no resultado, se o editor souber (onEditText); senão na caixa do painel.
  const setEditingText = (v) => { editingText = v; update(); };
  const editText = () => {
    const e = selected();
    if (!e || e.mediaId) return;
    if (onEditText) onEditText(e); else { renderPanel(); $('#tText')?.focus(); $('#tText')?.select(); }
  };
  frame.addEventListener('dblclick', editText);
  preview.addEventListener('dblclick', ev => { const e = hit(ev); if (e) { select(e.id); editText(); } });
  preview.addEventListener('pointermove', ev => { if (!ev.buttons && hit(ev)) { ev.stopImmediatePropagation(); preview.style.cursor = 'move'; } else preview.style.cursor = ''; }, true);
  // A roda só redimensiona o elemento SELECIONADO (com a moldura à vista); sobre o resto é o zoom da vista.
  function wheel(ev) {
    const h = ev.currentTarget === frame ? selected() : hit(ev), e = h && h === selected() ? h : null;
    if (!e || st.busy) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    e.size = clamp(e.size * (ev.deltaY < 0 ? 1.06 : 1 / 1.06), e.mediaId ? .03 : .02, e.mediaId ? 2 : .25);
    changed(); renderPanel();
  }
  preview.addEventListener('wheel', wheel, { capture: true, passive: false });
  frame.addEventListener('wheel', wheel, { passive: false });
  function renderTracks() {
    const items = all().reverse();
    const duration = D(), scale = timelineScale();
    const signature = JSON.stringify([st.dur, st.parts, duration, scale, st.textSel, st.name, st.busy, items.map(e => [e.id, e.z, label(e), e.in, e.out])]);
    if (gesture || signature === trackSignature) return;
    trackSignature = signature;
    const pct = t => scale ? t / scale * 100 : 0;
    tracks.innerHTML = items.map(e => {
      const {start, end} = times(e), displayStart = start, displayEnd = end;
      // Um elemento que cai todo num trecho cortado (que pode continuar a ocupar espaço na régua,
      // ou ficar com a largura mínima do bloco) — ou cujo ficheiro já não existe — parecia normal
      // na timeline sem nunca aparecer no vídeo. Fica marcado e explica porquê.
      const outside = exportedLength(start, end) < 0.05, missing = e.mediaId && !mediaItem(e.mediaId);
      const warn = missing ? 'O ficheiro já não está na biblioteca — não aparece no vídeo' : outside ? 'Fora do trecho exportado — não aparece no vídeo. Arrasta-o para dentro do vídeo.' : '';
      return `<div class="elementTrack" data-track="${esc(e.id)}"><button class="trackLabel" data-select="${esc(e.id)}" draggable="true" title="Selecionar ${esc(label(e))} · arrasta para reordenar as camadas">${e.mediaId ? '▧' : 'T'} ${esc(label(e))}</button><div class="trackLane"><div class="elementBlock ${e.mediaId ? 'imageBlock' : ''} ${e.id === st.textSel ? 'on' : ''} ${outside || missing ? 'unseen' : ''}" data-element="${esc(e.id)}" style="left:${pct(displayStart)}%;width:${Math.max(0, pct(displayEnd - displayStart))}%" role="button" tabindex="0" ${warn ? `title="${esc(warn)}"` : ''} aria-label="${esc(label(e))}: ${fmt(displayStart)} a ${fmt(displayEnd)}${warn ? ' · ' + esc(warn) : ''}"><span class="timeGrip" data-edge="in" title="Ajustar início"></span><span class="blockName">${esc(label(e))}</span><span class="timeGrip end" data-edge="out" title="Ajustar fim"></span></div></div></div>`;
    }).join('');
    buttons();
  }
  function trackDrag(ev) {
    const block = ev.target.closest('[data-element]'); if (!block || st.busy || !D() || ev.button !== 0) return;
    const e = all().find(e => e.id === block.dataset.element); if (!e) return;
    ev.preventDefault(); commit(); pause();
    // Manter o nó que captura o ponteiro até terminar o arrasto.
    gesture = true; st.textSel = e.id; renderPanel(); update(); buttons(); onSelection?.();
    block.classList.add('on'); block.setPointerCapture(ev.pointerId);
    const r = block.parentElement.getBoundingClientRect(), x0 = ev.clientX, old = { in: e.in, out: e.out }, initial = times(e), edge = ev.target.dataset.edge;
    const duration = D(), scale = timelineScale(), displayStart = initial.start, displayEnd = initial.end;
    const min = Math.min(.1, duration), displayLength = displayEnd - displayStart;
    const points = [0, duration, now(), ...all().filter(x => x !== e).flatMap(x => [times(x).start, times(x).end])];
    const snap = (value, alt) => alt ? value : points.find(x => Math.abs(x - value) < scale * 7 / r.width) ?? value;
    let moved = false;
    const move = event => {
      if (Math.abs(event.clientX - x0) < 3 && !moved) return;
      moved = true;
      const dt = (event.clientX - x0) / r.width * scale;
      if (edge === 'in') { e.in = clamp(snap(displayStart + dt, event.altKey), 0, initial.end - min); e.out = initial.end; }
      else if (edge === 'out') { e.in = initial.start; e.out = clamp(snap(displayEnd + dt, event.altKey), initial.start + min, duration); }
      else {
        let start = snap(displayStart + dt, event.altKey);
        if (start === displayStart + dt) start = snap(start + displayLength, event.altKey) - displayLength;
        start = clamp(start, 0, duration - displayLength);
        e.in = start; e.out = start + displayLength;
      }
      block.style.left = `${scale ? e.in / scale * 100 : 0}%`;
      block.style.width = `${scale ? Math.max(0, e.out - e.in) / scale * 100 : 0}%`;
      seek(edge === 'out' ? Math.max(e.in, e.out - .025) : e.in);
    };
    const end = event => {
      block.removeEventListener('pointermove', move); block.removeEventListener('pointerup', end); block.removeEventListener('pointercancel', end);
      if (block.hasPointerCapture(ev.pointerId)) block.releasePointerCapture(ev.pointerId);
      if (event.type === 'pointercancel') Object.assign(e, old);
      gesture = false; commit(); select(e.id, true);
    };
    block.addEventListener('pointermove', move); block.addEventListener('pointerup', end); block.addEventListener('pointercancel', end);
  }
  tracks.addEventListener('pointerdown', trackDrag);
  tracks.addEventListener('click', ev => {
    const id = ev.target.closest('[data-select]')?.dataset.select;
    if (id) select(id, true);
    else if (!ev.target.closest('[data-element]') && ev.target.closest('.trackLane') && D()) {
      const r = ev.target.closest('.trackLane').getBoundingClientRect(); seek(clamp((ev.clientX - r.left) / r.width * timelineScale(), 0, D()));
    }
  });
  tracks.addEventListener('keydown', ev => { if (ev.key === 'Enter' && ev.target.dataset.element) { ev.preventDefault(); select(ev.target.dataset.element, true); } });

  // Arrastar a etiqueta verticalmente troca a ordem das camadas (z), como num editor normal.
  // Usa o drag-and-drop nativo (não o pointer capture do trackDrag): assim nunca se chama
  // renderTracks() a meio do arrasto (isso cancelaria o drag nativo, ou pior, deixava-o preso
  // a um nó já destacado — o mesmo problema que houve no arrastar do áudio).
  function reorderElement(draggedId, targetId, before) {
    if (st.busy || draggedId === targetId) return;
    const item = all().find(x => x.id === draggedId);
    if (!item) return;
    commit();
    const order = all().reverse();   // de cima para baixo, como é mostrado
    order.splice(order.findIndex(x => x.id === draggedId), 1);
    let to = order.findIndex(x => x.id === targetId);
    if (to < 0) return;
    if (!before) to++;
    order.splice(to, 0, item);
    order.forEach((x, i) => { x.z = order.length - i; });
    commit(); renderPanel();
  }
  let draggingId = null;
  const clearDragMarks = () => tracks.querySelectorAll('.elementTrack').forEach(r => r.classList.remove('dragging', 'dragOver', 'dragOverBottom'));
  tracks.addEventListener('dragstart', ev => {
    const row = ev.target.closest('.elementTrack');
    if (!row || st.busy) { ev.preventDefault(); return; }
    draggingId = row.dataset.track;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', draggingId);   // o Firefox exige dados para o drag arrancar
    row.classList.add('dragging');
  });
  tracks.addEventListener('dragover', ev => {
    const row = ev.target.closest('.elementTrack');
    if (!row || !draggingId || row.dataset.track === draggingId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const r = row.getBoundingClientRect(), before = ev.clientY < r.top + r.height / 2;
    tracks.querySelectorAll('.dragOver, .dragOverBottom').forEach(x => x.classList.remove('dragOver', 'dragOverBottom'));
    row.classList.add(before ? 'dragOver' : 'dragOverBottom');
  });
  tracks.addEventListener('drop', ev => {
    const row = ev.target.closest('.elementTrack');
    if (row && draggingId && row.dataset.track !== draggingId) {
      ev.preventDefault();
      const r = row.getBoundingClientRect();
      reorderElement(draggingId, row.dataset.track, ev.clientY < r.top + r.height / 2);
    }
    draggingId = null; clearDragMarks();
  });
  tracks.addEventListener('dragend', () => { draggingId = null; clearDragMarks(); });
  const contextMenu = $('#elementContextMenu');
  let contextId = null;
  function closeContext(restoreFocus = false) {
    contextMenu.hidden = true;
    if (restoreFocus && contextId) tracks.querySelector(`[data-element="${contextId}"]`)?.focus();
    contextId = null;
  }
  function showContext(ev) {
    const target = ev.target.closest('[data-element], [data-select]');
    if (!target || st.busy) return;
    ev.preventDefault(); ev.stopPropagation();
    const rect = target.getBoundingClientRect();
    contextId = target.dataset.element || target.dataset.select;
    select(contextId, true);
    contextMenu.hidden = false;
    const x = ev.clientX || rect.left, y = ev.clientY || rect.bottom;
    contextMenu.style.left = `${clamp(x, 8, innerWidth - contextMenu.offsetWidth - 8)}px`;
    contextMenu.style.top = `${clamp(y, 8, innerHeight - contextMenu.offsetHeight - 8)}px`;
    contextMenu.querySelector('button').focus();
  }
  tracks.addEventListener('contextmenu', showContext);
  tracks.addEventListener('keydown', ev => {
    if (ev.key === 'ContextMenu' || (ev.shiftKey && ev.key === 'F10')) showContext(ev);
  });
  contextMenu.addEventListener('click', ev => {
    const action = ev.target.closest('[data-context-action]')?.dataset.contextAction;
    if (!action || !contextId) return;
    st.textSel = contextId;
    closeContext();
    if (action === 'delete') remove(); else duplicate();
    tracks.querySelector(`[data-element="${st.textSel}"]`)?.focus();
  });
  contextMenu.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Escape' || ev.key === 'Tab') { closeContext(true); ev.preventDefault(); }
    else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const items = [...contextMenu.querySelectorAll('button')], index = items.indexOf(document.activeElement);
      items[(index + (ev.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  document.addEventListener('pointerdown', ev => { if (!contextMenu.contains(ev.target)) closeContext(); });
  document.addEventListener('scroll', () => closeContext(), true);
  window.addEventListener('resize', () => { closeContext(); update(); });
  $('#elementUndo').addEventListener('click', () => onUndo ? onUndo(false) : history());
  $('#elementRedo').addEventListener('click', () => onUndo ? onUndo(true) : history(true));
  toolbar.addEventListener('click', ev => {
    const action = ev.target.closest('[data-action]')?.dataset.action;
    if (action === 'delete') remove();
    if (action === 'duplicate') duplicate();
    const e = selected(); if (!e || st.busy) return;
    if (action === 'front' || action === 'back') {
      commit(); e.z = action === 'front' ? nextZ() : Math.min(0, ...all().map(x => x.z || 0)) - 1; commit(); renderPanel();
    }
  });
  document.addEventListener('keydown', ev => {
    if (ev.target.closest('dialog, [role="menu"]')) return;
    if (st.busy || ev.target.matches('input,textarea,select,[contenteditable=true]')) return;
    const k = ev.key.toLowerCase(), ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && (k === 'z' || k === 'y')) { ev.preventDefault(); ev.stopImmediatePropagation(); if (onUndo) onUndo(k === 'y' || ev.shiftKey); else history(k === 'y' || ev.shiftKey); }
    else if (ctrl && k === 'd') { ev.preventDefault(); ev.stopImmediatePropagation(); duplicate(); }
    else if (!ctrl && !ev.altKey && (k === 'delete' || k === 'backspace') && selected()) { ev.preventDefault(); ev.stopImmediatePropagation(); remove(); }
    else if (k === 'escape') select(null);
    else if (k === 'enter' && selected() && !selected().mediaId) { ev.preventDefault(); ev.stopImmediatePropagation(); editText(); }
    else if (!ctrl && !ev.altKey && k === 't') { ev.preventDefault(); ev.stopImmediatePropagation(); addText(); }
    else if (selected() && ['arrowleft','arrowright','arrowup','arrowdown'].includes(k)) {
      ev.preventDefault(); ev.stopImmediatePropagation();
      const e = selected(), r = preview.getBoundingClientRect(), step = ev.shiftKey ? 10 : 1;
      if (k === 'arrowleft' || k === 'arrowright') e.x = clamp(e.x + (k === 'arrowleft' ? -step : step) / r.width, 0, 1);
      else e.y = clamp(e.y + (k === 'arrowup' ? -step : step) / r.height, 0, 1);
      changed(); update();
    }
  }, true);
  reset();
  return { selected, select, addImage, remove, removeById, duplicate, trimSelected, splitSelected, changed, commit, reset, update, renderTracks, nextZ, undo: history, refreshButtons: buttons, setEditingText };
}
