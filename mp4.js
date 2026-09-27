// Leitor mínimo de MP4 (não fragmentado, como os que o ffmpeg escreve) para o editor:
// devolve a pista de vídeo com as amostras (posição no ficheiro, tempos, keyframes)
// e a configuração para o VideoDecoder do WebCodecs.

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

function child(u8, box, type) {
  for (const b of boxes(u8, box.body, box.end)) if (b.type === type) return b;
  return null;
}

function path(u8, box, types) {
  let b = box;
  for (const t of types) { b = b && child(u8, b, t); }
  return b;
}

const hex = (n) => n.toString(16).padStart(2, '0');

export function parseMp4(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let moov = null;
  for (const b of boxes(u8)) if (b.type === 'moov') moov = b;
  if (!moov) throw new Error('MP4 sem índice (moov).');
  const mvhd = child(u8, moov, 'mvhd');
  const movieScale = mvhd ? (u8[mvhd.body] === 1 ? dv.getUint32(mvhd.body + 20) : dv.getUint32(mvhd.body + 12)) : 1000;

  const tracks = [];
  for (const trak of boxes(u8, moov.body, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(u8, trak, 'mdia');
    const hdlr = child(u8, mdia, 'hdlr');
    const handler = String.fromCharCode(...u8.subarray(hdlr.body + 8, hdlr.body + 12));
    const mdhd = child(u8, mdia, 'mdhd');
    const scale = u8[mdhd.body] === 1 ? dv.getUint32(mdhd.body + 20) : dv.getUint32(mdhd.body + 12);
    tracks.push({ trak, mdia, handler, scale });
  }
  const vt = tracks.find((t) => t.handler === 'vide');
  if (!vt) throw new Error('O MP4 não tem vídeo.');
  const { trak, mdia, scale } = vt;
  const stbl = path(u8, mdia, ['minf', 'stbl']);

  // --- descrição do codec ---
  const stsd = child(u8, stbl, 'stsd');
  const entry = boxes(u8, stsd.body + 8, stsd.end).next().value;
  const width = dv.getUint16(entry.body + 24), height = dv.getUint16(entry.body + 26);
  let codec = null, description = null;
  for (const b of boxes(u8, entry.body + 78, entry.end)) {
    if (b.type === 'avcC') {
      description = u8.slice(b.body, b.end);
      codec = `${entry.type}.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
    } else if (b.type === 'hvcC') {
      description = u8.slice(b.body, b.end);
      codec = 'hvc1.1.6.L93.B0';   // aproximado; o decoder usa a description
    }
  }
  if (!codec) throw new Error('Codec de vídeo não suportado no editor (' + entry.type + ').');

  // --- tabelas de amostras ---
  const read = (type) => child(u8, stbl, type);
  const stsz = read('stsz');
  const fixed = dv.getUint32(stsz.body + 4), count = dv.getUint32(stsz.body + 8);
  const sizes = new Uint32Array(count);
  for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.body + 12 + i * 4);

  const stco = read('stco'), co64 = read('co64');
  const chunkOffsets = [];
  if (stco) { const n = dv.getUint32(stco.body + 4); for (let i = 0; i < n; i++) chunkOffsets.push(dv.getUint32(stco.body + 8 + i * 4)); }
  else { const n = dv.getUint32(co64.body + 4); for (let i = 0; i < n; i++) chunkOffsets.push(Number(dv.getBigUint64(co64.body + 8 + i * 8))); }

  const stsc = read('stsc');
  const stscN = dv.getUint32(stsc.body + 4);
  const stscE = [];
  for (let i = 0; i < stscN; i++) stscE.push([dv.getUint32(stsc.body + 8 + i * 12), dv.getUint32(stsc.body + 12 + i * 12)]);

  const offsets = new Float64Array(count);
  let s = 0;
  for (let c = 0; c < chunkOffsets.length && s < count; c++) {
    let per = 0;
    for (const [first, n] of stscE) if (c + 1 >= first) per = n;
    let off = chunkOffsets[c];
    for (let k = 0; k < per && s < count; k++, s++) { offsets[s] = off; off += sizes[s]; }
  }

  const dts = new Float64Array(count);
  const stts = read('stts');
  { let i = 0, t = 0; const n = dv.getUint32(stts.body + 4);
    for (let e = 0; e < n; e++) {
      const c = dv.getUint32(stts.body + 8 + e * 8), d = dv.getUint32(stts.body + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) { dts[i] = t; t += d; }
    } }
  const cts = new Float64Array(count);
  const ctts = read('ctts');
  if (ctts) {
    const v1 = u8[ctts.body] === 1, n = dv.getUint32(ctts.body + 4);
    let i = 0;
    for (let e = 0; e < n; e++) {
      const c = dv.getUint32(ctts.body + 8 + e * 8);
      const o = v1 ? dv.getInt32(ctts.body + 12 + e * 8) : dv.getUint32(ctts.body + 12 + e * 8);
      for (let k = 0; k < c && i < count; k++, i++) cts[i] = o;
    }
  }
  const stss = read('stss');
  const key = new Uint8Array(count);
  if (stss) { const n = dv.getUint32(stss.body + 4); for (let i = 0; i < n; i++) key[dv.getUint32(stss.body + 8 + i * 4) - 1] = 1; }
  else key.fill(1);

  // Edit list: o ffmpeg desloca o início (B-frames / -avoid_negative_ts).
  let shift = 0, delay = 0;
  const elst = path(u8, trak, ['edts', 'elst']);
  if (elst) {
    const v1 = u8[elst.body] === 1, n = dv.getUint32(elst.body + 4), sz = v1 ? 20 : 12;
    for (let e = 0; e < n; e++) {
      const p = elst.body + 8 + e * sz;
      const segDur = v1 ? Number(dv.getBigUint64(p)) : dv.getUint32(p);
      const mediaTime = v1 ? Number(dv.getBigInt64(p + 8)) : dv.getInt32(p + 4);
      if (mediaTime === -1) delay += segDur / movieScale;
      else { shift = mediaTime; break; }
    }
  }

  const samples = new Array(count);
  let last = 0;
  for (let i = 0; i < count; i++) {
    const pts = (dts[i] + cts[i] - shift) / scale + delay;
    samples[i] = { offset: offsets[i], size: sizes[i], pts, dts: dts[i] / scale, key: !!key[i] };
    if (pts > last) last = pts;
  }
  const duration = count > 1 ? last + (dts[count - 1] - dts[count - 2]) / scale : last;
  const fps = count > 1 ? count / duration : 30;
  return { codec, description, width, height, samples, duration, fps, hasAudio: tracks.some((t) => t.handler === 'soun') };
}
