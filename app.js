import { SUPABASE_URL, SUPABASE_ANON_KEY, LOGIN_DOMAIN } from "./config.js";
import { outbox } from "./queue.js";
import { compressPhoto, scanInvoice, rotateCanvas, buildPdf, thumb, preloadPdf, loadImage, plainCanvas } from "./scan.js";

// ─────────────────────────────────────────────────────────────── constants
const VERSION = "1.10.2";
const TZ = "America/Toronto";
const BUCKET = "pickups";
const VEHICLE_TYPES = ["Car", "SUV", "Pickup", "Van", "Truck", "Motorcycle", "Other"];
const PAY_TYPES = [
  ["cash", "Cash"], ["etransfer", "E-Transfer"], ["cheque", "Cheque"], ["credit_card", "Credit Card"],
];
const PAY_LABEL = Object.fromEntries(PAY_TYPES);
const EXTRAS = [["D", "Dry run"], ["HT", "Heavy tow"], ["L", "Labor"], ["T", "Retow"], ["O", "Other fee"]];
const DRIVES = ["FWD", "RWD", "AWD", "4WD"];
// most common car colours first; swatch shown on each button
const COLORS = [["White", "#ffffff"], ["Black", "#111111"], ["Grey", "#7b8189"], ["Silver", "#c9ced6"], ["Blue", "#2f6fd6"],
  ["Dark Blue", "#1d2f5e"], ["Red", "#d32f2f"], ["Burgundy", "#7a1f2b"], ["Green", "#2e7d32"], ["Brown", "#6d4c33"],
  ["Beige", "#d8c7a3"], ["Gold", "#c9a227"], ["Yellow", "#f2d230"], ["Orange", "#ef7d1a"], ["Purple", "#6a3d9a"], ["Other", ""]];
const OTHER = "__other";
// Progi "Vehicle" section
const AIRBAGS = ["Driver steering wheel", "Passenger dashboard", "Driver side seat", "Passenger side seat", "Driver knees", "Passenger knees", "Driver curtain", "Passenger curtain", "Rear left seat side", "Rear right seat side"];
const EQUIPMENT = ["Air conditioning", "Sunroof"];
const BROKEN = ["Engine", "Transmission", "Transfer case", "Dashboard"];
const MISSING = ["Radio", "Catalyst"];
const PROGI_MIN_PHOTOS = 12;
const VPIC = "https://vpic.nhtsa.dot.gov/api/vehicles/";
const MAKES_RAW = ["Acura","Alfa Romeo","Audi","BMW","Buick","Cadillac","Chevrolet","Chrysler","Dodge","Fiat","Ford","Genesis","GMC","Honda","Hyundai","Infiniti","Jaguar","Jeep","Kia","Land Rover","Lexus","Lincoln","Mazda","Mercedes-Benz","Mini","Mitsubishi","Nissan","Polestar","Pontiac","Porsche","Ram","Saturn","Smart","Subaru","Suzuki","Tesla","Toyota","Volkswagen","Volvo","Harley-Davidson","Yamaha","Kawasaki","Freightliner","International","Hino","Isuzu","Scion","Mercury","Oldsmobile","Hummer","Maserati","Bentley","Land Rover","Rivian"];
const MAKES = [...new Set(MAKES_RAW)].sort((a, b) => a.localeCompare(b));

// ─────────────────────────────────────────────────────────────── tiny helpers
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => (n == null || n === "" ? "" : "$" + Number(n).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const fmtTime = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, hour: "numeric", minute: "2-digit" });
const fmtShort = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, month: "short", day: "numeric" });
const dayKey = (d) => fmtDay.format(new Date(d)); // YYYY-MM-DD in Toronto
const isToday = (d) => dayKey(d) === dayKey(new Date());
const whenLabel = (d) => !d || isNaN(new Date(d)) ? "—" : (isToday(d) ? "Today " : fmtShort.format(new Date(d)) + ", ") + fmtTime.format(new Date(d));

function tzOffsetMin(date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).formatToParts(date);
  const m = (p.find((x) => x.type === "timeZoneName")?.value || "GMT-5").match(/GMT([+-]\d+)(?::(\d+))?/);
  return m ? Number(m[1]) * 60 + Math.sign(Number(m[1])) * Number(m[2] || 0) : -300;
}
/** Toronto midnight at the start of a YYYY-MM-DD day (plus `addDays`), as an ISO string */
function torontoDayStart(ymd, addDays = 0) {
  const [y, mo, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d + addDays));
  return new Date(guess.getTime() - tzOffsetMin(guess) * 60000).toISOString();
}
/** Toronto midnight `daysAgo` days back, as an ISO string */
function torontoMidnight(daysAgo = 0) {
  const [y, mo, d] = dayKey(new Date()).split("-").map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d - daysAgo));
  return new Date(guess.getTime() - tzOffsetMin(guess) * 60000).toISOString();
}

function titleMake(s) {
  const t = String(s || "").trim();
  const known = MAKES.find((m) => m.toLowerCase() === t.toLowerCase());
  if (known) return known;
  return t === t.toUpperCase() ? t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : t.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── VIN + vehicle lists (NHTSA vPIC: free, no key) ──────────────────
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
function vinCheckOk(vin) {
  const map = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 };
  const w = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
  let sum = 0;
  for (let i = 0; i < 17; i++) { const c = vin[i]; sum += (/\d/.test(c) ? +c : map[c]) * w[i]; }
  const r = sum % 11;
  return vin[8] === (r === 10 ? "X" : String(r));
}
async function vpic(path) {
  if (window.__VPIC_MOCK__) return window.__VPIC_MOCK__(path);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try {
    const res = await fetch(VPIC + path + (path.includes("?") ? "&" : "?") + "format=json", { signal: ctl.signal });
    if (!res.ok) throw new Error("Vehicle lookup failed");
    return (await res.json()).Results || [];
  } finally { clearTimeout(t); }
}
function mapDrive(d) {
  d = String(d || "").toUpperCase();
  if (!d) return "";
  if (d.startsWith("AWD") || d.includes("ALL-WHEEL") || d.includes("ALL WHEEL")) return "AWD";
  if (d.startsWith("4WD") || d.includes("4X4") || d.includes("4-WHEEL") || d.includes("4WD")) return "4WD";
  if (d.startsWith("FWD") || d.includes("FRONT")) return "FWD";
  if (d.startsWith("RWD") || d.includes("REAR")) return "RWD";
  if (d.includes("4X2") || d.includes("2WD")) return "2WD"; // front or rear not stated: driver picks
  return "";
}
function mapType(vt, body) {
  vt = String(vt || "").toUpperCase(); body = String(body || "").toUpperCase();
  if (vt.includes("MOTORCYCLE")) return "Motorcycle";
  if (body.includes("PICKUP")) return "Pickup";
  if (body.includes("VAN")) return "Van";
  if (body.includes("SPORT UTILITY") || body.includes("CROSSOVER") || vt.includes("MULTIPURPOSE")) return "SUV";
  if (vt.includes("TRUCK") || vt.includes("BUS") || vt.includes("INCOMPLETE")) return "Truck";
  if (vt.includes("PASSENGER")) return "Car";
  return "";
}
// When NHTSA leaves gaps (common for Canadian-built cars) we fill from the model name.
const SUV_RE = /\b(rav4|cr-?v|hr-?v|rogue|murano|pathfinder|armada|kicks|qashqai|juke|escape|edge|explorer|expedition|bronco|ecosport|flex|equinox|traverse|tahoe|suburban|blazer|trax|trailblazer|terrain|acadia|yukon|envision|encore|enclave|tucson|santa fe|kona|palisade|venue|ioniq 5|sportage|sorento|telluride|seltos|niro|soul|cx-?\d+|cx-30|forester|outback|crosstrek|ascent|xv|highlander|4runner|sequoia|venza|c-hr|corolla cross|land cruiser|pilot|passport|cherokee|grand cherokee|compass|renegade|wrangler|durango|journey|nitro|patriot|liberty|outlander|rvr|eclipse cross|tiguan|atlas|taos|touareg|q[3578]|x[1-7]|gl[abcse]|ml|gle|glk|nx|rx|ux|gx|lx|rdx|mdx|qx\d+|xt[456]|escalade|srx|navigator|aviator|nautilus|corsair|mkx|mkc|model [yx]|macan|cayenne|range rover|discovery|evoque|velar|countryman|xc\d0|f-pace|e-pace|stelvio|mustang mach-e|ev9|ex30|bz4x)\b/i;
const PICKUP_RE = /\b(f-?150|f-?250|f-?350|ranger|maverick|silverado|colorado|sierra|canyon|ram|1500|2500|3500|tacoma|tundra|frontier|titan|ridgeline|gladiator|santa cruz|cybertruck|dakota)\b/i;
const VAN_RE = /\b(odyssey|sienna|caravan|grand caravan|pacifica|voyager|transit|e-?series|econoline|sprinter|metris|express|savana|promaster|nv200|nv\d+|carnival|sedona|quest|town (and|&) country|routan|kona electric van)\b/i;
const RWD_RE = /\b(mustang|camaro|corvette|challenger|charger|300|magnum|genesis|g70|g80|g90|is|gs|ls|rc|lc|q50|q60|q70|g37|ats|cts|ct4|ct5|3 series|4 series|5 series|[2-8]\d\di|c-?class|e-?class|s-?class|c\d{3}|e\d{3}|mx-5|miata|86|brz|gr86|supra|370z|350z|stinger|model s|model 3|transit|sprinter|express|savana|promaster)\b/i;
function typeFromModel(model) {
  if (PICKUP_RE.test(model)) return "Pickup";
  if (VAN_RE.test(model)) return "Van";
  if (SUV_RE.test(model)) return "SUV";
  return "";
}
/** "2WD/4x2" from NHTSA → FWD or RWD by model (pickups, vans, sports & luxury sedans are RWD; the rest FWD) */
function resolve2wd(model, type) {
  if (type === "Pickup" || type === "Truck" || RWD_RE.test(model)) return "RWD";
  return "FWD";
}

async function decodeVin(vin) {
  const r = (await vpic("DecodeVinValues/" + vin))[0] || {};
  if (!r.Make && !r.Model) throw new Error("No vehicle found for this VIN — check it for typos");
  const model = (r.Model || "").trim();
  const guessed = [];
  let vehicle_type = mapType(r.VehicleType, r.BodyClass);
  if (!vehicle_type || vehicle_type === "Car") { const t = typeFromModel(model); if (t) { if (!vehicle_type) guessed.push("type"); vehicle_type = t; } }
  if (!vehicle_type && model) { vehicle_type = "Car"; guessed.push("type"); }
  let drive_raw = mapDrive(r.DriveType);
  if (drive_raw === "2WD") { drive_raw = resolve2wd(model, vehicle_type); guessed.push("drive"); }
  let transmission = /manual/i.test(r.TransmissionStyle || "") ? "Manual" : /auto|cvt|dual|direct drive/i.test(r.TransmissionStyle || "") ? "Automatic" : "";
  if (!transmission && /electric/i.test(r.FuelTypePrimary || "")) transmission = "Automatic";
  if (!transmission) { transmission = "Automatic"; guessed.push("transmission"); }
  return { guessed,
    year: r.ModelYear || "", make: titleMake(r.Make), model,
    drive_raw, vehicle_type,
    body: r.BodyClass || "", trim: r.Trim || "",
    transmission,
    specs: {
      trim: [r.Trim, r.Series].filter(Boolean).join(" "), body: r.BodyClass || "", fuel: r.FuelTypePrimary || "",
      liters: r.DisplacementL ? (+r.DisplacementL).toFixed(1) : "", cylinders: r.EngineCylinders || "",
      transmission: r.TransmissionStyle || "", speeds: r.TransmissionSpeeds || "", turbo: r.Turbo || "", drive: r.DriveType || "",
    },
  };
}
async function modelsFor(make, year) {
  make = String(make || "").trim(); if (!make) return [];
  const key = `mp-models:${make.toLowerCase()}:${year || ""}`;
  try { const c = JSON.parse(localStorage.getItem(key) || "null"); if (c) return c; } catch { /* ignore */ }
  if (!navigator.onLine) return [];
  const path = year && +year >= 1981 ? `GetModelsForMakeYear/make/${encodeURIComponent(make)}/modelyear/${year}` : `GetModelsForMake/${encodeURIComponent(make)}`;
  const list = [...new Set((await vpic(path)).map((m) => String(m.Model_Name || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  try { localStorage.setItem(key, JSON.stringify(list)); } catch { /* full */ }
  return list;
}
let zxingPromise;
function loadZxing() {
  if (window.ZXing) return Promise.resolve(window.ZXing);
  zxingPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js";
    s.onload = () => (window.ZXing ? resolve(window.ZXing) : reject(new Error("Scanner didn't load")));
    s.onerror = () => { zxingPromise = null; reject(new Error("Scanner needs internet the first time")); };
    document.head.appendChild(s);
  });
  return zxingPromise;
}
/** Pull a 17-character VIN out of whatever a barcode holds */
function extractVin(text) {
  let t = String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (t.length === 18 && t[0] === "I") t = t.slice(1); // door-frame Code 39 often has a leading "I"
  const all = t.match(/[A-HJ-NPR-Z0-9]{17}/g) || [];
  return all.find(vinCheckOk) || all[0] || "";
}
// whole picture plus zoomed, overlapping parts so small windshield VIN text stays readable (same as the shop POS)
function shrinkJpeg(c, max) { const k = Math.min(1, max / Math.max(c.width, c.height)); if (k >= 1) return c.toDataURL("image/jpeg", 0.82); const d = document.createElement("canvas"); d.width = Math.round(c.width * k); d.height = Math.round(c.height * k); d.getContext("2d").drawImage(c, 0, 0, d.width, d.height); return d.toDataURL("image/jpeg", 0.82); }
function vinTiles(c) {
  const out = [shrinkJpeg(c, 1568)], W = c.width, H = c.height; if (Math.max(W, H) < 1400) return out;
  const g = Math.max(W, H) >= 2400 ? 3 : 2, f = g === 3 ? 0.42 : 0.55, step = (1 - f) / (g - 1), px = g === 3 ? 1200 : 1568;
  for (let r = 0; r < g; r++) for (let q = 0; q < g; q++) { const t = document.createElement("canvas"), w = Math.round(W * f), h = Math.round(H * f); t.width = w; t.height = h; t.getContext("2d").drawImage(c, Math.round(W * step * q), Math.round(H * step * r), w, h, 0, 0, w, h); out.push(shrinkJpeg(t, px)); }
  return out;
}
/** AI reads the VIN text from a picture. Resolves with [{v, ok, fixed}] or throws with a message. */
async function aiReadVin(canvas) {
  if (!navigator.onLine) throw new Error("The AI reader needs internet. Type the VIN instead.");
  const r = await adminCall({ action: "vinRead", images: vinTiles(canvas) });
  if (r?.off) throw new Error("The AI VIN reader isn't switched on yet (owner: add the key in Supabase).");
  if (r?.error) throw new Error(r.error);
  return r?.list || [];
}
const loadPhoto = (file) => loadImage(file);
function rot90(c) { const r = document.createElement("canvas"); r.width = c.height; r.height = c.width; const x = r.getContext("2d"); x.translate(r.width, 0); x.rotate(Math.PI / 2); x.drawImage(c, 0, 0); return r; }

/** Opens a full-screen camera scanner. Resolves with a VIN, or "" if cancelled. */
function scanVinBarcode() {
  return new Promise((resolve) => {
    const ov = document.createElement("div");
    ov.className = "scanov";
    ov.innerHTML = `<div class="scanbox">
        <video playsinline muted autoplay></video><div class="scanline"></div>
      </div>
      <p class="scanmsg" id="scanMsg">Starting camera…</p>
      <p class="scantip">Aim at the VIN barcode on the driver door frame. No barcode (windshield plate, ownership)? Tap <b>Read VIN numbers (AI)</b>.</p>
      <div class="vinpicks" id="vinPicks" hidden></div>
      <div class="btnrow center-row">
        <button type="button" class="btn primary" id="aiBtn">🔍 Read VIN numbers (AI)</button>
        <label class="btn filebtn">📷 Take a photo<input type="file" accept="image/*" capture="environment" hidden></label>
        <button type="button" class="btn ghost light" data-close>Cancel</button>
      </div>`;
    document.body.appendChild(ov);
    const video = ov.querySelector("video"), msg = ov.querySelector("#scanMsg"), picks = ov.querySelector("#vinPicks");
    let reader = null, stream = null, done = false, ZX = null, hints = null;
    const finish = (vin) => {
      if (done) return; done = true;
      try { reader?.reset(); } catch { /* ignore */ }
      try { (stream || video.srcObject)?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      ov.remove(); resolve(vin);
    };
    ov.querySelector("[data-close]").onclick = () => finish("");

    const showPicks = (list) => {
      if (list.length === 1 && list[0].ok && !list[0].fixed) { navigator.vibrate?.(80); return finish(list[0].v); }
      msg.textContent = list[0].ok ? "Found it. Tap the VIN to use it." : "Check the VIN carefully, then tap it:";
      picks.innerHTML = list.map((c) => `<button type="button" class="btn" data-v="${c.v}">${c.v}${c.fixed ? " ✓?" : c.ok ? " ✓" : ""}</button>`).join("");
      picks.hidden = false;
    };
    picks.onclick = (e) => { const b = e.target.closest("[data-v]"); if (b) finish(b.dataset.v); };
    const runAi = async (canvas) => {
      picks.hidden = true; msg.textContent = "Reading the VIN… (a few seconds)";
      try {
        const list = await aiReadVin(canvas);
        if (done) return;
        if (!list.length) { msg.textContent = "No VIN found. Get closer so the VIN fills the screen, avoid glare, and try again."; return; }
        showPicks(list);
      } catch (err) { if (!done) msg.textContent = err.message; }
    };
    ov.querySelector("#aiBtn").onclick = () => {
      if (!video.videoWidth) { msg.textContent = "Camera isn't on — use Take a photo instead."; return; }
      const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext("2d").drawImage(video, 0, 0); runAi(c);
    };
    // photo: barcode first (either way round), then the AI reads the printed VIN
    ov.querySelector("input[type=file]").onchange = async (e) => {
      const file = e.target.files[0]; e.target.value = ""; if (!file) return;
      msg.textContent = "Reading photo…"; picks.hidden = true;
      let img;
      try { img = await loadPhoto(file); } catch { msg.textContent = "Couldn't open that photo."; return; }
      const k = Math.min(1, 3600 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      if (ZX) for (const t of [c, rot90(c)]) {
        try {
          const rd = new ZX.MultiFormatReader(); rd.setHints(hints);
          const vin = extractVin(rd.decode(new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.HTMLCanvasElementLuminanceSource(t)))).getText());
          if (vin) return finish(vin);
        } catch { /* no barcode in this one */ }
      }
      runAi(c);
    };

    // camera on its own, so the AI button works even if the barcode reader can't load
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) { msg.textContent = "Live camera isn't available here — take a photo instead."; return; }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
        if (done) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream; await video.play().catch(() => {});
        msg.textContent = "Looking for a barcode…";
      } catch { msg.textContent = "Camera is blocked — allow it in Settings, or take a photo instead."; return; }
      try {
        ZX = await loadZxing();
        hints = new Map();
        hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.CODE_39, ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.DATA_MATRIX, ZX.BarcodeFormat.QR_CODE, ZX.BarcodeFormat.PDF_417]);
        hints.set(ZX.DecodeHintType.TRY_HARDER, true);
        if (done) return;
        reader = new ZX.BrowserMultiFormatReader(hints, 250);
        reader.decodeFromStream(stream, video, (res) => {
          if (!res || done) return;
          const vin = extractVin(res.getText());
          if (vin) { navigator.vibrate?.(80); finish(vin); }
          else msg.textContent = "That barcode isn't a VIN — try the other one, or Read VIN numbers (AI).";
        }).catch(() => {});
      } catch { if (!done) msg.textContent = "Barcode reader didn't load — use Read VIN numbers (AI)."; }
    })();
  });
}

/** datetime-local value for a date, in the phone's own time */
function localInputValue(d) {
  const x = new Date(d); const p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
}

function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("#toasts").appendChild(el);
  setTimeout(() => el.classList.add("out"), 3200);
  setTimeout(() => el.remove(), 3700);
}

// ─────────────────────────────────────────────────────────────── supabase
let sb;
async function client() {
  if (sb) return sb;
  const mod = window.__SUPABASE_MODULE__ || (await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm"));
  sb = mod.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: "mp-auth" },
  });
  return sb;
}
async function signedUrl(path, downloadName) {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600, downloadName ? { download: downloadName } : undefined);
  if (error) throw error;
  return data.signedUrl;
}
async function adminCall(body) {
  const { data, error } = await sb.functions.invoke("admin", { body });
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch { /* keep */ }
    throw new Error(msg);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

// ─────────────────────────────────────────────────────────────── state
const S = {
  user: null,          // auth user
  me: null,            // profile row
  view: "home",
  drivers: [],         // owner: all profiles
  suggestions: JSON.parse(localStorage.getItem("mp-sugg") || "[]"),
  shops: JSON.parse(localStorage.getItem("mp-shops-all") || "[]"),
  filters: { range: "7", from: "", to: "", driver: "", pay: "", progi: "", q: "", sort: "picked_up_at", asc: false },
  list: [],
  outboxCount: 0,
};
const isOwner = () => S.me?.role === "owner";

// ─────────────────────────────────────────────────────────────── boot
async function boot() {
  $("#app").innerHTML = `<div class="center muted">Loading…</div>`;
  try { await client(); } catch {
    $("#app").innerHTML = `<div class="center"><p>Can't reach the server. Check your internet and reload.</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
    return;
  }
  if (SUPABASE_URL.includes("YOUR-PROJECT")) {
    $("#app").innerHTML = `<div class="center"><h2>Setup needed</h2><p>Put your Supabase URL and key in <b>config.js</b>.</p></div>`;
    return;
  }
  const { data } = await sb.auth.getSession();
  S.user = data.session?.user || null;
  if (!S.user) return renderLogin();
  await loadMe();
  if (!S.me) return renderLogin();
  window.addEventListener("online", () => { updateNet(); syncOutbox(); });
  window.addEventListener("offline", updateNet);
  setInterval(syncOutbox, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncOutbox(); });
  preloadPdf();
  go(isOwner() ? "dash" : "home");
  if (isOwner()) window.MP = { sb, signedUrl, version: VERSION }; // used when Claude fills Progi from this browser
  syncOutbox();
  if (navigator.onLine) refreshSuggestions();
}

async function loadMe() {
  const cached = JSON.parse(localStorage.getItem("mp-me") || "null");
  if (cached?.id === S.user.id) S.me = cached;
  if (!navigator.onLine && S.me) return;
  const { data, error } = await sb.from("profiles").select("*").eq("id", S.user.id).maybeSingle();
  if (error && S.me) return; // offline-ish: keep cached
  if (!data || !data.active) {
    await sb.auth.signOut();
    S.user = S.me = null;
    localStorage.removeItem("mp-me");
    toast(data ? "Your account is turned off. Ask the owner." : "No profile for this login. Ask the owner.", "err");
    return;
  }
  S.me = data;
  localStorage.setItem("mp-me", JSON.stringify(data));
}

async function refreshSuggestions() {
  const { data } = await sb.rpc("vehicle_suggestions");
  if (data) { S.suggestions = data; localStorage.setItem("mp-sugg", JSON.stringify(data)); }
}

// ─────────────────────────────────────────────────────────────── login
function renderLogin() {
  document.body.dataset.view = "login";
  $("#app").innerHTML = `
  <div class="login">
    <div class="brand-big"><div class="logo">M</div><div><h1>Matthews Pickups</h1><p class="muted">Driver sign in</p></div></div>
    <form id="loginForm" class="card stack" autocomplete="on">
      <label class="field"><span>Username</span>
        <input name="u" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username" required></label>
      <label class="field"><span>Password</span>
        <input name="p" type="password" autocomplete="current-password" required></label>
      <p class="err-text" id="loginErr"></p>
      <button class="btn primary big" type="submit">Sign in</button>
    </form>
    <p class="muted small center">v${VERSION}</p>
  </div>`;
  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const u = String(fd.get("u")).trim().toLowerCase();
    const btn = e.target.querySelector("button");
    btn.disabled = true; btn.textContent = "Signing in…";
    const { data, error } = await sb.auth.signInWithPassword({ email: u.includes("@") ? u : `${u}@${LOGIN_DOMAIN}`, password: String(fd.get("p")) });
    if (error) {
      $("#loginErr").textContent = /invalid/i.test(error.message) ? "Wrong username or password" : /banned/i.test(error.message) ? "This account is turned off" : error.message;
      btn.disabled = false; btn.textContent = "Sign in";
      return;
    }
    S.user = data.user;
    await loadMe();
    if (S.me) boot(); else { btn.disabled = false; btn.textContent = "Sign in"; }
  };
}

async function logout() {
  const pending = (await outbox.all()).filter((i) => i.uid === S.user.id).length;
  if (pending && !confirm(`${pending} pickup(s) are not sent yet. They will stay on this phone and send after you sign in again. Sign out?`)) return;
  await sb.auth.signOut();
  localStorage.removeItem("mp-me");
  location.reload();
}

// ─────────────────────────────────────────────────────────────── shell
function shell(inner, { title = "", back = null } = {}) {
  const tabs = isOwner()
    ? [["dash", "Dashboard"], ["form", "New pickup"], ["drivers", "Drivers"]]
    : [["home", "My pickups"], ["form", "New pickup"]];
  $("#app").innerHTML = `
    <header class="top">
      ${back ? `<button class="iconbtn" id="backBtn" aria-label="Back">‹</button>` : `<div class="logo sm">M</div>`}
      <div class="top-title">${esc(title || "Matthews Pickups")}<small>${esc(S.me.full_name)}${isOwner() ? " · Owner" : ""}</small></div>
      <span class="net" id="net"></span>
      <button class="btn sm signout" id="menuBtn">Sign out</button>
    </header>
    <div id="outboxBar"></div>
    <main class="main">${inner}</main>
    ${back ? "" : `<nav class="tabs">${tabs.map(([v, l]) => `<button data-go="${v}" class="${S.view === v ? "on" : ""}">${l}</button>`).join("")}</nav>`}`;
  $("#menuBtn").onclick = logout;
  if (back) $("#backBtn").onclick = back;
  $$("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
  updateNet();
  renderOutboxBar();
}
function updateNet() {
  const el = $("#net");
  if (el) { el.textContent = navigator.onLine ? "" : "Offline"; el.className = "net" + (navigator.onLine ? "" : " off"); }
}

function go(view, arg) {
  S.view = view;
  document.body.dataset.view = view;
  window.scrollTo(0, 0);
  if (view === "home") return renderHome();
  if (view === "form") return isOwner() && !S.drivers.length ? loadDrivers().then(() => renderForm(null)) : renderForm(null);
  if (view === "dash") return renderDash();
  if (view === "drivers") return renderDrivers();
  if (view === "detail") return renderDetail(arg);
}

// ─────────────────────────────────────────────────────────────── outbox sync
let syncing = false;
async function renderOutboxBar() {
  const items = (await outbox.all()).filter((i) => i.uid === S.user?.id);
  S.outboxCount = items.length;
  const bar = $("#outboxBar");
  if (!bar) return;
  if (!items.length) { bar.innerHTML = ""; return; }
  const err = items.find((i) => i.lastError);
  bar.innerHTML = `<div class="outbox ${err ? "warn" : ""}">
    <span>${syncing ? "Sending…" : `${items.length} pickup${items.length > 1 ? "s" : ""} waiting to send`}${err && !syncing ? ` — ${esc(err.lastError)}` : ""}</span>
    <button class="btn sm" id="sendNow" ${syncing || !navigator.onLine ? "disabled" : ""}>Send now</button></div>`;
  const b = $("#sendNow");
  if (b) b.onclick = () => syncOutbox(true);
}

async function syncOutbox(manual = false) {
  if (syncing || !S.user) return;
  if (!navigator.onLine) { if (manual) toast("No internet right now", "err"); return; }
  const items = (await outbox.all()).filter((i) => i.uid === S.user.id);
  if (!items.length) return;
  syncing = true; renderOutboxBar();
  let sent = 0;
  for (const it of items) {
    try {
      await sendItem(it);
      await outbox.remove(it.client_id);
      sent++;
    } catch (e) {
      it.lastError = /jwt|token|auth/i.test(e.message) ? "sign in again" : (e.message || "failed").slice(0, 80);
      it.tries = (it.tries || 0) + 1;
      await outbox.put(it);
    }
  }
  syncing = false;
  await renderOutboxBar();
  if (sent) {
    toast(`${sent} pickup${sent > 1 ? "s" : ""} sent ✓`, "ok");
    if (S.view === "home") renderHome();
    if (S.view === "dash") loadDash();
  }
}

async function sendItem(it) {
  const base = `${it.folder || it.uid}/${it.client_id}/`;
  const row = { ...it.row };
  if (it.invoice) {
    const path = base + "invoice.pdf";
    const { error } = await sb.storage.from(BUCKET).upload(path, it.invoice, { contentType: "application/pdf", upsert: true });
    if (error) throw error;
    row.invoice_path = path;
  }
  row.photo_paths = [];
  for (let i = 0; i < (it.photos || []).length; i++) {
    const path = base + `photo-${String(i + 1).padStart(2, "0")}.jpg`;
    const { error } = await sb.storage.from(BUCKET).upload(path, it.photos[i], { contentType: "image/jpeg", upsert: true });
    if (error) throw error;
    row.photo_paths.push(path);
  }
  const { error } = await sb.from("pickups").upsert(row, { onConflict: "client_id", ignoreDuplicates: true });
  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────── driver home
async function renderHome() {
  shell(`
    <button class="btn primary huge" data-go="form">＋ New Pickup</button>
    <h3 class="section">My pickups <span class="muted small">(last 7 days)</span></h3>
    <div id="mine" class="cards"><div class="muted">Loading…</div></div>`, { title: "My pickups" });
  $$("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
  const local = (await outbox.all()).filter((i) => i.uid === S.user.id);
  let rows = [];
  if (navigator.onLine) {
    const { data, error } = await sb.from("pickups").select("*").eq("driver_id", S.user.id).order("picked_up_at", { ascending: false }).limit(200);
    if (!error) rows = data;
  }
  const el = $("#mine");
  if (!el) return;
  const pend = local.map((i) => ({ ...i.row, _local: true, invoice_path: i.invoice ? 1 : null, photo_paths: i.photos || [] }));
  const all = [...pend, ...rows];
  if (!all.length) { el.innerHTML = `<div class="empty">No pickups yet.${navigator.onLine ? "" : " (Offline — only pickups on this phone show.)"}</div>`; return; }
  el.innerHTML = all.map(cardHtml).join("");
  $$("[data-open]", el).forEach((c) => (c.onclick = () => go("detail", c.dataset.open)));
}

function cardHtml(p) {
  const veh = [p.year, p.make, p.model].filter(Boolean).join(" ");
  return `<div class="pcard" ${p._local ? "" : `data-open="${p.id}"`} role="button">
    <div class="pcard-top"><b class="fileno">${esc(p.file_number)}</b>
      ${p._local ? `<span class="pill amber">Waiting to send</span>` : progiPill(p)}</div>
    <div>${esc(veh)} <span class="muted">· ${esc([p.color, p.vehicle_type, p.drive_type].filter(Boolean).join(" · "))}</span>${p.burned ? ` <span class="pill red">Burned</span>` : ""}</div>
    <div class="muted small">${whenLabel(p.picked_up_at || p.recorded_at)}${p.shop_name ? " · " + esc(p.shop_name) : ""}</div>
    <div class="pcard-bot">
      ${p.paid ? `<b>${money(p.amount)}</b> <span class="muted">${PAY_LABEL[p.payment_type] || ""}</span>` : `<span class="muted">No payment</span>`}
      <span class="icons">${p.invoice_path ? "📄" : ""} ${p.photo_paths?.length ? "📷" + p.photo_paths.length : ""}</span>
    </div></div>`;
}
const progiPill = (p) => p.progi_status === "submitted" ? `<span class="pill green">Progi ✓</span>`
  : p.progi_status === "queued" ? `<span class="pill amber">📤 Progi queue</span>` : `<span class="pill">Progi pending</span>`;

// ─────────────────────────────────────────────────────────────── pickup form
/**
 * existing: a pickups row when editing, or null for a new pickup.
 * Returns nothing; on save navigates away.
 */
function renderForm(existing, opts = {}) {
  const edit = !!existing;
  const f = {
    file_number: existing?.file_number || "",
    driver_id: existing?.driver_id || "",
    picked_up_at: localInputValue(existing?.picked_up_at || existing?.recorded_at || new Date()),
    vin: existing?.vin || "",
    drive_type: existing?.drive_type || "",
    vehicle_type: existing?.vehicle_type || "",
    year: existing?.year || "",
    make: existing?.make || "",
    model: existing?.model || "",
    color: existing?.color || "",
    burned: existing?.burned || false,
    vehicle_specs: existing?.vehicle_specs || null,
    transmission: existing?.transmission || "",
    transmission_speeds: existing?.transmission_speeds != null ? String(existing.transmission_speeds) : "",
    odometer: existing?.odometer ?? "",
    odometer_unit: existing?.odometer_unit || "km",
    odometer_unreadable: existing?.odometer_unreadable || false,
    keys_qty: existing?.keys_qty != null ? String(existing.keys_qty) : "",
    remote_locking: existing?.remote_locking ?? "",
    wheels_good: existing?.wheels_good != null ? String(existing.wheels_good) : "",
    airbags: [...(existing?.airbags || [])],
    equipment: [...(existing?.equipment || [])],
    broken_parts: [...(existing?.broken_parts || [])],
    missing_parts: [...(existing?.missing_parts || [])],
    missing_other: existing?.missing_other || "",
    windows_open: existing?.windows_open || "",
    shop_name: existing?.shop_name || "",
    paid: existing ? existing.paid : null,
    amount: existing?.amount ?? "",
    hst_included: existing ? existing.hst_included !== false : true,
    payment_type: existing?.payment_type || "",
    card_last4: existing?.card_last4 || "",
    cheque_number: existing?.cheque_number || "",
    cheque_date: existing?.cheque_date || dayKey(new Date()),
    extras: [...(existing?.extras || [])],
    notes: existing?.notes || "",
  };
  const pages = [];       // {canvas, rot, src}
  let pdfFile = null;     // a PDF the driver picked instead of scanning
  const photos = [];      // {blob, url}
  let removePhotos = new Set(); // existing paths to remove (owner/driver edit)

  const target = opts.mount || null;
  const html = `
  <form id="pf" class="stack form" novalidate>
    ${edit ? "" : `<p class="muted small">Fill in and tap Save. Works without internet — it sends later.</p>`}
    ${isOwner() ? `<label class="field ownerpick"><span>Picked up by (driver) *</span>
      <select name="driver_id" id="selDriver"><option value="">Pick the driver…</option>
        ${S.drivers.filter((d) => d.active || d.id === f.driver_id).map((d) => `<option value="${d.id}">${esc(d.full_name)}${d.role === "owner" ? " (me)" : ""}${d.active ? "" : " (off)"}</option>`).join("")}
      </select><em class="hint">Counts in this driver's pickups.</em></label>` : ""}
    <label class="field"><span>File Number *</span>
      <input name="file_number" class="mono upper" placeholder="MT-A6342" autocapitalize="characters" autocorrect="off" spellcheck="false" value="${esc(f.file_number)}">
      <em class="hint" id="dupWarn"></em></label>

    <label class="field"><span>Pickup date &amp; time *</span>
      <input name="picked_up_at" type="datetime-local" value="${esc(f.picked_up_at)}"></label>

    <div class="field"><span>VIN <em class="muted">(optional — fills the vehicle for you)</em></span>
      <button type="button" class="btn big dark wide" id="vinScanBtn">▥ Scan VIN barcode</button>
      <div class="vinrow">
        <input name="vin" class="mono upper" maxlength="17" placeholder="17 characters" autocapitalize="characters" autocorrect="off" spellcheck="false" value="${esc(f.vin)}">
        <button type="button" class="btn" id="vinBtn">Decode</button>
      </div>
      <em class="hint" id="vinMsg"></em></div>

    <div class="field"><span>Vehicle Type *</span>
      <div class="chips" data-chips="vehicle_type">${VEHICLE_TYPES.map((t) => `<button type="button" data-val="${t}">${t}</button>`).join("")}</div></div>

    <div class="row3 selrow">
      <label class="field"><span>Year</span><select name="year" id="selYear"></select></label>
      <div class="field"><span>Make *</span><select id="selMake" aria-label="Make"></select>
        <input name="make" placeholder="Type the make" autocomplete="off" value="${esc(f.make)}" hidden></div>
      <div class="field"><span>Model *</span><select id="selModel" aria-label="Model"></select>
        <input name="model" placeholder="Type the model" autocomplete="off" value="${esc(f.model)}" hidden></div>
    </div>
    <em class="hint" id="modelHint"></em>

    <div class="row2">
      <div class="field"><span>Burned?</span>
        <div class="chips two" data-chips="burned"><button type="button" data-val="false">No</button><button type="button" data-val="true">🔥 Yes</button></div></div>
    </div>
    <div class="field"><span>Colour *</span>
      <div class="chips colors" data-chips="color">${[...COLORS, ...(f.color && !COLORS.some(([c]) => c === f.color) ? [[f.color, ""]] : [])]
        .map(([c, hex]) => `<button type="button" data-val="${esc(c)}">${hex ? `<i class="sw" style="background:${hex}"></i>` : ""}${esc(c)}</button>`).join("")}</div></div>

    <div class="field"><span>Drive</span>
      <div class="chips" data-chips="drive_type">${DRIVES.map((t) => `<button type="button" data-val="${t}">${t}</button>`).join("")}</div></div>

    <label class="field"><span>Picked up from (shop)</span><input name="shop_name" list="dlShop" placeholder="Shop name" value="${esc(f.shop_name)}"></label>
    <datalist id="dlShop"></datalist>

    <div class="field"><span>Paid the shop? *</span>
      <div class="chips two" data-chips="paid"><button type="button" data-val="true">Yes, paid</button><button type="button" data-val="false">No payment</button></div></div>

    <div id="paidBox" class="paidbox stack">
      <label class="field"><span>Amount ($) *</span><input name="amount" inputmode="decimal" placeholder="0.00" value="${esc(f.amount)}"></label>
      <div class="field"><span>Is HST in that amount?</span>
        <div class="chips two" data-chips="hst_included"><button type="button" data-val="true">Includes HST</button><button type="button" data-val="false">Before HST</button></div></div>
      <div class="field"><span>Payment Type *</span>
        <div class="chips" data-chips="payment_type">${PAY_TYPES.map(([v, l]) => `<button type="button" data-val="${v}">${l}</button>`).join("")}</div></div>
      <label class="field" id="last4Box"><span>Card last 4 digits</span><input name="card_last4" inputmode="numeric" maxlength="4" placeholder="1234" value="${esc(f.card_last4)}"></label>
      <div class="row2" id="chequeBox">
        <label class="field"><span>Cheque # *</span><input name="cheque_number" inputmode="numeric" maxlength="20" placeholder="001234" value="${esc(f.cheque_number)}"></label>
        <label class="field"><span>Cheque date *</span><input name="cheque_date" type="date" value="${esc(f.cheque_date)}"></label>
      </div>

      <div class="field"><span>Shop Invoice ${edit ? "" : "*"}</span>
        <div id="invExisting"></div>
        <div id="pages" class="pages"></div>
        <div class="btnrow">
          <label class="btn big dark filebtn">📄 <span id="scanLbl">Scan Invoice</span><input type="file" accept="image/*" capture="environment" id="scanIn" hidden></label>
          <label class="btn ghost filebtn">Upload file (PDF / photo)<input type="file" accept="application/pdf,image/*,.heic,.heif" id="pdfIn" hidden></label>
        </div>
        <em class="hint">Lay the invoice flat, fill the screen, take one photo per page.</em>
      </div>
    </div>

    <div class="field"><span>Extra charges <em class="muted">(optional)</em></span>
      <div class="chips" data-chips="extras" data-multi>${EXTRAS.map(([v, l]) => `<button type="button" data-val="${v}">${l} <small>${v}</small></button>`).join("")}</div></div>

    <details class="cond" id="condBox" ${edit ? "" : "open"}>
      <summary>Vehicle condition <em class="muted">(for Progi)</em></summary>
      <div class="stack">
        <div class="row2">
          <label class="field"><span>Odometer</span><input name="odometer" inputmode="numeric" maxlength="7" placeholder="123456" value="${esc(f.odometer)}"></label>
          <div class="field"><span>&nbsp;</span>
            <div class="chips" data-chips="odometer_unit"><button type="button" data-val="km">km</button><button type="button" data-val="mi">Miles</button></div></div>
        </div>
        <div class="chips" data-chips="odometer_unreadable"><button type="button" data-val="true">Can't read odometer</button></div>
        <div class="field"><span>Transmission</span>
          <div class="chips two" data-chips="transmission"><button type="button" data-val="Automatic">Automatic</button><button type="button" data-val="Manual">Manual</button></div></div>
        <div class="field" id="speedsBox"><span>Speeds (gears)</span>
          <div class="chips" data-chips="transmission_speeds">${["1", "2", "3", "4", "5", "6", "7", "8"].map((n) => `<button type="button" data-val="${n}">${n}</button>`).join("")}</div></div>
        <div class="row2">
          <div class="field"><span>Keys</span>
            <div class="chips" data-chips="keys_qty">${["0", "1", "2", "3"].map((n) => `<button type="button" data-val="${n}">${n === "3" ? "3+" : n}</button>`).join("")}</div></div>
          <div class="field"><span>Remote / fob</span>
            <div class="chips two" data-chips="remote_locking"><button type="button" data-val="true">Yes</button><button type="button" data-val="false">No</button></div></div>
        </div>
        <div class="field"><span>Wheels in good condition</span>
          <div class="chips" data-chips="wheels_good">${["0", "1", "2", "3", "4"].map((n) => `<button type="button" data-val="${n}">${n}</button>`).join("")}</div></div>
        <div class="field"><span>Windows open or broken?</span>
          <div class="chips" data-chips="windows_open"><button type="button" data-val="yes">Yes</button><button type="button" data-val="no">No</button><button type="button" data-val="unknown">Unknown</button></div></div>
        <div class="field"><span>Deployed airbags <em class="muted">(tap all that apply)</em></span>
          <div class="chips small" data-chips="airbags" data-multi>${AIRBAGS.map((a) => `<button type="button" data-val="${a}">${a}</button>`).join("")}</div></div>
        <div class="field"><span>Equipment</span>
          <div class="chips small" data-chips="equipment" data-multi>${EQUIPMENT.map((a) => `<button type="button" data-val="${a}">${a}</button>`).join("")}</div></div>
        <div class="field"><span>Broken parts</span>
          <div class="chips small" data-chips="broken_parts" data-multi>${BROKEN.map((a) => `<button type="button" data-val="${a}">${a}</button>`).join("")}</div></div>
        <div class="field"><span>Missing parts</span>
          <div class="chips small" data-chips="missing_parts" data-multi>${MISSING.map((a) => `<button type="button" data-val="${a}">${a}</button>`).join("")}</div>
          <input name="missing_other" placeholder="Other missing parts" value="${esc(f.missing_other)}" style="margin-top:8px"></div>
      </div>
    </details>

    <div class="field"><span>Vehicle Photos <em class="muted" id="photoCount"></em></span>
      <em class="hint">4 corners · damage close-up · inside (passenger door open) · engine (if hood opens) · VIN · keys · odometer (if it turns on)</em>
      <div id="photoGrid" class="photos"></div>
      <div class="btnrow">
        <label class="btn filebtn">📷 Take photo<input type="file" accept="image/*" capture="environment" id="camIn" hidden></label>
        <label class="btn ghost filebtn">From gallery<input type="file" accept="image/*,.heic,.heif" multiple id="galIn" hidden></label>
      </div></div>

    <label class="field"><span>Notes</span><textarea name="notes" rows="2" placeholder="Anything the office should know">${esc(f.notes)}</textarea></label>

    <p class="err-text" id="formErr"></p>
    <div class="savebar"><button class="btn primary big" type="submit" id="saveBtn">${edit ? "Save changes" : "Save Pickup"}</button></div>
  </form>`;

  if (target) target.innerHTML = html;
  else shell(html, { title: edit ? "Edit " + existing.file_number : "New pickup", back: edit ? () => go("detail", existing.id) : null });
  const form = $("#pf");

  const sd = $("#selDriver");
  if (sd) { sd.value = f.driver_id; sd.onchange = (e) => { f.driver_id = e.target.value; e.target.closest(".field").classList.remove("bad"); }; }

  // chips
  const setChips = () => {
    $$("[data-chips]", form).forEach((g) => {
      const key = g.dataset.chips;
      $$("button", g).forEach((b) => {
        const v = b.dataset.val;
        const on = g.hasAttribute("data-multi") ? f[key].includes(v) : String(f[key]) === v;
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on);
      });
    });
    $("#paidBox").hidden = f.paid !== true;
    $("#last4Box").hidden = f.payment_type !== "credit_card";
    $("#chequeBox").hidden = f.payment_type !== "cheque";
    $("#speedsBox").hidden = f.transmission !== "Manual";
  };
  $$("[data-chips]", form).forEach((g) => {
    g.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      const key = g.dataset.chips, v = b.dataset.val;
      if (g.hasAttribute("data-multi")) f[key] = f[key].includes(v) ? f[key].filter((x) => x !== v) : [...f[key], v];
      else if (["drive_type", "odometer_unreadable", "transmission", "transmission_speeds", "remote_locking", "windows_open", "keys_qty", "wheels_good"].includes(key) && String(f[key]) === v) f[key] = key === "odometer_unreadable" ? false : "";
      else f[key] = v === "true" ? true : v === "false" ? false : v;
      setChips();
    };
  });
  setChips();

  // inputs
  const clearBad = (el) => el?.closest(".field")?.classList.remove("bad");
  form.addEventListener("click", (e) => { if (e.target.closest("[data-chips]")) clearBad(e.target); });
  form.addEventListener("change", (e) => clearBad(e.target));
  form.addEventListener("input", (e) => {
    clearBad(e.target);
    const n = e.target.name; if (!n || !(n in f)) return;
    let v = e.target.value;
    if (n === "file_number") { v = v.toUpperCase().replace(/\s+/g, ""); e.target.value = v; }
    if (n === "vin") { v = v.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[IOQ]/g, (c) => ({ I: "1", O: "0", Q: "0" }[c])); e.target.value = v; f.vin = v; if (v.length === 17) runDecode(); else $("#vinMsg").textContent = v ? `${v.length}/17` : ""; }
    if (n === "year" || n === "card_last4" || n === "odometer") { v = v.replace(/\D/g, ""); e.target.value = v; }
    if (n === "amount") { v = v.replace(/[^\d.]/g, ""); e.target.value = v; }
    f[n] = v;
    if (n === "year") { clearTimeout(modelTimer); modelTimer = setTimeout(fillModels, 400); }
  });
  let modelTimer;

  // suggestions
  // ── year / make / model pickers (no typing unless "Other")
  const selYear = $("#selYear"), selMake = $("#selMake"), selModel = $("#selModel");
  const makeIn = form.make, modelIn = form.model;
  const opt = (v, l, sel) => `<option value="${esc(v)}"${sel ? " selected" : ""}>${esc(l)}</option>`;
  const renderYears = () => {
    const ys = []; for (let y = new Date().getFullYear() + 1; y >= 1980; y--) ys.push(String(y));
    if (f.year && !ys.includes(String(f.year))) ys.push(String(f.year));
    selYear.innerHTML = opt("", "Year", !f.year) + ys.map((y) => opt(y, y, String(f.year) === y)).join("");
  };
  let makeOther = false, modelOther = false;
  const renderMakes = () => {
    const cur = MAKES.find((m) => m.toLowerCase() === (f.make || "").toLowerCase());
    makeOther = !!f.make && !cur;            // a make that isn't in the list is typed
    makeIn.hidden = !makeOther;
    selMake.innerHTML = opt("", "Pick make", !f.make) + MAKES.map((m) => opt(m, m, m === cur)).join("") + opt(OTHER, "Other / not listed", makeOther);
    if (cur) f.make = cur;
  };
  let modelsReq = 0;
  const fillModels = async () => {
    const req = ++modelsReq, hint = $("#modelHint");
    hint.textContent = "";
    if (makeOther) {                          // typed make → typed model
      selModel.innerHTML = opt(OTHER, "Type the model ↓", true); selModel.disabled = true;
      modelOther = true; modelIn.hidden = false; return;
    }
    if (!f.make) {
      selModel.innerHTML = opt("", "Pick make first", true); selModel.disabled = true;
      modelOther = false; modelIn.hidden = true; return;
    }
    selModel.disabled = false;
    selModel.innerHTML = opt("", "Loading models…", true);
    const mk = f.make.toLowerCase();
    const past = S.suggestions.filter((x) => x.make.toLowerCase() === mk).map((x) => x.model);
    let api = [], failed = false;
    try { api = await modelsFor(f.make, f.year); } catch { failed = true; }
    if (req !== modelsReq) return;
    let models = [...new Set([...api, ...past])].sort((a, b) => a.localeCompare(b));
    let selected = "";
    if (f.model && !modelOther) {
      selected = models.find((m) => m.toLowerCase() === f.model.toLowerCase()) || "";
      if (!selected) { models = [f.model, ...models]; selected = f.model; } // e.g. decoded model not in the list
    }
    if (!models.length) modelOther = true;
    modelIn.hidden = !modelOther;
    selModel.innerHTML = opt("", models.length ? "Pick model" : "No list — type ↓", !selected && !modelOther)
      + models.map((m) => opt(m, m, m === selected)).join("") + opt(OTHER, "Other / not listed", modelOther);
    if (failed && !models.length) hint.textContent = "Couldn't load the model list (no internet?) — type the model.";
  };
  selYear.onchange = () => { f.year = selYear.value; clearBad(selYear); fillModels(); };
  selMake.onchange = () => {
    clearBad(selMake);
    makeOther = selMake.value === OTHER;
    f.make = makeOther ? "" : selMake.value; makeIn.value = f.make; makeIn.hidden = !makeOther;
    f.model = ""; modelIn.value = ""; modelOther = false;
    fillModels();
    if (makeOther) makeIn.focus();
  };
  selModel.onchange = () => {
    clearBad(selModel);
    modelOther = selModel.value === OTHER;
    f.model = modelOther ? "" : selModel.value; modelIn.value = f.model; modelIn.hidden = !modelOther;
    if (modelOther) modelIn.focus();
  };
  /** put a decoded / saved vehicle into the pickers */
  const syncVehicle = () => {
    modelOther = false;
    makeIn.value = f.make; modelIn.value = f.model;
    renderYears(); renderMakes(); fillModels();
  };

  // VIN decode
  const runDecode = async () => {
    const vin = f.vin, msg = $("#vinMsg");
    if (!VIN_RE.test(vin)) { msg.textContent = "A VIN is 17 letters/numbers (no I, O or Q)."; msg.className = "hint warn"; return; }
    if (!navigator.onLine) { msg.textContent = "No internet — fill the vehicle in by hand. The VIN is still saved."; msg.className = "hint"; return; }
    msg.textContent = "Looking up…"; msg.className = "hint";
    try {
      const d = await decodeVin(vin);
      if (d.year) f.year = String(d.year);
      if (d.make) f.make = d.make;
      if (d.model) f.model = d.model;
      if (DRIVES.includes(d.drive_raw)) f.drive_type = d.drive_raw;
      if (d.transmission) f.transmission = d.transmission;
      if (d.specs?.speeds && +d.specs.speeds >= 1 && +d.specs.speeds <= 8) f.transmission_speeds = String(+d.specs.speeds);
      f.vehicle_specs = d.specs;
      if (d.vehicle_type) f.vehicle_type = d.vehicle_type;
      setChips(); syncVehicle();
      [selYear, selMake, selModel].forEach(clearBad);
      const g = d.guessed || [];
      msg.textContent = `✓ Filled: ${[d.year, d.make, d.model, d.trim].filter(Boolean).join(" ")} · ${[d.vehicle_type, d.drive_raw || "drive not listed — tap it below", d.transmission].filter(Boolean).join(" · ")}`
        + (g.length ? ` (best guess: ${g.join(", ")} — check)` : "")
        + (vinCheckOk(vin) ? "" : " — check digit doesn't match, double-check the VIN");
      msg.className = "hint ok";
    } catch (err) {
      msg.textContent = err.name === "AbortError" ? "Lookup timed out — fill the vehicle in by hand." : err.message;
      msg.className = "hint warn";
    }
  };
  $("#vinBtn").onclick = runDecode;
  $("#vinScanBtn").onclick = async () => {
    const vin = await scanVinBarcode();
    if (!vin) return;
    f.vin = vin; form.vin.value = vin; clearBad(form.vin);
    runDecode();
  };
  syncVehicle();
  const shops = JSON.parse(localStorage.getItem("mp-shops") || "[]");
  const allShops = () => [...new Set([...shops, ...(S.shops || [])])];
  const fillShops = () => { const dl = $("#dlShop"); if (dl) dl.innerHTML = allShops().map((m) => `<option value="${esc(m)}">`).join(""); };
  fillShops();
  if (navigator.onLine && !S.shopsLoaded) sb.rpc("shop_names").then(({ data }) => { if (data) { S.shops = data.map((r) => r.shop_name); S.shopsLoaded = true; try { localStorage.setItem("mp-shops-all", JSON.stringify(S.shops)); } catch { /* full */ } fillShops(); } });

  // duplicate file number warning
  const dupCheck = async () => {
    const fn = f.file_number.trim();
    const w = $("#dupWarn");
    if (fn.length < 3) { w.textContent = ""; return; }
    const local = (await outbox.all()).some((i) => i.row.file_number === fn && i.client_id !== existing?.client_id);
    let msg = local ? "⚠ Already saved on this phone (waiting to send)." : "";
    if (!msg && navigator.onLine) {
      const { data } = await sb.rpc("file_number_check", { fn, exclude_id: existing?.id || null });
      const r = data?.[0];
      if (r?.times) msg = `⚠ Already recorded${r.times > 1 ? " " + r.times + " times" : ""} — last ${fmtShort.format(new Date(r.last_recorded))}${r.last_driver ? " by " + r.last_driver : ""}. Check before saving.`;
    }
    w.textContent = msg;
    w.classList.toggle("warn", !!msg);
  };
  form.file_number.addEventListener("blur", dupCheck);
  if (edit) dupCheck();

  // invoice: existing
  const renderExistingInv = () => {
    const box = $("#invExisting");
    if (!edit || !existing.invoice_path || pages.length || pdfFile) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="hint ok">✓ Invoice on file${existing.invoice_pages ? ` (${existing.invoice_pages} page${existing.invoice_pages > 1 ? "s" : ""})` : ""}. Scan again to replace it.</div>`;
  };
  renderExistingInv();
  if (edit && existing.invoice_purged_at && !existing.invoice_path) $("#invExisting").innerHTML = `<div class="hint">Invoice file was auto-deleted ${fmtShort.format(new Date(existing.invoice_purged_at))}.</div>`;

  // invoice: scanning
  const renderPages = () => {
    $("#pages").innerHTML = pdfFile
      ? `<div class="pdfchip">📄 ${esc(pdfFile.name)} <button type="button" class="x" data-rmpdf>×</button></div>`
      : pages.map((p, i) => `<div class="page"><img src="${p.thumb}" alt="Page ${i + 1}"><span class="pg">${i + 1}</span>
          <div class="pagebtns"><button type="button" data-rot="${i}" aria-label="Rotate">⟳</button><button type="button" data-rm="${i}" aria-label="Remove">×</button></div></div>`).join("");
    $("#scanLbl").textContent = pages.length ? "Add page" : "Scan Invoice";
    renderExistingInv();
  };
  $("#pages").onclick = (e) => {
    const rot = e.target.closest("[data-rot]"), rm = e.target.closest("[data-rm]");
    if (e.target.closest("[data-rmpdf]")) { pdfFile = null; renderPages(); return; }
    if (rot) { const p = pages[+rot.dataset.rot]; p.rot = (p.rot + 1) % 4; p.canvas = rotateCanvas(p.src, p.rot); p.thumb = thumb(p.canvas); renderPages(); }
    if (rm) { pages.splice(+rm.dataset.rm, 1); renderPages(); }
  };
  $("#scanIn").onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    pdfFile = null;
    const lbl = $("#scanLbl"); lbl.textContent = "Processing…";
    try {
      const src = await scanInvoice(file);
      pages.push({ src, rot: 0, canvas: src, thumb: thumb(src) });
    } catch (err) { toast(err.message, "err"); }
    renderPages();
  };
  $("#pdfIn").multiple = true;
  $("#pdfIn").onchange = async (e) => {
    const files = [...e.target.files]; e.target.value = "";
    if (!files.length) return;
    const pdf = files.find((x) => x.type === "application/pdf" || /\.pdf$/i.test(x.name));
    if (pdf) {
      if (pdf.size > 15 * 1024 * 1024) return toast("PDF is too big (max 15 MB)", "err");
      pages.length = 0; pdfFile = pdf; renderPages(); return;
    }
    pdfFile = null; $("#scanLbl").textContent = "Processing…";      // photos of the invoice (JPG, PNG, HEIC)
    for (const file of files) {
      try { const src = await scanInvoice(file); pages.push({ src, rot: 0, canvas: src, thumb: thumb(src) }); }
      catch (err) { toast(err.message, "err"); }
    }
    renderPages();
  };

  // photos
  const renderPhotos = () => {
    const ex = (edit ? existing.photo_paths || [] : []).filter((p) => !removePhotos.has(p));
    $("#photoGrid").innerHTML =
      ex.map((p) => `<div class="ph" data-path="${esc(p)}"><div class="phload"></div><button type="button" class="x" data-rmex="${esc(p)}">×</button></div>`).join("") +
      photos.map((p, i) => `<div class="ph"><img src="${p.url}" alt=""><button type="button" class="x" data-rmph="${i}">×</button></div>`).join("");
    if (ex.length) loadThumbs($("#photoGrid"));
    const n = ex.length + photos.length, pc = $("#photoCount");
    if (pc) { pc.textContent = `${n}/${PROGI_MIN_PHOTOS} for Progi`; pc.classList.toggle("okc", n >= PROGI_MIN_PHOTOS); }
  };
  $("#photoGrid").onclick = (e) => {
    const a = e.target.closest("[data-rmph]"), b = e.target.closest("[data-rmex]");
    if (a) { URL.revokeObjectURL(photos[+a.dataset.rmph].url); photos.splice(+a.dataset.rmph, 1); renderPhotos(); }
    if (b) { removePhotos.add(b.dataset.rmex); renderPhotos(); }
  };
  const addPhotos = async (files) => {
    for (const file of files) {
      try {
        const blob = await compressPhoto(file);
        photos.push({ blob, url: URL.createObjectURL(blob) });
        renderPhotos();
      } catch (err) { toast(err.message, "err"); }
    }
  };
  $("#camIn").onchange = (e) => { const fs = [...e.target.files]; e.target.value = ""; addPhotos(fs); };
  $("#galIn").onchange = (e) => { const fs = [...e.target.files]; e.target.value = ""; addPhotos(fs); };
  renderPhotos();

  // save
  form.onsubmit = async (e) => {
    e.preventDefault();
    const errs = [];
    if (f.file_number.trim().length < 2) errs.push(["file_number", "File Number is required"]);
    const pickedAt = f.picked_up_at ? new Date(f.picked_up_at) : null;
    if (!pickedAt || isNaN(pickedAt)) errs.push(["picked_up_at", "Enter the pickup date and time"]);
    else if (pickedAt > new Date(Date.now() + 15 * 60000)) errs.push(["picked_up_at", "Pickup time is in the future"]);
    if (f.vin && !VIN_RE.test(f.vin)) errs.push(["vin", "VIN must be 17 characters (or leave it empty)"]);
    if (!f.vehicle_type) errs.push(["vehicle_type", "Pick a vehicle type"]);
    if (f.year && (+f.year < 1950 || +f.year > new Date().getFullYear() + 2)) errs.push(["year", "Year looks wrong"]);
    if (!f.make.trim()) errs.push(["make", "Make is required"]);
    if (!f.model.trim()) errs.push(["model", "Model is required"]);
    if (!f.color) errs.push(["color", "Pick the colour"]);
    if (isOwner() && !f.driver_id) errs.push(["driver_id", "Pick which driver picked it up"]);
    if (f.paid === null) errs.push(["paid", "Was the shop paid? Tap Yes or No"]);
    if (f.paid) {
      if (!(+f.amount > 0)) errs.push(["amount", "Enter the amount paid"]);
      if (!f.payment_type) errs.push(["payment_type", "Pick a payment type"]);
      const hasInv = pages.length || pdfFile || (edit && existing.invoice_path);
      if (!hasInv && !edit) errs.push(["scanIn", "Scan the shop invoice"]);
    }
    if (f.card_last4 && !/^\d{4}$/.test(f.card_last4)) errs.push(["card_last4", "Card: exactly 4 digits"]);
    if (f.paid && f.payment_type === "cheque") {
      if (!f.cheque_number.trim()) errs.push(["cheque_number", "Enter the cheque number"]);
      if (!f.cheque_date) errs.push(["cheque_date", "Pick the cheque date"]);
    }
    $$(".bad", form).forEach((x) => x.classList.remove("bad"));
    if (errs.length) {
      $("#formErr").textContent = errs.map((x) => x[1]).join(" · ");
      errs.forEach(([k]) => (form.querySelector(`[name="${k}"]`) || form.querySelector(`[data-chips="${k}"]`) || $("#" + k))?.closest(".field")?.classList.add("bad"));
      form.querySelector(".bad")?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    $("#formErr").textContent = "";
    const btn = $("#saveBtn"); btn.disabled = true; btn.textContent = "Saving…";

    const row = {
      file_number: f.file_number.trim().toUpperCase(),
      picked_up_at: new Date(f.picked_up_at).toISOString(),
      vin: f.vin || null,
      drive_type: f.drive_type || null,
      vehicle_type: f.vehicle_type,
      year: f.year ? +f.year : null,
      make: titleMake(f.make),
      color: f.color,
      burned: !!f.burned,
      vehicle_specs: f.vehicle_specs,
      transmission: f.transmission || null,
      transmission_speeds: f.transmission === "Manual" && f.transmission_speeds ? +f.transmission_speeds : null,
      odometer: f.odometer_unreadable || f.odometer === "" ? null : +f.odometer,
      odometer_unit: f.odometer_unit,
      odometer_unreadable: !!f.odometer_unreadable,
      keys_qty: f.keys_qty === "" ? null : +f.keys_qty,
      remote_locking: f.remote_locking === "" ? null : f.remote_locking === true || f.remote_locking === "true",
      wheels_good: f.wheels_good === "" ? null : +f.wheels_good,
      airbags: f.airbags, equipment: f.equipment, broken_parts: f.broken_parts, missing_parts: f.missing_parts,
      missing_other: f.missing_other.trim() || null,
      windows_open: f.windows_open || null,
      model: f.model.trim(),
      shop_name: (() => { const t = f.shop_name.trim().replace(/\s+/g, " "); if (!t) return null; return allShops().find((x) => x.toLowerCase() === t.toLowerCase()) || t; })(),
      paid: !!f.paid,
      amount: f.paid ? Math.round(+f.amount * 100) / 100 : null,
      hst_included: f.paid ? !!f.hst_included : null,
      payment_type: f.paid ? f.payment_type : null,
      card_last4: f.paid && f.payment_type === "credit_card" && f.card_last4 ? f.card_last4 : null,
      cheque_number: f.paid && f.payment_type === "cheque" ? f.cheque_number.trim() : null,
      cheque_date: f.paid && f.payment_type === "cheque" ? f.cheque_date : null,
      extras: f.extras,
      notes: f.notes.trim() || null,
      ...(isOwner() && f.driver_id ? { driver_id: f.driver_id } : {}),
    };
    if (row.shop_name) localStorage.setItem("mp-shops", JSON.stringify([row.shop_name, ...shops.filter((s) => s !== row.shop_name)].slice(0, 80)));

    try {
      let invoiceBlob = null;
      if (pdfFile) invoiceBlob = pdfFile;
      else if (pages.length) invoiceBlob = await buildPdf(pages.map((p) => p.canvas), row.file_number);
      const invoicePages = pdfFile ? 1 : pages.length;

      if (!edit) {
        const client_id = uuid();
        await outbox.put({
          client_id, uid: S.user.id, folder: row.driver_id || S.user.id, created: Date.now(),
          row: { ...row, client_id, recorded_at: new Date().toISOString(), invoice_pages: invoicePages },
          invoice: invoiceBlob, photos: photos.map((p) => p.blob),
        });
        photos.forEach((p) => URL.revokeObjectURL(p.url));
        toast(navigator.onLine ? "Saved — sending…" : "Saved on phone — will send when online", "ok");
        go(isOwner() ? "dash" : "home");
        syncOutbox();
        return;
      }

      // editing: goes straight to the server
      if (!navigator.onLine) throw new Error("Editing needs internet");
      const folder = `${existing.driver_id}/${existing.client_id}/`;
      if (invoiceBlob) {
        const path = existing.invoice_path || folder + "invoice.pdf";
        const { error } = await sb.storage.from(BUCKET).upload(path, invoiceBlob, { contentType: "application/pdf", upsert: true });
        if (error) throw error;
        row.invoice_path = path; row.invoice_pages = invoicePages;
      }
      let paths = (existing.photo_paths || []).filter((p) => !removePhotos.has(p));
      for (let i = 0; i < photos.length; i++) {
        const path = folder + `photo-${Date.now().toString(36)}-${i + 1}.jpg`;
        const { error } = await sb.storage.from(BUCKET).upload(path, photos[i].blob, { contentType: "image/jpeg", upsert: true });
        if (error) throw error;
        paths.push(path);
      }
      row.photo_paths = paths;
      const { data, error } = await sb.from("pickups").update(row).eq("id", existing.id).select();
      if (error) throw error;
      if (!data?.length) throw new Error(isOwner() ? "Not saved" : "Can only edit today's pickups");
      if (removePhotos.size && isOwner()) await sb.storage.from(BUCKET).remove([...removePhotos]);
      toast("Saved ✓", "ok");
      opts.onSaved ? opts.onSaved() : go(isOwner() ? "dash" : "home");
    } catch (err) {
      $("#formErr").textContent = err.message || "Could not save";
      btn.disabled = false; btn.textContent = edit ? "Save changes" : "Save Pickup";
    }
  };
}

async function loadThumbs(root) {
  const nodes = $$("[data-path]", root);
  if (!nodes.length) return;
  const { data } = await sb.storage.from(BUCKET).createSignedUrls(nodes.map((n) => n.dataset.path), 3600);
  (data || []).forEach((d, i) => {
    if (!d.signedUrl) return;
    const n = nodes[i];
    const img = document.createElement("img");
    img.src = d.signedUrl; img.alt = "";
    n.querySelector(".phload")?.replaceWith(img);
  });
}

// ─────────────────────────────────────────────────────────────── owner dashboard
async function renderDash() {
  shell(`
    <section class="stats" id="stats">${["Today", "Last 7 days", "Paid today", "Not in Progi yet"].map((l) => `<div class="stat"><small>${l}</small><b>–</b></div>`).join("")}</section>
    <div id="alerts"></div>
    <section class="card filters">
      <div class="rangerow">
        <div class="seg" id="range">${[["0", "Today"], ["7", "7 days"], ["30", "30 days"], ["all", "All"]].map(([v, l]) => `<button data-v="${v}">${l}</button>`).join("")}</div>
        <div class="daterange"><label>From <input type="date" id="fFrom"></label><label>To <input type="date" id="fTo"></label>
          <button class="btn ghost sm" id="fClearDates" hidden>Clear dates</button></div>
      </div>
      <div class="frow">
        <select id="fDriver"><option value="">All drivers</option></select>
        <select id="fPay"><option value="">Any payment</option><option value="none">No payment</option>${PAY_TYPES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select>
        <select id="fProgi"><option value="">Progi: all</option><option value="pending">Progi: pending</option><option value="queued">Progi: upload queue</option><option value="submitted">Progi: submitted</option></select>
        <input id="fQ" type="search" placeholder="Search: CR-V, 2018 Civic, 6458, VIN, shop, colour…">
        <button class="btn ghost" id="csvBtn">Export CSV</button>
      </div>
    </section>
    <div id="list"><div class="muted">Loading…</div></div>`, { title: "Dashboard" });

  const fl = S.filters;
  const custom = () => !!(fl.from || fl.to);
  const setSeg = () => {
    $$("#range button").forEach((b) => b.classList.toggle("on", !custom() && b.dataset.v === fl.range));
    $("#fFrom").value = fl.from; $("#fTo").value = fl.to; $("#fClearDates").hidden = !custom();
  };
  setSeg();
  $("#range").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; fl.range = b.dataset.v; fl.from = fl.to = ""; setSeg(); loadList(); };
  $("#fFrom").onchange = (e) => { fl.from = e.target.value; setSeg(); loadList(); };
  $("#fTo").onchange = (e) => { fl.to = e.target.value; setSeg(); loadList(); };
  $("#fClearDates").onclick = () => { fl.from = fl.to = ""; setSeg(); loadList(); };
  $("#fPay").value = fl.pay; $("#fProgi").value = fl.progi; $("#fQ").value = fl.q;
  $("#fDriver").onchange = (e) => { fl.driver = e.target.value; loadList(); };
  $("#fPay").onchange = (e) => { fl.pay = e.target.value; loadList(); };
  $("#fProgi").onchange = (e) => { fl.progi = e.target.value; loadList(); };
  let t; $("#fQ").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { fl.q = e.target.value.trim(); loadList(); }, 300); };
  $("#csvBtn").onclick = exportCsv;

  await loadDrivers();
  $("#fDriver").innerHTML = `<option value="">All drivers</option>` + S.drivers.map((d) => `<option value="${d.id}">${esc(d.full_name)}${d.active ? "" : " (off)"}</option>`).join("");
  $("#fDriver").value = fl.driver;
  loadDash();
  dailyCleanup();
}

async function loadDrivers() {
  const { data } = await sb.from("profiles").select("*").order("full_name");
  S.drivers = data || [];
}
const driverName = (id) => S.drivers.find((d) => d.id === id)?.full_name || "—";

async function loadDash() { await Promise.all([loadStats(), loadList()]); }

async function loadStats() {
  const since7 = torontoMidnight(6), today0 = torontoMidnight(0);
  const [{ data: wk }, { count: pending }, { data: expiring }, { data: queued }] = await Promise.all([
    sb.from("pickups").select("picked_up_at, paid, amount, payment_type").gte("picked_up_at", since7),
    sb.from("pickups").select("id", { count: "exact", head: true }).neq("progi_status", "submitted"),
    sb.from("pickups").select("id, file_number, recorded_at").neq("progi_status", "submitted")
      .lt("recorded_at", new Date(Date.now() - 10 * 864e5).toISOString()).order("recorded_at").limit(20),
    sb.from("pickups").select("id, file_number").eq("progi_status", "queued").order("picked_up_at").limit(50),
  ]);
  const rows = wk || [];
  const today = rows.filter((r) => r.picked_up_at >= today0);
  const paidToday = today.filter((r) => r.paid);
  const sum = paidToday.reduce((a, r) => a + Number(r.amount || 0), 0);
  const by = PAY_TYPES.map(([v, l]) => [l, paidToday.filter((r) => r.payment_type === v).reduce((a, r) => a + Number(r.amount || 0), 0)]).filter(([, a]) => a > 0);
  const el = $("#stats"); if (!el) return;
  el.innerHTML = `
    <div class="stat"><small>Today</small><b>${today.length}</b><span>pickups</span></div>
    <div class="stat"><small>Last 7 days</small><b>${rows.length}</b><span>pickups</span></div>
    <div class="stat wide"><small>Paid today</small><b>${money(sum)}</b><span>${by.length ? by.map(([l, a]) => `${l} ${money(a)}`).join(" · ") : "nothing paid"}</span></div>
    <div class="stat ${pending ? "alert" : ""}" id="pendTile" role="button"><small>Not in Progi yet</small><b>${pending ?? "–"}</b><span>tap to show</span></div>
    ${(queued || []).length ? `<div class="stat wide queue" id="queueTile" role="button"><small>📤 Progi upload queue</small><b>${queued.length}</b><span>${queued.map((r) => esc(r.file_number)).join(" · ")} — ask Claude: “upload the Progi queue”</span></div>` : ""}`;
  const qt = $("#queueTile"); if (qt) qt.onclick = () => { S.filters.progi = "queued"; S.filters.range = "all"; renderDash(); };
  $("#pendTile").onclick = () => { S.filters.progi = "pending"; S.filters.range = "all"; renderDash(); };
  const al = $("#alerts");
  if (al) al.innerHTML = (expiring || []).length
    ? `<div class="alertbox">⚠ ${expiring.length} pickup${expiring.length > 1 ? "s are" : " is"} 10+ days old and still not in Progi. Photos and invoice are auto-deleted at 14 days: ${expiring.map((r) => `<a href="#" data-open="${r.id}">${esc(r.file_number)}</a>`).join(", ")}</div>` : "";
  $$("#alerts [data-open]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); go("detail", a.dataset.open); }));
}

const normSearch = (t) => String(t || "").toLowerCase().split(/\s+/).map((w) => w.replace(/[^a-z0-9]/g, "")).filter(Boolean).slice(0, 6);

function sortTh(key, label, cls = "") {
  const fl = S.filters, on = fl.sort === key;
  return `<th class="sortable ${cls} ${on ? "on" : ""}" data-sort="${key}" title="Sort">${label} <span class="arrow">${on ? (fl.asc ? "▲" : "▼") : "↕"}</span></th>`;
}

async function loadList() {
  const fl = S.filters;
  let q = sb.from("pickups").select("*").order(fl.sort || "picked_up_at", { ascending: !!fl.asc }).order("picked_up_at", { ascending: false }).limit(500);
  if (fl.from || fl.to) {
    if (fl.from) q = q.gte("picked_up_at", torontoDayStart(fl.from));
    if (fl.to) q = q.lt("picked_up_at", torontoDayStart(fl.to, 1));
  } else if (fl.range !== "all") q = q.gte("picked_up_at", torontoMidnight(fl.range === "0" ? 0 : +fl.range - 1));
  if (fl.driver) q = q.eq("driver_id", fl.driver);
  if (fl.pay === "none") q = q.eq("paid", false); else if (fl.pay) q = q.eq("payment_type", fl.pay);
  if (fl.progi) q = q.eq("progi_status", fl.progi);
  // every word must match somewhere (file #, VIN, year, make, model, shop, colour, type); dashes/spaces ignored
  for (const w of normSearch(fl.q)) q = q.ilike("search_text", `%${w}%`);
  const { data, error } = await q;
  const el = $("#list"); if (!el) return;
  if (error) { el.innerHTML = `<div class="empty">Couldn't load: ${esc(error.message)}</div>`; return; }
  S.list = data;
  if (!data.length) { el.innerHTML = `<div class="empty">No pickups match.</div>`; return; }
  el.innerHTML = `
    <table class="tbl">
      <thead><tr>${sortTh("file_number", "File #")}<th>Vehicle</th><th>Driver</th>${sortTh("picked_up_at", "Pickup date")}${sortTh("amount", "Paid", "r")}<th>Progi</th><th>QuickBooks</th><th>Files</th></tr></thead>
      <tbody>${data.map((p) => `<tr data-open="${p.id}">
        <td class="mono fileno"><b>${esc(p.file_number)}</b>${p.extras?.length ? ` <small class="muted">${p.extras.join(" ")}</small>` : ""}</td>
        <td>${esc([p.year, p.make, p.model].filter(Boolean).join(" "))}${p.burned ? ` <span class="pill red">Burned</span>` : ""}<small class="muted block">${esc([p.color, p.vehicle_type, p.drive_type].filter(Boolean).join(" · "))}${p.shop_name ? " · " + esc(p.shop_name) : ""}</small></td>
        <td>${esc(driverName(p.driver_id))}</td>
        <td class="nowrap">${(() => { const d = p.picked_up_at || p.recorded_at; return d ? `<b>${dayKey(d)}</b>` : "—"; })()}</td>
        <td class="r">${p.paid ? `<b>${money(p.amount)}</b><small class="muted block">${PAY_LABEL[p.payment_type]}${p.cheque_number ? " #" + esc(p.cheque_number) : ""}</small>` : `<span class="muted">—</span>`}</td>
        <td class="acts">${p.progi_status === "submitted"
          ? `<span class="pill green">Progi ✓</span><button class="mini ghost" data-act="progi_status" data-v="pending" data-id="${p.id}" title="Undo">↺</button>`
          : `${p.progi_status === "queued"
              ? `<button class="mini on" data-act="progi_status" data-v="pending" data-id="${p.id}" title="Take out of the upload queue">📤 In queue ✕</button>`
              : `<button class="mini" data-act="progi_status" data-v="queued" data-id="${p.id}" data-photos="${p.photo_paths?.length || 0}">📤 Upload to Progi</button>`}
             <button class="mini ghost" data-act="progi_status" data-v="submitted" data-id="${p.id}">✓ Submitted</button>`}</td>
        <td class="acts">${p.qb_status === "done"
          ? `<span class="pill green">QB ✓</span><button class="mini ghost" data-act="qb_status" data-v="pending" data-id="${p.id}" title="Undo">↺</button>`
          : `<button class="mini" data-act="qb_status" data-v="done" data-id="${p.id}">✓ QB done</button>`}</td>
        <td class="nowrap">${p.invoice_path ? "📄" : p.paid ? `<span title="No invoice" class="warnc">!</span>` : ""} ${p.photo_paths?.length ? "📷" + p.photo_paths.length : ""}</td>
      </tr>`).join("")}</tbody>
    </table>
    <p class="muted small">${data.length}${data.length === 500 ? "+ (showing newest 500)" : ""} pickup${data.length > 1 ? "s" : ""}</p>`;
  $$("[data-sort]", el).forEach((h) => (h.onclick = () => {
    const k = h.dataset.sort;
    if (fl.sort === k) fl.asc = !fl.asc; else { fl.sort = k; fl.asc = k === "file_number"; }
    loadList();
  }));
  $$("[data-open]", el).forEach((r) => (r.onclick = (e) => { if (!e.target.closest("[data-act]")) go("detail", r.dataset.open); }));
  $$("[data-act]", el).forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const { act, v, id } = b.dataset;
    if (act === "progi_status" && v === "queued" && +b.dataset.photos < PROGI_MIN_PHOTOS &&
        !confirm(`Only ${b.dataset.photos} photos (Progi needs ${PROGI_MIN_PHOTOS}). Add to the upload queue anyway?`)) return;
    if (act === "progi_status" && v === "submitted" && !confirm("Mark this file as submitted in Progi?")) return;
    b.disabled = true;
    const { error } = await sb.from("pickups").update({ [act]: v }).eq("id", id);
    if (error) { b.disabled = false; return toast(error.message, "err"); }
    toast({ queued: "Added to the Progi upload queue", submitted: "Marked submitted to Progi", done: "Marked done in QuickBooks", pending: "Undone" }[v] || "Saved", "ok");
    loadDash();
  }));
}

function exportCsv() {
  const rows = S.list;
  if (!rows.length) return toast("Nothing to export", "err");
  const cols = ["file_number", "pickup_date", "pickup_time", "driver", "vin", "vehicle_type", "year", "make", "model", "drive", "colour", "burned", "shop", "paid", "amount", "hst_included", "payment_type", "card_last4", "cheque_number", "cheque_date", "odometer", "keys", "remote", "good_wheels", "windows_open", "airbags", "extras", "progi_status", "progi_submitted", "quickbooks", "invoice_pdf", "photos", "notes"];
  const cell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [cols.join(",")].concat(rows.map((p) => [
    p.file_number, dayKey(p.picked_up_at), fmtTime.format(new Date(p.picked_up_at)), driverName(p.driver_id), p.vin, p.vehicle_type, p.year, p.make, p.model, p.drive_type, p.color, p.burned ? "yes" : "no",
    p.shop_name, p.paid ? "yes" : "no", p.paid ? Number(p.amount).toFixed(2) : "", p.paid ? (p.hst_included ? "incl" : "plus") : "",
    PAY_LABEL[p.payment_type] || "", p.card_last4, p.cheque_number, p.cheque_date, p.odometer_unreadable ? "can't read" : p.odometer != null ? `${p.odometer} ${p.odometer_unit || "km"}` : "", p.keys_qty, p.remote_locking == null ? "" : p.remote_locking ? "yes" : "no", p.wheels_good, p.windows_open, (p.airbags || []).join("; "), (p.extras || []).join(" "), p.progi_status,
    p.progi_submitted_at ? dayKey(p.progi_submitted_at) : "", p.qb_status, p.invoice_path ? "yes" : "no", (p.photo_paths || []).length, p.notes,
  ].map(cell).join(",")));
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const r = S.filters.range;
  a.download = `pickups-${r === "all" ? "all" : r === "0" ? dayKey(new Date()) : "last-" + r + "-days"}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

async function dailyCleanup() {
  const k = "mp-cleanup", today = dayKey(new Date());
  if (localStorage.getItem(k) === today) return;
  try {
    const r = await adminCall({ action: "cleanup" });
    localStorage.setItem(k, today);
    if (r?.photos_deleted || r?.invoices_deleted) console.info("cleanup", r);
  } catch (e) { console.warn("cleanup skipped:", e.message); }
}

// ─────────────────────────────────────────────────────────────── detail
function condHtml(p) {
  const bits = [];
  if (p.odometer_unreadable) bits.push("Odometer: can't read"); else if (p.odometer != null) bits.push(`Odometer: ${Number(p.odometer).toLocaleString("en-CA")} ${p.odometer_unit === "mi" ? "mi" : "km"}`);
  if (p.transmission) bits.push(p.transmission);
  if (p.keys_qty != null) bits.push(`Keys: ${p.keys_qty === 3 ? "3+" : p.keys_qty}${p.remote_locking ? " + remote" : p.remote_locking === false ? " (no remote)" : ""}`);
  if (p.wheels_good != null) bits.push(`Good wheels: ${p.wheels_good}`);
  if (p.windows_open) bits.push(`Windows open/broken: ${p.windows_open}`);
  if (p.airbags?.length) bits.push(`Airbags: ${p.airbags.join(", ")}`);
  if (p.equipment?.length) bits.push(`Equipment: ${p.equipment.join(", ")}`);
  if (p.broken_parts?.length) bits.push(`Broken: ${p.broken_parts.join(", ")}`);
  if (p.missing_parts?.length || p.missing_other) bits.push(`Missing: ${[...(p.missing_parts || []), p.missing_other].filter(Boolean).join(", ")}`);
  const sp = p.vehicle_specs;
  if (sp) bits.push([sp.trim, sp.liters && sp.liters + "L", sp.cylinders && sp.cylinders + " cyl", sp.fuel].filter(Boolean).join(" · "));
  return bits.length ? `<ul class="cond-list">${bits.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>` : "";
}
function feesHtml(p) {
  const fa = p.fees_ai;
  if (!fa) return p.invoice_path ? `<button class="btn sm" id="feesAiBtn">Read invoice amounts (AI)</button>` : "";
  const row = (l, v) => v == null || v === "" ? "" : `<div><small>${esc(l)}</small><b>${typeof v === "number" ? money(v) : esc(v)}</b></div>`;
  return `<div class="kv fees">
    ${row("Towing", fa.towing)}${row("Daily storage", fa.daily_storage)}${row("Storage days", fa.storage_days != null ? String(fa.storage_days) : "")}${row("Total storage", fa.total_storage)}
    ${(fa.other || []).map((o) => row(o.description || "Other", o.amount)).join("")}
    ${row("Before tax", fa.subtotal)}${row("HST", fa.tax)}${row("Total", fa.total)}
  </div>${fa.note ? `<p class="hint">${esc(fa.note)}</p>` : ""}<button class="btn sm ghost" id="feesAiBtn">Read again (AI)</button>`;
}
async function renderDetail(id) {
  shell(`<div class="muted">Loading…</div>`, { title: "Pickup", back: () => go(isOwner() ? "dash" : "home") });
  const { data: p, error } = await sb.from("pickups").select("*").eq("id", id).maybeSingle();
  if (error || !p) { $(".main").innerHTML = `<div class="empty">Not found${error ? ": " + esc(error.message) : ""}.</div>`; return; }
  if (isOwner() && !S.drivers.length) await loadDrivers();
  const canEdit = isOwner() || (p.driver_id === S.user.id && isToday(p.recorded_at));
  const veh = [p.year, p.make, p.model].filter(Boolean).join(" ");

  shell(`
    <section class="card head">
      <div class="headrow"><h2 class="mono">${esc(p.file_number)}</h2>${progiPill(p)}${isOwner() ? (p.qb_status === "done" ? `<span class="pill green">QuickBooks ✓</span>` : p.paid ? `<span class="pill">QB pending</span>` : "") : ""}</div>
      <div>${esc(veh)} · ${esc([p.color, p.vehicle_type, p.drive_type].filter(Boolean).join(" · "))} ${p.burned ? `<span class="pill red">Burned</span>` : ""}</div>
      ${p.vin ? `<div class="mono small">VIN ${esc(p.vin)}</div>` : ""}
      <div class="muted small">Picked up ${whenLabel(p.picked_up_at || p.recorded_at)} · ${esc(isOwner() ? driverName(p.driver_id) : S.me.full_name)}${p.shop_name ? " · from " + esc(p.shop_name) : ""}</div>
      <div class="kv">
        <div><small>Payment</small><b>${p.paid ? `${money(p.amount)} ${p.hst_included ? "incl. HST" : "+ HST"}` : "None"}</b>${p.paid ? `<span>${PAY_LABEL[p.payment_type]}${p.card_last4 ? " ••" + esc(p.card_last4) : ""}${p.cheque_number ? " #" + esc(p.cheque_number) : ""}${p.cheque_date ? " · dated " + esc(p.cheque_date) : ""}</span>` : ""}</div>
        <div><small>Extras</small><b>${p.extras?.length ? p.extras.map((x) => EXTRAS.find((e) => e[0] === x)?.[1] + ` (${x})`).join(", ") : "—"}</b></div>
      </div>
      ${p.notes ? `<p class="note">${esc(p.notes)}</p>` : ""}
      ${condHtml(p)}
    </section>

    <section class="card">
      <h3>Shop invoice</h3>
      ${isOwner() && p.paid ? feesHtml(p) : ""}
      ${p.invoice_path ? `<div class="btnrow"><button class="btn" id="openPdf">Open PDF</button><button class="btn ghost" id="dlPdf">Download ${esc(p.file_number)}.pdf</button></div>`
        : p.invoice_purged_at ? `<p class="muted">Auto-deleted ${fmtShort.format(new Date(p.invoice_purged_at))}.</p>` : `<p class="muted">${p.paid ? "⚠ No invoice attached." : "No invoice."}</p>`}
      <h3>Photos ${p.photo_paths?.length ? `<span class="muted">(${p.photo_paths.length})</span>` : ""}</h3>
      ${p.photo_paths?.length ? `<div class="photos gallery">${p.photo_paths.map((x) => `<div class="ph" data-path="${esc(x)}"><div class="phload"></div></div>`).join("")}</div>`
        : `<p class="muted">${p.photos_purged_at ? "Auto-deleted " + fmtShort.format(new Date(p.photos_purged_at)) + "." : "No photos."}</p>`}
    </section>

    ${isOwner() ? `
    <section class="card stack">
      <h3>Office</h3>
      <div class="btnrow">
        ${p.progi_status === "submitted"
          ? `<button class="btn ghost" id="progiBtn" data-v="pending">Undo Progi (submitted ${fmtShort.format(new Date(p.progi_submitted_at))})</button>`
          : p.progi_status === "queued"
          ? `<button class="btn ghost" id="queueBtn" data-v="pending">📤 In Progi upload queue — cancel</button>
             <button class="btn" id="progiBtn" data-v="submitted">Mark as submitted to Progi</button>`
          : `<button class="btn primary" id="queueBtn" data-v="queued">📤 Upload to Progi</button>
             <button class="btn" id="progiBtn" data-v="submitted">Mark as submitted to Progi</button>`}
        ${p.qb_status === "done"
          ? `<button class="btn ghost" id="qbBtn" data-v="pending">Undo QuickBooks (${fmtShort.format(new Date(p.qb_done_at))})</button>`
          : `<button class="btn" id="qbBtn" data-v="done">Mark entered in QuickBooks</button>`}
      </div>
      <div id="delBox"><button class="btn danger ghost" id="delBtn">Delete pickup…</button></div>
    </section>` : ""}

    ${canEdit ? `<section class="card"><h3>${isOwner() ? "Edit" : "Edit (today only)"}</h3><div id="editMount"></div></section>`
      : `<p class="muted small center">Only today's pickups can be edited. Ask the office for changes.</p>`}

    ${isOwner() ? `<section class="card"><h3>History</h3><div id="hist" class="muted small">Loading…</div></section>` : ""}
  `, { title: p.file_number, back: () => go(isOwner() ? "dash" : "home") });

  loadThumbs($(".main"));
  if (p.invoice_path) {
    $("#openPdf").onclick = async () => { const w = window.open("", "_blank"); try { const u = await signedUrl(p.invoice_path); if (w) w.location = u; else location.href = u; } catch (e) { w?.close(); toast(e.message, "err"); } };
    $("#dlPdf").onclick = async () => { try { location.href = await signedUrl(p.invoice_path, `${p.file_number}.pdf`); } catch (e) { toast(e.message, "err"); } };
  }
  if (canEdit) renderForm(p, { mount: $("#editMount"), onSaved: () => go(isOwner() ? "dash" : "home") });

  if (!isOwner()) return;
  const aiBtn = $("#feesAiBtn");
  if (aiBtn) aiBtn.onclick = async () => {
    aiBtn.disabled = true; aiBtn.textContent = "Reading invoice…";
    try { await adminCall({ action: "invoiceRead", id: p.id }); toast("Invoice read ✓", "ok"); renderDetail(p.id); }
    catch (e) { toast(e.message, "err"); aiBtn.disabled = false; aiBtn.textContent = "Read invoice amounts (AI)"; }
  };
  const setField = async (patch, msg) => {
    const { error: e } = await sb.from("pickups").update(patch).eq("id", p.id);
    if (e) return toast(e.message, "err");
    toast(msg, "ok"); renderDetail(p.id);
  };
  $("#progiBtn").onclick = (e) => setField({ progi_status: e.target.dataset.v }, e.target.dataset.v === "submitted" ? "Marked submitted to Progi" : "Set back to pending");
  const qb = $("#queueBtn");
  if (qb) qb.onclick = (e) => {
    const v = e.target.dataset.v;
    if (v === "queued" && (p.photo_paths?.length || 0) < PROGI_MIN_PHOTOS && !confirm(`Only ${p.photo_paths?.length || 0} photos (Progi needs ${PROGI_MIN_PHOTOS}). Add to the upload queue anyway?`)) return;
    setField({ progi_status: v }, v === "queued" ? "Added to the Progi upload queue" : "Removed from the upload queue");
  };
  $("#qbBtn").onclick = (e) => setField({ qb_status: e.target.dataset.v }, e.target.dataset.v === "done" ? "Marked done in QuickBooks" : "Set back to pending");
  $("#delBtn").onclick = () => {
    $("#delBox").innerHTML = `<div class="confirm">Delete <b>${esc(p.file_number)}</b> and its files? This can't be undone.
      <div class="btnrow"><button class="btn danger" id="delYes">Yes, delete</button><button class="btn ghost" id="delNo">Cancel</button></div></div>`;
    $("#delNo").onclick = () => renderDetail(p.id);
    $("#delYes").onclick = async () => {
      const files = [...(p.photo_paths || []), p.invoice_path].filter(Boolean);
      const { error: e } = await sb.from("pickups").delete().eq("id", p.id);
      if (e) return toast(e.message, "err");
      if (files.length) await sb.storage.from(BUCKET).remove(files);
      toast("Deleted", "ok"); go("dash");
    };
  };

  const { data: hist } = await sb.from("audit_log").select("*").eq("pickup_id", p.id).order("changed_at", { ascending: false }).limit(50);
  const hide = new Set(["updated_at", "photo_paths", "invoice_path", "client_id", "id", "created_at"]);
  $("#hist").innerHTML = (hist || []).map((h) => {
    const who = driverName(h.changed_by) === "—" ? "system" : driverName(h.changed_by);
    let what = h.action === "insert" ? "created" : h.action === "delete" ? "deleted" : "";
    if (h.action === "update") {
      what = Object.entries(h.changes || {}).filter(([k]) => !hide.has(k))
        .map(([k, [a, b]]) => `${k.replace(/_/g, " ")}: <s>${esc(fmtVal(a))}</s> → <b>${esc(fmtVal(b))}</b>`).join("; ");
      if (!what) what = "files updated";
    }
    return `<div class="hrow"><span>${whenLabel(h.changed_at)} · ${esc(who)}</span><span>${what}</span></div>`;
  }).join("") || "No history.";
}
const fmtVal = (v) => v == null ? "—" : Array.isArray(v) ? v.join(" ") || "—" : typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) ? whenLabel(v) : String(v);

// ─────────────────────────────────────────────────────────────── drivers (owner)
async function renderDrivers() {
  shell(`
    <section class="card stack">
      <h3>Add driver</h3>
      <form id="addDrv" class="stack">
        <div class="row2">
          <label class="field"><span>Full name</span><input name="full_name" required></label>
          <label class="field"><span>Phone</span><input name="phone" inputmode="tel"></label>
        </div>
        <div class="row2">
          <label class="field"><span>Username (for sign in)</span><input name="username" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="mike" required></label>
          <label class="field"><span>Password (min 6)</span><input name="password" required minlength="6"></label>
        </div>
        <p class="err-text" id="drvErr"></p>
        <button class="btn primary" type="submit">Add driver</button>
      </form>
    </section>
    <section class="card"><h3>Drivers</h3><div id="drvList" class="muted">Loading…</div></section>`, { title: "Drivers" });

  $("#addDrv").onsubmit = async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    const b = e.target.querySelector("button"); b.disabled = true;
    try {
      await adminCall({ action: "create_driver", ...fd, username: fd.username.trim().toLowerCase() });
      toast(`Added ${fd.full_name}. Sign in: ${fd.username.trim().toLowerCase()}`, "ok");
      renderDrivers();
    } catch (err) { $("#drvErr").textContent = err.message; b.disabled = false; }
  };
  await loadDrivers();
  $("#drvList").innerHTML = S.drivers.map((d) => `
    <div class="drv ${d.active ? "" : "off"}" data-id="${d.id}">
      <div><b>${esc(d.full_name)}</b> ${d.role === "owner" ? `<span class="pill">Owner</span>` : ""} ${d.active ? "" : `<span class="pill red">Off</span>`}
        <div class="muted small">sign-in: <span class="mono">${esc(d.username)}</span>${d.phone ? " · " + esc(d.phone) : ""}</div></div>
      <div class="btnrow">
        <button class="btn sm ghost" data-act="pw">Reset password</button>
        ${d.role === "owner" ? "" : `<button class="btn sm ${d.active ? "ghost danger" : ""}" data-act="toggle">${d.active ? "Turn off" : "Turn on"}</button>`}
      </div>
      <div class="pwbox" hidden><input placeholder="New password (min 6)" minlength="6"><button class="btn sm primary" data-act="pwsave">Save</button></div>
    </div>`).join("");
  $("#drvList").onclick = async (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return;
    const row = b.closest(".drv"), id = row.dataset.id, d = S.drivers.find((x) => x.id === id);
    try {
      if (b.dataset.act === "pw") { row.querySelector(".pwbox").hidden = false; row.querySelector(".pwbox input").focus(); }
      if (b.dataset.act === "pwsave") {
        const pw = row.querySelector(".pwbox input").value;
        await adminCall({ action: "reset_password", id, password: pw });
        toast(`Password changed for ${d.full_name}`, "ok"); renderDrivers();
      }
      if (b.dataset.act === "toggle") {
        await adminCall({ action: "update_driver", id, active: !d.active });
        toast(`${d.full_name} turned ${d.active ? "off" : "on"}`, "ok"); renderDrivers();
      }
    } catch (err) { toast(err.message, "err"); }
  };
}

// ─────────────────────────────────────────────────────────────── start
if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("./sw.js").catch(() => {});
boot();

// ---- photo viewer: click any photo thumbnail to see it large (← → to move, Esc / click to close)
function openViewer(imgs, start) {
  let i = start;
  const ov = document.createElement("div");
  ov.className = "viewer";
  ov.innerHTML = `<img alt=""><button type="button" class="vbtn vprev" aria-label="Previous">‹</button>
    <button type="button" class="vbtn vnext" aria-label="Next">›</button><button type="button" class="vbtn vclose" aria-label="Close">×</button><div class="vcount"></div>`;
  const show = () => { ov.querySelector("img").src = imgs[i]; ov.querySelector(".vcount").textContent = `${i + 1} / ${imgs.length}`; };
  const close = () => { ov.remove(); document.removeEventListener("keydown", key); };
  const step = (d) => { i = (i + d + imgs.length) % imgs.length; show(); };
  const key = (e) => { if (e.key === "Escape") close(); else if (e.key === "ArrowLeft") step(-1); else if (e.key === "ArrowRight") step(1); };
  ov.onclick = (e) => {
    if (e.target.closest(".vprev")) step(-1); else if (e.target.closest(".vnext")) step(1); else close();
  };
  ov.querySelector(".vprev").hidden = ov.querySelector(".vnext").hidden = imgs.length < 2;
  document.addEventListener("keydown", key);
  document.body.appendChild(ov); show();
}
document.addEventListener("click", (e) => {
  const img = e.target.closest(".ph img");
  if (!img || e.target.closest(".x")) return;
  const grid = img.closest(".photos") || img.parentElement;
  const all = [...grid.querySelectorAll(".ph img")].filter((x) => x.src);
  openViewer(all.map((x) => x.src), Math.max(0, all.indexOf(img)));
});
