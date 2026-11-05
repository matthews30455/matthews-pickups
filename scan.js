// Image helpers: vehicle photo compression, invoice "scan" look, and PDF building.

// iPhone photos (HEIC) open in Safari but not in Chrome, so they are converted to JPEG here.
const HEIC_TO = "https://cdn.jsdelivr.net/npm/heic-to@1.6.7/dist/heic-to.js";       // current libheif (newer iPhones)
const HEIC2ANY = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js"; // older fallback
let heic2anyPromise;
function loadHeic2any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  heic2anyPromise ||= new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = HEIC2ANY;
    sc.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error("HEIC converter didn't load")));
    sc.onerror = () => { heic2anyPromise = null; reject(new Error("HEIC converter needs internet")); };
    document.head.appendChild(sc);
  });
  return heic2anyPromise;
}
export const isHeic = (file) => /hei[cf]/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || "");
async function looksHeic(file) {               // "ftypheic"/"ftypmif1"… in the first bytes, whatever the name says
  try {
    const head = new TextDecoder("latin1").decode(await file.slice(4, 12).arrayBuffer());
    return /^ftyp(hei|hev|mif|msf|avi)/.test(head);
  } catch { return false; }
}
async function decodeBlob(blob) {
  const url = URL.createObjectURL(blob);
  try { const img = new Image(); img.decoding = "async"; img.src = url; await img.decode(); return img; }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
/** Opens any photo, including iPhone HEIC on computers whose browser can't read HEIC (converted to JPEG first). */
export async function loadImage(file) {
  try { return await decodeBlob(file); }                 // Safari reads HEIC itself; JPEG/PNG everywhere
  catch { /* try HEIC conversion */ }
  if (isHeic(file) || await looksHeic(file)) {
    try {
      const { heicTo } = await import(HEIC_TO);
      return await decodeBlob(await heicTo({ blob: file, type: "image/jpeg", quality: 0.9 }));
    } catch (e) { console.warn("heic-to failed", e); }
    try {
      const h = await loadHeic2any();
      let out = await h({ blob: file, toType: "image/jpeg", quality: 0.9 });
      if (Array.isArray(out)) out = out[0];
      return await decodeBlob(out);
    } catch (e) { console.warn("heic2any failed", e); }
    throw new Error("This iPhone photo (HEIC) couldn't be converted. Check the internet, or export it as JPEG.");
  }
  throw new Error("This picture format can't be opened. Try a JPG/PNG, or take the photo again.");
}

/** Any picture → one-page canvas (no scan filter); used for a pickup sheet photo */
export async function plainCanvas(file, maxSide = 1700) {
  const img = await loadImage(file);
  const [w, h] = fit(img.naturalWidth, img.naturalHeight, maxSide);
  const c = canvasOf(w, h);
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, w, h); x.drawImage(img, 0, 0, w, h);
  return c;
}

function fit(w, h, max) {
  const s = Math.min(1, max / Math.max(w, h));
  return [Math.round(w * s), Math.round(h * s)];
}

function canvasOf(w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

const toBlob = (canvas, type, q) =>
  new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("Could not encode image"))), type, q));

/** Vehicle photo → JPEG, longest side ≤ maxSide. Always JPEG, so HEIC never reaches the server. */
export async function compressPhoto(file, maxSide = 2048, quality = 0.85) {
  const img = await loadImage(file);
  const [w, h] = fit(img.naturalWidth, img.naturalHeight, maxSide);
  const c = canvasOf(w, h);
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return toBlob(c, "image/jpeg", quality);
}

/**
 * Find the sheet of paper in a photo (bright, low-colour area not touching the photo edge).
 * Returns its 4 corners [TL, TR, BR, BL] in the canvas' pixels, or null when unsure (then nothing is cropped).
 */
export function findPaper(src) {
  const [w, h] = fit(src.width, src.height, 360);
  const t = canvasOf(w, h), tx = t.getContext("2d", { willReadFrequently: true });
  tx.drawImage(src, 0, 0, w, h);
  const d = tx.getImageData(0, 0, w, h).data, n = w * h;
  const score = new Float32Array(n), hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = d[j], g = d[j + 1], b = d[j + 2];
    const s = Math.max(0, Math.min(255, (r + g + b) / 3 - 1.2 * (Math.max(r, g, b) - Math.min(r, g, b))));
    score[i] = s; hist[s | 0]++;
  }
  // Otsu threshold: paper vs background
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sB = 0, wB = 0, best = 0, th = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sB += i * hist[i]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; th = i; }
  }
  const paper = new Uint8Array(n); for (let i = 0; i < n; i++) paper[i] = score[i] > th ? 1 : 0;
  // background = dark area connected to the photo edge; everything else (paper + the text on it) is the sheet
  const bg = new Uint8Array(n), stack = [];
  const push = (i) => { if (!bg[i] && !paper[i]) { bg[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) { const i = stack.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1); if (x < w - 1) push(i + 1); if (y > 0) push(i - w); if (y < h - 1) push(i + w); }
  // biggest connected sheet
  const lab = new Int32Array(n); let bestLab = 0, bestN = 0, cur = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (bg[s0] || lab[s0]) continue;
    cur++; let cnt = 0; lab[s0] = cur; stack.push(s0);
    while (stack.length) { const i = stack.pop(); cnt++; const x = i % w, y = (i / w) | 0;
      for (const k of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
        if (k >= 0 && !bg[k] && !lab[k]) { lab[k] = cur; stack.push(k); } }
    if (cnt > bestN) { bestN = cnt; bestLab = cur; }
  }
  if (bestN < n * 0.2 || bestN > n * 0.97) return null;           // no clear sheet, or the sheet fills the photo already
  let tl = [0, 0, Infinity], tr = [0, 0, -Infinity], br = [0, 0, -Infinity], bl = [0, 0, Infinity];
  for (let i = 0; i < n; i++) if (lab[i] === bestLab) {
    const x = i % w, y = (i / w) | 0;
    if (x + y < tl[2]) tl = [x, y, x + y]; if (x + y > br[2]) br = [x, y, x + y];
    if (x - y > tr[2]) tr = [x, y, x - y]; if (x - y < bl[2]) bl = [x, y, x - y];
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [x, y]);
  // sanity: a real quadrilateral that covers most of the sheet's pixels
  let area = 0; for (let i = 0; i < 4; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % 4]; area += x1 * y2 - x2 * y1; }
  area = Math.abs(area) / 2;
  if (area < bestN * 0.85 || area > bestN * 1.25 || area > n * 0.97) return null;
  const s = src.width / w;
  return q.map(([x, y]) => [x * s, y * s]);
}

/** Cut the sheet out of the photo and make it a straight rectangle (perspective correction). */
export function warpPaper(src, q) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const W = Math.round((dist(q[0], q[1]) + dist(q[3], q[2])) / 2), H = Math.round((dist(q[0], q[3]) + dist(q[1], q[2])) / 2);
  // unit square → quad (Heckbert)
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3, dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den, hh = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + hh * x3, c = x0, d = y1 - y0 + g * y1, e = y3 - y0 + hh * y3, f = y0;
  const sd = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, src.width, src.height).data, sw = src.width, shh = src.height;
  const out = canvasOf(W, H), ox = out.getContext("2d"), od = ox.createImageData(W, H), o = od.data;
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W, z = g * u + hh * v + 1;
      const sx = Math.min(sw - 2, Math.max(0, (a * u + b * v + c) / z)), sy = Math.min(shh - 2, Math.max(0, (d * u + e * v + f) / z));
      const ix = sx | 0, iy = sy | 0, fx = sx - ix, fy = sy - iy, p = (iy * sw + ix) * 4, k = (y * W + x) * 4;
      for (let ch = 0; ch < 3; ch++)
        o[k + ch] = (sd[p + ch] * (1 - fx) + sd[p + 4 + ch] * fx) * (1 - fy) + (sd[p + sw * 4 + ch] * (1 - fx) + sd[p + sw * 4 + 4 + ch] * fx) * fy;
      o[k + 3] = 255;
    }
  }
  ox.putImageData(od, 0, 0);
  return out;
}
/** Photo canvas → just the sheet (or unchanged when no clear sheet is found). */
export function cropToPaper(c) {
  try { const q = findPaper(c); return q ? warpPaper(c, q) : c; } catch (e) { console.warn("crop", e); return c; }
}

/**
 * Invoice photo → clean black-and-white "scan".
 * Removes shadows by dividing by an estimate of the paper brightness, then stretches contrast.
 * Returns a canvas (grayscale) the caller can rotate / encode.
 */
export async function scanInvoice(file, maxSide = 2600) {
  const img = await loadImage(file);
  const [w0, h0] = fit(img.naturalWidth, img.naturalHeight, maxSide);
  const photo = canvasOf(w0, h0);
  photo.getContext("2d").drawImage(img, 0, 0, w0, h0);
  return scanCanvas(cropToPaper(photo));
}
/** Canvas (photo or rendered PDF page) → clean black-and-white scan. */
export function scanCanvas(c) {
  const w = c.width, h = c.height;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, w, h);
  const px = id.data;

  // 1) grayscale
  const n = w * h;
  const gray = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) gray[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];

  // 2) paper-brightness map on a small grid: max filter (wipes out text) then box blur
  const cell = 16;
  const sw = Math.max(1, Math.ceil(w / cell)), sh = Math.max(1, Math.ceil(h / cell));
  let small = new Float32Array(sw * sh);
  for (let sy = 0; sy < sh; sy++) for (let sx = 0; sx < sw; sx++) {
    // 90th percentile-ish: average of the brighter half of a few samples
    let best = 0, sum = 0, cnt = 0;
    for (let y = sy * cell; y < Math.min(h, (sy + 1) * cell); y += 4)
      for (let x = sx * cell; x < Math.min(w, (sx + 1) * cell); x += 4) {
        const v = gray[y * w + x]; sum += v; cnt++; if (v > best) best = v;
      }
    small[sy * sw + sx] = cnt ? (best * 0.7 + (sum / cnt) * 0.3) : 255;
  }
  const pass = (src, op) => {
    const out = new Float32Array(sw * sh);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      let acc = op === "max" ? 0 : 0, k = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = Math.min(sh - 1, Math.max(0, y + dy)), xx = Math.min(sw - 1, Math.max(0, x + dx));
        const v = src[yy * sw + xx];
        if (op === "max") acc = Math.max(acc, v); else { acc += v; k++; }
      }
      out[y * sw + x] = op === "max" ? acc : acc / k;
    }
    return out;
  };
  small = pass(pass(small, "max"), "max");
  small = pass(pass(pass(small, "blur"), "blur"), "blur");

  // 3) normalise each pixel against the paper brightness (bilinear sample of the small map)
  const norm = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, Math.max(0, y / cell - 0.5)), y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, Math.max(0, x / cell - 0.5)), x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const bg = (small[y0 * sw + x0] * (1 - tx) + small[y0 * sw + x1] * tx) * (1 - ty) +
                 (small[y1 * sw + x0] * (1 - tx) + small[y1 * sw + x1] * tx) * ty;
      const v = Math.min(255, (gray[y * w + x] / Math.max(bg, 40)) * 255);
      norm[y * w + x] = v;
      hist[v | 0]++;
    }
  }

  // 4) contrast stretch: darkest 1% → black, anything near paper → white
  let lo = 0, acc = 0;
  while (lo < 255 && (acc += hist[lo]) < n * 0.01) lo++;
  const hi = 225;
  lo = Math.min(lo, 120);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    let v = ((norm[i] - lo) * 255) / (hi - lo);
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    v = 255 * Math.pow(v / 255, 1.6); // deepen greys so text stays crisp
    px[j] = px[j + 1] = px[j + 2] = v; px[j + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return rotateCanvas(c, uprightTurns(c));
}

/**
 * Guess how many 90° turns make the text on a scanned page run left-to-right.
 * Lines of text make the ink profile "stripy" along one axis; if the stripes run vertically the page is sideways.
 * Which way to turn: lines of left-aligned text all start at the same spot, so the aligned end is the start of the line.
 * Returns 0 (already upright), 1 (turn clockwise) or 3 (turn counter-clockwise).
 */
export function uprightTurns(c) {
  const [w, h] = fit(c.width, c.height, 600);
  const t = canvasOf(w, h), x = t.getContext("2d", { willReadFrequently: true });
  x.drawImage(c, 0, 0, w, h);
  const d = x.getImageData(0, 0, w, h).data;
  const ink = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) ink[i] = d[j] < 110 ? 1 : 0;
  const rows = new Float64Array(h), cols = new Float64Array(w);
  for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) if (ink[y * w + xx]) { rows[y]++; cols[xx]++; }
  // between lines of text there are completely blank rows; blank columns are rare because word gaps don't line up.
  // So inside the inked area: many blank rows = text is horizontal, many blank columns = the page is sideways.
  const span = (a) => { let lo = 0, hi = a.length - 1; while (lo < hi && !a[lo]) lo++; while (hi > lo && !a[hi]) hi--; return [lo, hi]; };
  const blank = (a) => { const [lo, hi] = span(a); let n = 0; for (let i = lo; i <= hi; i++) if (a[i] <= 1) n++; return n / Math.max(1, hi - lo + 1); };
  const rs = blank(rows), cs = blank(cols);
  if (!(cs > 0.08 && cs > rs * 1.5)) return 0;         // text runs left-right (or unsure): leave as is
  // sideways: each text column is a line; compare how aligned the line starts are at the top vs the bottom
  const tops = [], bots = [];
  for (let xx = 0; xx < w; xx++) {
    if (cols[xx] < 4) continue;
    let a = -1, b = -1;
    for (let y = 0; y < h; y++) if (ink[y * w + xx]) { if (a < 0) a = y; b = y; }
    tops.push(a); bots.push(b);
  }
  // share of lines that start / end at the same spot (±1 px on the small image): the aligned side is the left margin
  const aligned = (v) => { const hgm = new Map(); for (const p of v) { const k = p >> 1; hgm.set(k, (hgm.get(k) || 0) + 1); }
    let best = 0; for (const [k, n] of hgm) best = Math.max(best, n + (hgm.get(k - 1) || 0) + (hgm.get(k + 1) || 0)); return best / Math.max(1, v.length); };
  // lines aligned at the top → the left margin is at the top (page turned clockwise) → turn it back counter-clockwise
  const at = aligned(tops), ab = aligned(bots);
  if (Math.abs(at - ab) > 0.05) return at > ab ? 3 : 1;
  // both ends line up (tables, right-aligned amounts): the top of an invoice (logo, addresses) carries more ink,
  // and a page turned clockwise has its top on the right
  let left = 0, right = 0;
  for (let xx = 0; xx < w; xx++) (xx < w / 2 ? (left += cols[xx]) : (right += cols[xx]));
  return right >= left ? 3 : 1;
}

/** Rotate a canvas by 90° steps. */
export function rotateCanvas(src, quarterTurns) {
  const q = ((quarterTurns % 4) + 4) % 4;
  if (!q) return src;
  const swap = q % 2 === 1;
  const c = canvasOf(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((q * Math.PI) / 2);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

let jsPdfPromise;
function loadJsPdf() {
  if (window.jspdf?.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
  jsPdfPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";
    s.onload = () => resolve(window.jspdf.jsPDF);
    s.onerror = () => { jsPdfPromise = null; reject(new Error("PDF tool didn't load — check internet and try again")); };
    document.head.appendChild(s);
  });
  return jsPdfPromise;
}
export const preloadPdf = () => loadJsPdf().catch(() => {});

/** Pages (canvases) → one Letter-size PDF blob. */
export async function buildPdf(canvases, title = "Invoice") {
  const JsPDF = await loadJsPdf();
  const doc = new JsPDF({ unit: "pt", format: "letter", compress: true });
  const PW = 612, PH = 792, M = 18;
  canvases.forEach((c, i) => {
    if (i) doc.addPage("letter", "portrait");
    const s = Math.min((PW - 2 * M) / c.width, (PH - 2 * M) / c.height);
    const w = c.width * s, h = c.height * s;
    doc.addImage(c.toDataURL("image/jpeg", 0.85), "JPEG", (PW - w) / 2, M, w, h, undefined, "MEDIUM");
  });
  doc.setProperties({ title });
  return doc.output("blob");
}

/** Small preview image for a canvas */
export function thumb(canvas, max = 240) {
  const [w, h] = fit(canvas.width, canvas.height, max);
  const c = canvasOf(w, h);
  c.getContext("2d").drawImage(canvas, 0, 0, w, h);
  return c.toDataURL("image/jpeg", 0.7);
}
