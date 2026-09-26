// The parts of ZXing (@zxing/library) that barcode.js uses. The package's index pulls
// in its writers and browser camera readers too, and isn't marked side-effect free,
// so these deep imports keep the chunk about a quarter smaller.
export { default as MultiFormatReader } from "@zxing/library/esm/core/MultiFormatReader.js";
export { default as BinaryBitmap } from "@zxing/library/esm/core/BinaryBitmap.js";
export { default as HybridBinarizer } from "@zxing/library/esm/core/common/HybridBinarizer.js";
export { HTMLCanvasElementLuminanceSource } from "@zxing/library/esm/browser/HTMLCanvasElementLuminanceSource.js";
export { default as BarcodeFormat } from "@zxing/library/esm/core/BarcodeFormat.js";
export { default as DecodeHintType } from "@zxing/library/esm/core/DecodeHintType.js";
