// Corre dentro de um iframe da extensão: junta os segmentos com ffmpeg.wasm e faz download.
import { FFmpeg } from './lib/ffmpeg/index.js';
import { saveLastClip } from './clipstore.js';

let ffmpeg = null;
let loading = null;
const post = (msg) => parent.postMessage({ __sc: true, ...msg }, '*');

async function getFFmpeg(id) {
  if (ffmpeg) return ffmpeg;
  if (!loading) {
    loading = (async () => {
      post({ type: 'progress', id, text: 'A carregar o motor de vídeo (1ª vez)…' });
      const f = new FFmpeg();
      await f.load({
        coreURL: chrome.runtime.getURL('lib/core/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('lib/core/ffmpeg-core.wasm'),
      });
      ffmpeg = f;
      return f;
    })();
    loading.catch(() => { loading = null; });
  }
  return loading;
}

async function handleClip({ id, parts, h264, out, name, save }) {
  // Se o ffmpeg abortar (ex.: sem memória) o motor fica inutilizável para sempre — todos os
  // clips seguintes falhariam da mesma forma até a página ser recarregada. Ao descartá-lo aqui,
  // o próximo clip arranca com um motor novo.
  function discardFFmpeg() {
    try { ffmpeg?.terminate(); } catch {}
    ffmpeg = null;
    loading = null;
  }
  async function execOnce(ff, args, label) {
    const log = [];
    const onLog = ({ message }) => { log.push(message); if (log.length > 60) log.shift(); };
    ff.on('log', onLog);
    try {
      let code;
      try { code = await ff.exec(args); }
      catch (e) { throw new Error(`ffmpeg encravou${label ? ' (' + label + ')' : ''}: ` + (e?.message || e) + ' | ' + log.slice(-4).join(' | ')); }
      if (code !== 0) throw new Error(`ffmpeg falhou (${code})${label ? ' — ' + label : ''}: ` + log.slice(-4).join(' | '));
      return await ff.readFile('out.mp4');
    } finally {
      ff.off('log', onLog);
    }
  }

  // Várias estratégias, da melhor qualidade (cópia, sem recodificar) até à mais leve/robusta
  // (recodifica mais pequeno). Se uma falhar — segmentos incompatíveis, motor sem memória,
  // etc. — tenta a seguinte com um motor ffmpeg novo, em vez de desistir logo.
  const baseArgs = ['-hide_banner', '-f', 'concat', '-safe', '0', '-i', 'list.txt'];
  const tail = ['-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', 'out.mp4'];
  const strategies = [];
  if (h264) strategies.push({ label: 'cópia', args: [...baseArgs, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', ...tail] });
  strategies.push({ label: 'recodificar', args: [...baseArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', ...tail] });
  strategies.push({
    label: 'recodificar (leve)',
    args: [...baseArgs, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-vf', "scale='min(1280,iw)':-2", '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', ...tail],
  });

  let lastErr = null;
  for (let attempt = 0; attempt < strategies.length; attempt++) {
    const ff = await getFFmpeg(id);
    const files = [];
    try {
      post({ type: 'progress', id, text: attempt === 0 ? 'A juntar segmentos…' : `A tentar de outra forma (${attempt + 1}/${strategies.length})…` });
      let list = '';
      for (let i = 0; i < parts.length; i++) {
        const fn = `s${i}.webm`;
        await ff.writeFile(fn, new Uint8Array(await parts[i].blob.arrayBuffer()));
        files.push(fn);
        // 'duration' evita que o demuxer concat tenha de adivinhar a duração de cada segmento
        // (os WebM do MediaRecorder normalmente não trazem essa informação no cabeçalho) — sem
        // isto os tempos entre segmentos podem desalinhar-se e dar um MP4 corrompido.
        list += `file '${fn}'\nduration ${parts[i].outpoint.toFixed(3)}\noutpoint ${parts[i].outpoint.toFixed(3)}\n`;
      }
      await ff.writeFile('list.txt', new TextEncoder().encode(list));
      files.push('list.txt');
      const data = await execOnce(ff, strategies[attempt].args, strategies[attempt].label);
      files.push('out.mp4');
      const blob = new Blob([data], { type: 'video/mp4' });
      await download(id, blob, name.replace(/\.webm$/i, '.mp4'), save);
      for (const f of files) { try { await ff.deleteFile(f); } catch {} }
      return;
    } catch (e) {
      lastErr = e;
      discardFFmpeg();   // o motor pode ter ficado num estado inválido depois de um erro/abort
      for (const f of files) { try { await ff.deleteFile(f); } catch {} }
    }
  }

  // Nada da conversão funcionou: em vez de perder o clip gravado, entrega os segmentos tal
  // como foram gravados (sem editor, mas o utilizador continua a ficar com o clip). Cada
  // segmento é o seu próprio WebM completo — concatenar os bytes não dava um ficheiro válido,
  // por isso descarrega-se cada um à parte (um só, se só houver um).
  try {
    post({ type: 'progress', id, text: 'A conversão falhou — a guardar o clip em bruto…' });
    const base = name.replace(/\.(webm|mp4)$/i, '');
    for (let i = 0; i < parts.length; i++) {
      const rawName = parts.length > 1 ? `${base}_bruto_parte${i + 1}.webm` : `${base}_bruto.webm`;
      await download(id, parts[i].blob, rawName, true, true);
    }
  } catch {
    throw lastErr || new Error('Não consegui converter nem guardar o clip.');
  }
}

// Modo live: segmentos descarregados da live (MP4 fragmentado). Corta [from, to] sem re-encode;
// o início recua até ao keyframe anterior, e o áudio corta no mesmo ponto para ficar em sincronia.
async function handleServer({ id, inputs, abs, from, to, name, save }) {
  const ff = await getFFmpeg(id);
  const log = [];
  const onLog = ({ message }) => { log.push(message); if (log.length > 60) log.shift(); };
  ff.on('log', onLog);
  const files = [];
  try {
    post({ type: 'progress', id, text: 'A preparar o corte…' });
    for (const inp of inputs) {
      await ff.writeFile(inp.name, new Uint8Array(await inp.blob.arrayBuffer()));
      files.push(inp.name);
    }
    files.push('pk.txt');
    // Nesta versão do ffmpeg.wasm o ffprobe devolve sempre -1, mesmo quando corre bem:
    // o que conta é ter escrito os pacotes no ficheiro.
    await ff.ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags',
      '-of', 'csv=p=0', inputs[0].name, '-o', 'pk.txt']);
    let pk = '';
    try { pk = new TextDecoder().decode(await ff.readFile('pk.txt')); } catch {}
    const packets = pk.split('\n')
      .map((l) => l.split(',')).filter((p) => p[0] && p[0] !== 'N/A' && isFinite(+p[0]))
      .map(([t, flags]) => ({ t: +t, key: (flags || '').includes('K') }));
    if (!packets.length) throw new Error('Não consegui ler o vídeo descarregado. ' + log.slice(-3).join(' | '));
    const cut = planCut(packets, { abs, from, to });

    post({ type: 'progress', id, text: 'A juntar o clip…' });
    // -copyts: vídeo e áudio mantêm os tempos originais, por isso cortam no mesmo instante
    // mesmo que os ficheiros comecem em pontos diferentes. Com -c copy e -ss à saída, o vídeo
    // só começa num keyframe; o ss fica um pouco antes do keyframe escolhido.
    // O áudio entra já cortado no keyframe (seek por tempo absoluto); se vier no mesmo ficheiro
    // do vídeo (Twitch), abre-se o ficheiro duas vezes.
    const audioFile = (inputs[1] || inputs[0]).name;
    const args = ['-hide_banner', '-copyts', '-i', inputs[0].name,
      '-seek_timestamp', '1', '-ss', cut.key.toFixed(3), '-i', audioFile,
      '-map', '0:v:0', '-map', '1:a:0?',
      '-ss', cut.ss.toFixed(3), '-to', cut.to.toFixed(3), '-c', 'copy',
      '-movflags', '+faststart', '-avoid_negative_ts', 'make_zero', '-y', 'out.mp4'];
    let code;
    const reset = () => { try { ff.terminate(); } catch {} ffmpeg = null; loading = null; };
    try { code = await ff.exec(args); }
    catch (e) { reset(); throw new Error('ffmpeg encravou a cortar: ' + (e?.message || e)); }
    if (code !== 0) { reset(); throw new Error('ffmpeg falhou (' + code + '): ' + log.slice(-4).join(' | ')); }
    files.push('out.mp4');
    const data = await ff.readFile('out.mp4');
    await download(id, new Blob([data.buffer], { type: 'video/mp4' }), name, save);
  } catch (e) {
    // Nunca perder o que já foi descarregado da live: entrega o vídeo descarregado tal como
    // está (sem o corte preciso), para o utilizador poder pelo menos guardá-lo.
    try {
      post({ type: 'progress', id, text: 'O corte falhou — a guardar o vídeo descarregado…' });
      const rawName = name.replace(/\.mp4$/i, '') + '_bruto.mp4';
      await download(id, new Blob([await inputs[0].blob.arrayBuffer()], { type: 'video/mp4' }), rawName, true, true);
    } catch { throw e; }
  } finally {
    ff.off('log', onLog);
    for (const f of files) { try { await ff.deleteFile(f); } catch {} }
  }
}

// Recebe os pacotes de vídeo e devolve o corte em tempos absolutos do ficheiro:
// começa no último keyframe antes de 'from' (para não perder nada) e acaba em 'to'.
// abs=false: from/to são relativos ao início do vídeo descarregado.
export function planCut(packets, { abs, from, to }) {
  if (!packets.length) throw new Error('O vídeo descarregado está vazio.');
  let start = Infinity;
  for (const p of packets) if (p.t < start) start = p.t;
  const fromAbs = abs ? from : start + from;
  const toAbs = abs ? to : start + to;
  const keys = packets.filter((p) => p.key).map((p) => p.t).sort((a, b) => a - b);
  let k = keys[0] ?? start;
  for (const kt of keys) if (kt <= fromAbs + 0.05) k = kt;
  if (!(toAbs - k > 0.5)) throw new Error('Trecho demasiado curto no que foi descarregado.');
  // O ffmpeg compara o -ss com o DTS, que nos keyframes com B-frames fica um pouco antes do PTS:
  // com margem de 0,5s o keyframe k entra de certeza (e nada antes dele, que não é keyframe).
  return { key: k, ss: Math.max(0, k - 0.5), to: toAbs };
}

// save=false: o clip vai para o editor (que guarda); só se entrega o ficheiro.
// raw=true: a conversão falhou e isto é o clip tal como foi gravado/descarregado — nunca vai
// para o editor (não sabe abrir estes casos), só é descarregado, para não se perder.
async function download(id, blob, name, save = true, raw = false) {
  if (!raw) await saveLastClip(blob, name).catch(() => {});   // para o editor (plano B)
  if (!save) { post({ type: 'done', id, name, size: blob.size, blob, raw }); return; }
  try {
    const url = URL.createObjectURL(blob);
    await chrome.downloads.download({ url, filename: 'StreamClips/' + name, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 120000);
    post({ type: 'done', id, name, size: blob.size, blob, raw });
  } catch (e) {
    // Sem API de downloads neste contexto: a página faz o download.
    post({ type: 'download-here', id, name, blob, raw });
  }
}

addEventListener('message', async (ev) => {
  const m = ev.data;
  if (ev.source !== parent || !m || m.__sc !== true || m.type !== 'job') return;
  try { await (m.kind === 'server' ? handleServer(m) : handleClip(m)); }
  catch (e) { post({ type: 'error', id: m.id, message: e.message || String(e) }); }
});

post({ type: 'ready' });
