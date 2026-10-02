// Stream Clipper — content script
// Mantém um buffer dos últimos ~140s do <video> principal da página com UM MediaRecorder contínuo
// (keyframe de 1 em 1 s). Os bocados são lidos em streaming (webmbuf.js) e guardados bloco a bloco;
// um clip é reconstruído a partir do keyframe certo, sem juntas entre gravadores diferentes.
// Ao clicar, o processador (ffmpeg.wasm num iframe da extensão) converte-o para MP4.
(() => {
  if (window.__streamClipper) return;
  window.__streamClipper = true;

  const KEEP_MS = 140000;        // histórico para clips de 120s e fallback do modo live
  const KEY_MS = 1000;           // intervalo pedido entre keyframes (define onde um clip pode começar)
  const SLICE_MS = 250;          // o MediaRecorder entrega dados a este ritmo (o fim do clip fica preciso)
  const FORCE_ROTATE_MS = 12000; // se o browser ignorar o KEY_MS e não houver keyframes, recomeça
  const DURATIONS = [15, 30, 45, 60, 120];
  const MIME_CANDIDATES = [
    'video/webm;codecs=h264,opus',   // Chrome: H.264 -> dá MP4 sem re-encode
    'video/webm;codecs=avc1,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=vp9,opus',
    'video/webm',
  ];
  const Webm = self.StreamClipperWebm;

  const state = {
    enabled: false,
    video: null,
    stream: null,
    mime: null,
    runs: [],           // gravações contínuas (normalmente 1; mais só depois de uma troca de resolução)
    current: null,      // a run a gravar agora
    holds: 0,           // clips à espera de ler o buffer: enquanto > 0 não se apaga nada
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

  // Bitrate generoso: o clip ainda vai ser recodificado no editor, por isso convém partir de boa
  // qualidade (≈0,15 bit/píxel; 1080p60 ≈ 19 Mbps, 1080p30 ≈ 9 Mbps, 720p30 ≈ 6 Mbps).
  function recorderOptions(stream, mime) {
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings?.() || {};
    const width = settings.width || state.video?.videoWidth || 1280;
    const height = settings.height || state.video?.videoHeight || 720;
    const fps = settings.frameRate || 30;
    const videoBitsPerSecond = Math.min(22_000_000, Math.max(6_000_000, Math.round(width * height * fps * 0.15)));
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

  // ---------- gravação contínua ----------
  // Uma run = um MediaRecorder do princípio ao fim. Os tempos dos blocos (t, ms) são do próprio
  // WebM; offset converte para o relógio da página (wall = t + offset), medido pelo menor atraso
  // entre um bloco ser gravado e chegar cá (latência do codificador + timeslice).
  let bufferGen = 0;
  function startRun() {
    const run = {
      rec: null, mime: state.mime, gen: bufferGen, header: null, blocks: [], parser: null,
      offset: Infinity, firstKeyT: null, lastT: null, lastKeyT: null, startedAt: now(), endWall: null,
      width: state.video?.videoWidth || 0, height: state.video?.videoHeight || 0,
      queue: Promise.resolve(), waiters: [], stopped: null,
    };
    run.firstKey = new Promise((res) => { run.firstKeyWaiter = res; });
    run.parser = Webm.createParser((b) => {
      if (b.video && b.key) {
        if (run.firstKeyT == null) { run.firstKeyT = b.t; run.firstKeyWaiter(); }
        run.lastKeyT = b.t;
      }
      // Antes do 1º keyframe de vídeo nada é utilizável (o clip tem de começar num keyframe).
      if (run.firstKeyT == null) return;
      run.blocks.push(b);
      if (b.video && (run.lastT == null || b.t > run.lastT)) run.lastT = b.t;
    });
    run.header = run.parser.header;
    let rec;
    const options = { ...recorderOptions(state.stream, state.mime), videoKeyFrameIntervalDuration: KEY_MS };
    try {
      rec = new MediaRecorder(state.stream, options);
    } catch (e) {
      state.triedCodecs.add(run.mime);
      fail('Não foi possível iniciar a gravação: ' + e.message);
      return null;
    }
    run.rec = rec;
    run.stopped = new Promise((res) => { rec.onstop = () => res(); });
    rec.ondataavailable = (e) => {
      if (!e.data?.size) return;
      const arrived = now();
      run.queue = run.queue.then(async () => {
        const bytes = new Uint8Array(await e.data.arrayBuffer());
        try { run.parser.push(bytes); } catch (err) {
          if (run.gen === bufferGen && run === state.current) fail('Gravação ilegível: ' + err.message);
          return;
        }
        if (run.lastT != null) run.offset = Math.min(run.offset, arrived - run.lastT);
        if (run.blocks.length && run.gen === bufferGen) { state.lastDataAt = arrived; state.error = null; }
      }).catch(() => {}).then(() => {
        for (const f of run.waiters.splice(0)) f();
      });
    };
    rec.onerror = (e) => {
      if (run.gen !== bufferGen) return;
      state.triedCodecs.add(run.mime);
      fail('Erro na gravação: ' + (e.error?.message || e));
    };
    try {
      rec.start(SLICE_MS);
    } catch (e) {
      state.triedCodecs.add(run.mime);
      fail('Não foi possível iniciar a gravação: ' + e.message);
      return null;
    }
    state.runs.push(run);
    return run;
  }

  // Relógio da página <-> tempo do WebM de uma run. Antes de haver medida, estima pelo arranque.
  const runOffset = (run) => (Number.isFinite(run.offset) ? run.offset : run.startedAt - (run.firstKeyT ?? 0));
  const wallOf = (run, t) => t + runOffset(run);
  const tOf = (run, wall) => wall - runOffset(run);

  // Pede ao MediaRecorder o que tiver pendente e espera que isso seja lido (o fim do clip fica
  // exatamente no clique). Numa run parada, espera só pelo fim da leitura.
  function flushRun(run, ms = 1500) {
    if (run.rec?.state !== 'recording') return Promise.race([run.queue, sleep(ms)]);
    const done = new Promise((res) => run.waiters.push(res));
    try { run.rec.requestData(); } catch {}
    return Promise.race([done, sleep(ms)]).then(() => Promise.race([run.queue, sleep(ms)]));
  }

  function stopRun(run) {
    if (!run?.rec) return Promise.resolve();
    run.endWall ??= now();
    if (run.rec.state !== 'inactive') { try { run.rec.stop(); } catch {} }
    return Promise.race([run.stopped, sleep(3000)]).then(() => Promise.race([run.queue, sleep(3000)]));
  }

  // Troca de run (mudou a resolução, ou o browser não está a dar keyframes): a nova começa antes
  // de a antiga parar, e a antiga fica guardada para clips que a atravessem.
  let rotating = Promise.resolve();
  function rotate() {
    const gen = bufferGen;
    const p = rotating.then(async () => {
      if (gen !== bufferGen || !state.stream) return;
      const old = state.current;
      const next = startRun();
      if (!next) return;
      state.current = next;
      await Promise.race([next.firstKey, sleep(3000)]);
      if (gen !== bufferGen) return;
      if (old) {
        old.endWall = next.firstKeyT != null ? wallOf(next, next.firstKeyT) : now();
        stopRun(old);
      }
      prune();
    });
    rotating = p.catch(() => {});
    return p;
  }

  // Apaga o que já não cabe no histórico. Dentro da run, só se corta num keyframe de vídeo (o clip
  // mais antigo possível tem de começar num). Nunca com clips à espera de ler o buffer.
  function prune() {
    if (state.holds > 0) return;
    const limit = now() - KEEP_MS;
    state.runs = state.runs.filter((r) => r === state.current || (r.endWall ?? now()) > limit);
    for (const run of state.runs) {
      if (!run.blocks.length) continue;
      const tLimit = tOf(run, limit);
      let cut = 0;
      for (let i = 0; i < run.blocks.length; i++) {
        const b = run.blocks[i];
        if (b.t > tLimit) break;
        if (b.video && b.key) cut = i;
      }
      if (cut > 0) run.blocks.splice(0, cut);
    }
  }

  // Manutenção periódica (no tick): apaga o que é velho e, se o browser não estiver a dar
  // keyframes (ignora videoKeyFrameIntervalDuration), recomeça a run para haver pontos de corte.
  function maintainBuffer() {
    prune();
    const run = state.current;
    if (!run || run.lastT == null || run.lastKeyT == null || state.holds > 0) return;
    if (run.lastT - run.lastKeyT > FORCE_ROTATE_MS) rotate().catch((e) => fail(e.message));
  }

  function stopBuffer() {
    if (manual.rec) stopManual(false);
    bufferGen++;
    for (const [target, type, listener] of state.seekListeners) target.removeEventListener(type, listener);
    state.seekListeners = [];
    for (const r of state.runs) stopRun(r);
    for (const track of state.stream?.getTracks() || []) track.stop();
    state.runs = [];
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
    if (!Webm) return fail('Falta o leitor de WebM (recarrega a extensão).');
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
    // Só reinicia com saltos a sério (o utilizador procurou outra posição); os players fazem
    // pequenos reajustes sozinhos (ex.: voltar ao direto depois de um stall) que não devem
    // deitar fora minutos de buffer bom. A referência só avança fora de um seek, por isso o
    // salto é sempre medido a partir da última posição estável.
    let seekRef = video.currentTime;
    const trackTime = () => { if (!video.seeking) seekRef = video.currentTime; };
    const videoSeeking = () => {
      if (state.stream !== stream || !state.enabled) return;
      if (Math.abs(video.currentTime - seekRef) < 2) return;
      seekRef = video.currentTime;
      resetRuns();   // instantâneo: recomeça já, não espera pelo 'seeked'
    };
    // Mudou a resolução (qualidade automática do player): run nova, a antiga fica para clips.
    const resized = () => {
      if (state.stream !== stream || !state.enabled || !state.current) return;
      if (video.videoWidth === state.current.width && video.videoHeight === state.current.height) return;
      rotate().catch((e) => fail(e.message));
    };
    // Se as faixas mudarem depois (troca de fonte), recomeça o buffer.
    let t;
    const restart = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (state.stream !== stream || !state.enabled || manual.rec) return;
        resetRuns();
      }, 1500);
    };
    video.addEventListener('timeupdate', trackTime);
    video.addEventListener('seeking', videoSeeking);
    video.addEventListener('resize', resized);
    stream.addEventListener('addtrack', restart);
    stream.addEventListener('removetrack', restart);
    state.seekListeners = [[video, 'timeupdate', trackTime], [video, 'seeking', videoSeeking], [video, 'resize', resized],
      [stream, 'addtrack', restart], [stream, 'removetrack', restart]];
    state.current = startRun();
    render();
  }

  // Descarta o buffer e recomeça já a gravar no mesmo stream.
  function resetRuns() {
    if (!state.stream) return;
    bufferGen++;
    for (const r of state.runs) stopRun(r);
    state.runs = [];
    state.current = state.stream.getVideoTracks().some((t) => t.readyState === 'live') ? startRun() : null;
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

  // Intervalo [início, fim] de cada run no relógio da página (uma run acaba onde a seguinte começa).
  function runSpan(run, i, runs) {
    if (run.lastT == null || !run.blocks.length) return null;
    const next = runs[i + 1];
    const start = wallOf(run, run.blocks[0].t);
    let end = wallOf(run, run.lastT);
    if (run.endWall != null) end = Math.min(end, run.endWall);
    if (next?.firstKeyT != null) end = Math.min(end, wallOf(next, next.firstKeyT));
    return end > start ? { start, end } : null;
  }

  function bufferedSeconds() {
    const limit = now() - KEEP_MS;
    let total = 0;
    state.runs.forEach((run, i, all) => {
      const s = runSpan(run, i, all);
      if (s) total += Math.max(0, s.end - Math.max(s.start, limit));
    });
    return Math.min(KEEP_MS, total) / 1000;
  }

  // Constrói as partes (WebM contínuos, cada um a começar num keyframe) que cobrem
  // [endWall − seconds, endWall]. Normalmente é uma só; mais só se o clip atravessar uma troca de run.
  async function buildParts(runs, seconds, endWall) {
    await Promise.all(runs.map((r) => flushRun(r)));
    const fromWall = endWall - seconds * 1000;
    const parts = [];
    runs.forEach((run, i) => {
      const span = runSpan(run, i, runs);
      if (!span) return;
      const a = Math.max(fromWall, span.start), z = Math.min(endWall, span.end);
      if (z - a < 50) return;
      const tFrom = tOf(run, a), tTo = Math.min(tOf(run, z), run.lastT);
      const blocks = run.blocks;
      // Último keyframe de vídeo até ao início pedido (o clip fica no máximo ~1 s mais longo).
      let k = -1;
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j];
        if (b.t > tFrom + 20 && k >= 0) break;
        if (b.video && b.key) k = j;
      }
      if (k < 0) return;
      const keyT = blocks[k].t;
      if (tTo - keyT < 50) return;
      const picked = [];
      for (let j = k; j < blocks.length; j++) {
        const b = blocks[j];
        if (b.t < keyT) continue;          // áudio de antes do keyframe
        if (b.t > tTo + 1) { if (b.video) break; continue; }
        picked.push(b);
      }
      const blob = new Blob(Webm.buildWebm(run.header, picked, keyT), { type: 'video/webm' });
      parts.push({ blob, outpoint: (tTo - keyT) / 1000, h264: /h264|avc1/.test(run.mime || ''), width: run.width, height: run.height });
    });
    return parts;
  }

  // ---------- criar o clip ----------
  const server = self.StreamClipperServer;
  const serverAvailable = () => !!server?.available();

  // Um clip a processar não impede o clique seguinte: cada clique agarra já a sua fatia do
  // buffer (e abre já o editor, tem de ser no gesto) e fica em fila se outro ainda estiver a
  // ser preparado. Só a gravação manual (● REC) continua a bloquear enquanto isso.
  const clipQueue = [];

  function clip(seconds) {
    const useServer = serverAvailable();
    if (!useServer && !state.stream) return toast('Nenhum vídeo a gravar ainda.');
    // O editor abre já (o browser só deixa abrir abas no instante do clique/tecla) e recebe o clip
    // quando estiver pronto. Se a aba for bloqueada, o clip é guardado diretamente.
    // O id liga esta aba a este clip: se a mensagem não chegar, o editor procura-o no IndexedDB
    // pelo id (e não abre por engano o clip de outro clique que ainda estava na fila).
    const clipId = crypto.randomUUID();
    const editor = openEditorTab('#pending=' + clipId);
    const clickTime = now();
    // Guarda as runs do instante do clique e impede que o buffer apague o que este clip vai usar
    // enquanto espera (modo live, fila de clips…). As runs continuam a crescer; o corte é pelo tempo.
    const snapshot = state.runs.slice();
    state.holds++;
    const task = { seconds, useServer, editor, clickTime, snapshot, clipId };
    if (state.busy) {
      clipQueue.push(task);
      editor?.send({ __scEd: 'progress', text: 'Na fila: à espera que o clip anterior termine…', clipId });
      // O "· N em fila" no render() já mostra a posição; o toast só confirma o clique.
      toast(`Clip de ${seconds}s registado`);
      return;
    }
    runClip(task);
  }

  async function runClip({ seconds, useServer, editor, clickTime, snapshot, clipId }) {
    let held = true;
    const release = () => { if (held) { held = false; state.holds = Math.max(0, state.holds - 1); } };
    state.busy = true;
    activeEditor = editor ? { editor, clipId, last: '' } : null;
    render('A preparar clip de ' + seconds + 's…');
    try {
      let job = null, serverError = null;
      if (useServer) {
        try {
          const r = await server.clip(seconds, { onProgress: (t) => render(t), video: state.video || findMainVideo() });
          job = { kind: 'server', ...r, name: makeFilename(seconds, 'mp4') };
          release();
        } catch (e) {
          serverError = e;
          console.warn('[StreamClipper] modo live falhou, a usar a gravação:', e);
          render(server.label() + ' falhou (' + e.message + ') · a usar a gravação…');
        }
      }
      if (!job) {
        // Num clique imediato, captureStream pode ainda estar a criar as faixas.
        // Dá tempo à inicialização já em curso antes de declarar o buffer vazio.
        for (let i = 0; i < 20 && !state.stream && state.video && state.enabled; i++) await sleep(100);
        if (!state.stream && !snapshot.length) throw serverError || new Error('Nenhum vídeo a gravar ainda.');
        try {
          job = await recordedJob(seconds, clickTime, snapshot);
        } catch (error) {
          throw serverError ? new Error(serverError.message + ' ' + error.message) : error;
        } finally {
          release();
        }
        if (job.got + 0.5 < seconds) {
          job.warning = `Clip parcial: ${job.got.toFixed(1)}s dos ${seconds}s pedidos · ${job.recovered ? 'capturado após o clique, porque o buffer estava vazio' : 'só havia este trecho no buffer'}`;
          job.name = makeFilename(Math.max(1, Math.round(job.got)) + 's_parcial', job.out);
        }
      }
      job.clipId = clipId;
      job.channel = channelKey();
      await deliver(job, editor);
    } catch (e) {
      console.error('[StreamClipper]', e);
      editor?.send({ __scEd: 'error', message: e.message, clipId });
      toast('Falhou: ' + e.message);
    } finally {
      release();
      activeEditor = null;
      state.busy = false;
      const next = clipQueue.shift();
      if (next) runClip(next); else render();
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
      editor?.send({ __scEd: 'error', message: 'Não consegui preparar o clip, mas gravei-o tal como estava — vê as transferências.', clipId: job.clipId });
      toast('A conversão falhou — guardei o clip em bruto nas transferências (não editável, mas não se perdeu).');
      return;
    }
    if (res?.blob) state.lastClip = { blob: res.blob, name: job.name, channel: channelKey() };
    if (editor && res?.blob) {
      editor.send({ __scEd: 'clip', blob: res.blob, name: job.name, channel: channelKey(), clipId: job.clipId });
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
    if (preRollSeconds && bufferedSeconds() < 0.5) return toast('Ainda não há vídeo no buffer.');
    const preRuns = preRollSeconds ? state.runs.slice() : [];
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
      preRollSeconds, preRollPromise: null, width: state.video?.videoWidth || 0, height: state.video?.videoHeight || 0,
    });
    if (preRollSeconds) {
      state.holds++;
      manual.preRollPromise = buildParts(preRuns, preRollSeconds, clickTime)
        .finally(() => { state.holds = Math.max(0, state.holds - 1); });
      manual.preRollPromise.catch(() => {});
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
    const clipId = crypto.randomUUID();
    const editor = openEd && !state.busy ? openEditorTab('#pending=' + clipId) : null;
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
      const parts = [...preParts, { blob, outpoint: secs + 5, width: m.width, height: m.height }];
      const got = secs + preParts.reduce((sum, part) => sum + part.outpoint, 0);
      const h264 = /h264|avc1/.test(m.mime) && preParts.every((p) => p.h264), out = 'mp4';
      await deliver({
        kind: 'clip', parts, got, h264, out, clipId, channel: channelKey(),
        name: makeFilename(m.preRollSeconds ? Math.round(got) + 's' : 'rec' + Math.round(secs), out),
      }, editor);
    } catch (e) {
      console.error('[StreamClipper]', e);
      editor?.send({ __scEd: 'error', message: e.message, clipId });
      toast('Falhou: ' + e.message);
    } finally {
      state.busy = false;
      render();
    }
  }

  // Clip a partir do buffer gravado do ecrã.
  async function recordedJob(seconds, clickTime, runs) {
    render('A preparar o vídeo gravado…');
    let parts = await buildParts(runs, seconds, clickTime), recovered = false;
    if (!parts.length) {
      if (!state.stream || !state.video || state.video.paused || state.video.readyState < 2) {
        throw new Error('O buffer não tem vídeo gravado. Reproduz o vídeo até o painel mostrar segundos em reserva e tenta novamente.');
      }
      render('Buffer vazio · a tentar recuperar a captura…');
      // Uma faixa terminada ou um codificador sem saída não recuperam só com uma espera.
      const recoveryStart = now();
      if (now() - state.lastDataAt > 5000) {
        state.triedCodecs.add(state.mime);
        await startBuffer(state.video, true);
      }
      await sleep(2500);
      if (!state.enabled || !state.stream) throw new Error('A gravação foi desligada.');
      parts = await buildParts(state.runs.slice(), (now() - recoveryStart) / 1000, now());
      if (!parts.length) throw new Error('A captura não recebeu frames. Confirma que o vídeo está a tocar e tenta novamente.');
      recovered = true;
    }
    const got = parts.reduce((a, p) => a + p.outpoint, 0);
    const h264 = parts.every((p) => p.h264);
    const out = 'mp4';
    return { kind: 'clip', parts, got, h264, out, recovered, name: makeFilename(recovered ? Math.max(1, Math.round(got)) : seconds, out) };
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

  // Sem limite fixo para o trabalho todo (recodificar um clip longo pode levar minutos): só falha
  // se o processador ficar este tempo sem dar sinal de vida (progresso do ffmpeg, etapas…).
  const JOB_IDLE_MS = 90000;
  let frameReadyResolve = null;

  window.addEventListener('message', (ev) => {
    if (ev.origin !== EXT_ORIGIN || !ev.data || ev.data.__sc !== true) return;
    if (!frame || ev.source !== frame.contentWindow) return;
    const m = ev.data;
    if (m.type === 'ready') { frameReadyResolve?.(); return; }
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === 'progress') { p.alive?.(); if (m.text) render(m.text); }
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
      let t;
      const arm = () => {
        clearTimeout(t);
        t = setTimeout(() => {
          pending.delete(id);
          resetFrame();
          reject(new Error('O processador deixou de responder. Tenta outra vez.'));
        }, JOB_IDLE_MS);
      };
      arm();
      pending.set(id, {
        alive: arm,
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

  // O editor aberto no clique vê em que passo está o clip (fila, descarga, junção…), em vez de
  // ficar só em «A preparar o clip…» sem saber se está a andar ou encravado.
  let activeEditor = null;
  function render(msg) {
    if (msg && activeEditor && msg !== activeEditor.last) {
      activeEditor.last = msg;
      activeEditor.editor.send({ __scEd: 'progress', text: msg, clipId: activeEditor.clipId });
    }
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
      // Os clips de duração fixa entram em fila enquanto um está a processar (não bloqueiam);
      // só a gravação manual (● REC / +continuar) fica mesmo à espera.
      b.disabled = (isContinue ? !rec : !(rec || live)) || (isContinue && state.busy) || manualOn;
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
    const base = msg
      || (state.error ? state.error + (live ? ' · ' + server.label() : '')
      : live ? server.label() + backup
      : !state.enabled ? 'Buffer desligado'
      : rec ? `A gravar · ${Math.floor(buf)}s em buffer`
      : 'À espera de um vídeo…');
    statusEl.textContent = clipQueue.length ? `${base} · ${clipQueue.length} clip${clipQueue.length > 1 ? 's' : ''} em fila` : base;
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
    if (state.stream) maintainBuffer();
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
