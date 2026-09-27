const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const uuid = '5c697a87-afce-4256-b01f-3c8fe71ef5cb';
const playlist = '#EXTM3U\n' + Array.from({ length: 10 }, (_, i) => `#EXTINF:10,\n${i}.ts\n`).join('') + '#EXT-X-ENDLIST';

function harness(site, pathname, unavailable = false) {
  const requests = [];
  const context = {
    URL, URLSearchParams, Blob, AbortController, setTimeout, clearTimeout,
    location: { hostname: site === 'tw' ? 'www.twitch.tv' : 'kick.com', pathname, origin: 'https://kick.com' },
    fetch: async (url, opts) => {
      requests.push(String(url));
      let data;
      if (String(url).includes('gql.twitch.tv')) {
        const body = JSON.parse(opts.body);
        assert.equal(body.variables.id, '12345');
        assert.ok(!body.query.includes('streamPlaybackAccessToken'));
        data = { data: { videoPlaybackAccessToken: { value: 'token', signature: 'sig' } } };
      } else if (String(url).startsWith('/api/v1/video/')) {
        assert.equal(url, `/api/v1/video/${uuid}`);
        data = unavailable ? {} : { source: 'https://cdn.test/master.m3u8' };
      } else if (String(url).includes('usher.ttvnw.net') || String(url).endsWith('master.m3u8')) {
        data = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\nhttps://cdn.test/high/index.m3u8';
      } else if (String(url).endsWith('index.m3u8')) data = playlist;
      else if (/https:\/\/cdn.test\/high\/\d+\.ts$/.test(url)) data = new Uint8Array([1, 2, 3]).buffer;
      else throw new Error(`Unexpected request: ${url}`);
      return { ok: true, json: async () => data, text: async () => data, arrayBuffer: async () => data };
    },
  };
  context.self = context;
  vm.runInNewContext(source, context);
  return { server: context.StreamClipperServer, requests, context };
}

for (const [site, pathname] of [['tw', '/videos/12345'], ['ki', `/someone/videos/${uuid}`], ['ki', `/video/${uuid}`]]) {
  test(`${site} ${pathname}: clips at the player's position, not the end of the archive`, async () => {
    const { server, requests } = harness(site, pathname);
    assert.equal(server.available(), true);
    assert.match(server.label(), /Modo VOD/);
    const video = { currentTime: 47, seeking: false, paused: true };
    const jobPromise = server.clip(15, { video, onProgress() { video.currentTime = 90; } });
    const job = await jobPromise;
    assert.equal(job.from, 2); assert.equal(job.to, 17); assert.equal(job.abs, false);
    assert.deepEqual(requests.filter((u) => u.endsWith('.ts')), ['https://cdn.test/high/3.ts', 'https://cdn.test/high/4.ts']);
    assert.equal(job.inputs[0].blob.size, 6);
  });
  test(`${site} ${pathname}: clips at the start and rejects an unsettled player`, async () => {
    const { server } = harness(site, pathname);
    const job = await server.clip(30, { video: { currentTime: 2 }, onProgress() {} });
    assert.equal(job.from, 0); assert.equal(job.to, 2);
    for (const video of [null, { currentTime: 0 }, { currentTime: NaN }, { currentTime: 50, seeking: true }]) {
      await assert.rejects(server.clip(15, { video, onProgress() {} }));
    }
  });
}

test('Kick unavailable archive rejects for recording fallback', async () => {
  const { server } = harness('ki', `/someone/videos/${uuid}`, true);
  await assert.rejects(server.clip(15, { video: { currentTime: 47 }, onProgress() {} }), /indisponível/);
});

test('navigation updates VOD/live modes without treating a video listing as a live', () => {
  for (const site of ['tw', 'ki']) {
    const { server, context } = harness(site, '/someone');
    assert.equal(server.available(), true); assert.match(server.label(), /Modo live/);
    context.location.pathname = site === 'tw' ? '/videos/12345' : `/someone/videos/${uuid}`;
    assert.equal(server.available(), true); assert.match(server.label(), /Modo VOD/);
    context.location.pathname = '/someone/videos';
    assert.equal(server.available(), false);
  }
});
