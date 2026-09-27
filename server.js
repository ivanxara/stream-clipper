// Stream Clipper — modo servidor
// Em vez de gravar o ecrã, descarrega os segmentos da própria live (YouTube / Twitch / Kick),
// por isso apanha os últimos X segundos a partir de onde estás, mesmo que não os tenhas visto.
// Corre no content script: os pedidos saem com a origem da página (youtube.com / twitch.tv / kick.com),
// que é o que os servidores aceitam.
(() => {
  if (self.StreamClipperServer) return;

  const host = location.hostname;
  const SITE = /(^|\.)youtube\.com$/.test(host) ? 'yt' : /(^|\.)twitch\.tv$/.test(host) ? 'tw' : /(^|\.)kick\.com$/.test(host) ? 'ki' : null;

  // Erro "esperado": este vídeo não dá para o modo servidor; usa-se a gravação.
  class Unsupported extends Error {}

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function get(url, { type = 'arrayBuffer', timeout = 20000, ...opts } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch(url, { credentials: 'omit', signal: ctl.signal, ...opts });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r[type]();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('O servidor não respondeu a tempo.');
      if (e.name === 'TypeError') throw new Unsupported('Não foi possível descarregar o vídeo. A rede ou o servidor bloqueou o pedido; a tentar a gravação local.');
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  // Corre fn sobre items com no máximo n pedidos em paralelo, mantendo a ordem.
  async function mapLimit(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    const worker = async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }

  // ---------- MP4 ----------
  function* boxes(u8, start = 0, end = u8.length) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let o = start; o + 8 <= end;) {
      let size = dv.getUint32(o), hdr = 8;
      const type = String.fromCharCode(u8[o + 4], u8[o + 5], u8[o + 6], u8[o + 7]);
      if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
      if (size < hdr || o + size > end) return;
      yield { type, start: o, end: o + size, body: o + hdr };
      o += size;
    }
  }

  function findBox(u8, path, start = 0, end = u8.length) {
    for (const b of boxes(u8, start, end)) {
      if (b.type !== path[0]) continue;
      return path.length === 1 ? b : findBox(u8, path.slice(1), b.body, b.end);
    }
    return null;
  }

  // Início (em segundos) do 1º fragmento de um segmento fMP4.
  function fragmentStart(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const mdhd = findBox(u8, ['moov', 'trak', 'mdia', 'mdhd']);
    const tfdt = findBox(u8, ['moof', 'traf', 'tfdt']);
    if (!mdhd || !tfdt) return null;
    const scale = u8[mdhd.body] === 1 ? dv.getUint32(mdhd.body + 20) : dv.getUint32(mdhd.body + 12);
    const t = u8[tfdt.body] === 1 ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
    return scale ? t / scale : null;
  }

  // Os segmentos do YouTube são MP4 completos (cada um com o seu cabeçalho e uma duração falsa
  // de ~25h). Fica o cabeçalho do 1º e só os fragmentos (moof+mdat) dos outros: um fMP4 limpo.
  function joinFragments(segs) {
    const parts = [];
    segs.forEach((u8, i) => {
      for (const b of boxes(u8)) {
        if ((i === 0 && (b.type === 'ftyp' || b.type === 'moov')) || b.type === 'moof' || b.type === 'mdat') {
          parts.push(u8.subarray(b.start, b.end));
        }
      }
    });
    return new Blob(parts, { type: 'video/mp4' });
  }

  // ---------- YouTube ----------
  let ytReq = 0;
  // Fala com o yt-main.js (mundo da página).
  function ytPlayerInfo() {
    const id = 'sc' + ++ytReq + '_' + Math.random().toString(36).slice(2);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { removeEventListener('message', on); reject(new Unsupported('Player do YouTube não respondeu.')); }, 1500);
      function on(ev) {
        const m = ev.data;
        if (ev.source !== window || !m || m.__scYT !== 'a' || m.id !== id) return;
        clearTimeout(t);
        removeEventListener('message', on);
        m.ok ? resolve(m) : reject(new Unsupported('Player do YouTube: ' + m.error));
      }
      addEventListener('message', on);
      window.postMessage({ __scYT: 'q', id }, location.origin);
    });
  }

  // O cliente iOS devolve links diretos para os segmentos (o do browser exige um token anti-bot).
  const YT_IOS = { clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple', deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', hl: 'en' };
  const ytCache = new Map();   // videoId -> {at, v, a, dur}

  async function ytFormats(vid) {
    const c = ytCache.get(vid);
    if (c && Date.now() - c.at < 30 * 60 * 1000) return c;
    const j = await get('/youtubei/v1/player?prettyPrint=false', {
      type: 'json',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-youtube-client-name': '5', 'x-youtube-client-version': YT_IOS.clientVersion },
      body: JSON.stringify({ context: { client: YT_IOS }, videoId: vid, contentCheckOk: true, racyCheckOk: true }),
    });
    const ps = j.playabilityStatus || {};
    if (ps.status !== 'OK') throw new Unsupported('YouTube recusou (' + (ps.reason || ps.status || '?') + ').');
    const fm = (j.streamingData?.adaptiveFormats || []).filter((f) => f.url);
    // H.264 (para sair MP4 pronto para o TikTok), a melhor até 1080p.
    const v = fm.filter((f) => /avc1/.test(f.mimeType) && (f.height || 0) <= 1080)
      .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0) || b.bitrate - a.bitrate)[0];
    const a = fm.find((f) => f.itag === 140) || fm.find((f) => /^audio\/mp4/.test(f.mimeType));
    if (!v || !a) throw new Unsupported('Sem formatos MP4 para este vídeo.');
    const r = {
      at: Date.now(), v: v.url, a: a.url, video: v, audio: a,
      dur: v.targetDurationSec || 5, label: v.qualityLabel || (v.height + 'p'),
    };
    ytCache.set(vid, r);
    return r;
  }

  async function ytClip(seconds, opts) {
    const info = await ytPlayerInfo();
    if (info.ad) throw new Error('Está a dar um anúncio — espera que acabe.');
    if (!info.vid || !Number.isFinite(info.t) || info.t <= 0) throw new Unsupported('Reproduz o vídeo até ao final do trecho que queres recortar.');
    const f = await ytFormats(info.vid);
    return info.isLive ? ytLiveClip(seconds, f, info, opts) : ytVideoClip(seconds, f, info, opts);
  }

  // Vídeos gravados têm um índice SIDX: cada entrada indica o tempo e os bytes
  // de um fragmento. Descarregamos só o trecho pedido, mesmo em VODs de várias horas.
  function indexedSegments(bytes, offset) {
    const box = findBox(bytes, ['sidx']);
    if (!box) throw new Unsupported('O vídeo não tem um índice de segmentos compatível.');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = bytes[box.body];
    if (version > 1) throw new Unsupported('Versão de índice MP4 não suportada.');
    const scale = dv.getUint32(box.body + 8);
    let p = box.body + 12;
    const readTime = () => {
      const value = version === 1 ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
      p += version === 1 ? 8 : 4;
      return value;
    };
    let time = readTime();
    let start = offset + box.end + readTime();
    p += 2;
    const count = dv.getUint16(p); p += 2;
    if (!scale || p + count * 12 > box.end) throw new Unsupported('Índice MP4 inválido.');
    const segments = [];
    for (let i = 0; i < count; i++, p += 12) {
      const ref = dv.getUint32(p), duration = dv.getUint32(p + 4);
      if (ref >>> 31) throw new Unsupported('Índice MP4 hierárquico não suportado.');
      const size = ref & 0x7fffffff;
      if (!size || !duration || !Number.isSafeInteger(start + size)) throw new Unsupported('Segmento MP4 inválido.');
      segments.push({ start, end: start + size - 1, from: time / scale, to: (time + duration) / scale });
      start += size; time += duration;
    }
    return segments;
  }

  async function ytRange(url, start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Unsupported('Intervalo MP4 inválido.');
    }
    const target = new URL(url);
    target.searchParams.set('range', `${start}-${end}`);
    let bytes;
    try {
      bytes = new Uint8Array(await get(target.href, { timeout: 30000 }));
    } catch (error) {
      if (error.message === 'HTTP 403') {
        throw new Unsupported('O YouTube recusou a descarga deste trecho (HTTP 403). Não foi possível obter o clip completo diretamente.');
      }
      throw error;
    }
    const expected = end - start + 1;
    if (bytes.length !== expected) throw new Unsupported('Trecho MP4 incompleto.');
    return bytes;
  }

  async function ytVideoClip(seconds, f, info, { onProgress }) {
    const to = info.t, from = Math.max(0, to - seconds);
    onProgress('A localizar o trecho no vídeo…');
    const prepare = async (format) => {
      if (!format.initRange || !format.indexRange) throw new Unsupported('Sem índice MP4 para este vídeo.');
      const offset = Number(format.indexRange.start);
      const bytes = await ytRange(format.url, offset, Number(format.indexRange.end));
      return { format, segments: indexedSegments(bytes, offset) };
    };
    const tracks = await Promise.all([prepare(f.video), prepare(f.audio)]);
    // Inclui o fragmento anterior para disponibilizar um keyframe antes do corte.
    const first = tracks[0].segments.findIndex((s) => s.to > from);
    if (first < 0) throw new Unsupported('Esse trecho ainda não está disponível no vídeo.');
    const downloadFrom = tracks[0].segments[Math.max(0, first - 1)].from;
    const selections = tracks.map(({ segments }) => segments.filter((s) => s.to > downloadFrom && s.from < to));
    if (selections.some((segments) => !segments.length || segments[segments.length - 1].to + 0.1 < to)) {
      throw new Unsupported('Esse trecho ainda não está disponível no vídeo.');
    }
    let done = 0;
    const total = selections.reduce((sum, segments) => sum + segments.length + 1, 0);
    const inputs = await Promise.all(tracks.map(async ({ format }, i) => {
      const ranges = [format.initRange, ...selections[i]];
      const parts = await mapLimit(ranges, 3, async (range) => {
        const bytes = await ytRange(format.url, Number(range.start), Number(range.end));
        onProgress(`A descarregar do vídeo (${f.label})… ${Math.round(++done / total * 100)}%`);
        return bytes;
      });
      return { name: i === 0 ? 'v.mp4' : 'a.mp4', blob: new Blob(parts, { type: 'video/mp4' }) };
    }));
    return { inputs, abs: true, from, to };
  }

  async function ytLiveClip(seconds, f, info, { onProgress }) {
    const to = info.t, from = Math.max(0, to - seconds);

    // Em princípio segmento n começa em n × dur; confirma-se com o 1º que se descarrega.
    onProgress('A localizar a posição na live…');
    const guess = Math.floor(to / f.dur);
    const probe = new Uint8Array(await get(f.v + '&sq=' + guess));
    const t0 = fragmentStart(probe);
    const sqOf = (t) => (t0 == null ? Math.floor(t / f.dur) : guess + Math.floor((t - t0) / f.dur));
    const sqEnd = sqOf(to), sqStart = Math.max(0, sqOf(from));
    const sqs = [];
    for (let s = sqStart; s <= sqEnd; s++) sqs.push(s);

    let done = 0;
    const total = sqs.length * 2;
    const fetchSeg = async (url, s) => {
      const u8 = url === f.v && s === guess ? probe : new Uint8Array(await get(url + '&sq=' + s));
      onProgress(`A descarregar da live (${f.label})… ${Math.round((++done / total) * 100)}%`);
      return u8;
    };
    const [vs, as] = await Promise.all([
      mapLimit(sqs, 3, (s) => fetchSeg(f.v, s)),
      mapLimit(sqs, 3, (s) => fetchSeg(f.a, s)),
    ]);
    return {
      inputs: [{ name: 'v.mp4', blob: joinFragments(vs) }, { name: 'a.mp4', blob: joinFragments(as) }],
      abs: true, from, to,          // tempos absolutos do média (os do player)
    };
  }

  // ---------- Twitch ----------
  const TW_CID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';   // Client-ID público do site da Twitch
  const TW_RESERVED = new Set(['directory', 'videos', 'settings', 'search', 'downloads', 'subscriptions', 'inventory',
    'wallet', 'drops', 'p', 'u', 'turbo', 'jobs', 'store', 'prime', 'friends', 'messages', 'following', 'clips']);

  function twLogin() {
    const parts = location.pathname.split('/').filter(Boolean).map((s) => s.toLowerCase());
    let login = parts[0];
    if (['popout', 'moderator', 'embed'].includes(login)) login = parts[1];
    if (!login || TW_RESERVED.has(login) || ['videos', 'clip', 'clips', 'schedule', 'about'].includes(parts[1])) return null;
    return /^\w{1,25}$/.test(login) ? login : null;
  }

  async function gql(query, variables) {
    const j = await get('https://gql.twitch.tv/gql', {
      type: 'json', method: 'POST', headers: { 'Client-ID': TW_CID }, body: JSON.stringify({ query, variables }),
    });
    if (j.errors?.length) throw new Error('Twitch: ' + j.errors[0].message);
    return j.data;
  }

  const lines = (txt) => txt.split('\n').map((l) => l.trim());
  const firstUrl = (txt) => lines(txt).find((l) => l && !l.startsWith('#'));

  // Tempo de emissão (segundos desde o início da live) do fim do que está no ecrã.
  async function twDisplayedTime(login, token, video) {
    const master = await get(`https://usher.ttvnw.net/api/channel/hls/${login}.m3u8?` + new URLSearchParams({
      sig: token.signature, token: token.value, allow_source: 'true', fast_bread: 'true', p: String(Math.floor(Math.random() * 1e6)),
    }), { type: 'text' });
    const media = await get(firstUrl(master), { type: 'text' });
    const elapsed = parseFloat(media.match(/#EXT-X-TWITCH-ELAPSED-SECS:([\d.]+)/)?.[1]);
    if (!isFinite(elapsed)) throw new Error('Não consegui ler a posição da live.');
    let edge = elapsed;
    for (const l of lines(media)) {
      if (l.startsWith('#EXTINF:')) edge += parseFloat(l.slice(8));
      else if (l.startsWith('#EXT-X-TWITCH-PREFETCH:')) edge += 2;   // o player em baixa latência já os tem
    }
    // O player está atrás da "ponta" da live aproximadamente o que tem em buffer à frente.
    let ahead = 0;
    if (video?.buffered?.length) ahead = Math.max(0, video.buffered.end(video.buffered.length - 1) - video.currentTime);
    return edge - ahead + 0.5;
  }

  function parseVod(txt) {
    const segs = [];
    let pos = 0, dur = 0, map = null;
    for (const l of lines(txt)) {
      if (l.startsWith('#EXT-X-MAP:')) map = l.match(/URI="([^"]+)"/)?.[1] || null;
      else if (l.startsWith('#EXTINF:')) dur = parseFloat(l.slice(8));
      else if (l && !l.startsWith('#')) { segs.push({ uri: l, start: pos, dur, map }); pos += dur; }
    }
    const total = parseFloat(txt.match(/#EXT-X-TWITCH-TOTAL-SECS:([\d.]+)/)?.[1]);
    return { segs, total: isFinite(total) ? total : pos };
  }

  const twVodId = () => location.pathname.match(/^\/videos\/(\d+)\/?$/)?.[1] || null;
  const kiVodId = () => location.pathname.match(/^\/(?:[\w-]+\/videos|video)\/([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\/?$/i)?.[1] || null;

  function vodPosition(video) {
    if (!video || video.seeking || !Number.isFinite(video.currentTime) || video.currentTime <= 0) {
      throw new Unsupported('Posiciona o vídeo no final do trecho e espera que carregue.');
    }
    return video.currentTime;
  }

  async function twClip(seconds, { onProgress, video }) {
    let vodId = twVodId();
    const archive = !!vodId;
    let to;
    if (archive) {
      to = vodPosition(video);
      onProgress('A localizar o trecho no VOD da Twitch…');
    } else {
    const login = twLogin();
    if (!login) throw new Unsupported('Não é uma live da Twitch.');
    onProgress('A localizar a posição na live…');
    const d = await gql(`query($login:String!){
      user(login:$login){ stream{ id archiveVideo{ id } } }
      streamPlaybackAccessToken(channelName:$login, params:{platform:"web", playerBackend:"mediaplayer", playerType:"embed"}){ value signature }
    }`, { login });
    const stream = d.user?.stream;
    if (!stream) throw new Unsupported('O canal não está em direto.');
    vodId = stream.archiveVideo?.id;
    if (!vodId) throw new Unsupported('Este canal não guarda VODs.');

    to = await twDisplayedTime(login, d.streamPlaybackAccessToken, video);
    }
    const from = Math.max(0, to - seconds);

    // O VOD da live em curso vai sendo escrito com poucos segundos de atraso.
    const vt = (await gql(`query($id:ID!){ videoPlaybackAccessToken(id:$id, params:{platform:"web", playerBackend:"mediaplayer", playerType:"site"}){ value signature } }`, { id: vodId })).videoPlaybackAccessToken;
    if (!vt?.value || !vt?.signature) throw new Unsupported('VOD da Twitch indisponível.');
    const masterUrl = `https://usher.ttvnw.net/vod/${vodId}.m3u8?` + new URLSearchParams({
      sig: vt.signature, token: vt.value, allow_source: 'true', p: String(Math.floor(Math.random() * 1e6)),
    });
    let vodMaster;
    try {
      vodMaster = await get(masterUrl, { type: 'text' });
    } catch (e) {
      throw new Unsupported('VOD indisponível (' + e.message + ').');
    }
    const variant = firstUrl(vodMaster);
    if (!variant) throw new Unsupported('Sem playlist para este VOD.');
    const vodUrl = new URL(variant, masterUrl).href;   // a 1ª variante é a qualidade original
    const base = vodUrl;
    const quality = vodUrl.split('/').slice(-2, -1)[0];

    let vod;
    for (let i = 0; ; i++) {
      vod = parseVod(await get(vodUrl, { type: 'text' }));
      if (archive || vod.total >= to || i >= 12) break;
      onProgress(`À espera que a Twitch grave o final… (${Math.ceil(to - vod.total)}s)`);
      await sleep(2500);
    }
    const end = Math.min(to, vod.total);
    let segs = vod.segs.filter((s) => s.start < end && s.start + s.dur > from);
    if (!segs.length) throw new Error('Não encontrei esse trecho no VOD.');
    // Uma quebra na emissão (novo init) a meio: fica só a parte depois da quebra.
    const lastMap = segs[segs.length - 1].map;
    segs = segs.filter((s) => s.map === lastMap);

    let done = 0;
    const init = lastMap ? new Uint8Array(await get(new URL(lastMap, base).href)) : null;
    const bodies = await mapLimit(segs, 3, async (s) => {
      const u8 = new Uint8Array(await get(new URL(s.uri, base).href, { timeout: 30000 }));
      onProgress(`A descarregar ${archive ? 'do VOD' : 'da live'} (${quality})… ${Math.round((++done / segs.length) * 100)}%`);
      return u8;
    });
    const first = segs[0].start;
    return {
      inputs: [{ name: 't.mp4', blob: new Blob(init ? [init, ...bodies] : bodies, { type: 'video/mp4' }) }],
      abs: false, from: Math.max(0, from - first), to: end - first,   // relativos ao 1º segmento
    };
  }

  // ---------- Kick ----------
  const KI_RESERVED = new Set(['categories', 'category', 'search', 'clips', 'video', 'videos', 'settings', 'dashboard']);

  function kiSlug() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) return null;
    const slug = parts[0]?.toLowerCase();
    return slug && !KI_RESERVED.has(slug) && /^[a-z0-9_]{1,25}$/.test(slug) ? slug : null;
  }

  function parseMaster(txt, base) {
    const variants = [];
    const rows = txt.split('\n').map((line) => line.trim());
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      const height = Number(rows[i].match(/RESOLUTION=\d+x(\d+)/)?.[1]) || 0;
      const bandwidth = Number(rows[i].match(/BANDWIDTH=(\d+)/)?.[1]) || 0;
      const uri = rows.slice(i + 1).find((line) => line && !line.startsWith('#'));
      if (uri) variants.push({ url: new URL(uri, base).href, height, bandwidth });
    }
    return variants.sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  }

  function parseKickPlaylist(txt) {
    const segments = [];
    let pos = 0, dur = 0, map = null, encrypted = false;
    for (const line of txt.split('\n').map((value) => value.trim())) {
      if (line.startsWith('#EXT-X-KEY:')) encrypted = !/METHOD=NONE/.test(line);
      else if (line.startsWith('#EXT-X-MAP:')) map = line.match(/URI="([^"]+)"/)?.[1] || null;
      else if (line.startsWith('#EXTINF:')) dur = parseFloat(line.slice(8));
      else if (line && !line.startsWith('#')) {
        if (!isFinite(dur) || dur <= 0) continue;
        segments.push({ uri: line, start: pos, dur, map });
        pos += dur;
        dur = 0;
      }
    }
    return { segments, total: pos, encrypted };
  }

  async function kickClip(seconds, { onProgress, video }) {
    const vodId = kiVodId();
    const position = vodId ? vodPosition(video) : null;
    let source;
    if (vodId) {
      onProgress('A localizar o trecho no VOD do Kick…');
      const archive = await get(`/api/v1/video/${encodeURIComponent(vodId)}`, { type: 'json' });
      source = archive.source;
      if (!source) throw new Unsupported('VOD do Kick indisponível.');
    } else {
    const slug = kiSlug();
    if (!slug) throw new Unsupported('Não é uma página de canal Kick.');
    onProgress('A localizar a live no Kick…');
    const channel = await get(`/api/v2/channels/${encodeURIComponent(slug)}`, { type: 'json' });
    const stream = channel.livestream;
    if (!stream?.is_live || !stream.playback_url) throw new Unsupported('O canal Kick não está em direto.');
    source = stream.playback_url;
    }

    let playlistUrl = new URL(source, location.origin).href;
    let playlist = await get(playlistUrl, { type: 'text' });
    const variants = parseMaster(playlist, playlistUrl);
    if (variants.length) {
      playlistUrl = variants[0].url;
      playlist = await get(playlistUrl, { type: 'text' });
    }
    const vod = parseKickPlaylist(playlist);
    if (vod.encrypted) throw new Unsupported('A playlist Kick está cifrada.');
    if (!vod.segments.length) throw new Unsupported('A playlist Kick não tem segmentos disponíveis.');

    const to = vodId ? Math.min(position, vod.total) : vod.total;
    const from = Math.max(0, to - seconds);
    let segments = vod.segments.filter((segment) => segment.start < to && segment.start + segment.dur > from);
    if (!segments.length || (!vodId && to - segments[0].start < Math.min(seconds, 5))) {
      throw new Unsupported('A playlist Kick ainda não tem segmentos suficientes.');
    }
    const lastMap = segments[segments.length - 1].map;
    segments = segments.filter((segment) => segment.map === lastMap);

    let done = 0;
    const init = lastMap ? new Uint8Array(await get(new URL(lastMap, playlistUrl).href)) : null;
    const bodies = await mapLimit(segments, 3, async (segment) => {
      const body = new Uint8Array(await get(new URL(segment.uri, playlistUrl).href, { timeout: 30000 }));
      onProgress(`A descarregar ${vodId ? 'do VOD' : 'da live'} Kick… ${Math.round((++done / segments.length) * 100)}%`);
      return body;
    });
    const first = segments[0].start;
    return {
      inputs: [{ name: 'kick.mp4', blob: new Blob(init ? [init, ...bodies] : bodies, { type: 'video/mp4' }) }],
      abs: false, from: Math.max(0, from - first), to: to - first,
    };
  }

  // No YouTube pergunta-se ao player (de vez em quando) se é uma live.
  const ytPage = () => /^\/(watch|live\/)/.test(location.pathname);
  let ytLive = false, ytReady = false, ytChecked = 0;
  async function refresh() {
    if (SITE !== 'yt' || Date.now() - ytChecked < 4000) return;
    ytChecked = Date.now();
    try {
      const info = ytPage() ? await ytPlayerInfo() : null;
      ytReady = !!info?.vid;
      ytLive = !!info?.isLive;
    } catch { ytReady = false; ytLive = false; }
  }

  self.StreamClipperServer = {
    Unsupported,
    refresh,
    // A primeira tentativa não deve depender da resposta assíncrona de refresh:
    // um clique logo depois de abrir o vídeo também tem de consultar o player.
    available: () => (SITE === 'yt' ? ytPage() : SITE === 'tw' ? !!(twVodId() || twLogin()) : SITE === 'ki' ? !!(kiVodId() || kiSlug()) : false),
    label: () => (SITE === 'yt' ? (ytLive ? 'Modo live (YouTube)' : 'Modo vídeo (YouTube)') : SITE === 'tw' ? (twVodId() ? 'Modo VOD (Twitch)' : 'Modo live (Twitch)') : (kiVodId() ? 'Modo VOD (Kick)' : 'Modo live (Kick)')),
    site: SITE,
    clip: (seconds, opts) => (SITE === 'yt' ? ytClip(seconds, opts) : SITE === 'tw' ? twClip(seconds, opts) : SITE === 'ki' ? kickClip(seconds, opts) : Promise.reject(new Unsupported('Site sem modo servidor.'))),
  };
})();
