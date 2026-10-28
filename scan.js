// Image helpers: vehicle photo compression, invoice "scan" look, and PDF building.

let heicPromise;
function loadHeic2any() {
  if (window.heic2any) return Promise.resolve(window.heic2any);
  heicPromise ||= new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
    sc.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error("HEIC converter didn't load")));
    sc.onerror = () => { heicPromise = null; reject(new Error("HEIC converter needs internet")); };
    document.head.appendChild(sc);
  });
  return heicPromise;
}
export const isHeic = (file) => /hei[cf]/i.test(file.type || "") || /\.(heic|heif)$/i.test(file.name || "");
async function decodeBlob(blob) {
  const url = URL.createObjectURL(blob);
  try { const img = new Image(); img.decoding = "async"; img.src = url; await img.decode(); return img; }
  finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}
/** Opens any photo, including iPhone HEIC on computers whose browser can't read HEIC (converted to JPEG first). */
export async function loadImage(file) {
  try { return await decodeBlob(file); }                 // Safari reads HEIC itself; JPEG/PNG everywhere
  catch { /* try HEIC conversion */ }
  if (isHeic(file) || !file.type) {
    try {
      const h = await loadHeic2any();
      let out = await h({ blob: file, toType: "image/jpeg", quality: 0.9 });
      if (Array.isArray(out)) out = out[0];
      return await decodeBlob(out);
    } catch { /* fall through */ }
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
export async function compressPhoto(file, maxSide = 1600, quality = 0.75) {
  const img = await loadImage(file);
  const [w, h] = fit(img.naturalWidth, img.naturalHeight, maxSide);
  const c = canvasOf(w, h);
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return toBlob(c, "image/jpeg", quality);
}

/**
 * Invoice photo → clean black-and-white "scan".
 * Removes shadows by dividing by an estimate of the paper brightness, then stretches contrast.
 * Returns a canvas (grayscale) the caller can rotate / encode.
 */
export async function scanInvoice(file, maxSide = 1700) {
  const img = await loadImage(file);
  const [w, h] = fit(img.naturalWidth, img.naturalHeight, maxSide);
  const c = canvasOf(w, h);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
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
  return c;
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
    doc.addImage(c.toDataURL("image/jpeg", 0.6), "JPEG", (PW - w) / 2, M, w, h, undefined, "FAST");
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
