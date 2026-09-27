// Garante que handleClip nunca perde o clip gravado: se o ffmpeg falhar (ex.: "Aborted()"
// por falta de memória) tenta outra vez com um motor novo, e se falhar sempre entrega o
// clip tal como foi gravado em vez de desistir.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

function loadHandleClip(context) {
  const root = path.resolve(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'processor.js'), 'utf8');
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function handleClip('), source.indexOf('// Modo live:')), context);
  return context.handleClip;
}

test('uma falha isolada do ffmpeg recupera sozinha com um motor novo', async () => {
  const root = path.resolve(__dirname, '..');
  globalThis.self = { location: { href: pathToFileURL(path.join(root, 'lib/core/ffmpeg-core.js')).href } };
  const { default: createCore } = await import(self.location.href);
  const core = await createCore({ wasmBinary: fs.readFileSync(path.join(root, 'lib/core/ffmpeg-core.wasm')) });
  core.setLogger(() => {});
  let builds = 0;
  const delivered = [];
  const context = {
    Blob, Uint8Array, TextEncoder, TextDecoder, post() {},
    download: async (_id, blob, name, save, raw) => { delivered.push({ name, size: blob.size, raw }); },
    getFFmpeg: async () => {
      const brokenAttempt = builds === 0;
      builds++;
      return {
        on() {}, off() {}, terminate() {},
        writeFile: async (name, data) => core.FS.writeFile(name, data),
        readFile: async (name) => core.FS.readFile(name),
        deleteFile: async (name) => { try { core.FS.unlink(name); } catch {} },
        exec: async (args) => { if (brokenAttempt) return 69; core.reset(); return core.exec(...args); },
      };
    },
  };
  const handleClip = loadHandleClip(context);

  const code = core.exec('-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'libopus', '-f', 'matroska', '-y', 'rec.webm');
  assert.equal(code, 0);
  const blob = new Blob([core.FS.readFile('rec.webm')], { type: 'video/webm' });

  await handleClip({ id: 1, parts: [{ blob, outpoint: 8 }], h264: true, out: 'mp4', name: 'clip.webm', save: true });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].name, 'clip.mp4');
  assert.ok(!delivered[0].raw, 'devia ter conseguido converter, sem precisar do fallback em bruto');
  assert.ok(builds >= 2, 'devia ter recriado o motor ffmpeg depois da falha');
});

test('uma falha total do ffmpeg nunca perde o clip — entrega-o em bruto', async () => {
  const delivered = [];
  const context = {
    Blob, Uint8Array, TextEncoder, TextDecoder, post() {},
    download: async (_id, blob, name, save, raw) => { delivered.push({ name, size: blob.size, raw }); },
    getFFmpeg: async () => ({
      on() {}, off() {}, terminate() {},
      writeFile: async () => {}, readFile: async () => { throw new Error('sem ficheiro'); }, deleteFile: async () => {},
      exec: async () => { throw new Error('Aborted()'); },
    }),
  };
  const handleClip = loadHandleClip(context);
  const blob = new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'video/webm' });

  await assert.doesNotReject(handleClip({ id: 1, parts: [{ blob, outpoint: 8 }], h264: true, out: 'mp4', name: 'clip.webm', save: true }));
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].name, /_bruto\.webm$/);
  assert.equal(delivered[0].raw, true);
  assert.equal(delivered[0].size, 5, 'o clip em bruto entregue devia ser exatamente o que foi gravado');
});

test('vários segmentos, se a conversão falhar sempre, são entregues um a um em bruto', async () => {
  const delivered = [];
  const context = {
    Blob, Uint8Array, TextEncoder, TextDecoder, post() {},
    download: async (_id, blob, name, save, raw) => { delivered.push({ name, size: blob.size, raw }); },
    getFFmpeg: async () => ({
      on() {}, off() {}, terminate() {},
      writeFile: async () => {}, readFile: async () => { throw new Error('sem ficheiro'); }, deleteFile: async () => {},
      exec: async () => 69,
    }),
  };
  const handleClip = loadHandleClip(context);
  const parts = [
    { blob: new Blob([new Uint8Array([1, 1])], { type: 'video/webm' }), outpoint: 8 },
    { blob: new Blob([new Uint8Array([2, 2, 2])], { type: 'video/webm' }), outpoint: 4 },
  ];

  await handleClip({ id: 1, parts, h264: true, out: 'mp4', name: 'clip.webm', save: true });
  assert.equal(delivered.length, 2, 'cada segmento deve ser entregue à parte (concatenar bytes de WebM não dá um ficheiro válido)');
  assert.match(delivered[0].name, /_bruto_parte1\.webm$/);
  assert.match(delivered[1].name, /_bruto_parte2\.webm$/);
  assert.ok(delivered.every((d) => d.raw));
});
