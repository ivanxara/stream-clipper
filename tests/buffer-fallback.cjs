const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const start = source.indexOf('  async function recordedJob(');
const end = source.indexOf('  // Canal da live', start);

function setup(segments, { paused = false, recovery = true } = {}) {
  let clock = 10000, rotations = 0;
  const context = {
    state: { stream: {}, mime: 'video/webm;codecs=h264,opus', enabled: true, video: { paused, readyState: 4 }, segments },
    render() {}, now: () => clock, sleep: async (ms) => { clock += ms; },
    isH264: () => true, makeFilename: (seconds, ext) => `${seconds}.${ext}`,
    waitDone: async (segment) => segment,
    startBuffer: async () => {},
    rotate: async () => {
      rotations++;
      if (recovery) context.state.segments.push({ start: 10000, end: clock, blob: new Blob(['frames']) });
    },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  return { context, job: () => context.recordedJob(15, 10000), rotations: () => rotations };
}

for (const seconds of [0.5, 2, 5]) test(`returns the available ${seconds}s even when 15s were requested`, async () => {
  const { job, rotations } = setup([{ start: 10000 - seconds * 1000, end: 10000, blob: new Blob(['frames']) }]);
  const result = await job();
  assert.equal(result.got, seconds);
  assert.equal(result.parts.length, 1);
  assert.equal(result.recovered, false);
  assert.equal(rotations(), 0);
});

test('an immediate click without earlier segments reaches frame recovery', async () => {
  const { job, rotations } = setup([]);
  const result = await job();
  assert.equal(result.recovered, true);
  assert.equal(result.got, 1.1);
  assert.equal(rotations(), 1);
});

test('empty segment also reaches recovery', async () => {
  const { job } = setup([{ start: 9500, end: 10000, blob: new Blob([]) }]);
  assert.equal((await job()).recovered, true);
});

test('paused playback still returns existing partial footage', async () => {
  const { job } = setup([{ start: 8000, end: 10000, blob: new Blob(['frames']) }], { paused: true });
  assert.equal((await job()).got, 2);
});

test('no footage and no new frames reports an actual capture error', async () => {
  await assert.rejects(setup([], { recovery: false }).job(), /não recebeu frames/);
  await assert.rejects(setup([], { paused: true }).job(), /não tem vídeo gravado/);
});

test('fallback keeps the clicked footage after the active buffer has been reset', async () => {
  const snapshot = [{ start: 8000, end: 14000, blob: new Blob(['frames']) }];
  const { context } = setup([]);
  context.state.stream = null;
  const result = await context.recordedJob(15, 10000, snapshot);
  assert.equal(result.got, 2);
  assert.equal(result.h264, true);
});

test('VP8 fallback is delivered as MP4 and requests transcoding', async () => {
  const { context, job } = setup([{ start: 8000, end: 10000, blob: new Blob(['frames']), mime: 'video/webm;codecs=vp8,opus' }]);
  context.state.mime = 'video/webm;codecs=vp8,opus';
  const result = await job();
  assert.equal(result.h264, false);
  assert.equal(result.out, 'mp4');
});

test('the reserve does not count empty recordings or extend past the last received data', () => {
  const { context } = setup([{ start: -130000, end: 10000, blob: new Blob([]) }]);
  context.KEEP_MS = 140000;
  const first = source.indexOf('  function bufferedSeconds()');
  vm.runInContext(source.slice(first, source.indexOf('  // ---------- criar o clip', first)), context);
  assert.equal(context.bufferedSeconds(), 0);
  context.state.segments.push({ start: 5000, dataAt: 7000, chunks: [new Blob(['frames'])] });
  assert.equal(context.bufferedSeconds(), 2);
});
