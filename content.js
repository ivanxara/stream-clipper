// Stream Clipper — content script
// Mantém um buffer circular dos últimos ~120s do <video> principal da página,
// gravado em segmentos curtos (cada um é um ficheiro WebM completo).
// Ao clicar, junta os segmentos certos (via ffmpeg.wasm num iframe da extensão).
(() => {
  if (window.__streamClipper) return;
  window.__streamClipper = true;

  const SEG_MS = 8000;          // menos reinícios do codificador, mantendo o buffer circular
  const KEEP_MS = 140000;       // histórico para clips de 120s e fallback do modo live
  const DURATIONS = [15, 30, 45, 60, 120];
  const MIME_CANDIDATES = [
    'video/webm;codecs=h264,opus',   // Chrome: H.264 -> dá MP4 sem re-encode
    'video/webm;codecs=avc1,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];

  const state = {
    enabled: false,
    video: null,
    stream: null,
    mime: null,
    segments: [],       // {start, end, blob, done, rec, donePromise}
    current: null,
    timer: null,
    seekListeners: [],
    busy: false,
    error: null,
    lastDataAt: 0,
    retryAt: 0,
    triedCodecs: new Set(),
  };

  // ---------- utilidades ----------
  const now = () => performance.now();

  function pickMime() {
    return MIME_CANDIDATES.find((m) => !state.triedCodecs.has(m) && window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  function recorderOptions(stream, mime) {
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    const width = settings.width || state.video?.videoWidth || 1280;
    const height = settings.height || state.video?.videoHeight || 720;
    const fps = settings.frameRate || 30;
    const videoBitsPerSecond = Math.min(18_000_000, Math.max(3_000_000, Math.round(width * height * fps * 0.13)));
    return { mimeType: mime, videoBitsPerSecond, audioBitsPerSecond: 192_000 };
  }

  function findMainVideo() {
    let best = null, bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 20000 || v.readyState < 2) continue;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  // ---------- gravação por segmentos ----------
  function startSegment() {
    const seg = { start: null, end: null, blob: null, done: false, chunks: [], mime: state.mime, gen: bufferGen };
    let rec;
    try {
      rec = new MediaRecorder(state.stream, recorderOptions(state.stream, state.mime));
    } catch (e) {
      state.triedCodecs.add(seg.mime);
      fail('Não foi possível iniciar a gravação: ' + e.message);
      return null;
    }
    seg.rec = rec;
    seg.startedPromise = new Promise((res) => { rec.onstart = () => { seg.start = now(); res(); }; });
    seg.donePromise = new Promise((res) => {
      rec.onstop = () => { seg.end ??= now(); finalize(seg); res(seg); };
    });
    rec.ondataavailable = (e) => {
      if (e.data?.size && seg.chunks) {
        seg.chunks.push(e.data);
        seg.dataAt = now();
        if (seg.gen === bufferGen) { state.lastDataAt = seg.dataAt; state.error = null; }
      }
    };
    rec.onerror = (e) => {
      if (seg.gen !== bufferGen) return;
      state.triedCodecs.add(seg.mime);
      fail('Erro na gravação: ' + (e.error?.message || e));
    };
    try {
      rec.start(1000);   // timeslice: os dados vão chegando, mesmo que o onstop se atrase
    } catch (e) {
      state.triedCodecs.add(seg.mime);
      fail('Não foi possível iniciar a gravação: ' + e.message);
      return null;
    }
    seg.start = now();   // o onstart afina isto, mas não dependemos dele
    state.segments.push(seg);
    return seg;
  }

  function finalize(seg) {
    if (seg.done) return;
    seg.blob = new Blob(seg.chunks || [], { type: seg.mime.split(';')[0] });
    seg.chunks = null;
    seg.done = true;
  }

  // Espera que o segmento feche; se o browser nunca disparar onstop, usa o que já chegou.
  function waitDone(seg, ms = 4000) {
    return Promise.race([seg.donePromise, sleep(ms).then(() => { finalize(seg); return seg; })]);
  }

  // Rotações em fila: a automática (4s) e a do clique nunca correm ao mesmo tempo.
  let rotating = Promise.resolve();
  function rotate() {
    const gen = bufferGen;
    const run = () => gen === bufferGen ? doRotate() : null;
    const p = rotating.then(run, run);
    rotating = p.catch(() => {});
    return p;
  }

  // Começa um segmento novo e só depois pára o anterior (sobreposição mínima, sem buracos).
  async function doRotate() {
    if (!state.stream) return null;
    const old = state.current;
    const next = startSegment();
    state.current = next;
    if (next) await Promise.race([next.startedPromise, sleep(1500)]);
    if (next && next.gen !== bufferGen) return old;
    if (old && old.rec.state !== 'inactive') {
      old.end = now();
      try { old.rec.stop(); } catch { finalize(old); }
    } else if (old && old.end == null) {
      old.end = now();
      finalize(old);
    }
    prune();
    return old;
  }

  function prune() {
    const limit = now() - KEEP_MS;
    state.segments = state.segments.filter((s) => s === state.current || (s.end ?? s.start) > limit);
  }

  function scheduleRotation() {
    clearInterval(state.timer);
    if (state.enabled && state.stream) state.timer = setInterval(() => rotate().catch((e) => fail(e.message)), SEG_MS);
  }

  let bufferGen = 0;
  function stopBuffer() {
    if (manual.rec) stopManual(false);
    bufferGen++;
    clearInterval(state.timer);
    state.timer = null;
    for (const [video, type, listener] of state.seekListeners) video.removeEventListener(type, listener);
    state.seekListeners = [];
    for (const s of state.segments) if (s.rec && s.rec.state !== 'inactive') { try { s.rec.stop(); } catch {} }
    for (const track of state.stream?.getTracks() || []) track.stop();
    state.segments = [];
    state.current = null;
    state.stream = null;
    state.video = null;
    render();
  }

  async function startBuffer(video, retry = false) {
    stopBuffer();
    const gen = ++bufferGen;
    state.retryAt = now() + 10000;
    if (!retry) state.triedCodecs.clear();
    state.error = null;
    state.mime = pickMime();
    if (!state.mime) return fail('Não foi possível gravar com os formatos disponíveis neste browser.');
    let stream;
    try {
      stream = video.captureStream();
    } catch (e) {
      return fail('Este vídeo não pode ser capturado (' + e.message + ').');
    }
    state.video = video;
    // As faixas aparecem de forma assíncrona: espera pelo vídeo (e dá tempo ao áudio).
    for (let i = 0; i < 50 && !stream.getVideoTracks().length; i++) await sleep(100);
    await sleep(300);
    if (gen !== bufferGen || !stream.getVideoTracks().length) {
      for (const track of stream.getTracks()) track.stop();
      if (gen === bufferGen) { state.video = null; fail('Sem imagem para gravar.'); }
      return;
    }
    state.stream = stream;
    state.lastDataAt = now();
    const videoSeeking = () => {
      if (state.stream === stream && state.enabled) resetSegments(false);
    };
    const videoSeeked = () => {
      if (state.stream === stream && state.enabled) resetSegments();
    };
    video.addEventListener('seeking', videoSeeking);
    video.addEventListener('seeked', videoSeeked);
    state.seekListeners = [[video, 'seeking', videoSeeking], [video, 'seeked', videoSeeked]];
    // Se as faixas mudarem depois (troca de fonte), recomeça o buffer.
    let t;
    const restart = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (state.stream !== stream || !state.enabled || manual.rec) return;
        resetSegments();
      }, 1500);
    };
    stream.addEventListener('addtrack', restart);
    stream.addEventListener('removetrack', restart);
    state.current = startSegment();
    scheduleRotation();
    render();
  }

  // Descarta o buffer e recomeça a gravar no mesmo stream.
  function resetSegments(restart = true) {
    if (!state.stream) return;
    bufferGen++;
    clearInterval(state.timer);
    state.timer = null;
    for (const s of state.segments) if (s.rec && s.rec.state !== 'inactive') { try { s.rec.stop(); } catch {} }
    state.segments = [];
    state.current = restart && state.stream.getVideoTracks().some((t) => t.readyState === 'live') ? startSegment() : null;
    if (state.current) scheduleRotation();
    render();
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitForSeeked(video) {
    if (!video?.seeking) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        video.removeEventListener('seeked', done);
        resolve();
      };
      video.addEventListener('seeked', done, { once: true });
      timer = setTimeout(() => {
        video.removeEventListener('seeked', done);
        reject(new Error('O vídeo ainda está a procurar uma posição.'));
      }, 15000);
      if (!video.seeking) done();
    });
  }

  function bufferedSeconds() {
    // Só conta dados recebidos; um MediaRecorder ativo pode nunca produzir imagem.
    const total = state.segments.reduce((sum, s, i, all) => {
      if (!s.blob?.size && !s.chunks?.some((b) => b.size)) return sum;
      const end = Math.min(s.end ?? s.dataAt ?? s.start, all[i + 1]?.start ?? Infinity);
      return sum + Math.max(0, end - Math.max(s.start, now() - KEEP_MS));
    }, 0);
    return Math.min(KEEP_MS, total) / 1000;
  }

  // ---------- criar o clip ----------
  const server = self.StreamClipperServer;
  const serverAvailable = () => !!server?.available();

  async function clip(seconds) {
    if (state.busy) return;
    const useServer = serverAvailable();
    if (!useServer && !state.stream) return toast('Nenhum vídeo a gravar ainda.');
    state.busy = true;
    render('A preparar clip de ' + seconds + 's…');
    // O editor abre já (o browser só deixa abrir abas no instante do clique/tecla) e recebe o clip
    // quando estiver pronto. Se a aba for bloqueada, o clip é guardado diretamente.
    const editor = openEditorTab('#pending');
    try {
      const clickTime = now();
      // Guarda as referências antes da descarga: o buffer pode rodar ou ser reiniciado entretanto.
      const snapshot = state.segments.slice();
      const snapshotGen = bufferGen;
      // Fecha o segmento atual exatamente agora (fica como reserva); não se espera por isto
      // antes do modo live, para a posição do player ser lida no instante do clique.
      const rotated = state.stream ? rotate().then(scheduleRotation) : Promise.resolve();
      rotated.catch(() => {});
      let job = null, serverError = null;
      if (useServer) {
        try {
          const r = await server.clip(seconds, { onProgress: (t) => render(t), video: state.video || findMainVideo() });
          job = { kind: 'server', ...r, name: makeFilename(seconds, 'mp4') };
        } catch (e) {
          serverError = e;
          console.warn('[StreamClipper] modo live falhou, a usar a gravação:', e);
          render(server.label() + ' falhou (' + e.message + ') · a usar a gravação…');
        }
      }
      if (!job) {
        await rotated;
        if (state.video?.seeking) {
          render('À espera que o vídeo termine a procura…');
          await waitForSeeked(state.video);
        }
        const bufferChanged = snapshotGen !== bufferGen;
        // Num clique imediato, captureStream pode ainda estar a criar as faixas.
        // Dá tempo à inicialização já em curso antes de declarar o buffer vazio.
        for (let i = 0; i < 20 && !state.stream && state.video && state.enabled; i++) await sleep(100);
        if (!state.stream && !snapshot.length) throw serverError || new Error('Nenhum vídeo a gravar ainda.');
        try {
          job = await recordedJob(seconds, bufferChanged ? now() : clickTime, bufferChanged ? state.segments.slice() : snapshot);
        } catch (error) {
          throw serverError ? new Error(serverError.message + ' ' + error.message) : error;
        }
        if (job.got + 0.5 < seconds) {
          job.warning = `Clip parcial: ${job.got.toFixed(1)}s dos ${seconds}s pedidos · ${job.recovered ? 'capturado após o clique, porque o buffer estava vazio' : 'só havia este trecho no buffer'}`;
          job.name = makeFilename(Math.max(1, Math.round(job.got)) + 's_parcial', job.out);
        }
      }
      await deliver(job, editor);
    } catch (e) {
      console.error('[StreamClipper]', e);
      editor?.send({ __scEd: 'error', message: e.message });
      toast('Falhou: ' + e.message);
    } finally {
      state.busy = false;
      render();
    }
  }

  // Junta o clip no processador e abre-o no editor (ou guarda-o, se a aba foi bloqueada).
  async function deliver(job, editor) {
    render(job.kind === 'server' ? 'A juntar o clip…' : `A juntar ${Math.round(job.got)}s de vídeo…`);
    job.save = !editor;
    const res = await processInFrame(job);
    if (res?.raw) {
      // A conversão falhou, mas o clip gravado não se perdeu: já foi descarregado tal como
      // estava (ver processor.js). Avisa e não tenta abrir isto no editor (não sabe ler).
      editor?.send({ __scEd: 'error', message: 'Não consegui preparar o clip, mas gravei-o tal como estava — vê as transferências.' });
      toast('A conversão falhou — guardei o clip em bruto nas transferências (não editável, mas não se perdeu).');
      return;
    }
    if (res?.blob) state.lastClip = { blob: res.blob, name: job.name, channel: channelKey() };
    if (editor && res?.blob) {
      editor.send({ __scEd: 'clip', blob: res.blob, name: job.name, channel: channelKey() });
      toast(job.warning || (job.recovered ? `Abriu um trecho recuperado (${Math.round(job.got)}s) · deixa a live a tocar para ter mais buffer` : 'Clip aberto no editor · guarda a partir de lá'));
    } else {
      toast(job.warning || (`Clip guardado: ${job.name}` + (state.lastClip ? ' · ✎ para editar' : '')));
    }
  }

  // ---------- gravação manual (● REC): começa, pausa e pára quando o utilizador quiser ----------
  const manual = { rec: null, chunks: [], mime: '', activeMs: 0, since: 0, paused: false, timer: null, preRollSeconds: 0, preRollPromise: null };
  const manualSecs = () => (manual.activeMs + (manual.rec && !manual.paused ? now() - manual.since : 0)) / 1000;
  const fmtSecs = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

  function startManual(preRollSeconds = 0) {
    if (manual.rec || state.busy) return;
    if (!state.stream) return toast('Para gravar, o buffer tem de estar ON e o vídeo a tocar.');
    const clickTime = now();
    const preSegments = preRollSeconds ? state.segments
      .filter((s) => s.start != null && s.start < clickTime && (s.end ?? clickTime) > clickTime - preRollSeconds * 1000)
      .sort((a, b) => a.start - b.start) : [];
    if (preRollSeconds && !preSegments.length) return toast('Ainda não há vídeo no buffer.');
    let rec;
    try {
      rec = new MediaRecorder(state.stream, recorderOptions(state.stream, state.mime));
      rec.ondataavailable = (e) => { if (e.data?.size) manual.chunks.push(e.data); };
      rec.onerror = () => stopManual(false);
      rec.start(1000);
    } catch (e) {
      return toast('Não deu para gravar: ' + e.message);
    }
    Object.assign(manual, {
      rec, chunks: [], mime: state.mime, activeMs: 0, since: clickTime, paused: false,
      preRollSeconds, preRollPromise: null,
    });
    if (preRollSeconds) {
      const rotated = rotate().then(scheduleRotation);
      manual.preRollPromise = rotated.then(() => partsFromSegments(preSegments, clickTime));
    }
    clearInterval(manual.timer);
    manual.timer = setInterval(() => render(), 250);
    render();
  }

  function togglePauseManual() {
    const m = manual;
    if (!m.rec) return;
    try {
      if (m.paused) { m.rec.resume(); m.since = now(); m.paused = false; }
      else { m.rec.pause(); m.activeMs += now() - m.since; m.paused = true; }
    } catch {}
    render();
  }

  // openEd: abrir o editor (só dá dentro de um clique/tecla); sem isso o clip é guardado.
  async function stopManual(openEd = true) {
    const m = manual, rec = m.rec;
    if (!rec) return;
    const secs = manualSecs();
    const editor = openEd && !state.busy ? openEditorTab('#pending') : null;
    clearInterval(m.timer);
    m.rec = null;
    m.paused = false;
    const stopped = new Promise((r) => { rec.onstop = r; setTimeout(r, 3000); });
    try { rec.stop(); } catch {}
    state.busy = true;
    render('A fechar a gravação…');
    try {
      await stopped;
      const blob = new Blob(m.chunks, { type: m.mime.split(';')[0] });
      m.chunks = [];
      if (!blob.size || secs < 0.5) throw new Error('A gravação ficou vazia.');
      const preParts = m.preRollPromise ? await m.preRollPromise : [];
      const parts = [...preParts, { blob, outpoint: secs + 5 }];
      const got = secs + preParts.reduce((sum, part) => sum + part.outpoint, 0);
      const h264 = /h264|avc1/.test(m.mime) && preParts.every((p) => p.h264), out = 'mp4';
      await deliver({
        kind: 'clip', parts, got, h264, out,
        name: makeFilename(m.preRollSeconds ? Math.round(got) + 's' : 'rec' + Math.round(secs), out),
      }, editor);
    } catch (e) {
      console.error('[StreamClipper]', e);
      editor?.send({ __scEd: 'error', message: e.message });
      toast('Falhou: ' + e.message);
    } finally {
      state.busy = false;
      render();
    }
  }

  // Clip a partir do buffer gravado do ecrã.
  async function recordedJob(seconds, clickTime, snapshot = state.segments) {
    const from = clickTime - seconds * 1000;
    const segs = snapshot
      .filter((s) => s.start != null && (s.end ?? clickTime) > from && s.start < clickTime)
      .sort((a, b) => a.start - b.start);
    render('A fechar segmentos…');
    let parts = await partsFromSegments(segs, clickTime), recovered = false;
    if (!parts.length) {
      if (!state.stream || !state.video || state.video.paused || state.video.readyState < 2) {
        throw new Error('O buffer não tem vídeo gravado. Reproduz o vídeo até o painel mostrar segundos em reserva e tenta novamente.');
      }
      render('Buffer vazio · a tentar recuperar a captura…');
      // Uma faixa terminada ou um codificador sem saída não recuperam só com uma espera.
      const recoveryStart = now();
      if (now() - state.lastDataAt > 5000) state.triedCodecs.add(state.mime);
      await startBuffer(state.video, true);
      await sleep(1100);
      if (!state.enabled || !state.stream) throw new Error('A gravação foi desligada.');
      await rotate();
      const recoverySegs = state.segments
        .filter((s) => s.start != null && s.start >= recoveryStart && s.end != null)
        .sort((a, b) => a.start - b.start);
      parts = await partsFromSegments(recoverySegs, now());
      if (!parts.length) throw new Error('A captura não recebeu frames. Confirma que o vídeo está a tocar e tenta novamente.');
      recovered = true;
    }
    const got = parts.reduce((a, p) => a + p.outpoint, 0);

    const h264 = parts.every((p) => /h264|avc1/.test(p.blob.type) || p.h264);
    const out = 'mp4';
    return { kind: 'clip', parts, got, h264, out, recovered, name: makeFilename(recovered ? Math.max(1, Math.round(got)) : seconds, out) };
  }

  async function partsFromSegments(segs, endTime) {
    await Promise.all(segs.map((s) => waitDone(s)));
    return segs.map((s, i) => {
      const endAt = Math.min(s.end ?? endTime, endTime, segs[i + 1]?.start ?? Infinity);
      return { blob: s.blob, outpoint: Math.max(0, (endAt - s.start) / 1000), h264: /h264|avc1/.test(s.mime || state.mime || '') };
    }).filter((p) => p.blob?.size > 0 && p.outpoint > 0);
  }

  // Canal da live (ex.: "twitch:nome"): o editor lembra-se de onde está a câmara de cada streamer.
  function channelKey() {
    const site = location.hostname.replace(/^www\./, '').split('.')[0];
    if (site !== 'youtube') return site + ':' + (location.pathname.split('/')[1] || '').toLowerCase();
    const a = document.querySelector('ytd-watch-metadata #owner a[href^="/@"], #owner a[href^="/@"], ytd-video-owner-renderer a[href]');
    const who = a?.getAttribute('href') || document.querySelector('span[itemprop="author"] link[itemprop="name"]')?.getAttribute('content') || '';
    return 'youtube:' + who.replace(/^\//, '').toLowerCase();
  }

  function makeFilename(seconds, ext) {
    const site = location.hostname.replace(/^www\./, '').split('.')[0];
    const title = (document.title || 'stream')
      .replace(/ - (YouTube|Twitch)$/i, '')
      .replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'stream';
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
    return `${site}_${title}_${ts}_${seconds}s.${ext}`;
  }

  // ---------- iframe processador (ffmpeg.wasm) ----------
  let frame = null, frameReady = null, reqId = 0;
  const pending = new Map();
  const EXT_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;

  const JOB_TIMEOUT_MS = 180000;  // inclui o 1º carregamento do ffmpeg.wasm (~32 MB)
  let frameReadyResolve = null;

  window.addEventListener('message', (ev) => {
    if (ev.origin !== EXT_ORIGIN || !ev.data || ev.data.__sc !== true) return;
    if (!frame || ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (m.type === 'ready') { frameReadyResolve?.(); return; }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') render(m.text);
    if (m.type === 'done') { pending.delete(m.id); p.resolve(m); }
    if (m.type === 'error') { pending.delete(m.id); p.reject(new Error(m.message)); }
    if (m.type === 'download-here') {           // fallback: descarregar a partir da página
      pending.delete(m.id);
      const url = URL.createObjectURL(m.blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: m.name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      p.resolve(m);
    }
  });

  // Deita fora o iframe (e o ffmpeg dentro dele); o próximo clip cria um novo.
  function resetFrame() {
    frame?.remove();
    frame = null;
    frameReady = null;
    frameReadyResolve = null;
  }

  function ensureFrame() {
    if (frameReady) return frameReady;
    frameReady = new Promise((resolve, reject) => {
      frame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL('processor.html');
      frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none;';
      frame.setAttribute('aria-hidden', 'true');
      const t = setTimeout(() => { resetFrame(); reject(new Error('O processador não carregou.')); }, 20000);
      frameReadyResolve = () => { clearTimeout(t); resolve(); };
      document.documentElement.appendChild(frame);
    });
    return frameReady;
  }

  async function processInFrame(job) {
    render('A abrir o processador…');
    await ensureFrame();
    const id = ++reqId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        resetFrame();
        reject(new Error('O processamento demorou demasiado. Tenta outra vez.'));
      }, JOB_TIMEOUT_MS);
      pending.set(id, {
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      frame.contentWindow.postMessage({ ...job, __sc: true, type: 'job', id }, EXT_ORIGIN);
    });
  }

  // ---------- UI ----------
  let panel, statusEl, toggleBtn, toastUntil = 0, lastToast = '';

  function buildUI() {
    panel = document.createElement('div');
    panel.id = 'sc-panel';
    panel.innerHTML = `
      <div class="sc-head">
        <span class="sc-dot"></span>
        <span class="sc-title">Clipper</span>
        <button class="sc-edit" title="Editar o último clip (cortar, 9:16 para TikTok)" hidden>✎</button>
        <button class="sc-toggle" title="Ligar/desligar Stream Clipper"></button>
        <button class="sc-min" title="Minimizar">–</button>
      </div>
      <div class="sc-body">
        <div class="sc-row">
          <div class="sc-recs">
            <button class="sc-rec-btn" title="Gravar a partir de agora (Alt+R)"><span class="sc-rdot"></span>REC</button>
            <button class="sc-pause" title="Pausa / continuar (Alt+P)" hidden>❚❚</button>
          </div>
          <div class="sc-btns">${DURATIONS.map((d, i) =>
            `<span class="sc-duration"><button class="sc-clip" data-s="${d}" title="Clip dos últimos ${d}s (Alt+${i + 1})">${d}s</button><button class="sc-continue" data-s="${d}" title="Começar com até ${d}s anteriores e continuar a gravar" aria-label="Clip com até ${d} segundos anteriores e continuar a gravar">+</button></span>`).join('')}</div>
        </div>
        <div class="sc-status"></div>
      </div>`;
    document.documentElement.appendChild(panel);
    statusEl = panel.querySelector('.sc-status');
    toggleBtn = panel.querySelector('.sc-toggle');
    panel.querySelectorAll('.sc-clip').forEach((b) =>
      b.addEventListener('click', () => clip(+b.dataset.s)));
    panel.querySelectorAll('.sc-continue').forEach((b) =>
      b.addEventListener('click', () => startManual(+b.dataset.s)));
    toggleBtn.addEventListener('click', () => setEnabled(!state.enabled));
    panel.querySelector('.sc-rec-btn').addEventListener('click', () => (manual.rec ? stopManual() : startManual()));
    panel.querySelector('.sc-pause').addEventListener('click', togglePauseManual);
    panel.querySelector('.sc-edit').addEventListener('click', openEditor);
    panel.querySelector('.sc-min').addEventListener('click', () => {
      panel.classList.toggle('sc-collapsed');
      save({ collapsed: panel.classList.contains('sc-collapsed') });
    });
    makeDraggable(panel, panel.querySelector('.sc-head'));
  }

  // Abre o editor numa aba nova e entrega-lhe o último clip quando ele disser que está pronto.
  function openEditor() {
    const c = state.lastClip;
    if (!c) return;
    const ed = openEditorTab('');
    if (!ed) return toast('O browser bloqueou a aba do editor.');
    ed.send({ __scEd: 'clip', blob: c.blob, name: c.name, channel: c.channel });
  }

  // Abre o editor numa aba nova. send(msg) entrega a mensagem assim que o editor disser que está
  // pronto (pode ser antes ou depois). Devolve null se o browser bloquear a aba.
  function openEditorTab(hash) {
    const w = window.open(chrome.runtime.getURL('editor.html') + hash, '_blank');
    if (!w) return null;
    let ready = false;
    const queue = [];
    const flush = () => { while (queue.length) w.postMessage(queue.shift(), EXT_ORIGIN); };
    const onMsg = (ev) => {
      if (ev.source !== w || ev.origin !== EXT_ORIGIN || ev.data?.__scEd !== 'ready') return;
      removeEventListener('message', onMsg);
      ready = true;
      flush();
    };
    addEventListener('message', onMsg);
    setTimeout(() => removeEventListener('message', onMsg), 120000);
    return { send: (msg) => { queue.push(msg); if (ready) flush(); } };
  }

  function makeDraggable(el, handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); ox = r.left; oy = r.top;
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(innerWidth - 60, ox + e.clientX - sx));
      const y = Math.max(0, Math.min(innerHeight - 30, oy + e.clientY - sy));
      Object.assign(el.style, { left: x + 'px', top: y + 'px', right: 'auto', bottom: 'auto' });
    });
    handle.addEventListener('pointerup', () => {
      if (!dragging) return; dragging = false;
      save({ pos: { left: el.style.left, top: el.style.top } });
    });
  }

  function render(msg) {
    if (!panel) return;
    panel.hidden = !state.enabled;
    if (!msg && now() < toastUntil) msg = lastToast;
    const rec = !!state.stream && state.enabled;
    const manualOn = !!manual.rec;
    panel.classList.toggle('sc-rec', rec);
    panel.classList.toggle('sc-busy', state.busy);
    toggleBtn.textContent = state.enabled ? 'ON' : 'OFF';
    panel.querySelector('.sc-edit').hidden = !state.lastClip || state.busy;
    const buf = bufferedSeconds();
    const live = serverAvailable();   // modo live: não depende do buffer
    panel.classList.toggle('sc-live', live);
    panel.querySelectorAll('.sc-clip, .sc-continue').forEach((b) => {
      const isContinue = b.classList.contains('sc-continue');
      b.disabled = (isContinue ? !rec : !(rec || live)) || state.busy || manualOn;
      b.classList.toggle('sc-partial', rec && buf < +b.dataset.s);
    });
    const recBtn = panel.querySelector('.sc-rec-btn'), pauseBtn = panel.querySelector('.sc-pause');
    panel.classList.toggle('sc-manual', manualOn);
    panel.classList.toggle('sc-manual-paused', manualOn && manual.paused);
    recBtn.disabled = !manualOn && (!rec || state.busy);
    const recHtml = manualOn ? `<span class="sc-rsq"></span>${fmtSecs(manualSecs())}` : '<span class="sc-rdot"></span>REC';
    if (recBtn.innerHTML !== recHtml) recBtn.innerHTML = recHtml;   // só quando muda (não estraga cliques)
    recBtn.title = manualOn ? (manual.preRollSeconds ? 'Terminar o clip e abrir no editor (Alt+R)' : 'Parar e abrir no editor (Alt+R)') : rec ? 'Gravar a partir de agora (Alt+R)' : 'Liga o buffer (ON) para gravar';
    pauseBtn.hidden = !manualOn;
    pauseBtn.textContent = manual.paused ? '▶' : '❚❚';
    if (manualOn && !msg) msg = manual.paused
      ? `❚❚ Pausado · ${fmtSecs(manualSecs())} gravados`
      : manual.preRollSeconds ? `● Clip: até ${manual.preRollSeconds}s antes + ${fmtSecs(manualSecs())}` : `● A gravar · ${fmtSecs(manualSecs())}`;
    const backup = rec ? ` · reserva ${Math.floor(buf)}s` : '';
    statusEl.textContent = msg
      || (state.error ? state.error + (live ? ' · ' + server.label() : '')
      : live ? server.label() + backup
      : !state.enabled ? 'Buffer desligado'
      : rec ? `A gravar · ${Math.floor(buf)}s em buffer`
      : 'À espera de um vídeo…');
  }

  function toast(text) {
    toastUntil = now() + 5000;
    lastToast = text;
    render(text);
  }

  function fail(msg) { state.error = msg; console.warn('[StreamClipper]', msg); render(); }

  // ---------- definições ----------
  function save(obj) { try { chrome.storage.local.set(obj); } catch {} }

  function setEnabled(on) {
    state.enabled = on;
    save({ enabled: on });
    if (!on) stopBuffer();
    tick();
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.enabled) return;
    state.enabled = changes.enabled.newValue === true;
    if (!state.enabled) stopBuffer();
    tick();
    render();
  });

  // ---------- loop principal ----------
  function tick() {
    if (!state.enabled) { if (!state.busy) render(); return; }
    server?.refresh();
    const v = findMainVideo();
    if (v && v !== state.video && now() >= state.retryAt) startBuffer(v);
    else if (!v && state.video && !state.video.isConnected) stopBuffer();
    else if (v && state.stream && !state.busy && !manual.rec && !v.paused && !v.seeking && now() >= state.retryAt) {
      const ended = !state.stream.getVideoTracks().some((t) => t.readyState === 'live');
      if (ended || now() - state.lastDataAt > 10000 || state.triedCodecs.has(state.mime)) {
        if (!ended) state.triedCodecs.add(state.mime);
        startBuffer(v, true);
      }
    }
    if (!state.busy) render();
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    if (!state.enabled) return;
    const k = e.key.toLowerCase();
    if (k === 'r' || k === 'p') {
      e.preventDefault(); e.stopPropagation();
      if (k === 'p') togglePauseManual(); else if (manual.rec) stopManual(); else startManual();
      return;
    }
    const i = ['1', '2', '3', '4', '5'].indexOf(e.key);
    if (i < 0) return;
    e.preventDefault(); e.stopPropagation();
    clip(DURATIONS[i]);
  }, true);

  chrome.storage.local.get(['enabled', 'collapsed', 'pos'], (s) => {
    buildUI();
    state.enabled = s.enabled === true;
    if (s.collapsed) panel.classList.add('sc-collapsed');
    if (s.pos?.left) Object.assign(panel.style, { left: s.pos.left, top: s.pos.top, right: 'auto', bottom: 'auto' });
    render();
    tick();
    setInterval(tick, 1000);
  });
})();
