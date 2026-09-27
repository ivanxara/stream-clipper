// Run after processor-buffer.cjs creates SC_TEST_FIXTURE; requires Playwright.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const fixture = process.env.SC_TEST_FIXTURE || process.argv[2];
  if (!fixture) throw new Error('Set SC_TEST_FIXTURE to the generated test MP4.');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<video width="640" height="360" src="/fixture.mp4" autoplay muted loop></video>'); return; }
    const file = pathname === '/fixture.mp4' ? fixture : path.resolve(root, '.' + pathname);
    if (pathname !== '/fixture.mp4' && !file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    res.setHeader('Content-Type', { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.mp4': 'video/mp4', '.wasm': 'application/wasm' }[path.extname(file)] || 'application/octet-stream');
    fs.readFile(file, (error, data) => { res.statusCode = error ? 404 : 200; res.end(error ? '' : data); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
      window.chrome = { runtime: { getURL: name => new URL(name, location.origin + '/').href },
        storage: { local: { get: (_keys, cb) => cb({ enabled: true }), set() {} }, onChanged: { addListener() {} } } };
    });
    const page = await context.newPage();
    const errors = [];
    context.on('page', p => p.on('pageerror', e => errors.push(e.message)));
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    await page.evaluate(() => {
      // Simulate the reported network failure and a codec that claims support but emits nothing.
      window.StreamClipperServer = { available: () => true, refresh() {}, label: () => 'Modo vídeo (teste)', clip: async () => { throw new Error('Falha de rede simulada'); } };
      const NativeRecorder = MediaRecorder;
      window.MediaRecorder = class extends NativeRecorder {
        constructor(stream, options) {
          if (!/h264|avc1/.test(options.mimeType)) { super(stream, options); return; }
          return { state: 'inactive', start() { this.state = 'recording'; setTimeout(() => this.onstart?.(), 0); },
            stop() { this.state = 'inactive'; setTimeout(() => this.onstop?.(), 0); } };
        }
      };
    });
    const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8').replace(/\}\)\(\);\s*$/, 'window.__capture = { state, tick, bufferedSeconds }; })();');
    await page.addScriptTag({ content });
    await page.waitForFunction(() => window.__capture?.state.current);
    assert.equal(await page.evaluate(() => __capture.bufferedSeconds()), 0, 'empty recorder must not report a reserve');
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => { __capture.state.lastDataAt = -20000; __capture.state.retryAt = 0; __capture.tick(); });
      await page.waitForFunction(() => __capture.state.current);
    }
    await page.waitForFunction(() => __capture.bufferedSeconds() >= 1, { timeout: 15000 });
    assert.match(await page.evaluate(() => __capture.state.mime), /vp8/);
    const beforeSeek = await page.evaluate(() => __capture.state.segments.map(segment => segment.start));
    await page.evaluate(async () => {
      const video = document.querySelector('video');
      const target = video.currentTime < video.duration / 2 ? video.duration * 0.75 : video.duration * 0.25;
      const seeked = new Promise(resolve => video.addEventListener('seeked', resolve, { once: true }));
      video.currentTime = target;
      await seeked;
    });
    assert.equal(await page.evaluate((previous) => __capture.state.segments.some(segment => previous.includes(segment.start)), beforeSeek), false,
      'the capture buffer must not retain segments from before the seek');
    await page.waitForFunction(() => __capture.bufferedSeconds() >= 1, { timeout: 15000 });
    const popupPromise = page.waitForEvent('popup');
    await page.click('.sc-clip[data-s="15"]');
    const editor = await popupPromise;
    await editor.waitForFunction(() => window.__editor?.st.mp4?.samples.length > 0, { timeout: 60000 });
    const clip = await editor.evaluate(() => ({ codec: __editor.st.mp4.codec, duration: __editor.st.dur, status: document.querySelector('#status').textContent }));
    assert.match(clip.codec, /^avc1/);
    assert(clip.duration > 0);
    assert.equal(await editor.locator('#export').isEnabled(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: empty H.264 capture → automatic VP8 recovery → network failure → real ffmpeg → playable editor MP4', clip);
  } finally { await browser.close(); await new Promise(r => server.close(r)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
