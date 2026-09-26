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
  const { MultiFormatReader, BarcodeFormat: F, DecodeHintType, BinaryBitmap, HybridBinarizer, HTMLCanvasElementLuminanceSource } = await import("./zxing.js");
  const reader = new MultiFormatReader(), hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  reader.setHints(hints);
  const bitmap = (canvas) => new BinaryBitmap(new HybridBinarizer(new HTMLCanvasElementLuminanceSource(canvas)));
  return (zx = { reader, hints, bitmap });
}
function zxDecode({ reader, hints, bitmap }, canvas) {
  try {
    return reader.decode(bitmap(canvas), hints).getText();
  } catch { return null; } finally { reader.reset(); }
}
async function decodeImage(file) {
  const bmp = await loadBitmap(file);
  if ("BarcodeDetector" in window) {
    try { const found = await new BarcodeDetector().detect(bmp); if (found && found.length) return found[0].rawValue; } catch {}
  }
  const zx = await zxReader();
  const w = bmp.width, h = bmp.height;
  for (const max of [1280, 900, 1800, 2600]) {
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const txt = zxDecode(zx, c); if (txt) return txt;
    if (k === 1) break;
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
