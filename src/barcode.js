import { $, toast } from "./dom.js";

/* ---------- barcode reading ---------- */
async function loadBitmap(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch {} }
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
// ZXing, for browsers without a BarcodeDetector. Loaded the first time a photo needs
// it: its own chunk in the web build and the demo, inlined in the artifact (one file).
// A failed load (a web build chunk on a bad connection) isn't kept, so the next scan tries again.
let zx = null;
async function zxReader() {
  if (zx) return zx;
  const { MultiFormatReader, BarcodeFormat: F, DecodeHintType, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } = await import("./zxing.js");
  const reader = new MultiFormatReader(), hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);
  const bitmap = ({ L, width, height }) => new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(L, width, height)));
  return (zx = { reader, hints, bitmap, F });
}
// Grayscale pixels of a canvas, and the same turned a quarter turn. ZXing reads a 1D code
// along rows only; it can rotate a canvas source itself, but that is several times slower.
function grays(canvas) {
  const { data, width, height } = canvas.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const L = new Uint8ClampedArray(width * height);
  for (let i = 0; i < L.length; i++) L[i] = (data[4 * i] * 306 + data[4 * i + 1] * 601 + data[4 * i + 2] * 117) >> 10;
  return { L, width, height };
}
function turned({ L, width, height }) {
  const T = new Uint8ClampedArray(L.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) T[x * height + (height - 1 - y)] = L[y * width + x];
  return { L: T, width: height, height: width };
}
function zxDecode({ reader, hints, bitmap, F }, canvas) {
  const flat = grays(canvas);
  for (const pixels of [flat, turned(flat)]) {
    try {
      const r = reader.decode(bitmap(pixels), hints);
      return { fmt: String(F[r.getBarcodeFormat()]).toLowerCase(), text: r.getText() };
    } catch {} finally { reader.reset(); }
  }
  return null;
}

// Wrong-code protection. A retail code whose check digit is wrong is a misread
// ("bad"); a short Codabar or Code 39 is what stray bars in a photo often look like,
// so it is only believed when a second, separate decode agrees ("weak").
function verdict(fmt, text) {
  if (fmt === "ean_13" || fmt === "upc_a" || fmt === "ean_8") {
    if (!/^(\d{8}|\d{12,13})$/.test(text)) return "bad";
    const d = [...text].map(Number), check = d.pop();
    const sum = d.reverse().reduce((a, n, i) => a + n * (i % 2 ? 1 : 3), 0);
    return (10 - (sum % 10)) % 10 === check ? "ok" : "bad";
  }
  return (fmt === "codabar" || fmt === "code_39") && text.length < 6 ? "weak" : "ok";
}
function judge() {
  const seen = new Set();
  return (fmt, raw) => {
    const text = String(raw).trim(), v = text ? verdict(fmt, text) : "bad";
    if (v === "ok") return text;
    if (v === "weak") { if (seen.has(text)) return text; seen.add(text); }
    return null;
  };
}

// Passes for a barcode that is small in a big, busy photo: tiles of the photo, read
// separately (so the binarizer sees one patch, not the whole scene), at a few scales.
// max = longest edge the photo is scaled to (0 = as taken), t = tile edge, div = tiles per edge step.
const TILE_PASSES = [{ max: 1000, t: 400, div: 4 }, { max: 0, t: 1000, div: 2 }, { max: 1400, t: 560, div: 4 }, { max: 700, t: 250, div: 4 }];
const BUDGET_MS = 6000;
const pause = () => new Promise((r) => setTimeout(r));
const blankCanvas = (w, h) => {
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h }), g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); // a transparent photo reads as white, not black
  return c;
};
const starts = (len, t, div) => { const out = []; for (let p = 0; p < len - t; p += Math.ceil(t / div)) out.push(p); out.push(Math.max(0, len - t)); return out; };

async function decodeImage(file) {
  const bmp = await loadBitmap(file);
  const ok = judge();
  if ("BarcodeDetector" in window) {
    try {
      const found = await new BarcodeDetector().detect(bmp);
      const area = (f) => (f.boundingBox ? f.boundingBox.width * f.boundingBox.height : 0);
      // several codes in one photo: the biggest one is the one aimed at
      for (const f of [...found].sort((a, b) => area(b) - area(a))) { const t = ok(f.format, f.rawValue); if (t) return t; }
    } catch {}
  }
  const zx = await zxReader();
  const read = (c) => { const r = zxDecode(zx, c); return r && ok(r.fmt, r.text); };
  const w = bmp.width, h = bmp.height, long = Math.max(w, h);
  for (const max of [1280, 900, 1800, 2600]) {
    const k = Math.min(1, max / long);
    const c = blankCanvas(Math.round(w * k), Math.round(h * k));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const txt = read(c); if (txt) return txt;
    if (k === 1) break;
  }
  const deadline = performance.now() + BUDGET_MS;
  for (const { max, t, div } of TILE_PASSES) {
    const k = max ? Math.min(1, max / long) : 1, bw = Math.round(w * k), bh = Math.round(h * k);
    const tw = Math.min(t, bw), th = Math.min(t, bh);
    if (tw === bw && th === bh) continue; // the whole photo again
    const base = blankCanvas(bw, bh);
    base.getContext("2d").drawImage(bmp, 0, 0, w, h, 0, 0, bw, bh);
    for (const y of starts(bh, th, div)) for (const x of starts(bw, tw, div)) {
      if (performance.now() > deadline) return null;
      await pause(); // keep the page responsive
      const c = blankCanvas(tw, th);
      c.getContext("2d").drawImage(base, x, y, tw, th, 0, 0, tw, th);
      const txt = read(c); if (txt) return txt;
    }
  }
  return null;
}
export async function scanFromInput(input) {
  const file = input.files && input.files[0]; input.value = "";
  if (!file) return null;
  toast("Reading barcode…", 8000);
  let code = null;
  try { code = await decodeImage(file); } catch {}
  if (!code) { toast("No barcode found. Fill the frame with the barcode, keep it flat and well lit, or type the number.", 5000); return null; }
  $("#toast").hidden = true;
  return code.trim();
}
