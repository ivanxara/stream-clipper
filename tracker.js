// Seguimento de um alvo (cabeça, objeto…) no vídeo, sem IA: procura, frame a frame, a zona que
// mais se parece com a que foi marcada (correlação normalizada — NCC — numa janela à volta da
// posição anterior). Trabalha numa versão pequena de cada frame, com brilho E cor (três planos:
// Y, Cb, Cr) — só com cinzento, um alvo vermelho confundia-se com um fundo do mesmo brilho.
// O editor transforma o caminho encontrado em posições ◆ da moldura Vertical.

const TEMPLATE_SIDE = 36;          // lado maior do modelo, em píxeis da imagem de trabalho
const CHROMA = 1.5;                // peso da cor em relação ao brilho
export const LOST_SCORE = 0.45;    // abaixo disto o frame não conta (o alvo pode ter-se perdido)

// Tamanho da imagem de trabalho para um alvo com boxW×boxH píxeis da fonte (srcW×srcH).
export function workSize(srcW, srcH, boxW, boxH) {
  const scale = Math.min(1, TEMPLATE_SIDE / Math.max(1, boxW, boxH));
  const w = Math.round(Math.min(640, Math.max(96, srcW * scale)));
  return { w, h: Math.max(2, Math.round(w * srcH / srcW)) };
}

// RGBA → três planos seguidos (Y | Cb | Cr), Float32Array de 3·w·h.
export function toPlanes(rgba, w, h, out = new Float32Array(w * h * 3)) {
  const n = w * h;
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2], y = r * 0.299 + g * 0.587 + b * 0.114;
    out[i] = y;
    out[n + i] = (b - y) * 0.564 * CHROMA;
    out[2 * n + i] = (r - y) * 0.713 * CHROMA;
  }
  return out;
}
export const toGray = toPlanes;    // nome antigo

// planes: 3 planos W×H; devolve os 3 recortes w×h seguidos.
function patch(planes, W, H, x0, y0, w, h) {
  const n = W * H, p = new Float32Array(w * h * 3);
  for (let c = 0; c < 3; c++) {
    for (let y = 0; y < h; y++) {
      const src = c * n + (y0 + y) * W + x0;
      p.set(planes.subarray(src, src + w), c * w * h + y * w);
    }
  }
  return p;
}
// Média 0 em cada plano e norma 1 no total: a correlação mede a FORMA (brilho e cor), não o nível.
// A cor média guarda-se à parte (colorMeans) e só serve para rejeitar zonas de outra cor — se
// contasse na correlação, uma zona lisa da mesma cor parecia-se tanto como o próprio alvo.
// Cor média só na parte de dentro (sem a margem, que muda de cor com o fundo).
function colorMeans(p, w, h, inner) {
  const m = w * h;
  let cb = 0, cr = 0, k = 0;
  for (let y = inner.y; y < inner.y + inner.h; y++) for (let x = inner.x; x < inner.x + inner.w; x++) { cb += p[m + y * w + x]; cr += p[2 * m + y * w + x]; k++; }
  return { cb: cb / (k || 1), cr: cr / (k || 1) };
}
function normalize(p) {
  const out = new Float32Array(p.length), m = p.length / 3;
  let norm = 0;
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let i = c * m; i < (c + 1) * m; i++) mean += p[i];
    mean /= m;
    for (let i = c * m; i < (c + 1) * m; i++) { out[i] = p[i] - mean; norm += out[i] * out[i]; }
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

// box = {x, y, w, h} em píxeis da imagem de trabalho, no primeiro frame.
// O modelo leva uma margem de 10% à volta do que foi marcado: os contornos ajudam a distinguir o
// alvo de uma zona lisa da mesma cor.
export function createTracker(planes, W, H, box) {
  const mx = box.w * 0.1, my = box.h * 0.1;
  const w = Math.max(4, Math.min(W - 2, Math.round(box.w + 2 * mx))), h = Math.max(4, Math.min(H - 2, Math.round(box.h + 2 * my)));
  let x = Math.max(0, Math.min(W - w, Math.round(box.x - mx))), y = Math.max(0, Math.min(H - h, Math.round(box.y - my)));
  const inner = { x: Math.round(mx), y: Math.round(my), w: Math.max(1, w - 2 * Math.round(mx)), h: Math.max(1, h - 2 * Math.round(my)) };
  const first = patch(planes, W, H, x, y, w, h), original = normalize(first);
  let model = original, color = colorMeans(first, w, h, inner);
  const COLOR_SIGMA = 40;                                   // diferença de cor média tolerada
  let vx = 0, vy = 0;
  const radius = Math.round(Math.min(48, Math.max(12, Math.max(w, h) * 0.8)));
  const n = W * H, m = w * h;

  // Correlação normalizada (forma) × semelhança da cor média, para a zona que começa em (px, py).
  function score(planes, px, py) {
    let dot = 0, varSum = 0, cb = 0, cr = 0;
    for (let c = 0; c < 3; c++) {
      let sum = 0, sq = 0;
      for (let j = 0; j < h; j++) {
        const row = c * n + (py + j) * W + px, mrow = c * m + j * w;
        for (let i = 0; i < w; i++) {
          const v = planes[row + i];
          dot += model[mrow + i] * v; sum += v; sq += v * v;
        }
      }
      varSum += sq - (sum * sum) / m;                          // o modelo tem média 0 por plano
      if (c > 0) {
        let isum = 0;
        for (let j = inner.y; j < inner.y + inner.h; j++) {
          const row = c * n + (py + j) * W + px + inner.x;
          for (let i = 0; i < inner.w; i++) isum += planes[row + i];
        }
        if (c === 1) cb = isum / (inner.w * inner.h); else cr = isum / (inner.w * inner.h);
      }
    }
    if (varSum <= 1e-3) return 0;
    const d2 = (cb - color.cb) ** 2 + (cr - color.cr) ** 2;
    return dot / Math.sqrt(varSum) * Math.exp(-d2 / (2 * COLOR_SIGMA * COLOR_SIGMA));
  }

  function search(planes, cx, cy, r, step) {
    let best = -2, bx = cx, by = cy;
    const x0 = Math.max(0, cx - r), x1 = Math.min(W - w, cx + r), y0 = Math.max(0, cy - r), y1 = Math.min(H - h, cy + r);
    for (let py = y0; py <= y1; py += step) {
      for (let px = x0; px <= x1; px += step) {
        const s = score(planes, px, py);
        if (s > best) { best = s; bx = px; by = py; }
      }
    }
    return { x: bx, y: by, score: best };
  }

  // Devolve o centro do alvo no frame novo (píxeis de trabalho) e a confiança (−1…1).
  function track(planes) {
    const px = Math.max(0, Math.min(W - w, Math.round(x + vx))), py = Math.max(0, Math.min(H - h, Math.round(y + vy)));
    let r = search(planes, px, py, radius, 2);                        // grosso…
    r = search(planes, r.x, r.y, 2, 1);                               // …e afinado
    if (r.score >= LOST_SCORE) {
      vx = 0.6 * vx + 0.4 * (r.x - x); vy = 0.6 * vy + 0.4 * (r.y - y);
      x = r.x; y = r.y;
      // Adapta-se devagar a mudanças de aspeto (virar a cabeça, luz), sem se afastar do original.
      if (r.score > 0.6) {
        const raw = patch(planes, W, H, x, y, w, h), cur = normalize(raw), mix = new Float32Array(model.length), c2 = colorMeans(raw, w, h, inner);
        color = { cb: 0.8 * color.cb + 0.2 * c2.cb, cr: 0.8 * color.cr + 0.2 * c2.cr };
        for (let i = 0; i < mix.length; i++) mix[i] = 0.65 * model[i] + 0.25 * cur[i] + 0.1 * original[i];
        model = normalize(mix);
      }
    } else { vx *= 0.5; vy *= 0.5; }                                  // incerto: fica onde estava
    return { cx: x + w / 2, cy: y + h / 2, score: r.score };
  }
  return { track, box: () => ({ x, y, w, h }) };
}

// Suaviza um caminho [{t, x, y}] sem atraso (exponencial para a frente e para trás).
export function smoothPath(points, tau = 0.3) {
  if (points.length < 3) return points.map(p => ({ ...p }));
  const pass = (list) => {
    const out = [{ ...list[0] }];
    for (let i = 1; i < list.length; i++) {
      const dt = Math.abs(list[i].t - list[i - 1].t), a = 1 - Math.exp(-dt / tau), prev = out[i - 1];
      out.push({ t: list[i].t, x: prev.x + a * (list[i].x - prev.x), y: prev.y + a * (list[i].y - prev.y) });
    }
    return out;
  };
  return pass(pass(points).reverse()).reverse();
}

// Amostra o caminho de step em step segundos (interpolação linear), incluindo o início e o fim.
export function samplePath(points, step = 0.4) {
  if (!points.length) return [];
  const out = [], t0 = points[0].t, t1 = points.at(-1).t;
  let j = 0;
  for (let t = t0; t <= t1 + 1e-6; t = Math.min(t1, t + step)) {
    while (j < points.length - 2 && points[j + 1].t < t) j++;
    const a = points[j], b = points[Math.min(points.length - 1, j + 1)], u = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    out.push({ t, x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
    if (t >= t1) break;
  }
  return out;
}
