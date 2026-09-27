const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');

function index(version = 0) {
  const bytes = Buffer.alloc(32 + (version ? 8 : 0) + 12 * 6);
  bytes.writeUInt32BE(bytes.length, 0); bytes.write('sidx', 4);
  bytes[8] = version; bytes.writeUInt32BE(1000, 16);
  const countOffset = version ? 38 : 30;
  bytes.writeUInt16BE(6, countOffset);
  for (let i = 0; i < 6; i++) {
    const p = countOffset + 2 + i * 12;
    bytes.writeUInt32BE(10, p); bytes.writeUInt32BE(5000, p + 4);
  }
  return bytes;
}

function harness({ version = 0, time = 23, missingIndex = false, short = false, forbidden = false } = {}) {
  const sidx = index(version), requests = [], listeners = new Set();
  const context = {
    URL, Blob, AbortController, setTimeout, clearTimeout,
    location: { hostname: 'www.youtube.com', pathname: '/watch', origin: 'https://www.youtube.com' },
    addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn),
    postMessage: (m) => queueMicrotask(() => {
      for (const fn of listeners) fn({ source: vm.runInContext('window', context), data: { __scYT: 'a', id: m.id, ok: true, vid: 'test', isLive: false, t: time } });
    }),
    fetch: async (url) => {
      if (url.startsWith('/youtubei')) return { ok: true, json: async () => ({ playabilityStatus: { status: 'OK' }, streamingData: {
        adaptiveFormats: ['video', 'audio'].map((kind) => ({
          url: `https://media.test/${kind}`, mimeType: kind === 'video' ? 'video/mp4; codecs="avc1"' : 'audio/mp4',
          height: kind === 'video' ? 1080 : undefined, itag: kind === 'audio' ? 140 : 137,
          initRange: { start: '0', end: '7' },
          indexRange: missingIndex ? undefined : { start: '8', end: String(7 + sidx.length) },
        })),
      } }) };
      const u = new URL(url), range = u.searchParams.get('range');
      requests.push({ track: u.pathname, range });
      const [start, end] = range.split('-').map(Number);
      if (forbidden && start > 8) return { ok: false, status: 403 };
      const data = start === 8 ? sidx : Buffer.alloc(end - start + 1 - (short ? 1 : 0));
      return { ok: true, headers: { get: () => null }, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) };
    },
  };
  context.self = context; context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { server: context.StreamClipperServer, requests, sidx };
}

for (const version of [0, 1]) test(`VOD SIDX v${version}: downloads only selected fragments with absolute timestamps`, async () => {
  const { server, requests, sidx } = harness({ version });
  await server.refresh();
  assert.equal(server.available(), true);
  assert.equal(server.label(), 'Modo vídeo (YouTube)');
  const result = await server.clip(7, { onProgress() {} });
  assert.equal(result.from, 16); assert.equal(result.to, 23); assert.equal(result.abs, true);
  assert.equal(result.inputs.length, 2);
  assert.equal(result.inputs[0].blob.size, 38);
  const base = 8 + sidx.length;
  const videoRanges = requests.filter((r) => r.track === '/video').map((r) => r.range);
  assert.deepEqual(videoRanges, [`8-${7 + sidx.length}`, '0-7', `${base + 20}-${base + 29}`, `${base + 30}-${base + 39}`, `${base + 40}-${base + 49}`]);
});

test('clips near the start are clamped to zero', async () => {
  const { server } = harness({ time: 3 });
  const result = await server.clip(30, { onProgress() {} });
  assert.equal(result.from, 0); assert.equal(result.to, 3);
  assert.equal(result.inputs[0].blob.size, 18);
});

test('unsupported and incomplete media reject for the recording fallback', async () => {
  for (const options of [{ missingIndex: true }, { short: true }, { time: 40 }, { time: 0 }]) {
    const { server } = harness(options);
    await assert.rejects(server.clip(7, { onProgress() {} }));
  }
});

test('an immediate click can use direct mode before the first refresh', () => {
  const { server } = harness();
  assert.equal(server.available(), true);
});

test('a readable index does not imply downloadable media: report segment HTTP 403', async () => {
  const { server } = harness({ forbidden: true });
  await assert.rejects(server.clip(7, { onProgress() {} }), /YouTube recusou.*HTTP 403/);
});

test('finished broadcasts are classified as videos', () => {
  let listener, response;
  const context = { document: { getElementById: () => ({
    getVideoData: () => ({ video_id: 'archive', isLive: true }),
    getPlayerResponse: () => ({ microformat: { playerMicroformatRenderer: { liveBroadcastDetails: { endTimestamp: '2026-01-01', isLiveNow: false } } } }),
    getCurrentTime: () => 90, classList: { contains: () => false },
  }) }, location: { origin: 'https://www.youtube.com' }, addEventListener: (_, fn) => { listener = fn; }, postMessage: (m) => { response = m; } };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../yt-main.js'), 'utf8'), context);
  listener({ source: vm.runInContext('window', context), data: { __scYT: 'q', id: 'test' } });
  assert.equal(response.isLive, false); assert.equal(response.t, 90);
});
