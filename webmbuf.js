// Stream Clipper — leitura do WebM do MediaRecorder em streaming.
// O buffer grava com UM MediaRecorder contínuo (sem reiniciar o codificador de X em X segundos, o
// que dava saltos/pausas nas junções). Os bocados que o MediaRecorder entrega são lidos aqui:
// cabeçalho (EBML + Info + Tracks) e cada bloco (SimpleBlock) com o tempo absoluto e se é keyframe.
// Para fazer um clip, reconstrói-se um WebM válido a começar num keyframe de vídeo, com tempos
// a partir de 0 — contínuo, sem colar ficheiros de gravadores diferentes.
(() => {
  if (self.StreamClipperWebm) return;

  const ID = {
    EBML: 0x1A45DFA3, SEGMENT: 0x18538067, CLUSTER: 0x1F43B675, TIMECODE: 0xE7,
    SIMPLEBLOCK: 0xA3, BLOCKGROUP: 0xA0, BLOCK: 0xA1, REFBLOCK: 0xFB,
    INFO: 0x1549A966, TRACKS: 0x1654AE6B, TRACKENTRY: 0xAE, TRACKNUMBER: 0xD7, TRACKTYPE: 0x83,
    TIMECODESCALE: 0x2AD7B1,
  };
  // Filhos diretos do Segment: se aparecerem dentro de um Cluster de tamanho desconhecido, o
  // Cluster acabou.
  const SEGMENT_CHILDREN = new Set([ID.CLUSTER, 0x1C53BB6B, ID.INFO, ID.TRACKS, 0x114D9B74, 0x1254C367, 0x1941A469, 0x1043A770]);

  function readId(b, p, end) {
    if (p >= end) return null;
    const x = b[p];
    let len = 1, mask = 0x80;
    while (len <= 4 && !(x & mask)) { len++; mask >>= 1; }
    if (len > 4) throw new Error('WebM inválido (ID).');
    if (p + len > end) return null;
    let v = 0;
    for (let i = 0; i < len; i++) v = v * 256 + b[p + i];
    return { len, v };
  }

  function readSize(b, p, end) {
    if (p >= end) return null;
    const x = b[p];
    let len = 1, mask = 0x80;
    while (len <= 8 && !(x & mask)) { len++; mask >>= 1; }
    if (len > 8) throw new Error('WebM inválido (tamanho).');
    if (p + len > end) return null;
    let v = x & (mask - 1), allOnes = v === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + b[p + i]; if (b[p + i] !== 0xFF) allOnes = false; }
    return { len, v, unknown: allOnes };
  }

  const readUint = (b, p, n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[p + i]; return v; };

  // Lê os bocados pela ordem em que chegam. onBlock({t, track, video, key, data, tnLen}):
  // t em ms (TimecodeScale), data = conteúdo do SimpleBlock (cópia).
  function createParser(onBlock) {
    let buf = new Uint8Array(0), pos = 0, base = 0;   // base = offset absoluto de buf[0]
    let level = 0, clusterEnd = null, clusterTc = 0, scale = 1;
    const header = [];
    const tracks = { video: null, audio: null };
    const parser = { header, tracks, headerDone: false, push, blocks: 0 };

    function parseTracks(b, p, end) {
      while (p < end) {
        const id = readId(b, p, end), sz = id && readSize(b, p + id.len, end);
        if (!sz) return;
        const body = p + id.len + sz.len;
        if (id.v === ID.TRACKENTRY) {
          let q = body, num = null, type = null;
          const e = body + sz.v;
          while (q < e) {
            const cid = readId(b, q, e), cs = cid && readSize(b, q + cid.len, e);
            if (!cs) break;
            const cb = q + cid.len + cs.len;
            if (cid.v === ID.TRACKNUMBER) num = readUint(b, cb, cs.v);
            if (cid.v === ID.TRACKTYPE) type = readUint(b, cb, cs.v);
            q = cb + cs.v;
          }
          if (type === 1 && tracks.video == null) tracks.video = num;
          if (type === 2 && tracks.audio == null) tracks.audio = num;
        }
        p = body + sz.v;
      }
    }

    function parseInfo(b, p, end) {
      while (p < end) {
        const id = readId(b, p, end), sz = id && readSize(b, p + id.len, end);
        if (!sz) return;
        const body = p + id.len + sz.len;
        if (id.v === ID.TIMECODESCALE) scale = readUint(b, body, sz.v) / 1e6 || 1;
        p = body + sz.v;
      }
    }

    function emit(payload, key) {
      const tn = readSize(payload, 0, payload.length);
      if (!tn || payload.length < tn.len + 3) return;
      const rel = (payload[tn.len] << 24 >> 16) | payload[tn.len + 1];
      const data = payload.slice();
      if (key != null) data[tn.len + 2] = key ? (data[tn.len + 2] | 0x80) : (data[tn.len + 2] & 0x7F);
      const isKey = !!(data[tn.len + 2] & 0x80);
      const video = tracks.video != null ? tn.v === tracks.video : tn.v === 1;
      parser.blocks++;
      onBlock({ t: (clusterTc + rel) * scale, track: tn.v, video, key: isKey, data, tnLen: tn.len });
    }

    function push(chunk) {
      if (!chunk?.length) return;
      // Junta ao que sobrou do bocado anterior (só os bytes ainda não lidos).
      const rest = buf.subarray(pos);
      const next = new Uint8Array(rest.length + chunk.length);
      next.set(rest, 0); next.set(chunk, rest.length);
      base += pos; buf = next; pos = 0;
      const end = buf.length;
      for (;;) {
        if (level === 'cluster' && clusterEnd != null && base + pos >= clusterEnd) level = 'segment';
        const id = readId(buf, pos, end);
        if (!id) break;
        const sz = readSize(buf, pos + id.len, end);
        if (!sz) break;
        const hdr = id.len + sz.len, body = pos + hdr;
        if (level === 0) {
          if (id.v === ID.SEGMENT) {
            // Tamanho sempre "desconhecido" no WebM reconstruído (é assim que o Chrome o grava).
            header.push(new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]));
            pos = body; level = 'segment';
            continue;
          }
          if (sz.unknown) throw new Error('WebM inválido (elemento de topo sem tamanho).');
          if (body + sz.v > end) break;
          if (id.v === ID.EBML) header.push(buf.slice(pos, body + sz.v));
          pos = body + sz.v;
          continue;
        }
        if (id.v === ID.CLUSTER) {
          parser.headerDone = true;
          level = 'cluster'; clusterTc = 0;
          clusterEnd = sz.unknown ? null : base + body + sz.v;
          pos = body;
          continue;
        }
        if (level === 'cluster' && SEGMENT_CHILDREN.has(id.v)) { level = 'segment'; continue; }
        if (sz.unknown) { pos = body; continue; }   // mestre sem tamanho que não conhecemos: entra
        if (body + sz.v > end) break;
        if (level === 'segment') {
          if (!parser.headerDone && (id.v === ID.INFO || id.v === ID.TRACKS)) {
            header.push(buf.slice(pos, body + sz.v));
            if (id.v === ID.TRACKS) parseTracks(buf, body, body + sz.v);
            else parseInfo(buf, body, body + sz.v);
          }
        } else if (id.v === ID.TIMECODE) {
          clusterTc = readUint(buf, body, sz.v);
        } else if (id.v === ID.SIMPLEBLOCK) {
          emit(buf.subarray(body, body + sz.v), null);
        } else if (id.v === ID.BLOCKGROUP) {
          let q = body, block = null, ref = false;
          const e = body + sz.v;
          while (q < e) {
            const cid = readId(buf, q, e), cs = cid && readSize(buf, q + cid.len, e);
            if (!cs) break;
            const cb = q + cid.len + cs.len;
            if (cid.v === ID.BLOCK) block = buf.subarray(cb, cb + cs.v);
            if (cid.v === ID.REFBLOCK) ref = true;
            q = cb + cs.v;
          }
          if (block) emit(block, !ref);
        }
        pos = body + sz.v;
      }
    }
    return parser;
  }

  // Tamanho EBML de 8 bytes (serve para qualquer valor até 2^56 - 2).
  function size8(v) {
    const out = new Uint8Array(8);
    out[0] = 0x01;
    for (let i = 7; i >= 1; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
    return out;
  }
  const UNKNOWN = new Uint8Array([0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);
  const CLUSTER_ID = new Uint8Array([0x1F, 0x43, 0xB6, 0x75]);

  // Reconstrói um WebM com os blocos dados (o 1º tem de ser um keyframe de vídeo). Os tempos
  // passam a contar a partir de base (ms). Um Cluster novo em cada keyframe de vídeo (ou de 30 em
  // 30 s, por causa do limite de 16 bits do tempo relativo). Devolve um array de partes para Blob.
  function buildWebm(header, blocks, base) {
    const parts = [...header];
    let clusterStart = null;
    for (const b of blocks) {
      const t = Math.max(0, Math.round(b.t - base));
      if (clusterStart == null || (b.video && b.key) || t - clusterStart > 30000) {
        clusterStart = t;
        const tc = new Uint8Array(10);
        tc[0] = 0xE7; tc[1] = 0x88;
        let v = t;
        for (let i = 9; i >= 2; i--) { tc[i] = v % 256; v = Math.floor(v / 256); }
        parts.push(CLUSTER_ID, UNKNOWN, tc);
      }
      const data = b.data.slice();
      const rel = Math.max(-32768, Math.min(32767, t - clusterStart));
      data[b.tnLen] = (rel >> 8) & 0xFF;
      data[b.tnLen + 1] = rel & 0xFF;
      parts.push(new Uint8Array([0xA3]), size8(data.length), data);
    }
    return parts;
  }

  self.StreamClipperWebm = { createParser, buildWebm };
})();
