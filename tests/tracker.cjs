// Seguimento (tracker.js) com frames sintéticos: alvo com textura a mover-se sobre um fundo com
// zonas lisas da mesma cor (o caso que antes o fazia agarrar-se ao fundo).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const W = 320, H = 180;
function makeFrame(cx, cy, t) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const j = (y * W + x) * 4, bar = Math.floor(x / 46) % 3;          // barras lisas vermelha/verde/cinzenta
    rgba[j] = bar === 0 ? 200 : 90; rgba[j + 1] = bar === 1 ? 200 : 90; rgba[j + 2] = 90 + (y + t * 20) % 30; rgba[j + 3] = 255;
  }
  for (let y = -12; y < 12; y++) for (let x = -12; x < 12; x++) {     // alvo: vermelho com um "rosto" escuro
    const X = Math.round(cx) + x, Y = Math.round(cy) + y;
    if (X < 0 || X >= W || Y < 0 || Y >= H) continue;
    const j = (Y * W + X) * 4, eye = (Math.abs(x + 5) < 2 || Math.abs(x - 5) < 2) && Math.abs(y + 3) < 2, mouth = Math.abs(y - 6) < 2 && Math.abs(x) < 6;
    rgba[j] = eye || mouth ? 20 : 220; rgba[j + 1] = eye || mouth ? 20 : 60; rgba[j + 2] = eye || mouth ? 20 : 60;
  }
  return rgba;
}

test('segue um alvo com textura sem se agarrar a zonas lisas da mesma cor', async () => {
  const { createTracker, toPlanes, smoothPath, samplePath, LOST_SCORE } = await import(pathToFileURL(path.join(__dirname, '../tracker.js')).href);
  const pos = t => ({ x: 30 + 250 * t / 8 + 10 * Math.sin(t * 2), y: 90 + 50 * Math.sin(t * 0.8) });
  let p = pos(0);
  const tracker = createTracker(toPlanes(makeFrame(p.x, p.y, 0), W, H), W, H, { x: p.x - 12, y: p.y - 12, w: 24, h: 24 });
  let maxErr = 0, minScore = 1;
  const pts = [];
  for (let i = 1; i <= 240; i++) {
    const t = i / 30;
    p = pos(t);
    const r = tracker.track(toPlanes(makeFrame(p.x, p.y, t), W, H));
    maxErr = Math.max(maxErr, Math.hypot(r.cx - p.x, r.cy - p.y));
    minScore = Math.min(minScore, r.score);
    pts.push({ t, x: r.cx / W, y: r.cy / H });
  }
  assert(maxErr < 3, `erro máximo ${maxErr.toFixed(2)} px`);
  assert(minScore >= LOST_SCORE, `confiança mínima ${minScore.toFixed(2)}`);
  const keys = samplePath(smoothPath(pts), 0.4);
  assert.equal(keys.length, Math.ceil((8 - 1 / 30) / 0.4) + 1, 'uma posição de 0,4 em 0,4 s, com o fim');
  assert(keys.every((k, i) => i === 0 || k.t > keys[i - 1].t));
});

test('um alvo que desaparece dá confiança baixa (o editor pára em vez de seguir outra coisa)', async () => {
  const { createTracker, toPlanes, LOST_SCORE } = await import(pathToFileURL(path.join(__dirname, '../tracker.js')).href);
  const tracker = createTracker(toPlanes(makeFrame(100, 90, 0), W, H), W, H, { x: 88, y: 78, w: 24, h: 24 });
  const r = tracker.track(toPlanes(makeFrame(-100, -100, 0.1), W, H));   // o alvo saiu do ecrã
  assert(r.score < LOST_SCORE, `confiança ${r.score.toFixed(2)}`);
});
