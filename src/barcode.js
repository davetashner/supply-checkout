import { $, toast } from "./dom.js";

/* ---------- barcode reading ---------- */
async function loadBitmap(file) {
  if (window.createImageBitmap) { try { return await createImageBitmap(file); } catch {} }
  return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = rej; img.src = URL.createObjectURL(file); });
}
let zxReader = null, zxHints = null;
function zxDecode(canvas) {
  const Z = window.ZXing; if (!Z) return null;
  if (!zxReader) {
    zxReader = new Z.MultiFormatReader(); zxHints = new Map();
    const F = Z.BarcodeFormat;
    zxHints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.CODE_93, F.ITF, F.CODABAR, F.QR_CODE, F.DATA_MATRIX]);
    zxHints.set(Z.DecodeHintType.TRY_HARDER, true);
    zxReader.setHints(zxHints);
  }
  try {
    const bmp = new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)));
    return zxReader.decode(bmp, zxHints).getText();
  } catch { return null; } finally { try { zxReader.reset(); } catch {} }
}
async function decodeImage(file) {
  const bmp = await loadBitmap(file);
  if ("BarcodeDetector" in window) {
    try { const found = await new BarcodeDetector().detect(bmp); if (found && found.length) return found[0].rawValue; } catch {}
  }
  const w = bmp.width, h = bmp.height;
  for (const max of [1280, 900, 1800, 2600]) {
    const k = Math.min(1, max / Math.max(w, h));
    const c = document.createElement("canvas"); c.width = Math.round(w * k); c.height = Math.round(h * k);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const txt = zxDecode(c); if (txt) return txt;
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
