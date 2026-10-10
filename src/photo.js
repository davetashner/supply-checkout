// Receipt photos are shrunk on the device before they're sent to be read: at most 1568 px on
// the long edge (as large as the model reads an image without scaling it down itself) and
// JPEG at 0.8 quality, so a 12 MP phone photo goes up as a few hundred KB, well under the
// request limits, and costs fewer tokens. A photo with so much fine detail (or sensor noise)
// that it's still over 600 KB is encoded again at lower qualities. The photo is drawn the way
// it was taken: a phone that stores it sideways with an EXIF orientation tag gets it turned
// upright here, so the pixels sent are upright whether or not the reader looks at EXIF.
export const MAX_EDGE = 1568, QUALITIES = [0.8, 0.65, 0.5], MAX_BYTES = 600 * 1024;

/** The photo, decoded upright, or null when this browser can't decode it. */
export async function decodePhoto(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { return null; }
}

/** The canvas as a JPEG, at the first of `qualities` that makes it `maxBytes` or less (else the last); null if it can't be encoded. */
export async function toJpeg(canvas, qualities, maxBytes) {
  let blob = null;
  for (const q of qualities) {
    blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", q));
    if (!blob || blob.size <= maxBytes) break;
  }
  return blob;
}

/** A smaller, upright JPEG of the photo, or the photo itself when this browser can't decode or re-encode it. */
export async function shrinkPhoto(file) {
  const bmp = await decodePhoto(file);
  if (!bmp) return file;
  const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await toJpeg(c, QUALITIES, MAX_BYTES);
  return blob ? new File([blob], "receipt.jpg", { type: "image/jpeg" }) : file;
}
