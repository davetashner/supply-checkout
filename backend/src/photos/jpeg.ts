// The profile photo check (supply-checkout-6uw.30): pure TypeScript, no native
// modules and no decoder. The browser crops and re-encodes the photo to a
// 256×256 JPEG; the server trusts none of that and accepts only a JPEG whose
// structure it can walk from end to end:
//
// - SOI (FF D8) first, then marker segments, each with a length that fits.
// - Exactly one frame, SOF0, SOF1 or SOF2 (baseline, extended or progressive
//   Huffman), 8-bit, exactly PHOTO_SIZE × PHOTO_SIZE, with 1 or 3 components.
// - Tables (DQT, DHT) and DRI, before and between scans; at least one DQT and
//   one DHT before the first scan.
// - Every APPn and COM segment dropped: that strips EXIF (and its GPS), XMP,
//   ICC profiles, Adobe and maker notes, even from a crafted upload. A JFIF
//   APP0 is put back as a fixed one (STANDARD_JFIF), so not even its
//   thumbnail or density survives.
// - Any other marker (arithmetic coding, lossless, hierarchical, DNL, a
//   second SOI or frame, RSTn outside a scan, reserved markers) refused.
// - EOI (FF D9) as the very last two bytes: nothing after it, so no trailing
//   payload (a zip or HTML polyglot) survives.
//
// What's stored is the JPEG put back together from the kept segments, never
// the upload as it came. Whatever bytes remain (tables, entropy-coded data)
// are served only as image/jpeg from the photos bucket's own host.

/** The only size a profile photo may be, in pixels each way. */
export const PHOTO_SIZE = 256;

/** The largest photo accepted, in bytes (before stripping). */
export const MAX_PHOTO_BYTES = 64 * 1024;

/** The most scans a photo may have: a progressive JPEG has about ten. Bounds the work. */
const MAX_SCANS = 64;

/** Why a photo was refused: not a usable JPEG (`invalid`) or too many bytes (`too_large`). */
export class PhotoRejectedError extends Error {
  override readonly name = "PhotoRejectedError";
  readonly reason: "invalid" | "too_large";

  constructor(reason: "invalid" | "too_large", message: string) {
    super(message);
    this.reason = reason;
  }
}

const invalid = (message: string) => new PhotoRejectedError("invalid", message);

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DQT = 0xdb;
const DHT = 0xc4;
const DRI = 0xdd;
const COM = 0xfe;
const APP0 = 0xe0;
const APP15 = 0xef;
/** Baseline, extended sequential and progressive, all Huffman-coded. */
const FRAMES = new Set([0xc0, 0xc1, 0xc2]);
/**
 * The APP0 every stored photo starts with, whatever the upload had: JFIF 1.01,
 * square pixels, no thumbnail. It says the 3 components are YCbCr, which is
 * what canvas encoders write.
 */
export const STANDARD_JFIF = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00];

const isRst = (marker: number) => marker >= 0xd0 && marker <= 0xd7;

export interface StrippedPhoto {
  /** The JPEG with only the kept segments: what's stored. */
  readonly bytes: Buffer;
  readonly progressive: boolean;
  /** 1 (grayscale) or 3 (YCbCr). */
  readonly components: number;
  /** How many APPn (other than a JFIF APP0) and COM segments were dropped. */
  readonly dropped: number;
}

/**
 * Checks a profile photo and returns it without its metadata, or throws
 * PhotoRejectedError. Never reads past the end of `input`, and does a bounded
 * amount of work for any input.
 */
export function stripPhoto(input: Uint8Array): StrippedPhoto {
  if (input.length > MAX_PHOTO_BYTES) throw new PhotoRejectedError("too_large", `A photo may be at most ${MAX_PHOTO_BYTES} bytes`);
  const data = Buffer.from(input.buffer, input.byteOffset, input.length);
  if (data.length < 4 || data[0] !== 0xff || data[1] !== SOI) throw invalid("Not a JPEG");

  const kept: Buffer[] = [data.subarray(0, 2), STANDARD_JFIF];
  let p = 2;
  let frame: { progressive: boolean; components: number } | undefined;
  let tables = { dqt: false, dht: false };
  let scans = 0;
  let dropped = 0;

  for (;;) {
    if (p + 2 > data.length) throw invalid("The JPEG ends early");
    // No fill bytes: a canvas encoder never writes them
    if (data[p] !== 0xff) throw invalid("Expected a marker");
    const marker = data[p + 1] as number;
    if (marker === EOI) {
      if (scans === 0) throw invalid("The JPEG has no image data");
      if (p + 2 !== data.length) throw invalid("Data after the end of the JPEG");
      kept.push(data.subarray(p, p + 2));
      break;
    }
    if (marker === SOI || marker === 0xff || marker === 0x00 || marker === 0x01 || isRst(marker)) throw invalid("Unexpected marker");
    if (p + 4 > data.length) throw invalid("The JPEG ends early");
    const length = data.readUInt16BE(p + 2);
    if (length < 2 || p + 2 + length > data.length) throw invalid("A segment runs past the end");
    const segment = data.subarray(p, p + 2 + length);
    const body = data.subarray(p + 4, p + 2 + length);
    p += 2 + length;

    if (marker >= APP0 && marker <= APP15) {
      // Every application segment goes; STANDARD_JFIF stands in for a JFIF APP0
      if (!(marker === APP0 && JFIF.every((b, i) => body[i] === b))) dropped++;
      continue;
    }
    if (marker === COM) {
      dropped++;
      continue;
    }
    if (FRAMES.has(marker)) {
      if (frame) throw invalid("More than one frame");
      frame = readFrame(marker, body);
      kept.push(segment);
      continue;
    }
    if (marker === DQT) {
      checkDqt(body);
      tables = { ...tables, dqt: true };
      kept.push(segment);
      continue;
    }
    if (marker === DHT) {
      checkDht(body);
      tables = { ...tables, dht: true };
      kept.push(segment);
      continue;
    }
    if (marker === DRI) {
      if (length !== 4) throw invalid("Bad restart interval");
      kept.push(segment);
      continue;
    }
    if (marker !== SOS) throw invalid("Unsupported marker");

    // A scan: its header, then entropy-coded data up to the next marker
    if (!frame) throw invalid("A scan before the frame");
    if (!tables.dqt || !tables.dht) throw invalid("A scan before its tables");
    if (++scans > MAX_SCANS) throw invalid("Too many scans");
    checkScanHeader(body, frame.components);
    const start = p;
    while (p < data.length) {
      if (data[p] !== 0xff) {
        p++;
        continue;
      }
      if (p + 1 >= data.length) throw invalid("The JPEG ends early");
      const next = data[p + 1] as number;
      // A stuffed zero byte or a restart marker belongs to the scan
      if (next === 0x00 || isRst(next)) {
        p += 2;
        continue;
      }
      break;
    }
    if (p >= data.length) throw invalid("The JPEG ends early");
    kept.push(segment, data.subarray(start, p));
  }

  if (!frame) throw invalid("The JPEG has no frame");
  return { bytes: Buffer.concat(kept), progressive: frame.progressive, components: frame.components, dropped };
}

/** SOFn: 8-bit precision, exactly PHOTO_SIZE square, 1 or 3 components with sane sampling and table numbers. */
function readFrame(marker: number, body: Buffer): { progressive: boolean; components: number } {
  if (body.length < 6) throw invalid("Bad frame header");
  const precision = body[0];
  const height = body.readUInt16BE(1);
  const width = body.readUInt16BE(3);
  const components = body[5] as number;
  if (precision !== 8) throw invalid("Only 8-bit JPEGs");
  if (width !== PHOTO_SIZE || height !== PHOTO_SIZE) throw invalid(`The photo must be ${PHOTO_SIZE}×${PHOTO_SIZE} pixels`);
  if (components !== 1 && components !== 3) throw invalid("Only grayscale or color JPEGs");
  if (body.length !== 6 + 3 * components) throw invalid("Bad frame header");
  const ids = new Set<number>();
  for (let i = 0; i < components; i++) {
    const id = body[6 + i * 3] as number;
    const sampling = body[7 + i * 3] as number;
    const table = body[8 + i * 3] as number;
    const [h, v] = [sampling >> 4, sampling & 0x0f];
    if (ids.has(id) || h < 1 || h > 4 || v < 1 || v > 4 || table > 3) throw invalid("Bad frame component");
    ids.add(id);
  }
  return { progressive: marker === 0xc2, components };
}

/** DQT: one or more tables, each 8- or 16-bit, numbered 0 to 3, filling the segment exactly. */
function checkDqt(body: Buffer): void {
  let i = 0;
  if (body.length === 0) throw invalid("Empty quantization table");
  while (i < body.length) {
    const info = body[i] as number;
    const [precision, id] = [info >> 4, info & 0x0f];
    if (precision > 1 || id > 3) throw invalid("Bad quantization table");
    i += 1 + 64 * (precision + 1);
  }
  if (i !== body.length) throw invalid("Bad quantization table");
}

/** DHT: one or more tables, each class 0 or 1, numbered 0 to 3, its code counts matching its values, filling the segment exactly. */
function checkDht(body: Buffer): void {
  let i = 0;
  if (body.length === 0) throw invalid("Empty Huffman table");
  while (i < body.length) {
    if (i + 17 > body.length) throw invalid("Bad Huffman table");
    const info = body[i] as number;
    if (info >> 4 > 1 || (info & 0x0f) > 3) throw invalid("Bad Huffman table");
    let count = 0;
    for (let k = 1; k <= 16; k++) count += body[i + k] as number;
    if (count > 256) throw invalid("Bad Huffman table");
    i += 17 + count;
  }
  if (i !== body.length) throw invalid("Bad Huffman table");
}

/** SOS header: 1 to the frame's components, each with table numbers 0 to 3, and its length exact. */
function checkScanHeader(body: Buffer, frameComponents: number): void {
  const count = body[0] ?? 0;
  if (count < 1 || count > frameComponents || body.length !== 1 + 2 * count + 3) throw invalid("Bad scan header");
  for (let i = 0; i < count; i++) {
    const tables = body[2 + i * 2] as number;
    if (tables >> 4 > 3 || (tables & 0x0f) > 3) throw invalid("Bad scan header");
  }
}
