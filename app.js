/* mixelpixel — image → dot/pixel pattern for 3D printing, cross stitch & diamond painting.
   Pipeline: sample image onto a cols×rows grid → adjust → knock out background →
   quantize (k-means in Lab, or nearest of a user palette) → optional dither → merge rare colors.
   Everything after that (shape, size, outline, view) is render-only and never recomputes. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ================= state ================= */
const DEFAULTS = {
  cols: 60, rows: 60, lockAspect: true,
  shape: 'circle', sizeMm: 2.5, gapMm: 0.3, stagger: false,
  paletteMode: 'auto', nColors: 12, dither: false, minCount: 0,
  customPalette: '#000000 Black\n#FFFFFF White\n#FF0000 Red\n#FFD700 Yellow\n#00C2CB Teal\n#FF00FF Magenta\n#1E3A8A Navy\n#16A34A Green\n#8B4513 Brown\n#9CA3AF Grey',
  cartoon: true, cartoonSmooth: 55, outlineAmt: 45, outlineColor: '#1A1A1A', colorPop: 35,
  brightness: 0, contrast: 0, saturation: 0, knockout: false, knockTol: 14,
  includeBase: true, baseMm: 1.2, heightMm: 1.0, marginMm: 3, plateColor: '#F5F5DC',
  kitHole: 'through', kitThick: 1.6, kitPieceMode: 'exact',
  kitFloor: 1.2, kitDepth: 1.2, kitClear: 0.2, kitPieceH: 2.0, kitGuides: false, kitGuideH: 0.4,
  kitPocketEmpty: false, kitSpare: 5, kitMargin: 5, kitBed: 250,
  outline: false, gridLines: false, symbols: false,
  view: 'preview', tool: 'view', zoom: 1,
};
// Settings that change the quantized grid (everything else is render-only)
const COMPUTE_KEYS = new Set(['cols', 'rows', 'lockAspect', 'paletteMode', 'nColors', 'dither', 'minCount',
  'customPalette', 'brightness', 'contrast', 'saturation', 'knockout', 'knockTol',
  'cartoon', 'cartoonSmooth', 'outlineAmt', 'outlineColor', 'colorPop']);

const S = Object.assign({}, DEFAULTS);
try {
  const saved = JSON.parse(localStorage.getItem('mixelpixel.settings') || '{}');
  if (!saved.kitV) { delete saved.kitGuides; } // v2: through holes + single-color plate became the default
  Object.assign(S, saved); S.kitV = 2;
} catch (e) {}
S.tool = 'view'; S.zoom = 1;
const save = () => { try { const { tool, zoom, ...keep } = S; localStorage.setItem('mixelpixel.settings', JSON.stringify(keep)); } catch (e) {} };

let IMG = null;        // HTMLImageElement / canvas source
let IMGID = 0;         // bumps on every new image, keys the cartoon cache
let GRID = null;       // { cols, rows, idx:Int16Array (-1 = empty), palette:[{r,g,b}] }
let selected = 0;      // palette index used by the paint tool

/* ================= color math ================= */
function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const LIN = new Float32Array(256); for (let i = 0; i < 256; i++) LIN[i] = srgbToLin(i);
function lab(r, g, b) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
const hex = c => '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
function parseHex(h) {
  h = h.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(h)) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}
const luma = c => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ================= sampling ================= */
// Area-average the image onto cols×rows. Unlocked aspect = centre crop to fill.
// dominant: take the most common colour in each cell instead of the mean, so the flat
// regions of a cartoon stay crisp instead of blending into muddy in-between shades.
const BUCKET = new Uint16Array(4096);
function sample(img, cols, rows, lock, dominant) {
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (!lock) {
    const want = cols / rows;
    if (iw / ih > want) { sw = ih * want; sx = (iw - sw) / 2; } else { sh = iw / want; sy = (ih - sh) / 2; }
  }
  const k = clamp(Math.ceil(Math.min(sw / cols, sh / rows)), 1, 8);
  const c = document.createElement('canvas'); c.width = cols * k; c.height = rows * k;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  const out = new Float32Array(cols * rows * 4);
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) {
      const i = ((r * k + yy) * c.width + q * k + xx) * 4, a = d[i + 3];
      R += d[i] * a; G += d[i + 1] * a; B += d[i + 2] * a; A += a;
    }
    const o = (r * cols + q) * 4, n = k * k;
    if (A > 0) { out[o] = R / A; out[o + 1] = G / A; out[o + 2] = B / A; }
    out[o + 3] = A / n;
    if (dominant && n > 1 && A > 0) {
      let bk = -1, bc = 0; const keys = [];
      for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) {
        const i = ((r * k + yy) * c.width + q * k + xx) * 4; if (d[i + 3] < 128) continue;
        const key = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | d[i + 2] >> 4; keys.push(key, i);
        if (++BUCKET[key] > bc) { bc = BUCKET[key]; bk = key; }
      }
      let r2 = 0, g2 = 0, b2 = 0, m = 0;
      for (let t = 0; t < keys.length; t += 2) { BUCKET[keys[t]] = 0; if (keys[t] === bk) { const i = keys[t + 1]; r2 += d[i]; g2 += d[i + 1]; b2 += d[i + 2]; m++; } }
      if (m) { out[o] = r2 / m; out[o + 1] = g2 / m; out[o + 2] = b2 / m; }
    }
  }
  return out;
}

/* ================= cartoonize =================
   Kuwahara filter (edge-preserving: flattens texture into flat patches but keeps borders sharp),
   scaled to the grid so it removes exactly the detail a cell can't show, then a colour pop.
   Outlines are added later at grid level, one cell thick, so they survive pixelation. */
let CART = { key: '', canvas: null };
function kuwahara(d, W, H, r) {
  const W1 = W + 1, N = W1 * (H + 1), sR = new Float64Array(N), sG = new Float64Array(N), sB = new Float64Array(N), sY = new Float64Array(N), sYY = new Float64Array(N);
  for (let y = 0; y < H; y++) {
    let a = 0, b = 0, c = 0, e = 0, f = 0;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, Y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      a += d[i]; b += d[i + 1]; c += d[i + 2]; e += Y; f += Y * Y;
      const o = (y + 1) * W1 + x + 1, u = o - W1;
      sR[o] = sR[u] + a; sG[o] = sG[u] + b; sB[o] = sB[u] + c; sY[o] = sY[u] + e; sYY[o] = sYY[u] + f;
    }
  }
  const out = new Uint8ClampedArray(d.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let bv = Infinity, br = 0, bg = 0, bb = 0;
    for (let q = 0; q < 4; q++) {
      const x0 = q & 1 ? x : Math.max(0, x - r), x1 = q & 1 ? Math.min(W - 1, x + r) : x;
      const y0 = q & 2 ? y : Math.max(0, y - r), y1 = q & 2 ? Math.min(H - 1, y + r) : y;
      const A = y0 * W1 + x0, B = y0 * W1 + x1 + 1, C = (y1 + 1) * W1 + x0, D = (y1 + 1) * W1 + x1 + 1, n = (x1 - x0 + 1) * (y1 - y0 + 1);
      const m = (sY[D] - sY[B] - sY[C] + sY[A]) / n, v = (sYY[D] - sYY[B] - sYY[C] + sYY[A]) / n - m * m;
      if (v < bv) { bv = v; br = (sR[D] - sR[B] - sR[C] + sR[A]) / n; bg = (sG[D] - sG[B] - sG[C] + sG[A]) / n; bb = (sB[D] - sB[B] - sB[C] + sB[A]) / n; }
    }
    const i = (y * W + x) * 4; out[i] = br; out[i + 1] = bg; out[i + 2] = bb; out[i + 3] = d[i + 3];
  }
  return out;
}
function cartoonSource() {
  if (!S.cartoon || !IMG) return IMG;
  const iw = IMG.naturalWidth || IMG.width, ih = IMG.naturalHeight || IMG.height;
  const target = clamp(Math.ceil(Math.max(S.cols, S.rows) * 8 / 160) * 160, 320, 960), f = Math.min(1, target / Math.max(iw, ih));
  const W = Math.max(1, Math.round(iw * f)), H = Math.max(1, Math.round(ih * f));
  const key = [IMGID, W, H, S.cols, S.cartoonSmooth, S.colorPop].join('|');
  if (CART.key === key) return CART.canvas;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.imageSmoothingQuality = 'high'; g.drawImage(IMG, 0, 0, W, H);
  const img = g.getImageData(0, 0, W, H);
  let d = img.data;
  const cell = W / S.cols, r = Math.max(1, Math.round(cell * (0.2 + S.cartoonSmooth / 100)));
  if (S.cartoonSmooth > 0) { d = kuwahara(d, W, H, r); d = kuwahara(d, W, H, Math.max(1, r >> 1)); }
  const sat = 1 + S.colorPop / 100 * 0.9, con = 1 + S.colorPop / 100 * 0.25;
  for (let i = 0; i < d.length; i += 4) {
    let R = (d[i] - 128) * con + 128, G = (d[i + 1] - 128) * con + 128, B = (d[i + 2] - 128) * con + 128;
    const Y = 0.299 * R + 0.587 * G + 0.114 * B;
    d[i] = Y + (R - Y) * sat; d[i + 1] = Y + (G - Y) * sat; d[i + 2] = Y + (B - Y) * sat;
  }
  img.data.set(d); g.putImageData(img, 0, 0);
  CART = { key, canvas: c };
  return c;
}

// Mark one-cell outlines on light/dark borders (how a cartoonist inks). The threshold is a
// percentile of this image's own contrasts, so the slider means "how much gets inked" whether
// the photo is punchy or flat. The darker cell of each pair takes the line; with knock-out on,
// the subject's rim against the background is inked too.
function outlineCells(px, cols, rows, mask) {
  const n = cols * rows, L = new Float32Array(n), o = new Uint8Array(n), pairs = [];
  for (let i = 0; i < n; i++) if (mask[i]) L[i] = lab(px[i * 4] | 0, px[i * 4 + 1] | 0, px[i * 4 + 2] | 0)[0];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c; if (!mask[i]) continue;
    if (c + 1 < cols && mask[i + 1]) pairs.push(i, i + 1);
    if (r + 1 < rows && mask[i + cols]) pairs.push(i, i + cols);
    if (S.knockout) for (const [dc, dr] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const cc = c + dc, rr = r + dr; if (cc >= 0 && rr >= 0 && cc < cols && rr < rows && !mask[rr * cols + cc]) o[i] = 1;
    }
  }
  const d = new Float32Array(pairs.length / 2); for (let k = 0; k < d.length; k++) d[k] = Math.abs(L[pairs[2 * k]] - L[pairs[2 * k + 1]]);
  const sorted = Float32Array.from(d).sort(), share = S.outlineAmt / 100 * 0.16;
  const thr = Math.max(9, sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (1 - share)))] || 0);
  for (let k = 0; k < d.length; k++) if (d[k] >= thr) { const i = pairs[2 * k], j = pairs[2 * k + 1]; o[L[i] <= L[j] ? i : j] = 1; }
  // drop specks: an outline cell with no outline neighbour is noise, not a line
  const keep = o.slice();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c; if (!o[i]) continue; let nb = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { if (!dr && !dc) continue; const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && o[rr * cols + cc]) nb++; }
    if (!nb) keep[i] = 0;
  }
  return keep;
}

function adjust(px, s) {
  const b = s.brightness * 1.28, cc = s.contrast * 2.55, sat = 1 + s.saturation / 100;
  const cf = (259 * (cc + 255)) / (255 * (259 - cc));
  for (let i = 0; i < px.length; i += 4) {
    let r = px[i], g = px[i + 1], bl = px[i + 2];
    r = cf * (r - 128) + 128 + b; g = cf * (g - 128) + 128 + b; bl = cf * (bl - 128) + 128 + b;
    const y = 0.299 * r + 0.587 * g + 0.114 * bl;
    r = y + (r - y) * sat; g = y + (g - y) * sat; bl = y + (bl - y) * sat;
    px[i] = clamp(r, 0, 255); px[i + 1] = clamp(g, 0, 255); px[i + 2] = clamp(bl, 0, 255);
  }
}

/* ================= quantize ================= */
function kmeans(pts, k, seed = 7) {
  // pts: array of {r,g,b,w,L} unique colours with weights
  const rnd = mulberry32(seed), n = pts.length;
  if (n <= k) return pts.map(p => ({ r: p.r, g: p.g, b: p.b }));
  const C = [];
  let best = 0; for (let i = 1; i < n; i++) if (pts[i].w > pts[best].w) best = i;
  C.push(pts[best].L.slice());
  const D = new Float64Array(n).fill(Infinity);
  while (C.length < k) {
    const c = C[C.length - 1]; let sum = 0;
    for (let i = 0; i < n; i++) { const L = pts[i].L, d = (L[0] - c[0]) ** 2 + (L[1] - c[1]) ** 2 + (L[2] - c[2]) ** 2; if (d < D[i]) D[i] = d; sum += D[i] * pts[i].w; }
    let t = rnd() * sum, j = 0; for (; j < n - 1; j++) { t -= D[j] * pts[j].w; if (t <= 0) break; }
    C.push(pts[j].L.slice());
  }
  const as = new Int32Array(n);
  let acc = [];
  for (let it = 0; it < 24; it++) {
    acc = C.map(() => [0, 0, 0, 0, 0, 0, 0]);
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const L = pts[i].L; let bi = 0, bd = Infinity;
      for (let j = 0; j < k; j++) { const c = C[j], d = (L[0] - c[0]) ** 2 + (L[1] - c[1]) ** 2 + (L[2] - c[2]) ** 2; if (d < bd) { bd = d; bi = j; } }
      if (as[i] !== bi) moved++; as[i] = bi;
      const a = acc[bi], w = pts[i].w; a[0] += L[0] * w; a[1] += L[1] * w; a[2] += L[2] * w; a[3] += w; a[4] += pts[i].r * w; a[5] += pts[i].g * w; a[6] += pts[i].b * w;
    }
    for (let j = 0; j < k; j++) {
      const a = acc[j];
      if (a[3] > 0) C[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
      else { // empty cluster: reseed on the worst-fit point
        let wi = 0, wd = -1;
        for (let i = 0; i < n; i++) { const L = pts[i].L, c = C[as[i]], d = ((L[0] - c[0]) ** 2 + (L[1] - c[1]) ** 2 + (L[2] - c[2]) ** 2) * pts[i].w; if (d > wd) { wd = d; wi = i; } }
        C[j] = pts[wi].L.slice(); as[wi] = j; moved++;
      }
    }
    if (it > 2 && moved === 0) break;
  }
  return acc.filter(a => a[3] > 0).map(a => ({ r: Math.round(a[4] / a[3]), g: Math.round(a[5] / a[3]), b: Math.round(a[6] / a[3]) }));
}

function nearestFn(pal) {
  const PL = pal.map(p => lab(p.r, p.g, p.b));
  return (r, g, b) => {
    const L = lab(r | 0, g | 0, b | 0); let bi = 0, bd = Infinity;
    for (let j = 0; j < PL.length; j++) { const c = PL[j], d = (L[0] - c[0]) ** 2 + (L[1] - c[1]) ** 2 + (L[2] - c[2]) ** 2; if (d < bd) { bd = d; bi = j; } }
    return bi;
  };
}

function mapToPalette(px, cols, rows, pal, mask, dither) {
  const idx = new Int16Array(cols * rows).fill(-1);
  const near = nearestFn(pal);
  const buf = dither ? Float32Array.from(px) : px;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c; if (!mask[i]) continue;
    const o = i * 4, R = clamp(buf[o], 0, 255), G = clamp(buf[o + 1], 0, 255), B = clamp(buf[o + 2], 0, 255);
    const j = near(R, G, B); idx[i] = j;
    if (dither) {
      const p = pal[j], er = (R - p.r) * 0.85, eg = (G - p.g) * 0.85, eb = (B - p.b) * 0.85;
      const push = (dc, dr, f) => { const cc = c + dc, rr = r + dr; if (cc < 0 || cc >= cols || rr >= rows) return; const t = rr * cols + cc; if (!mask[t]) return; const q = t * 4; buf[q] += er * f; buf[q + 1] += eg * f; buf[q + 2] += eb * f; };
      push(1, 0, 7 / 16); push(-1, 1, 3 / 16); push(0, 1, 5 / 16); push(1, 1, 1 / 16);
    }
  }
  return idx;
}

function compute() {
  if (!IMG) { GRID = null; return; }
  const cols = S.cols, rows = S.rows;
  const px = sample(cartoonSource(), cols, rows, S.lockAspect, S.cartoon);
  adjust(px, S);
  const n = cols * rows, mask = new Uint8Array(n);
  let bgL = null;
  if (S.knockout) { // background = average of the four corner cells
    const cs = [0, cols - 1, (rows - 1) * cols, n - 1].map(i => i * 4); let r = 0, g = 0, b = 0;
    cs.forEach(o => { r += px[o]; g += px[o + 1]; b += px[o + 2]; });
    bgL = lab(r / 4 | 0, g / 4 | 0, b / 4 | 0);
  }
  for (let i = 0; i < n; i++) {
    const o = i * 4; if (px[o + 3] < 128) continue;
    if (bgL) { const L = lab(px[o] | 0, px[o + 1] | 0, px[o + 2] | 0); if (Math.hypot(L[0] - bgL[0], L[1] - bgL[1], L[2] - bgL[2]) < S.knockTol) continue; }
    mask[i] = 1;
  }
  if (S.paletteMode === 'gray') for (let i = 0; i < n * 4; i += 4) { const y = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; px[i] = px[i + 1] = px[i + 2] = y; }
  const oc = parseHex(S.outlineColor) || { r: 26, g: 26, b: 26 };
  const outl = S.cartoon && S.outlineAmt > 0 ? outlineCells(px, cols, rows, mask) : null;
  const nOut = outl ? outl.reduce((a, v) => a + v, 0) : 0;
  if (nOut) for (let i = 0; i < n; i++) if (outl[i]) { px[i * 4] = oc.r; px[i * 4 + 1] = oc.g; px[i * 4 + 2] = oc.b; }

  let pal;
  if (S.paletteMode === 'custom') {
    const all = parseCustom(S.customPalette);
    if (!all.length) { toast('warn', 'No valid colors', 'Add hex codes like #FF0000 to “My filaments”.'); pal = [{ r: 0, g: 0, b: 0 }]; }
    else {
      // Map to every filament, then keep the N the image uses most.
      const trial = mapToPalette(px, cols, rows, all, mask, false), cnt = new Array(all.length).fill(0);
      trial.forEach(j => { if (j >= 0) cnt[j]++; });
      pal = all.map((p, j) => ({ p, c: cnt[j] })).filter(o => o.c > 0).sort((a, b) => b.c - a.c).slice(0, S.nColors).map(o => o.p);
      if (!pal.length) pal = [all[0]];
    }
  } else {
    const map = new Map();
    for (let i = 0; i < n; i++) if (mask[i] && !(nOut && outl[i])) { const o = i * 4, key = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2]; map.set(key, (map.get(key) || 0) + 1); }
    const pts = [...map].map(([key, w]) => { const r = key >> 16 & 255, g = key >> 8 & 255, b = key & 255; return { r, g, b, w, L: lab(r, g, b) }; });
    pal = pts.length ? kmeans(pts, Math.max(1, S.nColors - (nOut ? 1 : 0))) : [];
    if (nOut) pal.push({ ...oc, name: 'Outline' });
    if (!pal.length) pal = [{ r: 0, g: 0, b: 0 }];
  }
  let idx = mapToPalette(px, cols, rows, pal, mask, S.dither);
  if (nOut) { const oj = nearestFn(pal)(oc.r, oc.g, oc.b); for (let i = 0; i < n; i++) if (outl[i]) idx[i] = oj; }
  GRID = { cols, rows, idx, palette: pal, px, mask };
  if (S.minCount > 0) mergeRare(S.minCount);
  sortPalette();
}

function parseCustom(txt) { // "#FF0000 Red PLA" per line (or comma separated); the name is optional
  const out = [], re = /#?\b([0-9a-f]{6}|[0-9a-f]{3})\b[ \t]*([^#,;\n]*)/gi; let m;
  while ((m = re.exec(txt || ''))) { const c = parseHex(m[1]); if (c) { const name = m[2].trim(); if (name) c.name = name; out.push(c); } }
  return out;
}
const colorName = j => GRID.palette[j].name || hex(GRID.palette[j]);
const slug = t => t.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24);
const fileTag = j => `${String(j + 1).padStart(2, '0')}_${GRID.palette[j].name ? slug(GRID.palette[j].name) + '_' : ''}${hex(GRID.palette[j]).slice(1)}`;

function counts() { const c = new Array(GRID.palette.length).fill(0); GRID.idx.forEach(j => { if (j >= 0) c[j]++; }); return c; }

// Drop palette entry j and send its cells to the nearest remaining colour.
function removeColor(j) {
  const pal = GRID.palette; if (pal.length <= 1) return false;
  const rest = pal.filter((_, i) => i !== j), near = nearestFn(rest), p = pal[j], to = near(p.r, p.g, p.b);
  const idx = GRID.idx;
  for (let i = 0; i < idx.length; i++) { if (idx[i] === j) idx[i] = to; else if (idx[i] > j) idx[i]--; }
  // `to` was computed on `rest`, so it is already in post-removal numbering
  GRID.palette = rest;
  return true;
}
function mergeRare(min) {
  for (;;) {
    const c = counts(); let j = -1, lo = Infinity;
    c.forEach((v, i) => { if (v < min && v < lo) { lo = v; j = i; } });
    if (j < 0 || GRID.palette.length <= 2) break;
    removeColor(j);
  }
}
function sortPalette() { // most-used first, so symbols stay stable and useful
  const c = counts(), order = GRID.palette.map((p, i) => i).sort((a, b) => c[b] - c[a]);
  const remap = new Int16Array(order.length); order.forEach((old, nw) => remap[old] = nw);
  GRID.palette = order.map(i => GRID.palette[i]);
  for (let i = 0; i < GRID.idx.length; i++) if (GRID.idx[i] >= 0) GRID.idx[i] = remap[GRID.idx[i]];
}

/* ================= shapes (unit polygons, centred, fit a 1×1 box, y down) ================= */
function fit(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  pts.forEach(([x, y]) => { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); });
  const s = 1 / Math.max(x1 - x0, y1 - y0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return pts.map(([x, y]) => [(x - cx) * s, (y - cy) * s]);
}
const regular = (n, rot = 0, r = 0.5) => Array.from({ length: n }, (_, i) => { const a = rot + i * 2 * Math.PI / n; return [Math.cos(a) * r, Math.sin(a) * r]; });
function roundedRect(rad, seg = 5) {
  const h = 0.5, c = h - rad, out = [];
  [[c, c, 0], [-c, c, 90], [-c, -c, 180], [c, -c, 270]].forEach(([x, y, a0]) => {
    for (let i = 0; i <= seg; i++) { const a = (a0 + 90 * i / seg) * Math.PI / 180; out.push([x + Math.cos(a) * rad, y + Math.sin(a) * rad]); }
  });
  return out;
}
function star(n, inner) { const o = []; for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + i * Math.PI / n, r = i % 2 ? inner : 0.5; o.push([Math.cos(a) * r, Math.sin(a) * r]); } return fit(o); }
function heart(n = 48) { const o = []; for (let i = 0; i < n; i++) { const t = i / n * 2 * Math.PI; o.push([16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]); } return fit(o); }
function plus(w = 0.36) { const a = w / 2, h = 0.5; return [[-a, -h], [a, -h], [a, -a], [h, -a], [h, a], [a, a], [a, h], [-a, h], [-a, a], [-h, a], [-h, -a], [-a, -a]]; }

const SHAPES = {
  circle: { label: 'Circle', poly: seg => regular(seg, 0) },
  square: { label: 'Square', poly: () => [[-.5, -.5], [.5, -.5], [.5, .5], [-.5, .5]] },
  rounded: { label: 'Rounded', poly: () => roundedRect(0.2) },
  diamond: { label: 'Diamond', poly: () => [[0, -.5], [.5, 0], [0, .5], [-.5, 0]] },
  hexagon: { label: 'Hexagon', poly: () => fit(regular(6, -Math.PI / 2)) },
  octagon: { label: 'Octagon', poly: () => fit(regular(8, Math.PI / 8)) },
  triangle: { label: 'Triangle', poly: () => fit(regular(3, -Math.PI / 2)) },
  star: { label: 'Star', poly: () => star(5, 0.21) },
  heart: { label: 'Heart', poly: seg => heart(Math.max(24, seg)) },
  plus: { label: 'Plus', poly: () => plus() },
};
const polyOf = (shape, seg = 40) => SHAPES[shape].poly(seg);

/* ================= geometry helpers ================= */
const pitch = () => S.sizeMm + S.gapMm;
function layoutMm() {
  const p = pitch(), cols = GRID ? GRID.cols : S.cols, rows = GRID ? GRID.rows : S.rows;
  const w = cols * p + (S.stagger ? p / 2 : 0), h = rows * p, m = S.includeBase ? S.marginMm : 0;
  return { p, w, h, m, plateW: w + 2 * m, plateH: h + 2 * m };
}
// Centre of cell (c,r) in "pitch units" from the pattern's top-left
const cellCenter = (c, r) => [c + 0.5 + (S.stagger && r % 2 ? 0.5 : 0), r + 0.5];

/* ================= symbols ================= */
const SYMS = '●■▲◆★✚✖○□△◇☆♥♦♣♠ABCDEFGHJKLMNPQRSTUVWXYZ23456789abdefghkmnqrtuy'.split('');
const symOf = j => SYMS[j % SYMS.length];

/* ================= rendering ================= */
const canvas = $('#canvas'), ctx = canvas.getContext('2d');
let view = { P: 10, ox: 0, oy: 0, gutter: 0 }; // px per pitch + offsets, for hit-testing

function drawPattern(g, P, ox, oy, opts = {}) {
  const pal = GRID.palette, { cols, rows, idx } = GRID;
  const s = P * S.sizeMm / pitch();
  const pts = S.shape === 'circle' ? null : polyOf(S.shape);
  for (let j = 0; j < pal.length; j++) {
    g.beginPath();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (idx[r * cols + c] !== j) continue;
      const [ux, uy] = cellCenter(c, r), x = ox + ux * P, y = oy + uy * P;
      if (!pts) { g.moveTo(x + s / 2, y); g.arc(x, y, s / 2, 0, Math.PI * 2); }
      else { g.moveTo(x + pts[0][0] * s, y + pts[0][1] * s); for (let k = 1; k < pts.length; k++) g.lineTo(x + pts[k][0] * s, y + pts[k][1] * s); g.closePath(); }
    }
    g.fillStyle = hex(pal[j]); g.fill();
    if (opts.outline) { g.lineWidth = Math.max(0.5, s * 0.07); g.strokeStyle = '#000'; g.stroke(); }
  }
  if (opts.symbols && s >= 9) {
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `700 ${Math.round(s * 0.55)}px "Space Mono", monospace`;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const j = idx[r * cols + c]; if (j < 0) continue;
      const [ux, uy] = cellCenter(c, r); g.fillStyle = luma(pal[j]) > 140 ? '#000' : '#fff';
      g.fillText(symOf(j), ox + ux * P, oy + uy * P + s * 0.03);
    }
  }
  if (opts.gridLines) gridLines(g, P, ox, oy, cols, rows);
}
function gridLines(g, P, ox, oy, cols, rows) {
  g.strokeStyle = '#000'; g.lineWidth = Math.max(1, P * 0.08);
  g.beginPath();
  for (let c = 0; c <= cols; c += 10) { g.moveTo(ox + c * P, oy); g.lineTo(ox + c * P, oy + rows * P); }
  for (let r = 0; r <= rows; r += 10) { g.moveTo(ox, oy + r * P); g.lineTo(ox + cols * P, oy + r * P); }
  g.stroke();
}

function drawPreview(g, W, H, P, pad) {
  const L = layoutMm(), mm = P / L.p;
  g.fillStyle = '#F5F5DC'; g.fillRect(0, 0, W, H);
  // plate
  const px0 = pad, py0 = pad, pw = L.plateW * mm, ph = L.plateH * mm;
  g.fillStyle = S.plateColor; g.strokeStyle = '#000'; g.lineWidth = Math.max(2, P * 0.12);
  roundRect(g, px0, py0, pw, ph, Math.min(12, P)); g.fill(); g.stroke();
  const ox = px0 + L.m * mm, oy = py0 + L.m * mm;
  drawPattern(g, P, ox, oy, { outline: S.outline, symbols: S.symbols, gridLines: S.gridLines });
  return { ox, oy };
}
// The empty board a customer receives: pockets, tinted by the color guide printed in each floor
function drawBoard(g, W, H, P, pad) {
  const K = kitGeom(), mm = P / K.p, m = S.kitMargin * mm, { cols, rows, idx, palette: pal } = GRID;
  g.fillStyle = '#F5F5DC'; g.fillRect(0, 0, W, H);
  g.fillStyle = S.plateColor; g.strokeStyle = '#000'; g.lineWidth = 2;
  g.beginPath(); g.rect(pad, pad, W - pad * 2, H - pad * 2); g.fill(); g.stroke();
  const tiles = kitTiles();
  if (tiles.length > 1) { g.setLineDash([6, 4]); g.strokeStyle = '#FF00FF'; g.lineWidth = 2; g.beginPath();
    tiles.forEach(t => { if (t.c0) { g.moveTo(pad + m + t.c0 * P, pad); g.lineTo(pad + m + t.c0 * P, H - pad); } if (t.r0) { g.moveTo(pad, pad + m + t.r0 * P); g.lineTo(W - pad, pad + m + t.r0 * P); } });
    g.stroke(); g.setLineDash([]); }
  const s = P * K.pocket / K.p, pts = polyOf(S.shape);
  g.lineWidth = Math.max(0.6, s * 0.06); g.strokeStyle = 'rgba(0,0,0,.75)';
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const j = idx[r * cols + c]; if (j < 0 && !S.kitPocketEmpty) continue;
    const [ux, uy] = cellCenter(c, r), x = pad + m + ux * P, y = pad + m + uy * P;
    g.beginPath(); g.moveTo(x + pts[0][0] * s, y + pts[0][1] * s); for (let k = 1; k < pts.length; k++) g.lineTo(x + pts[k][0] * s, y + pts[k][1] * s); g.closePath();
    g.fillStyle = K.through ? '#2a2a24' : K.G && j >= 0 ? hex(pal[j]) : 'rgba(0,0,0,.18)'; g.fill(); g.stroke();
  }
}
function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

function drawChart(g, P, gut, withLegend) {
  const { cols, rows, idx, palette: pal } = GRID;
  const W = gut + cols * P + gut, H = gut + rows * P + gut;
  g.fillStyle = '#fff'; g.fillRect(0, 0, g.canvas.width, g.canvas.height);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const j = idx[r * cols + c], x = gut + c * P, y = gut + r * P;
    if (j < 0) continue;
    g.fillStyle = hex(pal[j]); g.fillRect(x, y, P, P);
  }
  // symbols
  if (P >= 8) {
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `700 ${Math.round(P * 0.62)}px "Space Mono", monospace`;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const j = idx[r * cols + c]; if (j < 0) continue;
      g.fillStyle = luma(pal[j]) > 140 ? '#000' : '#fff';
      g.fillText(symOf(j), gut + c * P + P / 2, gut + r * P + P / 2 + P * 0.04);
    }
  }
  // fine grid
  g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 1; g.beginPath();
  for (let c = 0; c <= cols; c++) { g.moveTo(gut + c * P + .5, gut); g.lineTo(gut + c * P + .5, gut + rows * P); }
  for (let r = 0; r <= rows; r++) { g.moveTo(gut, gut + r * P + .5); g.lineTo(gut + cols * P, gut + r * P + .5); }
  g.stroke();
  gridLines(g, P, gut, gut, cols, rows);
  g.lineWidth = 3; g.strokeRect(gut, gut, cols * P, rows * P);
  // numbers every 10
  g.fillStyle = '#000'; g.font = `700 ${Math.max(9, Math.min(14, gut * 0.42))}px "Space Mono", monospace`; g.textBaseline = 'middle';
  for (let c = 0; c <= cols; c += 10) { g.textAlign = 'center'; g.fillText(c, gut + c * P, gut / 2); g.fillText(c, gut + c * P, gut + rows * P + gut / 2); }
  for (let r = 0; r <= rows; r += 10) { g.textAlign = 'right'; g.fillText(r, gut - 6, gut + r * P); g.textAlign = 'left'; g.fillText(r, gut + cols * P + 6, gut + r * P); }
  if (withLegend) drawLegend(g, gut, H + 10, W - gut * 2);
  return { W, H };
}
function legendHeight(width) { const per = Math.max(1, Math.floor(width / 230)); return 60 + Math.ceil(GRID.palette.length / per) * 34 + 20; }
function drawLegend(g, x, y, width) {
  const pal = GRID.palette, cnt = counts(), per = Math.max(1, Math.floor(width / 230)), L = layoutMm();
  g.fillStyle = '#000'; g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.font = '900 20px Archivo, sans-serif';
  g.fillText(`MIXELPIXEL · ${GRID.cols}×${GRID.rows} · ${pal.length} COLORS · ${total(cnt)} PIECES · ${L.w.toFixed(0)}×${L.h.toFixed(0)} MM`, x, y + 28);
  pal.forEach((p, j) => {
    const cx = x + (j % per) * 230, cy = y + 50 + Math.floor(j / per) * 34;
    g.fillStyle = hex(p); g.fillRect(cx, cy, 28, 26); g.strokeStyle = '#000'; g.lineWidth = 2; g.strokeRect(cx, cy, 28, 26);
    g.fillStyle = luma(p) > 140 ? '#000' : '#fff'; g.textAlign = 'center'; g.font = '700 15px "Space Mono", monospace'; g.fillText(symOf(j), cx + 14, cy + 19);
    g.fillStyle = '#000'; g.textAlign = 'left'; g.font = '700 13px "Space Mono", monospace'; g.fillText(`${hex(p)}  ×${cnt[j]}`, cx + 36, cy + 18);
  });
}
const total = c => c.reduce((a, b) => a + b, 0);

function render() {
  const stage = $('#stage');
  const has = !!GRID || (S.view === 'original' && IMG);
  $('#empty').hidden = !!IMG; canvas.hidden = !IMG;
  if (!IMG) { updateCounters(); return; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const availW = stage.clientWidth - 24, availH = stage.clientHeight - 24;
  let cssW, cssH;
  if (S.view === 'original') {
    const src = cartoonSource(), iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height, f = Math.min(availW / iw, availH / ih) * S.zoom;
    cssW = iw * f; cssH = ih * f; setCanvas(cssW, cssH, dpr);
    ctx.imageSmoothingQuality = 'high'; ctx.drawImage(src, 0, 0, cssW, cssH);
  } else if (GRID && S.view === 'chart') {
    const gut = 28, P0 = Math.min((availW - gut * 2) / GRID.cols, (availH - gut * 2) / GRID.rows);
    const P = clampP(P0 * S.zoom, GRID.cols + 2, GRID.rows + 2, dpr);
    cssW = gut * 2 + GRID.cols * P; cssH = gut * 2 + GRID.rows * P; setCanvas(cssW, cssH, dpr);
    drawChart(ctx, P, gut, false); view = { P, ox: gut, oy: gut, chart: true };
  } else if (GRID && S.view === 'board') {
    const K = kitGeom(), m = S.kitMargin, pad = 12, bw = GRID.cols * K.p + (S.stagger ? K.p / 2 : 0) + 2 * m, bh = GRID.rows * K.p + 2 * m;
    const mmFit = Math.min((availW - pad * 2) / bw, (availH - pad * 2) / bh);
    const P = clampP(mmFit * K.p * S.zoom, bw / K.p, bh / K.p, dpr), mm = P / K.p;
    cssW = bw * mm + pad * 2; cssH = bh * mm + pad * 2; setCanvas(cssW, cssH, dpr);
    drawBoard(ctx, cssW, cssH, P, pad); view = { P, ox: pad + m * mm, oy: pad + m * mm, chart: false };
  } else if (GRID) {
    const L = layoutMm(), pad = 12;
    const mmFit = Math.min((availW - pad * 2) / L.plateW, (availH - pad * 2) / L.plateH);
    const P = clampP(mmFit * L.p * S.zoom, L.plateW / L.p, L.plateH / L.p, dpr), mm = P / L.p;
    cssW = L.plateW * mm + pad * 2; cssH = L.plateH * mm + pad * 2; setCanvas(cssW, cssH, dpr);
    const o = drawPreview(ctx, cssW, cssH, P, pad); view = { P, ox: o.ox, oy: o.oy, chart: false };
  }
  canvas.style.marginTop = cssH < availH ? ((availH - cssH) / 2 + 12) + 'px' : '12px';
  updateCounters(); void has;
}
function clampP(P, unitsW, unitsH, dpr) { const maxPx = 8000 / dpr; return Math.max(1, Math.min(P, maxPx / unitsW, maxPx / unitsH)); }
function setCanvas(w, h, dpr) {
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* ================= UI: counters, legend, info ================= */
function updateCounters() {
  const c = GRID ? counts() : [];
  $('#cColors').textContent = GRID ? GRID.palette.length : 0;
  $('#cGrid').textContent = `${S.cols}×${S.rows}`;
  $('#cPieces').textContent = total(c).toLocaleString();
  const L = layoutMm();
  $('#sizeInfo').innerHTML = `Pattern: <b>${L.w.toFixed(1)} × ${L.h.toFixed(1)} mm</b> (${(L.w / 25.4).toFixed(1)} × ${(L.h / 25.4).toFixed(1)} in) · pitch ${L.p.toFixed(2)} mm`;
  $('#plateInfo').innerHTML = S.includeBase
    ? `Plate: <b>${L.plateW.toFixed(1)} × ${L.plateH.toFixed(1)} × ${(S.baseMm + S.heightMm).toFixed(1)} mm</b> total`
    : `Pieces only: <b>${S.heightMm} mm</b> tall, no base.`;
  $('#kitInfo').innerHTML = kitInfoHTML();
  if (L.plateW > 256 || L.plateH > 256) $('#plateInfo').innerHTML += `<br>⚠ Larger than a 256 mm bed — split it or shrink the grid.`;
}

function renderLegend() {
  const body = $('#legendBody');
  if (!GRID) { body.innerHTML = '<tr><td colspan="6" class="muted">Upload an image to generate the key.</td></tr>'; return; }
  const c = counts(), t = total(c) || 1;
  selected = clamp(selected, 0, GRID.palette.length - 1);
  body.innerHTML = GRID.palette.map((p, j) => `<tr data-j="${j}" class="${j === selected ? 'sel' : ''}">
    <td><span class="sym" style="background:${hex(p)};color:${luma(p) > 140 ? '#000' : '#fff'}">${symOf(j)}</span></td>
    <td><button class="sw" type="button" data-recolor="${j}" style="background:${hex(p)}" aria-label="Change color ${hex(p)}"></button></td>
    <td>${p.name ? `<b>${p.name.replace(/</g, '&lt;')}</b><br>` : ''}${hex(p)}</td><td class="r">${c[j].toLocaleString()}</td><td class="r">${(c[j] / t * 100).toFixed(1)}</td>
    <td class="r"><button class="xbtn" type="button" data-dl="${j}" aria-label="Download ${hex(p)} pieces STL" title="Download this color's pieces (STL)">↓</button> <button class="xbtn" type="button" data-merge="${j}" aria-label="Merge ${hex(p)} into nearest color" title="Merge into nearest color">✕</button></td></tr>`).join('');
}

/* ================= controls ================= */
function syncControls() {
  $$('[data-k]').forEach(el => {
    const k = el.dataset.k;
    if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k];
  });
  $$('output[data-for]').forEach(o => { o.textContent = S[o.dataset.for]; });
  $('#colsRange').value = S.cols;
  $$('[data-pm]').forEach(b => b.setAttribute('aria-selected', b.dataset.pm === S.paletteMode));
  $$('[data-view]').forEach(b => b.setAttribute('aria-selected', b.dataset.view === S.view));
  $$('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === S.tool));
  $$('.shape').forEach(b => b.setAttribute('aria-checked', b.dataset.shape === S.shape));
  $('#customWrap').hidden = S.paletteMode !== 'custom';
  $('.cartoon-opts').hidden = !S.cartoon;
  $$('[data-hole]').forEach(b => b.setAttribute('aria-selected', b.dataset.hole === S.kitHole));
  $$('[data-pmode]').forEach(b => b.setAttribute('aria-selected', b.dataset.pmode === S.kitPieceMode));
  $$('.pocket-only').forEach(el => el.hidden = S.kitHole === 'through');
  $$('.through-only').forEach(el => el.hidden = S.kitHole !== 'through');
  $('#nColors').max = S.paletteMode === 'custom' ? Math.max(2, parseCustom(S.customPalette).length) : 48;
  $('#zoomVal').textContent = Math.round(S.zoom * 100) + '%';
  $('#stage').classList.toggle('paint', S.tool !== 'view');
}

const aspect = () => IMG ? (IMG.naturalHeight || IMG.height) / (IMG.naturalWidth || IMG.width) : 1;
function setKey(k, v) {
  if (['cols', 'rows', 'nColors', 'minCount', 'brightness', 'contrast', 'saturation', 'knockTol'].includes(k)) v = Math.round(+v || 0);
  if (['sizeMm', 'gapMm', 'baseMm', 'heightMm', 'marginMm', 'kitFloor', 'kitDepth', 'kitClear', 'kitPieceH', 'kitGuideH', 'kitThick', 'kitMargin', 'kitBed', 'kitSpare'].includes(k)) v = Math.max(0, +v || 0);
  if (k === 'kitBed') v = clamp(v, 60, 1000);
  if (k === 'cols') { v = clamp(v, 4, 300); if (S.lockAspect) S.rows = clamp(Math.round(v * aspect()), 4, 300); }
  if (k === 'rows') { v = clamp(v, 4, 300); if (S.lockAspect) S.cols = clamp(Math.round(v / aspect()), 4, 300); }
  if (k === 'sizeMm') v = clamp(v, 0.5, 50);
  if (k === 'gapMm') v = clamp(v, 0, 20);
  S[k] = v;
  if (k === 'lockAspect' && v) S.rows = clamp(Math.round(S.cols * aspect()), 4, 300);
  save(); syncControls();
  if (COMPUTE_KEYS.has(k)) schedule(); else { render(); renderLegend(); }
}

let timer = 0, edited = false;
function schedule() {
  clearTimeout(timer);
  if (!IMG) { render(); return; }
  $('#busy').hidden = false;
  timer = setTimeout(() => {
    if (edited) { toast('info', 'Edits reset', 'Grid or colors changed, so hand edits were cleared.'); edited = false; }
    try { compute(); } catch (e) { console.error(e); toast('err', 'Could not process', e.message); }
    $('#busy').hidden = true; render(); renderLegend();
  }, 120);
}

function bind() {
  $$('[data-k]').forEach(el => {
    const ev = el.type === 'range' || el.tagName === 'TEXTAREA' || el.type === 'color' ? 'input' : 'change';
    el.addEventListener(ev, () => setKey(el.dataset.k, el.type === 'checkbox' ? el.checked : el.value));
    if (el.type === 'range') el.addEventListener('input', () => { const o = $(`output[data-for="${el.dataset.k}"]`); if (o) o.textContent = el.value; });
  });
  $('#colsRange').addEventListener('input', e => setKey('cols', e.target.value));
  $('#fitW').addEventListener('click', () => {
    const w = +$('#targetW').value; if (!(w > 0)) return toast('warn', 'Width needed', 'Type a width in mm first.');
    setKey('cols', Math.floor((w - (S.stagger ? pitch() / 2 : 0)) / pitch()));
    toast('ok', 'Fitted', `${S.cols} columns × ${pitch().toFixed(2)} mm pitch.`);
  });
  $$('[data-pm]').forEach(b => b.addEventListener('click', () => setKey('paletteMode', b.dataset.pm)));
  $$('[data-hole]').forEach(b => b.addEventListener('click', () => setKey('kitHole', b.dataset.hole)));
  $$('[data-pmode]').forEach(b => b.addEventListener('click', () => setKey('kitPieceMode', b.dataset.pmode)));
  $$('[data-view]').forEach(b => b.addEventListener('click', () => { S.view = b.dataset.view; S.zoom = 1; save(); syncControls(); render(); }));
  $$('[data-tool]').forEach(b => b.addEventListener('click', () => { S.tool = b.dataset.tool; syncControls(); if (S.tool !== 'view' && S.view === 'original') { S.view = 'preview'; syncControls(); render(); } }));
  $('#zoomIn').addEventListener('click', () => zoomBy(1.25));
  $('#zoomOut').addEventListener('click', () => zoomBy(0.8));
  $$('[data-preset]').forEach(b => b.addEventListener('click', () => {
    const [s, g, sh] = b.dataset.preset.split(','); S.sizeMm = +s; S.gapMm = +g; S.shape = sh; save(); syncControls(); render();
    toast('ok', b.textContent, `${s} mm ${sh}, ${g} mm gap.`);
  }));
  $('#resetAdj').addEventListener('click', () => { ['brightness', 'contrast', 'saturation'].forEach(k => S[k] = 0); S.knockout = false; save(); syncControls(); schedule(); });

  // shapes
  const wrap = $('#shapes');
  wrap.innerHTML = Object.entries(SHAPES).map(([k, v]) => {
    const pts = polyOf(k, 32).map(([x, y]) => `${(x * 20 + 12).toFixed(2)},${(y * 20 + 12).toFixed(2)}`).join(' ');
    return `<button type="button" class="shape" role="radio" data-shape="${k}" aria-label="${v.label}"><svg viewBox="0 0 24 24"><polygon points="${pts}"/></svg><span>${v.label}</span></button>`;
  }).join('');
  wrap.addEventListener('click', e => { const b = e.target.closest('.shape'); if (b) setKey('shape', b.dataset.shape); });

  // source
  const file = $('#file');
  file.addEventListener('change', () => file.files[0] && loadFile(file.files[0]));
  $('#drop').addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  $('#emptyUpload').addEventListener('click', () => file.click());
  $('#sampleBtn').addEventListener('click', loadSample);
  $('#emptySample').addEventListener('click', loadSample);
  $('#clearBtn').addEventListener('click', () => { IMG = null; GRID = null; $('#thumb').hidden = true; $('#dropText').hidden = false; render(); renderLegend(); });
  ['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); $('#drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) $('#drop').classList.remove('over'); }));
  document.addEventListener('drop', e => { const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('image/')); if (f) loadFile(f); });
  document.addEventListener('paste', e => { const it = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/')); if (it) loadFile(it.getAsFile()); });

  // legend
  $('#legendBody').addEventListener('click', e => {
    const dl = e.target.closest('[data-dl]');
    if (dl) { exportColorPieces(+dl.dataset.dl); return; }
    const m = e.target.closest('[data-merge]'), rc = e.target.closest('[data-recolor]'), tr = e.target.closest('tr[data-j]');
    if (m) { const j = +m.dataset.merge, h = hex(GRID.palette[j]); if (removeColor(j)) { sortPalette(); edited = true; render(); renderLegend(); toast('ok', 'Merged', `${h} folded into its nearest color.`); } else toast('warn', 'Last color', 'A pattern needs at least one color.'); return; }
    if (rc) { const j = +rc.dataset.recolor, inp = $('#recolor'); inp.value = hex(GRID.palette[j]).toLowerCase(); inp.dataset.j = j; inp.click(); }
    if (tr) { selected = +tr.dataset.j; renderLegend(); if (S.tool === 'view') { S.tool = 'paint'; syncControls(); } }
  });
  $('#recolor').addEventListener('input', e => { const j = +e.target.dataset.j, c = parseHex(e.target.value); if (c && GRID?.palette[j]) { if (GRID.palette[j].name) c.name = GRID.palette[j].name; GRID.palette[j] = c; render(); renderLegend(); } });

  // canvas interaction
  let down = false;
  canvas.addEventListener('pointerdown', e => { if (S.tool === 'view' || !GRID) return; down = true; canvas.setPointerCapture(e.pointerId); act(e); });
  canvas.addEventListener('pointermove', e => { hover(e); if (down) act(e); });
  canvas.addEventListener('pointerup', () => { if (down) { down = false; renderLegend(); } });
  canvas.addEventListener('pointerleave', () => { $('#tip').hidden = true; });
  $('#stage').addEventListener('wheel', e => { if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.1 : 0.9); } }, { passive: false });
  window.addEventListener('resize', () => { clearTimeout(bind.rt); bind.rt = setTimeout(render, 100); });

  $$('[data-export]').forEach(b => b.addEventListener('click', () => doExport(b.dataset.export)));
}
function zoomBy(f) { S.zoom = clamp(S.zoom * f, 0.25, 12); syncControls(); render(); }

function cellAt(e) {
  if (!GRID || S.view === 'original') return null;
  const rc = canvas.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top;
  const r = Math.floor((y - view.oy) / view.P);
  const off = !view.chart && S.stagger && r % 2 ? 0.5 : 0;
  const c = Math.floor((x - view.ox) / view.P - off);
  if (r < 0 || c < 0 || r >= GRID.rows || c >= GRID.cols) return null;
  return { r, c, i: r * GRID.cols + c };
}
function hover(e) {
  const tip = $('#tip'), cell = cellAt(e);
  if (!cell) { tip.hidden = true; return; }
  const j = GRID.idx[cell.i];
  tip.innerHTML = j < 0 ? `ROW ${cell.r + 1} · COL ${cell.c + 1} · EMPTY` : `<i style="background:${hex(GRID.palette[j])}"></i>${symOf(j)} ${hex(GRID.palette[j])} · ROW ${cell.r + 1} · COL ${cell.c + 1}`;
  tip.hidden = false; tip.style.left = (e.clientX + 14) + 'px'; tip.style.top = (e.clientY + 14) + 'px';
}
let raf = 0;
function act(e) {
  const cell = cellAt(e); if (!cell) return;
  if (S.tool === 'pick') { const j = GRID.idx[cell.i]; if (j >= 0) { selected = j; S.tool = 'paint'; syncControls(); renderLegend(); } return; }
  const v = S.tool === 'erase' ? -1 : selected;
  if (GRID.idx[cell.i] === v) return;
  GRID.idx[cell.i] = v; edited = true;
  cancelAnimationFrame(raf); raf = requestAnimationFrame(() => render());
}

/* ================= loading ================= */
function loadFile(f) {
  if (!f || !f.type.startsWith('image/')) return toast('err', 'Not an image', 'Use PNG, JPG, WEBP, GIF or SVG.');
  const url = URL.createObjectURL(f), img = new Image();
  img.onload = () => useImage(img, url, f.name);
  img.onerror = () => toast('err', 'Could not read image', f.name);
  img.src = url;
}
function useImage(img, url, name) {
  IMG = img; IMGID++; edited = false;
  $('#thumb').src = url; $('#thumb').hidden = false; $('#dropText').hidden = true;
  if (S.lockAspect) S.rows = clamp(Math.round(S.cols * aspect()), 4, 300);
  if (S.view === 'original') S.view = 'preview';
  syncControls(); schedule();
  toast('ok', 'Image loaded', `${name} · ${img.naturalWidth}×${img.naturalHeight}px`);
}
function loadSample() {
  const c = document.createElement('canvas'); c.width = 600; c.height = 600; const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 600); sky.addColorStop(0, '#00C2CB'); sky.addColorStop(.55, '#FF7AD9'); sky.addColorStop(1, '#FFD700');
  g.fillStyle = sky; g.fillRect(0, 0, 600, 600);
  g.fillStyle = '#FFF4B0'; g.beginPath(); g.arc(300, 330, 130, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#FF00FF'; for (let i = 0; i < 5; i++) g.fillRect(150, 300 + i * 26, 300, 9 + i * 2);
  g.fillStyle = '#1b1b3a'; g.beginPath(); g.moveTo(0, 600); g.lineTo(0, 470); g.lineTo(140, 390); g.lineTo(260, 480); g.lineTo(390, 380); g.lineTo(600, 500); g.lineTo(600, 600); g.fill();
  g.fillStyle = '#000'; g.fillRect(0, 540, 600, 60);
  const img = new Image(); img.onload = () => useImage(img, img.src, 'sample.png'); img.src = c.toDataURL('image/png');
}

/* ================= exports ================= */
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
const baseName = () => `mixelpixel_${GRID.cols}x${GRID.rows}_${GRID.palette.length}c`;

function doExport(kind) {
  if (!GRID) return toast('warn', 'Nothing to export', 'Upload an image first.');
  try {
    if (kind === 'png') {
      const L = layoutMm(), P = Math.min(40, 8000 / (L.plateW / L.p)), mm = P / L.p, pad = 20;
      const c = document.createElement('canvas'); c.width = Math.round(L.plateW * mm + pad * 2); c.height = Math.round(L.plateH * mm + pad * 2);
      drawPreview(c.getContext('2d'), c.width, c.height, P, pad);
      c.toBlob(b => download(b, baseName() + '_preview.png'));
    } else if (kind === 'chart') {
      const P = clamp(Math.floor(7000 / Math.max(GRID.cols, GRID.rows)), 10, 28), gut = 36;
      const W = gut * 2 + GRID.cols * P, c = document.createElement('canvas');
      c.width = W; c.height = gut * 2 + GRID.rows * P + legendHeight(W - gut * 2) + 10;
      drawChart(c.getContext('2d'), P, gut, true);
      c.toBlob(b => download(b, baseName() + '_chart.png'));
    } else if (kind === 'svg') download(new Blob([buildSVG()], { type: 'image/svg+xml' }), baseName() + '.svg');
    else if (kind === 'csv') {
      const c = counts(), rows = [['symbol', 'hex', 'r', 'g', 'b', 'pieces']].concat(GRID.palette.map((p, j) => [symOf(j), hex(p), p.r, p.g, p.b, c[j]]));
      download(new Blob(['﻿' + rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' }), baseName() + '_colors.csv');
    } else if (kind === 'stl') exportSTL();
    else if (kind.startsWith('kit:')) exportKit(kind.slice(4));
    if (kind === 'stl' || kind.startsWith('kit:')) return;
    toast('ok', 'Exported', kind.toUpperCase() + ' downloaded.');
  } catch (e) { console.error(e); toast('err', 'Export failed', e.message); }
}

function buildSVG() {
  const L = layoutMm(), s = S.sizeMm, f = n => +n.toFixed(3);
  const pts = S.shape === 'circle' ? null : polyOf(S.shape);
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${f(L.plateW)}mm" height="${f(L.plateH)}mm" viewBox="0 0 ${f(L.plateW)} ${f(L.plateH)}">\n`;
  if (S.includeBase) out += `<rect id="plate" width="${f(L.plateW)}" height="${f(L.plateH)}" fill="${S.plateColor}"/>\n`;
  GRID.palette.forEach((p, j) => {
    out += `<g id="c${String(j + 1).padStart(2, '0')}_${hex(p).slice(1)}" fill="${hex(p)}">\n`;
    for (let r = 0; r < GRID.rows; r++) for (let c = 0; c < GRID.cols; c++) {
      if (GRID.idx[r * GRID.cols + c] !== j) continue;
      const [ux, uy] = cellCenter(c, r), x = L.m + ux * L.p, y = L.m + uy * L.p;
      out += pts ? `<polygon points="${pts.map(([a, b]) => f(x + a * s) + ',' + f(y + b * s)).join(' ')}"/>\n` : `<circle cx="${f(x)}" cy="${f(y)}" r="${f(s / 2)}"/>\n`;
    }
    out += '</g>\n';
  });
  return out + '</svg>\n';
}

/* ---------- STL ---------- */
function earClip(P) { // P: CCW [[x,y]...] → triangles as index triples
  const V = P.map((_, i) => i), T = [];
  const cross = (a, b, c) => (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]);
  const inside = (p, a, b, c) => { const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p); return d1 > 1e-12 && d2 > 1e-12 && d3 > 1e-12; };
  let guard = 0;
  while (V.length > 3 && guard++ < 5000) {
    let cut = false;
    for (let i = 0; i < V.length; i++) {
      const a = V[(i + V.length - 1) % V.length], b = V[i], c = V[(i + 1) % V.length];
      if (cross(a, b, c) <= 1e-12) continue;
      if (V.some(v => v !== a && v !== b && v !== c && inside(v, a, b, c))) continue;
      T.push([a, b, c]); V.splice(i, 1); cut = true; break;
    }
    if (!cut) { for (let i = 1; i < V.length - 1; i++) T.push([V[0], V[i], V[i + 1]]); return T; }
  }
  T.push([V[0], V[1], V[2]]); return T;
}
function stlWriter(triCount) {
  const buf = new ArrayBuffer(84 + triCount * 50), dv = new DataView(buf);
  const head = 'mixelpixel'; for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, triCount, true); let o = 84;
  return {
    tri(a, b, c) {
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
      [nx / l, ny / l, nz / l, ...a, ...b, ...c].forEach(v => { dv.setFloat32(o, v, true); o += 4; });
      dv.setUint16(o, 0, true); o += 2;
    },
    bytes: () => new Uint8Array(buf),
  };
}
function exportSTL() {
  const L = layoutMm(), s = S.sizeMm, z0 = S.includeBase ? S.baseMm : 0, z1 = z0 + S.heightMm;
  // unit polygon in y-up coords, CCW
  let poly = polyOf(S.shape, 20).map(([x, y]) => [x, -y]);
  let area = 0; poly.forEach((p, i) => { const q = poly[(i + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; });
  if (area < 0) poly.reverse();
  const tris = earClip(poly), n = poly.length, perPiece = tris.length * 2 + n * 2;
  const cnt = counts(), totalTris = total(cnt) * perPiece;
  const estMB = (totalTris * 50) / 1e6;
  if (estMB > 250 && !confirm(`These STLs will be about ${estMB.toFixed(0)} MB. Continue?`)) return;
  toast('info', 'Building STL', `${total(cnt).toLocaleString()} pieces…`);
  setTimeout(() => {
    const files = [];
    GRID.palette.forEach((p, j) => {
      if (!cnt[j]) return;
      const w = stlWriter(cnt[j] * perPiece);
      for (let r = 0; r < GRID.rows; r++) for (let c = 0; c < GRID.cols; c++) {
        if (GRID.idx[r * GRID.cols + c] !== j) continue;
        const [ux, uy] = cellCenter(c, r), cx = L.m + ux * L.p, cy = L.plateH - (L.m + uy * L.p);
        const B = poly.map(([x, y]) => [cx + x * s, cy + y * s, z0]), T = poly.map(([x, y]) => [cx + x * s, cy + y * s, z1]);
        tris.forEach(([a, b, d]) => { w.tri(T[a], T[b], T[d]); w.tri(B[a], B[d], B[b]); });
        for (let i = 0; i < n; i++) { const k = (i + 1) % n; w.tri(B[i], B[k], T[k]); w.tri(B[i], T[k], T[i]); }
      }
      files.push({ name: `${String(j + 1).padStart(2, '0')}_${symName(j)}_${hex(p).slice(1)}.stl`, data: w.bytes() });
    });
    if (S.includeBase) {
      const w = stlWriter(12), X = L.plateW, Y = L.plateH, Z = S.baseMm;
      const v = [[0, 0, 0], [X, 0, 0], [X, Y, 0], [0, Y, 0], [0, 0, Z], [X, 0, Z], [X, Y, Z], [0, Y, Z]];
      [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]].forEach(([a, b, c]) => w.tri(v[a], v[b], v[c]));
      files.unshift({ name: '00_base_plate.stl', data: w.bytes() });
    }
    const readme = [
      'MIXELPIXEL — 3D print files', '',
      `Grid ${GRID.cols} x ${GRID.rows}, shape ${S.shape}, size ${S.sizeMm} mm, gap ${S.gapMm} mm`,
      `Plate ${L.plateW.toFixed(1)} x ${L.plateH.toFixed(1)} mm, base ${S.includeBase ? S.baseMm + ' mm' : 'none'}, pieces ${S.heightMm} mm tall`, '',
      'HOW TO PRINT', '1. Select ALL the .stl files and drag them into your slicer together.',
      '2. When asked "load as a single object with multiple parts?", choose YES.',
      '3. Assign a filament to each part using the color list below.', '',
      'COLORS', ...GRID.palette.map((p, j) => `${String(j + 1).padStart(2, '0')}  ${symOf(j)}  ${hex(p)}  x${cnt[j]}`), '',
    ].join('\r\n');
    files.push({ name: 'README.txt', data: new TextEncoder().encode(readme) });
    download(zip(files), baseName() + '_stl.zip');
    toast('ok', 'STL ZIP ready', `${files.length - 1} files · ${(files.reduce((a, f) => a + f.data.length, 0) / 1e6).toFixed(1)} MB`);
  }, 30);
}
const symName = j => /[A-Za-z0-9]/.test(symOf(j)) ? symOf(j) : 'c' + (j + 1);

/* ---------- DIY board kit: pocketed base plate + color guides + loose pieces ----------
   The plate top is tiled cell by cell (square minus pocket, joined by a bridge so ear clipping
   can do it), plus fillers and a margin frame. Every shared edge is built from the same
   u/v → mm arithmetic, so neighbouring cells meet exactly and the mesh is watertight. */
class Mesh {
  constructor() { this.a = new Float32Array(9 * 4096); this.n = 0; }
  tri(a, b, c) {
    if ((this.n + 1) * 9 > this.a.length) { const g = new Float32Array(this.a.length * 2); g.set(this.a); this.a = g; }
    this.a.set([a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]], this.n++ * 9);
  }
  stl() {
    const w = stlWriter(this.n), A = this.a;
    for (let i = 0; i < this.n; i++) { const o = i * 9; w.tri([A[o], A[o + 1], A[o + 2]], [A[o + 3], A[o + 4], A[o + 5]], [A[o + 6], A[o + 7], A[o + 8]]); }
    return w.bytes();
  }
}
const area2 = P => { let a = 0; P.forEach((p, i) => { const q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; }); return a / 2; };
const ccw = (a, b, c) => ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 0 ? [a, b, c] : [a, c, b];
const at = (p, z) => [p[0], p[1], z];
function walls(m, poly, z0, z1, inward) { // poly in XY; outward-facing unless inward
  let pl = area2(poly) > 0 ? poly : poly.slice().reverse(); if (inward) pl = pl.slice().reverse();
  for (let i = 0; i < pl.length; i++) { const a = pl[i], b = pl[(i + 1) % pl.length]; m.tri(at(a, z0), at(b, z0), at(b, z1)); m.tri(at(a, z0), at(b, z1), at(a, z1)); }
}
function prism(m, poly, tris, z0, z1) {
  tris.forEach(([i, j, k]) => { const [a, b, c] = ccw(poly[i], poly[j], poly[k]); m.tri(at(a, z1), at(b, z1), at(c, z1)); m.tri(at(a, z0), at(c, z0), at(b, z0)); });
  walls(m, poly, z0, z1, false);
}
function unitShape(seg = 20) { const p = polyOf(S.shape, seg); if (area2(p) < 0) p.reverse(); return { poly: p, tris: earClip(p) }; }

function kitGeom() {
  const p = pitch(), want = S.sizeMm + S.kitClear, pocket = Math.min(want, p - 0.4), through = S.kitHole === 'through';
  const G = !through && S.kitGuides ? S.kitGuideH : 0;
  return { p, pocket, wall: p - pocket, limited: want > p - 0.4, through, F: through ? 0 : S.kitFloor, G, H: through ? S.kitThick : S.kitFloor + G + S.kitDepth };
}
function kitTiles() { // split along cell lines so each plate fits the printer bed
  const { p } = kitGeom(), m = S.kitMargin, cols = GRID.cols, rows = GRID.rows;
  const per = Math.max(1, Math.floor((S.kitBed - 2 * m) / p));
  const nx = S.stagger ? 1 : Math.ceil(cols / per), ny = S.stagger ? 1 : Math.ceil(rows / per), out = [];
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) out.push({ tx, ty, nx, ny,
    c0: Math.round(tx * cols / nx), c1: Math.round((tx + 1) * cols / nx), r0: Math.round(ty * rows / ny), r1: Math.round((ty + 1) * rows / ny) });
  return out;
}
function tileDims(t) {
  const { p } = kitGeom(), m = S.kitMargin;
  const ml = t.c0 === 0 ? m : 0, mr = t.c1 === GRID.cols ? m : 0, mt = t.r0 === 0 ? m : 0, mb = t.r1 === GRID.rows ? m : 0;
  const Wu = t.c1 - t.c0 + (S.stagger ? 0.5 : 0), Hu = t.r1 - t.r0;
  return { ml, mr, mt, mb, Wu, Hu, W: ml + Wu * p + mr, H: mt + Hu * p + mb };
}
function cellTemplate(scale) { // unit cell (±0.5), y down; ring = cell minus pocket, bridged at the top-right corner
  const hole = polyOf(S.shape, 20).map(([x, y]) => [x * scale, y * scale]); if (area2(hole) < 0) hole.reverse();
  const n = hole.length, A = [0.5, -0.5], tail = S.stagger ? [[0.5, 0.5], [0, 0.5], [-0.5, 0.5], [-0.5, -0.5], [0, -0.5]] : [[0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]];
  let mi = 0; hole.forEach((q, i) => { const b = hole[mi]; if (q[0] > b[0] + 1e-12 || (Math.abs(q[0] - b[0]) <= 1e-12 && q[1] < b[1])) mi = i; });
  const ring = [A]; for (let k = 0; k <= n; k++) ring.push(hole[((mi - k) % n + n) % n]); ring.push(A, ...tail);
  const full = [A, ...tail];
  return { hole, holeTris: earClip(hole), ring, ringTris: earClip(ring), full, fullTris: earClip(full) };
}

function buildBoardTile(t) {
  const K = kitGeom(), d = tileDims(t), tpl = cellTemplate(K.pocket / K.p), cols = GRID.cols;
  const plate = new Mesh(), guides = GRID.palette.map(() => null), foot = [];
  const P = (u, v) => [d.ml + (u - t.c0) * K.p, d.H - (d.mt + (v - t.r0) * K.p)];
  const X = x => x, Yv = y => d.H - y; // raw mm (y down) → XY for the frame corners
  const add = (pts, tris, z) => tris.forEach(([a, b, c]) => foot.push([pts[a], pts[b], pts[c], z]));
  for (let r = t.r0; r < t.r1; r++) for (let c = t.c0; c < t.c1; c++) {
    const cu = c + 0.5 + (S.stagger && r % 2 ? 0.5 : 0), cv = r + 0.5, j = GRID.idx[r * cols + c];
    const map = q => P(cu + q[0], cv + q[1]);
    if (j < 0 && !S.kitPocketEmpty) { add(tpl.full.map(map), tpl.fullTris, K.H); continue; }
    add(tpl.ring.map(map), tpl.ringTris, K.H);
    if (K.through) continue; // hole edges are left open → the outline pass walls them in
    const hole = tpl.hole.map(map);
    add(hole, tpl.holeTris, K.F);
    walls(plate, hole, K.F, K.H, true);
    if (K.G && j >= 0) prism(guides[j] || (guides[j] = new Mesh()), hole, tpl.holeTris, K.F, K.F + K.G);
  }
  if (S.stagger) for (let r = t.r0; r < t.r1; r++) { // half-cell fillers at the ragged row ends
    const [u0, u1] = r % 2 ? [0, 0.5] : [GRID.cols, GRID.cols + 0.5];
    const q = [P(u0, r), P(u1, r), P(u1, r + 1), P(u0, r + 1)]; add(q, [[0, 1, 2], [0, 2, 3]], K.H);
  }
  // margin frame: four strips, each fanned from its two outer corners to the pattern edge points
  const step = S.stagger ? 0.5 : 1, us = [], vs = [];
  for (let u = 0; u <= d.Wu + 1e-9; u += step) us.push(t.c0 + u);
  for (let v = t.r0; v <= t.r1; v++) vs.push(v);
  const strip = (L, O1, O2) => { const mid = L.length >> 1; for (let i = 0; i < L.length - 1; i++) foot.push([i < mid ? O1 : O2, L[i], L[i + 1], K.H]); foot.push([O1, L[mid], O2, K.H]); };
  const yTop = d.mt, yBot = d.mt + d.Hu * K.p, xL = d.ml, xR = d.ml + d.Wu * K.p;
  if (d.mt > 0) strip([...(d.ml > 0 ? [[X(0), Yv(yTop)]] : []), ...us.map(u => P(u, t.r0)), ...(d.mr > 0 ? [[X(d.W), Yv(yTop)]] : [])], [X(0), Yv(0)], [X(d.W), Yv(0)]);
  if (d.mb > 0) strip([...(d.ml > 0 ? [[X(0), Yv(yBot)]] : []), ...us.map(u => P(u, t.r1)), ...(d.mr > 0 ? [[X(d.W), Yv(yBot)]] : [])], [X(0), Yv(d.H)], [X(d.W), Yv(d.H)]);
  if (d.ml > 0) strip(vs.map(v => P(t.c0, v)), [X(0), Yv(yTop)], [X(0), Yv(yBot)]);
  if (d.mr > 0) strip(vs.map(v => P(t.c0 + d.Wu, v)), [X(d.W), Yv(yTop)], [X(d.W), Yv(yBot)]);
  void xL; void xR;
  // top/floor faces, the bottom, and walls around every edge that only one footprint triangle uses
  const key = p => Math.round(p[0] * 1e4) * 1e7 + Math.round(p[1] * 1e4), edges = new Map();
  foot.forEach(f => {
    const [a, b, c] = ccw(f[0], f[1], f[2]);
    plate.tri(at(a, f[3]), at(b, f[3]), at(c, f[3])); plate.tri(at(a, 0), at(c, 0), at(b, 0));
    [[a, b], [b, c], [c, a]].forEach(([p, q]) => { const kp = key(p), kq = key(q), k = kp < kq ? kp + '_' + kq : kq + '_' + kp, e = edges.get(k); if (e) e.n++; else edges.set(k, { n: 1, p, q }); });
  });
  edges.forEach(e => { if (e.n === 1) { plate.tri(at(e.p, 0), at(e.q, 0), at(e.q, K.H)); plate.tri(at(e.p, 0), at(e.q, K.H), at(e.p, K.H)); } });
  return { plate, guides, d };
}

function kitPieceCounts() { const c = counts(); return c.map(n => n ? Math.ceil(n * (1 + S.kitSpare / 100)) : 0); }
function sheetLayout() { const sp = S.sizeMm + 1.5, per = Math.max(1, Math.floor((S.kitBed - 10) / sp)); return { sp, per, sheet: per * per }; }
function buildPieces(n) { // n loose pieces packed on bed-sized sheets → array of Mesh
  const { poly, tris } = unitShape(), s = S.sizeMm, { sp, per, sheet } = sheetLayout(), out = [];
  for (let i = 0; i < n; i++) {
    if (i % sheet === 0) out.push(new Mesh());
    const k = i % sheet, x = 5 + (k % per + 0.5) * sp, y = 5 + (Math.floor(k / per) + 0.5) * sp;
    prism(out[out.length - 1], poly.map(([a, b]) => [x + a * s, y - b * s]), tris, 0, S.kitPieceH);
  }
  return out;
}
// Pieces to PRINT per color: exact (design + spares) or one full bed sheet for stock
function printCounts() { const pc = kitPieceCounts(); return S.kitPieceMode === 'sheet' ? pc.map(n => n ? sheetLayout().sheet : 0) : pc; }
function pieceFiles(j, n) {
  const sheets = buildPieces(n), dir = `${fileTag(j)}_x${n}/`;
  return sheets.map((m, k) => ({ name: dir + `pieces_${hex(GRID.palette[j]).slice(1)}${sheets.length > 1 ? `_sheet${k + 1}of${sheets.length}` : ''}.stl`, data: m.stl() }));
}

function kitInfoHTML() {
  if (!GRID) return 'Upload an image to size the board.';
  const K = kitGeom(), tiles = kitTiles(), d = tileDims(tiles[0]), pc = kitPieceCounts();
  let h = `Board: <b>${tiles.length === 1 ? `${d.W.toFixed(1)} × ${d.H.toFixed(1)}` : `${tiles.length} plates (${tiles[0].nx}×${tiles[0].ny})`}</b> × ${K.H.toFixed(1)} mm · ${K.through ? 'hole' : 'pocket'} ${K.pocket.toFixed(2)} mm · wall ${K.wall.toFixed(2)} mm`;
  h += `<br>Package: <b>${total(pc).toLocaleString()}</b> pieces in ${pc.filter(Boolean).length} colors (incl. ${S.kitSpare}% spare)`;
  if (S.kitPieceMode === 'sheet') h += `<br>Printing: one full sheet of <b>${sheetLayout().sheet}</b> per color`;
  if (K.wall < 0.8) h += `<br>⚠ Walls under 0.8 mm print poorly — raise Gap to ≥ ${(S.kitClear + 0.8).toFixed(1)} mm.`;
  if (K.limited) h += `<br>⚠ Hole shrunk to keep a 0.4 mm wall; pieces may not fit.`;
  if (S.stagger && (d.W > S.kitBed || d.H > S.kitBed)) h += `<br>⚠ Honeycomb boards can't be split — bigger than the bed.`;
  if (K.through && S.kitPieceH < S.kitThick) h += `<br>⚠ Pieces are shorter than the plate — they'll sit below the surface.`;
  if (!K.through && S.kitPieceH <= S.kitDepth) h += `<br>⚠ Pieces are no taller than the pocket — hard to see and remove.`;
  if (S.kitPieceMode === 'sheet' && Math.max(...pc) > sheetLayout().sheet) h += `<br>⚠ Some colors need more than one sheet for this design.`;
  return h;
}

const canvasPNG = c => { const b = atob(c.toDataURL('image/png').split(',')[1]), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
function chartCanvas() {
  const P = clamp(Math.floor(7000 / Math.max(GRID.cols, GRID.rows)), 10, 28), gut = 36, W = gut * 2 + GRID.cols * P, c = document.createElement('canvas');
  c.width = W; c.height = gut * 2 + GRID.rows * P + legendHeight(W - gut * 2) + 10; drawChart(c.getContext('2d'), P, gut, true); return c;
}
// One page to pack an order from: every color, how many pieces go in the bag, a tick box
function packingCanvas() {
  const pal = GRID.palette, cnt = counts(), pc = kitPieceCounts(), K = kitGeom(), tiles = kitTiles(), d = tileDims(tiles[0]);
  const rows = pal.map((p, j) => j).filter(j => cnt[j]), W = 1240, top = 250, rh = 62, c = document.createElement('canvas');
  c.width = W; c.height = top + rows.length * rh + 190; const g = c.getContext('2d');
  g.fillStyle = '#F5F5DC'; g.fillRect(0, 0, W, c.height);
  g.fillStyle = '#000'; g.font = '900 64px Archivo, sans-serif'; g.textBaseline = 'alphabetic'; g.fillText('PACKING LIST', 60, 110);
  g.font = '700 22px "Space Mono", monospace';
  g.fillText(`${GRID.cols}×${GRID.rows} ${S.shape} · ${S.sizeMm} mm pieces · ${pal.length} colors`, 60, 152);
  g.fillText(`Board ${tiles.length > 1 ? tiles.length + ' plates' : d.W.toFixed(0) + '×' + d.H.toFixed(0) + ' mm'} · ${K.through ? 'through holes' : 'pockets'} · spares ${S.kitSpare}%`, 60, 184);
  const cols = [60, 120, 200, 640, 820, 1010];
  g.fillRect(40, top - 46, W - 80, 40); g.fillStyle = '#fff'; g.font = '900 18px Archivo, sans-serif';
  ['✓', 'SYM', 'COLOR', 'HEX', 'IN DESIGN', 'PACK'].forEach((t, i) => g.fillText(t, cols[i], top - 19));
  rows.forEach((j, i) => {
    const p = pal[j], y = top + i * rh;
    g.fillStyle = i % 2 ? '#fff' : '#fbfbef'; g.fillRect(40, y, W - 80, rh);
    g.strokeStyle = '#000'; g.lineWidth = 3; g.strokeRect(cols[0], y + 15, 32, 32);
    g.fillStyle = hex(p); g.fillRect(cols[1], y + 11, 56, 40); g.strokeRect(cols[1], y + 11, 56, 40);
    g.fillStyle = luma(p) > 140 ? '#000' : '#fff'; g.font = '700 22px "Space Mono", monospace'; g.textAlign = 'center'; g.fillText(symOf(j), cols[1] + 28, y + 39); g.textAlign = 'left';
    g.fillStyle = '#000'; g.font = '900 24px Archivo, sans-serif'; g.fillText((p.name || `Color ${j + 1}`).slice(0, 28), cols[2], y + 40);
    g.font = '700 22px "Space Mono", monospace'; g.fillText(hex(p), cols[3], y + 40); g.fillText(cnt[j].toLocaleString(), cols[4], y + 40);
    g.font = '900 30px Archivo, sans-serif'; g.fillText(pc[j].toLocaleString(), cols[5], y + 42);
    g.strokeStyle = '#000'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(40, y + rh); g.lineTo(W - 40, y + rh); g.stroke();
  });
  const y = top + rows.length * rh + 20; g.lineWidth = 4; g.strokeRect(40, top - 46, W - 80, rows.length * rh + 46);
  g.fillStyle = '#FFD700'; g.fillRect(40, y + 10, W - 80, 64); g.strokeRect(40, y + 10, W - 80, 64);
  g.fillStyle = '#000'; g.font = '900 28px Archivo, sans-serif';
  g.fillText(`TOTAL  ${total(pc).toLocaleString()} PIECES  +  ${tiles.length} BASE PLATE${tiles.length > 1 ? 'S' : ''}  +  CHART`, 60, y + 53);
  g.font = '700 18px "Space Mono", monospace'; g.fillText('Tick each color as it goes in the bag.', 60, y + 120);
  return c;
}

function exportColorPieces(j) {
  if (!GRID) return; const n = printCounts()[j] || kitPieceCounts()[j];
  if (!n) return toast('warn', 'No pieces', 'This color is not used.');
  const f = pieceFiles(j, n);
  if (f.length === 1) download(new Blob([f[0].data], { type: 'model/stl' }), `${fileTag(j)}_x${n}.stl`); else download(zip(f), `${fileTag(j)}_x${n}.zip`);
  toast('ok', colorName(j), `${n} pieces${f.length > 1 ? ` on ${f.length} sheets` : ''}.`);
}

// what: 'plate' | 'pieces' | 'packing' | 'kit'
function exportKit(what) {
  const tiles = kitTiles(), K = kitGeom(), pc = kitPieceCounts(), pr = printCounts();
  if (what === 'packing') { packingCanvas().toBlob(b => download(b, baseName() + '_packing_list.png')); return toast('ok', 'Packing list', 'PNG downloaded.'); }
  toast('info', 'Building ' + (what === 'plate' ? 'base plate' : what === 'pieces' ? 'pieces' : 'kit'), 'One moment…');
  setTimeout(() => {
    try {
      const files = [], multi = tiles.length > 1, withPlate = what !== 'pieces', withPieces = what !== 'plate';
      if (withPlate) tiles.forEach(t => {
        const b = buildBoardTile(t), nm = multi ? `plate_r${t.ty + 1}c${t.tx + 1}` : 'base_plate', dir = what === 'kit' ? '00_base_plate/' : '';
        files.push({ name: dir + nm + '.stl', data: b.plate.stl() });
        b.guides.forEach((g, j) => { if (g) files.push({ name: `${dir}${nm}_guide_${fileTag(j)}.stl`, data: g.stl() }); });
      });
      if (what === 'plate' && files.length === 1) {
        download(new Blob([files[0].data], { type: 'model/stl' }), baseName() + '_base_plate.stl');
        return toast('ok', 'Base plate ready', `${(files[0].data.length / 1e6).toFixed(1)} MB STL`);
      }
      if (withPieces) GRID.palette.forEach((p, j) => { if (pr[j]) files.push(...pieceFiles(j, pr[j])); });
      if (what === 'kit') {
        files.push({ name: 'packing_list.png', data: canvasPNG(packingCanvas()) });
        files.push({ name: 'chart.png', data: canvasPNG(chartCanvas()) });
      }
      const cnt = counts();
      files.push({ name: 'README.txt', data: new TextEncoder().encode([
        'MIXELPIXEL — DIY board kit', '',
        `Grid ${GRID.cols} x ${GRID.rows}, ${S.shape} pieces ${S.sizeMm} mm x ${S.kitPieceH} mm tall, pitch ${K.p.toFixed(2)} mm`,
        K.through ? `Plate: ${K.H} mm thick with ${K.pocket.toFixed(2)} mm through holes (${S.kitClear} mm clearance). Pieces press in from the top.`
          : `Plate: floor ${K.F} mm${K.G ? ` + ${K.G} mm color guide` : ''} + ${S.kitDepth} mm pockets = ${K.H.toFixed(1)} mm; pockets ${K.pocket.toFixed(2)} mm (${S.kitClear} mm clearance)`,
        multi ? `Split into ${tiles.length} plates (${tiles[0].nx} across × ${tiles[0].ny} down) that butt together edge to edge.` : '', '',
        'PRINT', '- Base plate: one color.' + (K.G ? ' Load the _guide_ files with it as parts of one object for colored pocket floors.' : ''),
        '- Pieces: each color folder = one filament. Print them separately and keep them bagged by color.',
        S.kitPieceMode === 'sheet' ? '- Pieces are full bed sheets for stock; pack the PACK count below per order.' : '- Piece files already hold the PACK count below.', '',
        'PACK  (no, symbol, name, hex, pockets in design, pieces to pack)',
        ...GRID.palette.map((p, j) => `${String(j + 1).padStart(2, '0')}  ${symOf(j)}  ${(p.name || '-').padEnd(16)}  ${hex(p)}  ${String(cnt[j]).padStart(5)}  ${String(pc[j]).padStart(5)}`),
        `TOTAL pieces to pack: ${total(pc)}  + ${tiles.length} base plate(s) + chart`, '',
      ].join('\r\n')) });
      download(zip(files), baseName() + { plate: '_base_plates', pieces: '_pieces_by_color', kit: '_diy_kit' }[what] + '.zip');
      toast('ok', 'ZIP ready', `${files.length} files · ${(files.reduce((a, f) => a + f.data.length, 0) / 1e6).toFixed(1)} MB`);
    } catch (e) { console.error(e); toast('err', 'Kit export failed', e.message); }
  }, 30);
}

/* ---------- minimal ZIP (store, no compression) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(d) { let c = 0xFFFFFFFF; for (let i = 0; i < d.length; i++) c = CRC[(c ^ d[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const parts = [], cd = [], enc = new TextEncoder(); let off = 0;
  const now = new Date(), time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  files.forEach(f => {
    const name = enc.encode(f.name), crc = crc32(f.data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, time, true); h.setUint16(12, date, true); h.setUint32(14, crc, true);
    h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h.buffer, name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, time, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    cd.push(c.buffer, name);
    off += 30 + name.length + f.data.length;
  });
  const cdSize = cd.reduce((a, p) => a + p.byteLength, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cd, e.buffer], { type: 'application/zip' });
}

/* ================= toasts ================= */
function toast(type, title, msg) {
  const el = document.createElement('div'); el.className = 'toast ' + type;
  el.innerHTML = `<div><b></b><span></span></div>`; $('b', el).textContent = title; $('span', el).textContent = msg || '';
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 3600);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

/* ================= boot ================= */
bind(); syncControls(); render(); renderLegend();
