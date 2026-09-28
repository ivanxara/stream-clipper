// Stream Clipper — página do TikTok Studio.
// Quando o editor carrega em «Exportar + TikTok», esta aba abre no upload; aqui pede-se o MP4 ao
// editor (chrome.runtime, aos bocados), mete-se no campo de ficheiro, escreve-se a legenda e
// destaca-se a opção de agendar. Publicar fica sempre para o utilizador.
(() => {
  if (window.__scTikTok) return;
  window.__scTikTok = true;

  const FRESH_MS = 30 * 60 * 1000;         // um pedido com mais de 30 min já não conta
  const CHUNK = 8 * 1024 * 1024;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isUpload = () => /\/(tiktokstudio|creator-center)\/upload|\/upload\b/.test(location.pathname);

  let job = null, running = false, card = null, caption = '', schedule = null, enabled = false;

  // ---------- cartão de ajuda (shadow DOM: o CSS do TikTok não lhe toca) ----------
  function ensureCard() {
    if (card) return card;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      .c { width: 300px; font: 13px/1.4 system-ui, "Segoe UI", sans-serif; color: #f4f4f5; background: rgba(20,20,24,.96);
        border: 1px solid rgba(255,255,255,.14); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.45); padding: 12px; }
      .h { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 8px; }
      .h i { width: 9px; height: 9px; border-radius: 50%; background: linear-gradient(135deg,#25f4ee,#fe2c55); }
      .h span { flex: 1; }
      .x { all: unset; cursor: pointer; color: #a1a1aa; padding: 0 4px; font-size: 16px; }
      ol { margin: 0 0 10px; padding: 0; list-style: none; display: grid; gap: 4px; }
      li { display: flex; gap: 8px; color: #a1a1aa; }
      li b { width: 16px; text-align: center; }
      li.ok { color: #f4f4f5; } li.ok b { color: #22c55e; }
      li.now { color: #f4f4f5; } li.now b { color: #f59e0b; }
      li.bad { color: #fca5a5; } li.bad b { color: #ef4444; }
      .m { font-size: 12px; color: #d4d4d8; margin: 0 0 10px; }
      .r { display: flex; gap: 6px; }
      button.b { all: unset; cursor: pointer; flex: 1; text-align: center; padding: 7px 8px; border-radius: 8px; background: rgba(255,255,255,.1); font-weight: 600; font-size: 12px; }
      button.b:hover { background: rgba(255,255,255,.18); }
      button.p { background: #fe2c55; } button.p:hover { background: #ff4d6d; }
      [hidden] { display: none !important; }
    </style>
    <div class="c">
      <div class="h"><i></i><span>Stream Clipper → TikTok</span><button class="x" title="Fechar">×</button></div>
      <ol>
        <li data-s="video"><b>○</b>Vídeo</li>
        <li data-s="caption"><b>○</b>Legenda</li>
        <li data-s="when" hidden><b>○</b>Data e hora</li>
        <li data-s="post"><b>○</b>Carregar em Publicar/Agendar (tu)</li>
      </ol>
      <p class="m"></p>
      <div class="r"><button class="b dl" hidden>Descarregar vídeo</button><button class="b copy">Copiar legenda</button><button class="b p sched" hidden>Agendar</button></div>
    </div>`;
    root.querySelector('.x').addEventListener('click', () => { host.remove(); card = null; });
    root.querySelector('.copy').addEventListener('click', copyCaption);
    root.querySelector('.sched').addEventListener('click', () => { const el = findSchedule(); if (el) { el.click(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } });
    document.documentElement.appendChild(host);
    card = { host, root };
    return card;
  }

  function step(name, cls) {
    const li = ensureCard().root.querySelector(`[data-s="${name}"]`);
    li.className = cls;
    li.hidden = false;
    li.querySelector('b').textContent = { ok: '✓', now: '…', bad: '✕' }[cls] || '○';
  }
  const say = (t) => { ensureCard().root.querySelector('.m').textContent = t; };

  // Plano B: guardar o vídeo que já veio do editor, para o arrastar à mão.
  function offerDownload(file) {
    const b = ensureCard().root.querySelector('.dl');
    b.hidden = false;
    b.onclick = () => {
      const url = URL.createObjectURL(file);
      const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    };
  }

  async function copyCaption() {
    try {
      await navigator.clipboard.writeText(caption);
      say('Legenda copiada. Clica na caixa da descrição e cola (Ctrl+V).');
    } catch {
      say('Não deu para copiar automaticamente.');
    }
  }

  // ---------- procurar coisas na página (e em iframes do mesmo site) ----------
  function docs() {
    const out = [document];
    for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument) out.push(f.contentDocument); } catch {} }
    return out;
  }
  function query(sel) {
    for (const d of docs()) { const el = d.querySelector(sel); if (el) return el; }
    return null;
  }
  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(300); }
    return null;
  }
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 10; };

  function findCaptionBox() {
    for (const d of docs()) {
      const list = [...d.querySelectorAll('.public-DraftEditor-content[contenteditable="true"], [contenteditable="true"][role="combobox"], [contenteditable="true"]')];
      const el = list.find(visible);
      if (el) return el;
    }
    return null;
  }

  function findSchedule() {
    const re = /^\s*(agendar|programar|schedule)\s*$/i;
    for (const d of docs()) {
      for (const el of d.querySelectorAll('label, [role="radio"], button, span, div')) {
        if (el.children.length > 2 || !re.test(el.textContent || '')) continue;
        return el.closest('label, [role="radio"], button') || el;
      }
    }
    return null;
  }

  // ---------- data e hora do agendamento ----------
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };   // ícones e números são pequenos
  const leafs = (d) => [...d.querySelectorAll('*')].filter((el) => !el.children.length && shown(el));
  const disabled = (el) => !!el.closest('[aria-disabled="true"], [disabled], [class*="disabled" i]');

  function findDateTimeInputs() {
    let date = null, time = null;
    for (const d of docs()) {
      for (const i of d.querySelectorAll('input')) {
        if (!visible(i)) continue;
        const v = i.value.trim();
        if (!time && /^\d{1,2}:\d{2}$/.test(v)) time = i;
        else if (!date && (/^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(v))) date = i;
      }
    }
    return date && time ? { date, time } : null;
  }

  // Abre o seletor (os pickers reagem a mousedown/click no campo).
  async function openPicker(input) {
    input.scrollIntoView({ block: 'center' });
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) input.dispatchEvent(new MouseEvent(t, { bubbles: true }));
    input.focus();
    await sleep(500);
  }
  function press(el) {
    el.scrollIntoView({ block: 'nearest' });
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: true }));
  }

  // Hora: duas colunas de números (horas 00-23, minutos de 5 em 5). Distingue-as pelo conteúdo.
  async function pickTime(input, hhmm) {
    const [hh, mm] = hhmm.split(':');
    await openPicker(input);
    const nums = docs().flatMap(leafs).filter((el) => /^\d{2}$/.test(el.textContent.trim()) && el !== input);
    const cols = new Map();
    for (const el of nums) { const p = el.parentElement?.parentElement || el.parentElement; if (!cols.has(p)) cols.set(p, []); cols.get(p).push(el); }
    const groups = [...cols.values()].filter((g) => g.length >= 6);
    const has = (g, t) => g.some((el) => el.textContent.trim() === t);
    const minutes = groups.find((g) => has(g, '55') || has(g, '45'));
    const hours = groups.find((g) => g !== minutes && has(g, '23'));
    const hEl = hours?.find((el) => el.textContent.trim() === hh);
    const mEl = minutes?.find((el) => el.textContent.trim() === mm);
    if (!hEl || !mEl) return false;
    press(hEl);
    await sleep(250);
    press(mEl);
    await sleep(400);
    return input.value.trim().padStart(5, '0') === hhmm;
  }

  // Data: calendário com dias 1-31; se for do mês seguinte, avança com a seta da direita.
  async function pickDate(input, ymd) {
    const [y, mo, da] = ymd.split('-').map(Number);
    const matches = () => {
      const v = input.value.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v === ymd;
      const n = v.split(/[/.-]/).map(Number);
      return n.includes(da) && n.includes(mo);
    };
    if (matches()) return true;
    await openPicker(input);
    const cur = input.value.match(/^(\d{4})-(\d{2})/);
    const monthsAhead = cur ? (y - +cur[1]) * 12 + (mo - +cur[2]) : (new Date().getMonth() + 1 === mo ? 0 : 1);
    const dayCells = () => {
      const cells = docs().flatMap(leafs).filter((el) => /^\d{1,2}$/.test(el.textContent.trim()) && el !== input);
      const first = cells.findIndex((el) => el.textContent.trim() === '1');     // antes disto são dias do mês anterior
      return first < 0 ? [] : cells.slice(first);
    };
    for (let i = 0; i < monthsAhead; i++) {
      // Sobe a partir dos dias até encontrar setas (a da direita/última é «mês seguinte»).
      const cells = dayCells();
      let anc = cells[0]?.parentElement, arrows = [];
      for (let up = 0; anc && up < 6 && !arrows.length; up++, anc = anc.parentElement) {
        arrows = [...anc.querySelectorAll('svg, [class*="arrow" i], [aria-label*="next" i], [class*="next" i]')]
          .filter((el) => shown(el) && !cells.some((c) => el.contains(c)));
      }
      const nextish = arrows.filter((el) => /next|right/i.test((el.getAttribute('class') || '') + (el.getAttribute('aria-label') || '')));
      const next = nextish[nextish.length - 1] || arrows[arrows.length - 1];
      if (!next) return false;
      press(next.closest('button, [role="button"], span, div') || next);
      await sleep(400);
    }
    const cell = dayCells().find((el) => el.textContent.trim() === String(da) && !disabled(el));
    if (!cell) return false;
    press(cell);
    await sleep(400);
    return matches();
  }

  async function setSchedule(sc) {
    const radio = await waitFor(findSchedule, 15000);
    if (!radio) return false;
    press(radio);
    const fields = await waitFor(findDateTimeInputs, 6000);
    if (!fields) return false;
    const okD = await pickDate(fields.date, sc.date).catch(() => false);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));   // fecha o calendário
    await sleep(300);
    const okT = await pickTime(fields.time, sc.time).catch(() => false);
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return okD && okT;
  }

  // ---------- trazer o vídeo do editor ----------
  const ask = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }); } catch { res(null); }
  });

  async function fetchVideo(id) {
    const info = await ask({ scTT: 'info', id });
    if (!info?.size) return null;
    caption = info.caption || '';
    schedule = info.schedule || null;
    const buf = new Uint8Array(info.size);
    for (let off = 0; off < info.size; off += CHUNK) {
      const b64 = await ask({ scTT: 'chunk', id, offset: off, len: CHUNK });
      if (b64 == null) return null;
      const bin = atob(b64);
      for (let i = 0; i < bin.length; i++) buf[off + i] = bin.charCodeAt(i);
      say(`A trazer o vídeo do editor… ${Math.min(100, Math.round(((off + CHUNK) / info.size) * 100))}%`);
    }
    return new File([buf], info.name || 'clip.mp4', { type: info.type || 'video/mp4', lastModified: Date.now() });
  }

  // ---------- pôr a legenda (a caixa é um editor Draft.js: escreve-se como se fosse teclado) ----------
  async function putCaption(box) {
    const text = caption.replace(/(#[^\s#]+)$/, '$1 ');       // espaço no fim fecha a sugestão de hashtags
    box.focus();
    const d = box.ownerDocument;
    d.execCommand('selectAll', false);
    d.execCommand('delete', false);
    await sleep(100);
    d.execCommand('insertText', false, text);
    await sleep(400);
    const got = (box.innerText || '').replace(/\s+/g, ' ');
    return got.includes(caption.replace(/\s+/g, ' ').trim().slice(0, 20));
  }

  // ---------- fluxo ----------
  // Nunca clicamos em Publicar/Agendar (é sempre o utilizador), por isso não há confirmação real
  // do TikTok — isto só regista até onde a extensão conseguiu preencher sozinha, para servir de
  // referência ao próximo clip (chega tão perto de "verificado" quanto dá sem tocar no botão final).
  function recordFilled(when, name) {
    try { chrome.storage.local.set({ scLastTikTok: { at: when, name, mode: schedule ? 'at' : 'now', recordedAt: Date.now() } }); } catch {}
  }

  async function run(j) {
    running = true;
    const done = () => { try { chrome.storage.local.set({ scTikTok: { ...j, state: 'done', at: Date.now() } }); } catch {} };
    try {
      step('video', 'now');
      say('A trazer o vídeo do editor…');
      const file = await fetchVideo(j.id);
      if (!file) {
        step('video', 'bad');
        say('Não consegui falar com o editor (foi fechado?). No editor carrega em «Guardar cópia no PC» e arrasta o ficheiro para aqui.');
        return done();
      }
      say('A pôr o vídeo no TikTok…');
      const input = await waitFor(() => query('input[type="file"][accept*="video"]') || query('input[type="file"]'), 20000);
      if (!input) {
        step('video', 'bad');
        offerDownload(file);
        say('Não encontrei onde pôr o vídeo. Carrega em «Descarregar vídeo» e arrasta o ficheiro para aqui.');
        return done();
      }
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      step('video', 'ok');

      if (caption.trim()) {
        step('caption', 'now');
        say('A carregar o vídeo… a legenda entra a seguir.');
        const box = await waitFor(findCaptionBox, 90000);
        // O TikTok escreve o nome do ficheiro na descrição quando o upload arranca: espera por isso.
        if (box) {
          await waitFor(() => (box.innerText || '').trim(), 4000);
          await sleep(700);
        }
        const ok = box && (await putCaption(box));
        step('caption', ok ? 'ok' : 'bad');
        if (!ok) await copyCaption();
      } else step('caption', 'ok');

      if (schedule) {
        const when = new Date(`${schedule.date}T${schedule.time}`)
          .toLocaleString('pt-PT', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
        step('when', 'now');
        say('A pôr a data e a hora…');
        const ok = await setSchedule(schedule);
        step('when', ok ? 'ok' : 'bad');
        step('post', 'now');
        say(ok ? `Agendado para ${when}. Confere e carrega em «Agendar»/«Publicar».`
          : `Não consegui pôr a data/hora sozinho: escolhe «Agendar» e põe ${when}. Depois carrega em «Agendar».`);
        if (ok) recordFilled(new Date(`${schedule.date}T${schedule.time}`).getTime(), file.name);
        if (!ok) { ensureCard().root.querySelector('.sched').hidden = false; const r = findSchedule(); if (r) { r.style.outline = '3px solid #fe2c55'; r.style.outlineOffset = '4px'; r.scrollIntoView({ block: 'center', behavior: 'smooth' }); } }
        return done();
      }

      // Sem agendamento = publicar já.
      step('post', 'now');
      say('Pronto! Confere e carrega em «Publicar».');
      recordFilled(Date.now(), file.name);
      done();
    } catch (e) {
      console.warn('[StreamClipper TikTok]', e);
      say('Algo falhou: ' + e.message);
      done();
    } finally {
      running = false;
    }
  }

  function consider(j) {
    if (!enabled || !j || !j.at || Date.now() - j.at > FRESH_MS || running) return;
    job = j;
    if (j.state === 'pending') { ensureCard(); step('video', 'now'); say('A gerar o vídeo no editor… deixa esta aba aberta.'); }
    else if (j.state === 'error') { ensureCard(); step('video', 'bad'); say('A exportação falhou: ' + (j.message || '')); }
    else if (j.state === 'ready') {
      if (isUpload()) run(j);
      else { ensureCard(); say('Abre a página de upload do TikTok Studio (ou inicia sessão) e eu ponho lá o vídeo.'); }
    }
  }

  chrome.storage.local.get(['enabled', 'scTikTok'], (s) => {
    enabled = s.enabled === true;
    consider(s.scTikTok);
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    if (ch.enabled) {
      enabled = ch.enabled.newValue === true;
      if (enabled) chrome.storage.local.get('scTikTok', (s) => consider(s.scTikTok));
      else if (card && !running) { card.host.remove(); card = null; }
    }
    if (enabled && ch.scTikTok) consider(ch.scTikTok.newValue);
  });
  // O TikTok é uma SPA: se o upload só aparece depois do login, tenta outra vez quando a página mudar.
  let lastPath = location.pathname;
  setInterval(() => {
    if (!enabled) return;
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    if (job?.state === 'ready' && !running) consider({ ...job, at: job.at });
  }, 1000);
})();
