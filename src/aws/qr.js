// A QR code as an inline SVG, for the authenticator app's secret (mfa.js). ZXing's encoder,
// deep-imported like src/zxing.js, so only it comes along; mfa.js loads this module only
// when the setup dialog shows a code.
import Encoder from "@zxing/library/esm/core/qrcode/encoder/Encoder.js";
import ErrorCorrectionLevel from "@zxing/library/esm/core/qrcode/decoder/ErrorCorrectionLevel.js";

// The quiet zone scanners need around the code, in modules
const QUIET = 4;

// Dark modules on white whatever the theme: scanners want dark on light
export function qrSvg(text, label) {
  const matrix = Encoder.encode(text, ErrorCorrectionLevel.M).getMatrix();
  const n = matrix.getWidth(), size = n + 2 * QUIET;
  let d = "";
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (matrix.get(x, y) === 1) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
