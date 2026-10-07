import { $, toast } from "./dom.js";

/* ---------- barcode reading ---------- */
async function loadBitmap(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch {} }
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
// ZXing, for browsers without a BarcodeDetector. Loaded the first time a photo needs
// it: its own chunk in the web build and the demo, inlined in the artifact (one file).
// A failed load (a web build chunk on a bad connection) isn't kept, so the next scan tries again.
// Two readers: "any" reads every format we take; "line" only 1D codes, for pixels turned a
// quarter turn (a QR code or Data Matrix reads the same either way, so turning is for 1D codes).
let zx = null;
async function zxReader() {
  if (zx) return zx;
  const { MultiFormatReader, BarcodeFormat: F, DecodeHintType, BinaryBitmap, HybridBinarizer, RGBLuminanceSource } = await import("./zxing.js");
  const LINE = [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR];
  const reader = (formats) => {
    const r = new MultiFormatReader(), hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, formats);
    hints.set(DecodeHintType.TRY_HARDER, true);
    r.setHints(hints);
    return { r, hints };
  };
  const bitmap = ({ L, width, height }) => new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(L, width, height)));
  return (zx = { any: reader([...LINE, F.QR_CODE, F.DATA_MATRIX]), line: reader(LINE), bitmap, F });
}
function zxRead({ bitmap, F }, { r, hints }, pixels) {
  try {
    const res = r.decode(bitmap(pixels), hints);
    return { fmt: String(F[res.getBarcodeFormat()]).toLowerCase(), text: res.getText() };
  } catch { return null; } finally { r.reset(); }
}

// Grayscale pixels of a canvas, a part of them, and the same turned a quarter turn. ZXing reads
// a 1D code along rows only, and reverses each row itself (so a code upside down, at 180° or
// 270°, needs no pass of its own); it can rotate a canvas source, but that is several times slower.
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

// Wrong-code protection. A retail code whose check digit is wrong is a misread
// ("bad"). A short Codabar or Code 39 is what stray bars in a photo often look like, and
// an 8-digit EAN-8 or UPC-E what a slanted scan across part of a longer retail code can look
// like (one in ten of those has a check digit that works), so they are only believed when a
// second, separate decode agrees ("weak").
const checkDigitOk = (digits) => {
  const d = [...digits].map(Number), check = d.pop();
  return (10 - (d.reverse().reduce((a, n, i) => a + n * (i % 2 ? 1 : 3), 0) % 10)) % 10 === check;
};
// A UPC-E code (number system 0 or 1, six digits, check digit) is a UPC-A with zeros left out;
// its check digit is the UPC-A's.
function upcA(e) {
  const [ns, a, b, c, d, f, last, check] = e;
  const mid = last <= "2" ? a + b + last + "0000" + c + d + f : last === "3" ? a + b + c + "00000" + d + f : last === "4" ? a + b + c + d + "00000" + f : a + b + c + d + f + "0000" + last;
  return ns + mid + check;
}
function verdict(fmt, text) {
  if (fmt === "ean_13" || fmt === "upc_a") return /^\d{12,13}$/.test(text) && checkDigitOk(text) ? "ok" : "bad";
  if (fmt === "ean_8") return /^\d{8}$/.test(text) && checkDigitOk(text) ? "weak" : "bad";
  if (fmt === "upc_e") return /^[01]\d{7}$/.test(text) && checkDigitOk(upcA(text)) ? "weak" : "bad";
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

// Where a 1D code is: its bars make edges that all run one way. For cells of C pixels, the
// summed brightness steps across (gx) and down (gy); a code with upright bars has gx far over gy.
const C = 16;
function edges({ L, width: W, height: H }) {
  const cw = Math.ceil(W / C), ch = Math.ceil(H / C), gx = new Float32Array(cw * ch), gy = new Float32Array(cw * ch);
  for (let y = 0; y < H; y++) {
    const row = ((y / C) | 0) * cw, down = y + 1 < H;
    for (let x = 0, i = y * W; x < W; x++, i++) {
      const c = row + ((x / C) | 0);
      if (x + 1 < W) gx[c] += Math.abs(L[i + 1] - L[i]);
      if (down) gy[c] += Math.abs(L[i + W] - L[i]);
    }
  }
  return { cw, ch, gx, gy };
}
// Spots that look like a 1D code: groups of touching cells with strong edges one way (at least
// SPOT of the strongest cell's), biggest first. Each comes with a margin for the code's quiet
// zones, and says whether its bars lie flat (turn: read it turned a quarter turn). The edge of
// a box in the photo makes a strip of such cells too, but along its bars; a code's bars are
// at most BARS times as long as the code. The smallest code ZXing reads, an EAN-8 a pixel to the
// bar, covers MIN_CELLS cells; a box's corner, fewer.
const SPOT = 0.3, MIN_STEP = 4 * C * C, MIN_CELLS = 8, BARS = 2;
function spots(px) {
  const { cw, ch, gx, gy } = edges(px), pw = cw + 2;
  // one-way edge strength per cell, in a grid with an empty border, so every cell has four neighbours
  const d = new Float32Array(pw * (ch + 2));
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) d[(y + 1) * pw + x + 1] = gx[y * cw + x] - gy[y * cw + x];
  const thr = Math.max(MIN_STEP, SPOT * d.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
  const seen = new Uint8Array(d.length), out = [];
  for (let i = 0; i < d.length; i++) {
    if (seen[i] || Math.abs(d[i]) < thr) continue;
    const sign = Math.sign(d[i]), stack = [i];
    let x0 = pw, x1 = 0, y0 = ch + 2, y1 = 0, score = 0, n = 0;
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop(), x = (j % pw) - 1, y = ((j / pw) | 0) - 1;
      score += Math.abs(d[j]); n++;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      for (const k of [j + 1, j - 1, j + pw, j - pw]) {
        if (seen[k] || Math.sign(d[k]) !== sign || Math.abs(d[k]) < thr) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    const turn = sign < 0, across = x1 - x0 + 1, down = y1 - y0 + 1;
    if (n < MIN_CELLS || (turn ? across > BARS * down : down > BARS * across)) continue;
    const mx = 0.25 * across * C + 2 * C, my = 0.25 * down * C + 2 * C;
    const x = Math.max(0, Math.round(x0 * C - mx)), y = Math.max(0, Math.round(y0 * C - my));
    out.push({ x, y, w: Math.min(px.width, Math.round((x1 + 1) * C + mx)) - x, h: Math.min(px.height, Math.round((y1 + 1) * C + my)) - y, turn, score });
  }
  return out.sort((a, b) => b.score - a.score);
}

// Passes, cheapest first, until a code is found or the time budget is spent:
// 1. the whole photo at a few sizes;
// 2. spots that look like a 1D code, each cropped out and read across its bars, the likeliest
//    first. ZXing picks each row's black point from the whole row, so a small code in a busy
//    photo reads only when cropped. SPOT_PASSES: the photo's longest edge (FULL: as taken), and
//    the last pass on the photo turned 45° (its longest edge then), for a code held at a
//    slant: its edges run both ways, so it only looks like a code once turned;
// 3. tiles of the photo (TILE_PASSES), read separately so the binarizer sees one patch, not
//    the whole scene: for a QR code or Data Matrix (or a 1D code no spot found), the photo as
//    taken first, and in each pass the busiest tiles (the most edges) first.
// For tiles, max = longest edge the photo is scaled to, t = tile edge, div = tiles per edge step.
// FULL is as taken, up to 16 megapixels: a bigger canvas is blank in iOS Safari.
const FULL = 4096;
const SPOT_PASSES = [{ max: FULL }, { max: 1600 }, { max: 3000, slant: true }], SPOTS_PER_PASS = 6;
const TILE_PASSES = [{ max: FULL, t: 1000, div: 2 }, { max: 1000, t: 400, div: 4 }, { max: 1400, t: 560, div: 4 }, { max: 700, t: 250, div: 4 }];
const BUDGET_MS = 6000;
const pause = () => new Promise((r) => setTimeout(r));
const blankCanvas = (w, h) => {
  const c = Object.assign(document.createElement("canvas"), { width: w, height: h }), g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); // a transparent photo reads as white, not black
  g.imageSmoothingQuality = "high"; // shrinking averages the pixels, so thin bars don't alias away
  return c;
};
const starts = (len, t, div) => { const out = []; for (let p = 0; p < len - t; p += Math.ceil(t / div)) out.push(p); out.push(Math.max(0, len - t)); return out; };
// The photo scaled down to a longest edge of max, as a canvas; slant: turned 45°
// first, on a canvas big enough for all of it (the longest edge is then the canvas's).
function scaled(bmp, max, slant = false) {
  const w = bmp.width, h = bmp.height, side = slant ? (w + h) / Math.SQRT2 : Math.max(w, h);
  const k = Math.min(1, max / side);
  const c = blankCanvas(Math.round((slant ? side : w) * k), Math.round((slant ? side : h) * k)), g = c.getContext("2d");
  g.translate(c.width / 2, c.height / 2); g.rotate(slant ? Math.PI / 4 : 0); g.scale(k, k);
  g.drawImage(bmp, 0, 0, w, h, -w / 2, -h / 2, w, h);
  return c;
}
// A part of a canvas, as its own canvas
function part(base, x, y, w, h) {
  const c = blankCanvas(w, h);
  c.getContext("2d").drawImage(base, x, y, w, h, 0, 0, w, h);
  return c;
}

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
  const got = (r) => r && ok(r.fmt, r.text);
  // as is with every format, then turned with the 1D ones
  const read = (px) => got(zxRead(zx, zx.any, px)) || got(zxRead(zx, zx.line, turned(px)));
  const w = bmp.width, h = bmp.height, long = Math.max(w, h);
  for (const max of [1280, 900, 1800, 2600]) {
    const k = Math.min(1, max / long);
    const c = blankCanvas(Math.round(w * k), Math.round(h * k));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const txt = read(grays(c)); if (txt) return txt;
    if (k === 1) break;
  }
  const deadline = performance.now() + BUDGET_MS;
  for (const { max, slant } of SPOT_PASSES) {
    await pause(); // keep the page responsive
    const base = scaled(bmp, max, slant);
    for (const s of spots(grays(base)).slice(0, SPOTS_PER_PASS)) {
      if (performance.now() > deadline) return null;
      await pause();
      const px = grays(part(base, s.x, s.y, s.w, s.h));
      const txt = got(zxRead(zx, zx.line, s.turn ? turned(px) : px)); if (txt) return txt;
    }
  }
  for (const { max, t, div } of TILE_PASSES) {
    await pause();
    const base = scaled(bmp, max), bw = base.width, bh = base.height;
    const tw = Math.min(t, bw), th = Math.min(t, bh);
    if (tw === bw && th === bh) continue; // the whole photo again
    const { cw, gx, gy } = edges(grays(base)), tiles = [];
    for (const y of starts(bh, th, div)) for (const x of starts(bw, tw, div)) {
      let score = 0;
      for (let cy = Math.floor(y / C); cy < Math.ceil((y + th) / C); cy++) for (let cx = Math.floor(x / C); cx < Math.ceil((x + tw) / C); cx++) score += gx[cy * cw + cx] + gy[cy * cw + cx];
      tiles.push({ x, y, score });
    }
    for (const { x, y } of tiles.sort((a, b) => b.score - a.score)) {
      if (performance.now() > deadline) return null;
      await pause();
      const txt = read(grays(part(base, x, y, tw, th))); if (txt) return txt;
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
