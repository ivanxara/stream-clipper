// Buffer contínuo (content.js + webmbuf.js) sem browser: runs sintéticas com blocos WebM.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const webmSource = fs.readFileSync(path.join(__dirname, '../webmbuf.js'), 'utf8');
const between = (from, to) => {
  const a = source.indexOf(from), b = source.indexOf(to, a + 1);
  assert(a >= 0 && b > a, `não encontrei ${from}`);
  return source.slice(a, b);
};

// Cabeçalho mínimo: EBML + Segment (tamanho desconhecido) + Tracks (1 = vídeo, 2 = áudio).
const HEADER = [
  Uint8Array.of(0x1A, 0x45, 0xDF, 0xA3, 0x84, 0x42, 0x86, 0x81, 0x01),
  Uint8Array.of(0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF),
  Uint8Array.of(0x16, 0x54, 0xAE, 0x6B, 0x90, 0xAE, 0x86, 0xD7, 0x81, 0x01, 0x83, 0x81, 0x01, 0xAE, 0x86, 0xD7, 0x81, 0x02, 0x83, 0x81, 0x02),
];

// Run sintética: vídeo a 30 fps com keyframe de 1 em 1 s, áudio de 20 em 20 ms, de t0 a t1 (ms).
// wall = t + offset. Faixa 1 = vídeo, 2 = áudio (tnLen 1).
function makeRun({ t0 = 0, t1 = 10000, offset = 0, mime = 'video/webm;codecs=h264,opus', keyEvery = 1000 } = {}) {
  const blocks = [];
  const block = (track, t, key) => ({ t, track, video: track === 1, key, tnLen: 1, data: new Uint8Array([0x80 | track, 0, 0, key ? 0x80 : 0, 1, 2, 3]) });
  let v = t0, a = t0, frame = 0;
  while (v <= t1 || a <= t1) {
    if (v <= a) { blocks.push(block(1, v, frame % Math.round(keyEvery * 30 / 1000) === 0)); frame++; v = t0 + frame * 1000 / 30; } else { blocks.push(block(2, a, true)); a += 20; }
  }
  const video = blocks.filter((b) => b.video);
  return {
    mime, blocks, header: HEADER, offset, rec: { state: 'inactive' }, queue: Promise.resolve(),
    firstKeyT: video[0].t, lastT: video.at(-1).t, lastKeyT: video.filter((b) => b.key).at(-1).t, startedAt: offset, endWall: null,
    width: 1280, height: 720,
  };
}

function setup(runs = [], { paused = false, recoveryRun = null } = {}) {
  let clock = 20000;
  const context = {
    Blob, Uint8Array, Promise, Math, Number, Infinity, setTimeout,
    KEEP_MS: 140000,
    state: { stream: {}, mime: 'video/webm;codecs=h264,opus', enabled: true, video: { paused, readyState: 4 }, runs, lastDataAt: clock },
    render() {}, now: () => clock, sleep: async (ms) => { clock += ms; },
    makeFilename: (seconds, ext) => `${seconds}.${ext}`,
    startBuffer: async () => {},
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(webmSource, context);
  context.Webm = context.StreamClipperWebm;
  vm.runInContext(between('  const runOffset =', '  function stopRun('), context);
  vm.runInContext(between('  function runSpan(', '  // ---------- criar o clip'), context);
  vm.runInContext(between('  async function recordedJob(', '  // Canal da live'), context);
  const origSleep = context.sleep;
  context.sleep = async (ms) => { await origSleep(ms); if (recoveryRun && !context.state.runs.includes(recoveryRun)) context.state.runs.push(recoveryRun); };
  return { context, clock: () => clock, job: (seconds = 15, at = clock) => context.recordedJob(seconds, at, context.state.runs.slice()) };
}

async function readBack(part) {
  const context = {};
  context.self = context;
  vm.createContext(context);
  vm.runInContext(webmSource, context);
  const blocks = [];
  const parser = context.StreamClipperWebm.createParser((b) => blocks.push(b));
  const bytes = new Uint8Array(await part.blob.arrayBuffer());
  for (let i = 0; i < bytes.length; i += 7) parser.push(bytes.subarray(i, i + 7));   // bocados partidos a meio
  return blocks;
}

for (const seconds of [0.5, 2, 5]) test(`devolve os ${seconds}s que há mesmo quando se pedem 15s`, async () => {
  const run = makeRun({ t0: 0, t1: seconds * 1000, offset: 20000 - seconds * 1000 });
  const { job } = setup([run]);
  const result = await job();
  assert(Math.abs(result.got - seconds) < 0.05, `got ${result.got}`);
  assert.equal(result.parts.length, 1);
  assert.equal(result.recovered, false);
});

test('o clip começa no keyframe anterior ao início pedido e fica contínuo', async () => {
  const run = makeRun({ t0: 0, t1: 30000, offset: -10000 });   // wall 20000 = t 30000
  const { job } = setup([run]);
  const result = await job(3.5);
  assert.equal(result.parts.length, 1);
  assert(result.got >= 3.5 && result.got < 4.6, `got ${result.got}`);
  const blocks = await readBack(result.parts[0]);
  const video = blocks.filter((b) => b.track === 1);
  assert.equal(video[0].key, true, 'o 1º frame é um keyframe');
  assert.equal(Math.round(video[0].t), 0, 'os tempos recomeçam no 0');
  assert(blocks.every((b) => b.t >= 0), 'nenhum bloco antes do keyframe');
  for (let i = 1; i < video.length; i++) assert(video[i].t - video[i - 1].t < 40, `salto aos ${video[i - 1].t}ms`);
  assert(Math.abs(video.at(-1).t / 1000 - result.got) < 0.05);
  assert(blocks.some((b) => b.track === 2), 'o áudio vem junto');
});

test('um clip que atravessa uma troca de run dá duas partes seguidas', async () => {
  const a = makeRun({ t0: 0, t1: 12000, offset: 0 });
  const b = makeRun({ t0: 0, t1: 8000, offset: 12000 });
  a.endWall = 12000;
  const { job } = setup([a, b]);
  const result = await job(15);
  assert.equal(result.parts.length, 2);
  assert(Math.abs(result.parts[1].outpoint - 8) < 0.05);
  assert(result.got >= 15 && result.got < 16.1, `got ${result.got}`);
});

test('um clique imediato sem vídeo gravado recupera o que chega depois', async () => {
  const { job } = setup([], { recoveryRun: makeRun({ t0: 0, t1: 2500, offset: 20000 }) });
  const result = await job();
  assert.equal(result.recovered, true);
  assert(result.got > 2);
});

test('pausado mas com vídeo no buffer continua a devolver o que há', async () => {
  const { job } = setup([makeRun({ t0: 0, t1: 2000, offset: 18000 })], { paused: true });
  assert(Math.abs((await job()).got - 2) < 0.05);
});

test('sem vídeo e sem frames novos dá um erro claro', async () => {
  await assert.rejects(setup([]).job(), /não recebeu frames/);
  await assert.rejects(setup([], { paused: true }).job(), /não tem vídeo gravado/);
});

test('as runs guardadas no clique continuam válidas depois de o buffer ser reiniciado', async () => {
  const snapshot = [makeRun({ t0: 0, t1: 6000, offset: 14000 })];
  const { context } = setup([]);
  context.state.stream = null;
  const result = await context.recordedJob(15, 20000, snapshot);
  assert(Math.abs(result.got - 6) < 0.05);
  assert.equal(result.h264, true);
});

test('VP8 vai para MP4 e pede recodificação', async () => {
  const { job } = setup([makeRun({ t1: 2000, offset: 18000, mime: 'video/webm;codecs=vp8,opus' })]);
  const result = await job();
  assert.equal(result.h264, false);
  assert.equal(result.out, 'mp4');
});

test('a reserva não conta runs sem blocos nem passa do último dado recebido', () => {
  const { context } = setup([]);
  const empty = makeRun({ t1: 1000 });
  empty.blocks = []; empty.lastT = null;
  context.state.runs = [empty];
  assert.equal(context.bufferedSeconds(), 0);
  context.state.runs.push(makeRun({ t0: 0, t1: 2000, offset: 18000 }));
  assert(Math.abs(context.bufferedSeconds() - 2) < 0.05);
});

test('o parser lê clusters de tamanho conhecido e BlockGroups, e reconstrói um WebM equivalente', async () => {
  const context = {};
  context.self = context;
  vm.createContext(context);
  vm.runInContext(webmSource, context);
  const W = context.StreamClipperWebm;
  const el = (id, body) => { const size = body.length; const out = [...id, 0x01, 0, 0, 0, 0, 0, (size >> 8) & 255, size & 255]; return Uint8Array.from([...out, ...body]); };
  const u = (n) => [n >> 8 & 255, n & 255];
  const trackEntry = (num, type) => [...el([0xAE], [...el([0xD7], [num]), ...el([0x83], [type])])];
  const tracks = el([0x16, 0x54, 0xAE, 0x6B], [...trackEntry(1, 2), ...trackEntry(2, 1)]);   // áudio = 1, vídeo = 2
  const simple = (track, rel, key) => [...el([0xA3], [0x80 | track, ...u(rel), key ? 0x80 : 0, 9, 9])];
  const group = (track, rel, ref) => [...el([0xA0], [...el([0xA1], [0x80 | track, ...u(rel), 0, 7]), ...(ref ? el([0xFB], [1]) : [])])];
  const cluster = (tc, children) => el([0x1F, 0x43, 0xB6, 0x75], [...el([0xE7], u(tc)), ...children]);
  const file = Uint8Array.from([
    ...el([0x1A, 0x45, 0xDF, 0xA3], [0x42, 0x86, 0x81, 0x01]),
    0x18, 0x53, 0x80, 0x67, 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    ...tracks,
    ...cluster(1000, [...simple(1, 0, true), ...group(2, 0, false), ...group(2, 33, true)]),
    ...cluster(2000, [...simple(2, 0, true), ...simple(1, 10, true)]),
  ]);
  const got = [];
  const parser = W.createParser((b) => got.push(b));
  for (const byte of file) parser.push(Uint8Array.of(byte));   // byte a byte
  assert.equal(parser.tracks.video, 2);
  assert.equal(parser.tracks.audio, 1);
  assert.deepEqual(got.map((b) => [b.t, b.track, b.video, b.key]), [[1000, 1, false, true], [1000, 2, true, true], [1033, 2, true, false], [2000, 2, true, true], [2010, 1, false, true]]);
  const rebuilt = [];
  const again = W.createParser((b) => rebuilt.push(b));
  const parts = W.buildWebm(parser.header, got.slice(1), 1000);
  again.push(new Uint8Array(await new Blob(parts).arrayBuffer()));
  assert.equal(again.tracks.video, 2);
  assert.deepEqual(rebuilt.map((b) => [b.t, b.track, b.key]), [[0, 2, true], [33, 2, false], [1000, 2, true], [1010, 1, true]]);
});
