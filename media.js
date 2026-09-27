// Biblioteca de media das composições: importar vídeos/imagens e ler vídeos frame a frame.
import { parseMp4 } from './mp4.js';

const decoderConfig = (m) => ({ codec: m.codec, codedWidth: m.width, codedHeight: m.height, description: m.description });

async function decodable(buf) {
  try {
    const m = parseMp4(buf);
    if (!m.samples.length) return null;
    return (await VideoDecoder.isConfigSupported(decoderConfig(m))).supported ? m : null;
  } catch {
    return null;
  }
}

// Miniatura quadrada (para a lista da biblioteca).
function thumbOf(img, w, h) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const s = Math.max(128 / w, 128 / h);
  c.getContext('2d').drawImage(img, (128 - w * s) / 2, (128 - h * s) / 2, w * s, h * s);
  return c.toDataURL('image/png');
}

const newId = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Serializa o motor partilhado, incluindo chamadas de substituição/importação em simultâneo.
let importQueue = Promise.resolve();
export function importMediaFile(file, getFFmpeg) {
  const task = importQueue.then(() => importFile(file, getFFmpeg));
  importQueue = task.catch(() => {});
  return task;
}

async function importFile(file, getFFmpeg) {
  const base = { id: newId(), name: file.name.replace(/\.[^.]+$/, ''), at: Date.now(),
    sourceBlob: file, sourceName: file.name, importVersion: 2 };
  if (file.type === 'image/gif' || /\.gif$/i.test(file.name)) {
    const reader = await GifTrackReader.open(file);
    try {
      const frame = await reader.frameAt(0);
      return { ...base, type: 'gif', blob: file, w: frame.displayWidth, h: frame.displayHeight,
        dur: reader.duration, frameDurations: reader.durations, thumb: thumbOf(frame, frame.displayWidth, frame.displayHeight) };
    } finally { reader.close(); }
  }
  if (file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|avif|svg)$/i.test(file.name)) {
    const bmp = await createImageBitmap(file);
    const rec = { ...base, type: 'image', blob: file, w: bmp.width, h: bmp.height, thumb: thumbOf(bmp, bmp.width, bmp.height) };
    bmp.close();
    return rec;
  }
  // Inspeciona o conteúdo real, não a extensão. Nunca passa um vídeo com alfa
  // pela conversão opaca: cor e máscara são guardadas no mesmo frame e no mesmo relógio.
  const ff = await getFFmpeg(), prefix = base.id;
  const inName = prefix + '.source', probeName = prefix + '.json', outName = prefix + '.mp4';
  try {
    await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()));
    await ff.ffprobe(['-v', 'error', '-show_streams', '-show_pixel_formats', '-of', 'json', '-o', probeName, inName], 30000);
    const info = JSON.parse(new TextDecoder().decode(await ff.readFile(probeName)));
    const stream = info.streams?.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
    if (!stream || !stream.width || !stream.height) throw new Error('O ficheiro não contém um vídeo legível.');
    const alpha = !!info.pixel_formats?.find(p => p.name === stream.pix_fmt)?.flags?.alpha ||
      Object.entries(stream.tags || {}).some(([k, v]) => k.toLowerCase() === 'alpha_mode' && +v === 1);
    // Os descodificadores nativos VP8/VP9 ignoram a máscara WebM; libvpx lê-a.
    const decoder = alpha && ['vp8', 'vp9'].includes(stream.codec_name) ? ['-c:v', stream.codec_name === 'vp9' ? 'libvpx-vp9' : 'libvpx'] : [];
    let blob = file, mp4 = !alpha && await decodable(await file.arrayBuffer());
    if (alpha) {
      const filter = '[0:v:0]format=rgba,split[c][a];' +
        '[c]pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p[c0];' +
        '[a]alphaextract,pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p[a0];[c0][a0]hstack[v]';
      const code = await ff.exec(['-hide_banner', ...decoder, '-i', inName, '-filter_complex', filter,
        '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', '-y', outName], 120000);
      if (code !== 0) throw new Error('Não consegui converter este vídeo preservando a transparência.');
      blob = new Blob([await ff.readFile(outName)], { type: 'video/mp4' });
      mp4 = await decodable(await blob.arrayBuffer());
      if (!mp4) throw new Error('Este browser não consegue ler o vídeo com transparência.');
    } else if (!mp4) {
      const code = await ff.exec(['-hide_banner', '-i', inName, '-map', '0:v:0', '-an', '-c:v', 'copy', '-movflags', '+faststart', '-y', outName], 120000);
      if (code === 0) {
        blob = new Blob([await ff.readFile(outName)], { type: 'video/mp4' });
        mp4 = await decodable(await blob.arrayBuffer());
      }
      if (!mp4) {
        const converted = await ff.exec(['-hide_banner', '-i', inName, '-map', '0:v:0', '-an', '-vf', 'scale=ceil(iw/2)*2:ceil(ih/2)*2',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', outName], 120000);
        if (converted === 0) {
          blob = new Blob([await ff.readFile(outName)], { type: 'video/mp4' });
          mp4 = await decodable(await blob.arrayBuffer());
        }
      }
    }
    if (!mp4 || !Number.isFinite(mp4.duration) || mp4.duration <= 0) throw new Error(`«${file.name}»: codec não suportado ou vídeo inválido.`);
    const rotation = +(stream.side_data_list?.find(s => s.rotation != null)?.rotation || stream.tags?.rotate || 0);
    const swap = Math.abs(rotation) % 180 === 90;
    const rec = { ...base, type: 'video', blob, dur: mp4.duration,
      w: alpha ? (swap ? stream.height : stream.width) : mp4.width,
      h: alpha ? (swap ? stream.width : stream.height) : mp4.height,
      alphaLayout: alpha ? 'side-by-side' : null };
    const reader = await openMediaReader(rec);
    try {
      const frame = await reader.frameAt(0);
      if (!frame) throw new Error('O vídeo não contém frames legíveis.');
      rec.thumb = thumbOf(frame, frame.displayWidth, frame.displayHeight);
      return rec;
    } finally { reader.close(); }
  } finally {
    for (const name of [inName, probeName, outName]) { try { await ff.deleteFile(name); } catch {} }
  }
}

// Reconstrói RGBA sem remover cores da imagem. A máscara guarda também os níveis
// intermédios de opacidade (sombras e contornos suaves), sincronizados com a cor.
export class AlphaTrackReader {
  static async open(media) {
    const r = new AlphaTrackReader();
    r.video = await VideoTrackReader.open(media.blob);
    r.duration = r.video.duration;
    r.canvas = new OffscreenCanvas(media.w, media.h);
    r.mask = new OffscreenCanvas(media.w, media.h);
    r.ctx = r.canvas.getContext('2d', { willReadFrequently: true });
    r.mctx = r.mask.getContext('2d', { willReadFrequently: true });
    return r;
  }
  async frameAt(t) {
    const frame = await this.video.frameAt(t);
    if (!frame) return null;
    if (this.frame && this.timestamp === frame.timestamp) return this.frame;
    const { width: w, height: h } = this.canvas, half = frame.displayWidth / 2;
    this.ctx.drawImage(frame, 0, 0, w, h, 0, 0, w, h);
    this.mctx.drawImage(frame, half, 0, w, h, 0, 0, w, h);
    const color = this.ctx.getImageData(0, 0, w, h), alpha = this.mctx.getImageData(0, 0, w, h).data;
    for (let i = 0; i < color.data.length; i += 4) color.data[i + 3] = alpha[i];
    this.ctx.putImageData(color, 0, 0);
    this.frame?.close();
    this.frame = new VideoFrame(this.canvas, { timestamp: frame.timestamp });
    this.timestamp = frame.timestamp;
    return this.frame;
  }
  close() { this.frame?.close(); this.video?.close(); }
}

export const usesFrameReader = m => !!m?.alphaLayout || isGif(m);
export const openMediaReader = m => m.alphaLayout ? AlphaTrackReader.open(m) :
  isGif(m) ? GifTrackReader.open(m.blob, m.frameDurations) : VideoTrackReader.open(m.blob);

// GIFs mantêm transparência e duração de cada frame. Só o frame atual fica em memória.
export class GifTrackReader {
  static async open(blob, durations) {
    if (!globalThis.ImageDecoder) throw new Error('Este browser não consegue abrir GIFs animados. Atualiza o Chrome ou o Edge.');
    const r = new GifTrackReader();
    r.decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/gif', preferAnimation: true });
    try {
      await r.decoder.tracks.ready;
      const count = r.decoder.tracks.selectedTrack?.frameCount || 0;
      if (!count) throw new Error('O GIF não contém imagens.');
      r.durations = durations?.length === count && durations.every(d => Number.isFinite(d) && d > 0) ? durations : [];
      if (!r.durations.length) {
        for (let i = 0; i < count; i++) {
          const { image } = await r.decoder.decode({ frameIndex: i });
          r.durations.push(image.duration > 0 ? image.duration / 1e6 : .1);
          image.close();
        }
      }
      r.duration = r.durations.reduce((a, b) => a + b, 0);
      return r;
    } catch (e) { r.close(); throw e; }
  }
  async frameAt(t) {
    t = Math.max(0, t) % this.duration;
    let index = 0;
    while (index < this.durations.length - 1 && t >= this.durations[index] - 1e-6) t -= this.durations[index++];
    if (index !== this.index) {
      const { image } = await this.decoder.decode({ frameIndex: index });
      this.frame?.close(); this.frame = image; this.index = index;
    }
    return this.frame;
  }
  close() { this.frame?.close(); this.decoder?.close(); }
}

// Reconhece também GIFs importados em versões anteriores como imagens estáticas.
export const isGif = m => m?.type === 'gif' || m?.blob?.type === 'image/gif' || /\.gif$/i.test(m?.blob?.name || '');

// Lê um vídeo MP4 da biblioteca por ordem, para a exportação: frameAt(t) devolve o frame que
// está no ecrã no instante t. Se t voltar atrás (loop), recomeça do início.
export class VideoTrackReader {
  static async open(blob) {
    const r = new VideoTrackReader();
    const buf = await blob.arrayBuffer();
    r.mp4 = parseMp4(buf);
    r.u8 = new Uint8Array(buf);
    r.cfg = decoderConfig(r.mp4);
    r.duration = r.mp4.duration;
    if (!r.mp4.samples.length || !Number.isFinite(r.duration) || r.duration <= 0) throw new Error('Vídeo vazio ou inválido.');
    r.restart();
    return r;
  }

  restart(t = 0) {
    try { this.decoder?.close(); } catch {}
    this.cur?.close();
    for (const f of this.frames || []) f.close();
    this.frames = [];
    this.cur = null;
    this.next = 0;
    for (let i = 0; i < this.mp4.samples.length; i++) {
      const sample = this.mp4.samples[i];
      if (sample.key && sample.pts <= t) this.next = i;
    }
    this.flushed = false;
    this.flushing = false;
    this.err = null;
    this.lastT = null;
    this.decoder = new VideoDecoder({ output: (f) => this.frames.push(f), error: (e) => { this.err = e; } });
    this.decoder.configure(this.cfg);
  }

  async frameAt(t) {
    if (this.lastT != null && (t + 1e-6 < this.lastT || t - this.lastT > 1)) this.restart(t);
    this.lastT = t;
    const S = this.mp4.samples;
    const deadline = performance.now() + 10000;
    for (;;) {
      if (this.closed) throw new Error('Leitor de vídeo fechado.');
      if (performance.now() > deadline) throw new Error('O leitor de vídeo demorou demasiado a responder.');
      if (this.err) throw this.err;
      while (this.frames.length && this.frames[0].timestamp / 1e6 <= t + 1e-4) {
        this.cur?.close();
        this.cur = this.frames.shift();
      }
      if (this.frames.length) return this.cur || this.frames[0];            // o próximo já é futuro
      if (this.flushed) return this.cur;                                     // acabou o vídeo
      if (this.next < S.length) {
        if (this.decoder.decodeQueueSize < 6) {
          const s = S[this.next++];
          this.decoder.decode(new EncodedVideoChunk({
            type: s.key ? 'key' : 'delta', timestamp: Math.round(s.pts * 1e6), data: this.u8.subarray(s.offset, s.offset + s.size),
          }));
          continue;
        }
      } else if (!this.flushing) {
        // Continua a libertar frames enquanto flush decorre (o decoder tem um pool limitado).
        this.flushing = true;
        const decoder = this.decoder;
        decoder.flush().then(() => { if (this.decoder === decoder) this.flushed = true; },
          e => { if (this.decoder === decoder) this.err = e; });
      }
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  close() {
    this.closed = true;
    this.cur?.close();
    for (const f of this.frames) f.close();
    this.frames = [];
    try { this.decoder.close(); } catch {}
  }
}
