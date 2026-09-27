// Exercises the bundled ffmpeg engine with real H.264 and VP8 recordings.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

test('recorded H.264 and VP8 both become playable MP4s for the editor', async () => {
  const root = path.resolve(__dirname, '..');
  globalThis.self = { location: { href: pathToFileURL(path.join(root, 'lib/core/ffmpeg-core.js')).href } };
  const { default: createCore } = await import(self.location.href);
  const core = await createCore({ wasmBinary: fs.readFileSync(path.join(root, 'lib/core/ffmpeg-core.wasm')) });
  const logs = [];
  core.setLogger(({ message }) => logs.push(message));
  const exec = (...args) => { core.reset(); return core.exec(...args); };
  const { parseMp4 } = await import(pathToFileURL(path.join(root, 'mp4.js')).href);
  const source = fs.readFileSync(path.join(root, 'processor.js'), 'utf8');
  let delivered;
  const context = { Blob, Uint8Array, TextEncoder, post() {},
    download: async (_id, blob, name) => { delivered = { blob, name }; },
    getFFmpeg: async () => ({ on() {}, off() {},
      writeFile: async (name, data) => core.FS.writeFile(name, data),
      readFile: async name => core.FS.readFile(name),
      deleteFile: async name => core.FS.unlink(name),
      exec: async args => exec(...args),
    }),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function handleClip('), source.indexOf('// Modo live:')), context);
  for (const [codec, h264] of [['libx264', true], ['libvpx', false]]) {
    const code = exec('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '6', '-c:v', codec, '-c:a', 'libopus', '-f', 'matroska', '-y', 'recording.webm');
    assert.equal(code, 0, logs.slice(-10).join('\n'));
    const blob = new Blob([core.FS.readFile('recording.webm')], { type: 'video/webm' });
    await context.handleClip({ id: 1, parts: [{ blob, outpoint: 2 }], h264, out: 'mp4', name: 'clip.webm', save: false });
    assert.equal(delivered.blob.type, 'video/mp4');
    assert.equal(delivered.name, 'clip.mp4');
    const mp4 = parseMp4(await delivered.blob.arrayBuffer());
    assert.match(mp4.codec, /^avc1/);
    assert(mp4.samples.length >= 40);
    assert(mp4.duration >= 1.8 && mp4.duration < 2.5, `unexpected duration: ${mp4.duration}`);
    if (process.env.SC_TEST_FIXTURE && h264) {
      assert.equal(exec('-i', 'recording.webm', '-c:v', 'copy', '-c:a', 'aac', '-y', 'fixture.mp4'), 0);
      fs.writeFileSync(process.env.SC_TEST_FIXTURE, core.FS.readFile('fixture.mp4'));
    }
  }
});
