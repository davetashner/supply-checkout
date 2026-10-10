// The profile photo check (src/photos/jpeg.ts, supply-checkout-6uw.30): real
// JPEGs from test/fixtures/photos (made with Pillow: a 256×256 gradient,
// baseline, progressive and grayscale; a camera-like one with EXIF and GPS,
// XMP, an ICC profile and a comment), and crafted variants of them.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_PHOTO_BYTES, PHOTO_SIZE, PhotoRejectedError, STANDARD_JFIF, stripPhoto } from "../src/photos/jpeg.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/photos/${name}`, import.meta.url));
const baseline = fixture("baseline.jpg");
const progressive = fixture("progressive.jpg");
const camera = fixture("camera.jpg");

interface Segment {
  readonly marker: number;
  readonly start: number;
  readonly end: number;
}

/** The marker segments before the first scan (SOS included), as offsets into `jpeg`. */
function segments(jpeg: Buffer): Segment[] {
  const found: Segment[] = [];
  let p = 2;
  for (;;) {
    const marker = jpeg[p + 1] as number;
    const end = p + 2 + jpeg.readUInt16BE(p + 2);
    found.push({ marker, start: p, end });
    if (marker === 0xda) return found;
    p = end;
  }
}

/** Every marker the JPEG has, in order, through its scans to EOI. */
const markers = (jpeg: Buffer): number[] => markerOffsets(jpeg).map((p) => jpeg[p + 1] as number);

/** Where each of the JPEG's markers starts, through its scans to EOI. */
function markerOffsets(jpeg: Buffer): number[] {
  const found: number[] = [];
  let p = 2;
  while (p < jpeg.length) {
    const marker = jpeg[p + 1] as number;
    found.push(p);
    if (marker === 0xd9) break;
    p += 2 + jpeg.readUInt16BE(p + 2);
    if (marker === 0xda) {
      while (!(jpeg[p] === 0xff && jpeg[p + 1] !== 0x00 && !((jpeg[p + 1] as number) >= 0xd0 && (jpeg[p + 1] as number) <= 0xd7))) p++;
    }
  }
  return found;
}

const segment = (marker: number, body: Buffer | string) => {
  const data = typeof body === "string" ? Buffer.from(body, "latin1") : body;
  const head = Buffer.alloc(4);
  head.writeUInt8(0xff, 0);
  head.writeUInt8(marker, 1);
  head.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([head, data]);
};

/** `jpeg` with `extra` inserted right after SOI. */
const afterSoi = (jpeg: Buffer, ...extra: Buffer[]) => Buffer.concat([jpeg.subarray(0, 2), ...extra, jpeg.subarray(2)]);

/** `jpeg` with the segment of `marker` (the first one) replaced by `replacement`. */
function replaceSegment(jpeg: Buffer, marker: number, replacement: Buffer): Buffer {
  const s = segments(jpeg).find((x) => x.marker === marker);
  if (!s) throw new Error("No such segment");
  return Buffer.concat([jpeg.subarray(0, s.start), replacement, jpeg.subarray(s.end)]);
}

const rejected = (bytes: Uint8Array, reason: "invalid" | "too_large" = "invalid") => {
  let error: unknown;
  try {
    stripPhoto(bytes);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(PhotoRejectedError);
  expect((error as PhotoRejectedError).reason).toBe(reason);
  return (error as PhotoRejectedError).message;
};

describe("stripPhoto: what it accepts", () => {
  it("takes a baseline 256×256 JPEG, and stores it with a standard JFIF header and nothing else changed", () => {
    const { bytes, progressive: isProgressive, components, dropped } = stripPhoto(baseline);
    expect([isProgressive, components, dropped]).toEqual([false, 3, 0]);
    // Pillow's own APP0 is a JFIF one; it's replaced by the standard one
    const app0 = segments(baseline).find((s) => s.marker === 0xe0) as Segment;
    expect(bytes).toEqual(Buffer.concat([baseline.subarray(0, 2), STANDARD_JFIF, baseline.subarray(app0.end)]));
    expect(bytes.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
  });

  it("takes a progressive one, every scan and the tables between them kept", () => {
    const { bytes, progressive: isProgressive, dropped } = stripPhoto(progressive);
    expect([isProgressive, dropped]).toEqual([true, 0]);
    expect(markers(bytes).filter((m) => m === 0xda).length).toBeGreaterThan(1);
    expect(markers(bytes)).toContain(0xc2);
    expect(bytes.length).toBe(progressive.length - (segments(progressive).find((s) => s.marker === 0xe0) as Segment).end + 2 + STANDARD_JFIF.length);
  });

  it("takes a grayscale one", () => {
    expect(stripPhoto(fixture("gray.jpg"))).toMatchObject({ components: 1, progressive: false });
  });

  it("takes a JPEG without any APP0, and gives it the standard one", () => {
    const app0 = segments(baseline).find((s) => s.marker === 0xe0) as Segment;
    const bare = Buffer.concat([baseline.subarray(0, 2), baseline.subarray(app0.end)]);
    expect(stripPhoto(bare).bytes).toEqual(stripPhoto(baseline).bytes);
  });

  it("accepts a Uint8Array view into a larger buffer, reading only its own bytes", () => {
    const padded = Buffer.concat([Buffer.from("junk"), baseline, Buffer.from("junk")]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 4, baseline.length);
    expect(stripPhoto(view).bytes).toEqual(stripPhoto(baseline).bytes);
  });

  it("keeps a restart interval and the restart markers in the scan", () => {
    const dri = segment(0xdd, Buffer.from([0x00, 0x04]));
    const sos = segments(baseline).find((s) => s.marker === 0xda) as Segment;
    // A restart marker in the entropy-coded data, and a stuffed zero byte
    const scan = Buffer.concat([baseline.subarray(sos.end, sos.end + 10), Buffer.from([0xff, 0xd0, 0xff, 0x00]), baseline.subarray(sos.end + 10)]);
    const jpeg = Buffer.concat([baseline.subarray(0, sos.start), dri, baseline.subarray(sos.start, sos.end), scan]);
    const { bytes } = stripPhoto(jpeg);
    expect(markers(bytes)).toContain(0xdd);
    expect(bytes.includes(Buffer.from([0xff, 0xd0, 0xff, 0x00]))).toBe(true);
  });
});

describe("stripPhoto: metadata", () => {
  it("strips EXIF (with its GPS), XMP, the ICC profile and the comment from a camera-like photo", () => {
    const kinds = segments(camera).map((s) => s.marker);
    expect(kinds.filter((m) => m === 0xe1)).toHaveLength(2);
    expect(kinds).toContain(0xe2);
    expect(kinds).toContain(0xfe);
    expect(camera.includes(Buffer.from("Exif\0\0"))).toBe(true);
    const { bytes, dropped } = stripPhoto(camera);
    expect(dropped).toBe(4);
    for (const text of ["Exif", "ExampleCam", "Model X", "http://ns.adobe.com/xap/1.0/", "GPSLatitude", "ICC_PROFILE", "secret comment"]) {
      expect(bytes.includes(Buffer.from(text, "latin1")), text).toBe(false);
    }
    expect(markers(bytes).filter((m) => (m >= 0xe0 && m <= 0xef) || m === 0xfe)).toEqual([0xe0]);
    // The image itself is what the plain photo has
    expect(bytes).toEqual(stripPhoto(baseline).bytes);
  });

  it("drops every APPn and COM, wherever they are, even between progressive scans and in a JFIF's thumbnail", () => {
    const appSegments = Array.from({ length: 16 }, (_, n) => segment(0xe0 + n, `APP${n} payload <script>alert(1)</script>`));
    // An APP0 that says JFIF but carries a 1×1 thumbnail of someone else's picture
    const jfifThumb = segment(0xe0, Buffer.concat([Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 2, 1, 0, 72, 0, 72, 1, 1]), Buffer.from("THUMBXYZ!")]));
    const second = markerOffsets(progressive).filter((p) => progressive[p + 1] === 0xda)[1] as number;
    const between = Buffer.concat([progressive.subarray(0, second), segment(0xfe, "between scans"), segment(0xe1, "Exif\0\0late"), progressive.subarray(second)]);
    const { bytes, dropped } = stripPhoto(afterSoi(between, jfifThumb, ...appSegments));
    expect(dropped).toBe(16 + 2);
    for (const text of ["payload", "script", "THUMB", "between scans", "late"]) expect(bytes.includes(Buffer.from(text)), text).toBe(false);
    expect(bytes.subarray(2, 2 + STANDARD_JFIF.length)).toEqual(STANDARD_JFIF);
  });

  it("keeps no thumbnail or density from the upload's own JFIF header", () => {
    const fancy = segment(0xe0, Buffer.concat([Buffer.from("JFIF\0", "latin1"), Buffer.from([1, 2, 2, 0x01, 0x2c, 0x01, 0x2c, 0, 0])]));
    const app0 = segments(baseline).find((s) => s.marker === 0xe0) as Segment;
    const jpeg = Buffer.concat([baseline.subarray(0, 2), fancy, baseline.subarray(app0.end)]);
    expect(stripPhoto(jpeg).bytes).toEqual(stripPhoto(baseline).bytes);
  });
});

describe("stripPhoto: what it refuses", () => {
  it("refuses other formats: PNG, GIF, WebP, SVG, HTML, text and nothing", () => {
    rejected(fixture("photo.png"));
    rejected(fixture("photo.gif"));
    rejected(Buffer.from("RIFF\x24\0\0\0WEBPVP8 ", "latin1"));
    rejected(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
    rejected(Buffer.from("<!doctype html><html><script>alert(1)</script></html>"));
    rejected(Buffer.from("hello"));
    rejected(Buffer.alloc(0));
    rejected(Buffer.from([0xff, 0xd8]));
    rejected(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  it("refuses the wrong size, either way", () => {
    expect(rejected(fixture("wrong-size.jpg"))).toMatch(`${PHOTO_SIZE}×${PHOTO_SIZE}`);
    rejected(fixture("large-dimensions.jpg"));
    for (const [w, h] of [[256, 255], [0, 0], [65535, 65535]]) {
      const sof = segments(baseline).find((s) => s.marker === 0xc0) as Segment;
      const jpeg = Buffer.from(baseline);
      jpeg.writeUInt16BE(h as number, sof.start + 5);
      jpeg.writeUInt16BE(w as number, sof.start + 7);
      rejected(jpeg);
    }
  });

  it("refuses an upload over the limit before reading it", () => {
    expect(rejected(Buffer.alloc(MAX_PHOTO_BYTES + 1, 0xff), "too_large")).toMatch(/at most/);
    // Padding a real photo past the limit with a comment
    rejected(afterSoi(baseline, ...Array.from({ length: 2 }, () => segment(0xfe, Buffer.alloc(40_000, 0x41)))), "too_large");
  });

  it("refuses anything after EOI: no trailing payload, polyglot or second image", () => {
    rejected(Buffer.concat([baseline, Buffer.from("PK\x03\x04zip")]));
    rejected(Buffer.concat([baseline, Buffer.from("<script>alert(1)</script>")]));
    rejected(Buffer.concat([baseline, baseline]));
    rejected(Buffer.concat([baseline, Buffer.from([0x00])]));
  });

  it("refuses a JPEG cut short anywhere: in a segment header, in a segment, in a scan, or with no EOI", () => {
    const sos = segments(baseline).find((s) => s.marker === 0xda) as Segment;
    for (const length of [3, 4, 5, 21, sos.start + 1, sos.start + 3, sos.end - 1, sos.end + 100, baseline.length - 2, baseline.length - 1]) rejected(baseline.subarray(0, length));
    // The scan ends on a lone FF
    rejected(Buffer.concat([baseline.subarray(0, baseline.length - 2), Buffer.from([0xff])]));
  });

  it("refuses a segment whose length runs past the end, or is too short to be one", () => {
    const dqt = segments(baseline).find((s) => s.marker === 0xdb) as Segment;
    for (const length of [0, 1, 0xffff]) {
      const jpeg = Buffer.from(baseline);
      jpeg.writeUInt16BE(length, dqt.start + 2);
      rejected(jpeg);
    }
    rejected(afterSoi(baseline, Buffer.from([0xff, 0xfe, 0xff, 0xff, 0x41])));
  });

  it("refuses markers it doesn't expect before a scan", () => {
    // Fill bytes, a second SOI, a stray RST or TEM, a reserved marker, DNL, DAC (arithmetic), lossless and hierarchical frames
    rejected(afterSoi(baseline, Buffer.from([0xff, 0xff, 0xfe, 0x00, 0x03, 0x41])));
    rejected(afterSoi(baseline, Buffer.from([0xff, 0xd8])));
    rejected(afterSoi(baseline, Buffer.from([0xff, 0xd0])));
    rejected(afterSoi(baseline, Buffer.from([0xff, 0x01])));
    rejected(afterSoi(baseline, Buffer.from([0xff, 0x00])));
    rejected(afterSoi(baseline, Buffer.from([0x00, 0xff, 0xfe, 0x00, 0x03, 0x41])));
    for (const marker of [0x02, 0xbf, 0xdc, 0xcc, 0xde, 0xdf, 0xf0, 0xfd]) rejected(afterSoi(baseline, segment(marker, "xx")));
    for (const frame of [0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]) {
      const sof = segments(baseline).find((s) => s.marker === 0xc0) as Segment;
      const jpeg = Buffer.from(baseline);
      jpeg[sof.start + 1] = frame;
      rejected(jpeg);
    }
  });

  it("refuses a second frame, a scan before the frame or its tables, and no scan at all", () => {
    const sof = segments(baseline).find((s) => s.marker === 0xc0) as Segment;
    const sos = segments(baseline).find((s) => s.marker === 0xda) as Segment;
    const sofBytes = baseline.subarray(sof.start, sof.end);
    rejected(Buffer.concat([baseline.subarray(0, sof.end), sofBytes, baseline.subarray(sof.end)]));
    // The frame moved after the scan header
    rejected(Buffer.concat([baseline.subarray(0, sof.start), baseline.subarray(sof.end, sos.start), baseline.subarray(sos.start)]));
    // No DHT or no DQT before the scan
    for (const marker of [0xc4, 0xdb]) {
      const without = segments(baseline).filter((s) => s.marker !== marker);
      const head = Buffer.concat([baseline.subarray(0, 2), ...without.map((s) => baseline.subarray(s.start, s.end))]);
      rejected(Buffer.concat([head, baseline.subarray(sos.end)]));
    }
    // Headers and EOI, no scan
    rejected(Buffer.concat([baseline.subarray(0, sos.start), Buffer.from([0xff, 0xd9])]));
  });

  it("refuses a frame that isn't 8-bit, 1 or 3 components, or has bad components", () => {
    const sof = segments(baseline).find((s) => s.marker === 0xc0) as Segment;
    const at = sof.start + 4;
    const variant = (change: (b: Buffer) => void) => {
      const jpeg = Buffer.from(baseline);
      change(jpeg);
      return jpeg;
    };
    rejected(variant((b) => b.writeUInt8(12, at)));
    rejected(variant((b) => b.writeUInt8(2, at + 5)));
    rejected(variant((b) => b.writeUInt8(4, at + 5)));
    // Two components with the same ID
    rejected(variant((b) => b.writeUInt8(b[at + 6] as number, at + 9)));
    // Sampling factors 0 and 5, a table number past 3
    rejected(variant((b) => b.writeUInt8(0x01, at + 7)));
    rejected(variant((b) => b.writeUInt8(0x51, at + 7)));
    rejected(variant((b) => b.writeUInt8(0x10, at + 7)));
    rejected(variant((b) => b.writeUInt8(0x15, at + 7)));
    rejected(variant((b) => b.writeUInt8(4, at + 8)));
    // A frame header shorter than its fields, or with room left over
    rejected(replaceSegment(baseline, 0xc0, segment(0xc0, Buffer.from([8, 1, 0, 1]))));
    rejected(replaceSegment(baseline, 0xc0, segment(0xc0, Buffer.concat([baseline.subarray(sof.start + 4, sof.end), Buffer.from([0])]))));
  });

  it("refuses malformed tables: quantization and Huffman", () => {
    const dqt = segments(baseline).find((s) => s.marker === 0xdb) as Segment;
    const dqtBody = baseline.subarray(dqt.start + 4, dqt.end);
    rejected(replaceSegment(baseline, 0xdb, segment(0xdb, Buffer.alloc(0))));
    rejected(replaceSegment(baseline, 0xdb, segment(0xdb, Buffer.concat([Buffer.from([0x04]), dqtBody.subarray(1)]))));
    rejected(replaceSegment(baseline, 0xdb, segment(0xdb, Buffer.concat([Buffer.from([0x20]), dqtBody.subarray(1)]))));
    rejected(replaceSegment(baseline, 0xdb, segment(0xdb, dqtBody.subarray(0, 40))));
    // A 16-bit table is fine if it's all there
    expect(() => stripPhoto(replaceSegment(baseline, 0xdb, segment(0xdb, Buffer.concat([Buffer.from([0x10]), Buffer.alloc(128, 1)]))))).not.toThrow();
    const dht = segments(baseline).find((s) => s.marker === 0xc4) as Segment;
    const dhtBody = baseline.subarray(dht.start + 4, dht.end);
    rejected(replaceSegment(baseline, 0xc4, segment(0xc4, Buffer.alloc(0))));
    rejected(replaceSegment(baseline, 0xc4, segment(0xc4, dhtBody.subarray(0, 10))));
    rejected(replaceSegment(baseline, 0xc4, segment(0xc4, Buffer.concat([Buffer.from([0x20]), dhtBody.subarray(1)]))));
    rejected(replaceSegment(baseline, 0xc4, segment(0xc4, Buffer.concat([Buffer.from([0x04]), dhtBody.subarray(1)]))));
    rejected(replaceSegment(baseline, 0xc4, segment(0xc4, dhtBody.subarray(0, dhtBody.length - 1))));
    // Code counts adding up past 256
    rejected(replaceSegment(baseline, 0xc4, segment(0xc4, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(16, 17), Buffer.alloc(272)]))));
    // A restart interval of the wrong length
    rejected(afterSoi(baseline, segment(0xdd, Buffer.from([0, 4, 0]))));
  });

  it("refuses a scan header with no components, more than the frame has, bad tables or the wrong length", () => {
    const sos = segments(baseline).find((s) => s.marker === 0xda) as Segment;
    const header = baseline.subarray(sos.start + 4, sos.end);
    const withHeader = (body: Buffer) => Buffer.concat([baseline.subarray(0, sos.start), segment(0xda, body), baseline.subarray(sos.end)]);
    rejected(withHeader(Buffer.concat([Buffer.from([0]), header.subarray(1)])));
    rejected(withHeader(Buffer.concat([Buffer.from([4]), header.subarray(1)])));
    rejected(withHeader(Buffer.concat([header.subarray(0, 2), Buffer.from([0x40]), header.subarray(3)])));
    rejected(withHeader(Buffer.concat([header.subarray(0, 2), Buffer.from([0x04]), header.subarray(3)])));
    rejected(withHeader(header.subarray(0, header.length - 1)));
    rejected(withHeader(Buffer.alloc(0)));
  });

  it("refuses an image with too many scans", () => {
    const sos = segments(progressive).find((s) => s.marker === 0xda) as Segment;
    // The first scan, again and again, before the rest
    let end = sos.end;
    while (!(progressive[end] === 0xff && progressive[end + 1] !== 0 && !((progressive[end + 1] as number) >= 0xd0 && (progressive[end + 1] as number) <= 0xd7))) end++;
    const scan = progressive.subarray(sos.start, end);
    const many = Buffer.concat([progressive.subarray(0, sos.start), ...Array.from({ length: 65 }, () => scan), progressive.subarray(end)]);
    expect(many.length).toBeLessThan(MAX_PHOTO_BYTES);
    expect(rejected(many)).toMatch(/Too many scans/);
    const fine = Buffer.concat([progressive.subarray(0, sos.start), ...Array.from({ length: 3 }, () => scan), progressive.subarray(end)]);
    expect(() => stripPhoto(fine)).not.toThrow();
  });

  it("never throws anything but PhotoRejectedError, whatever the bytes", () => {
    // Every prefix and a sweep of single-byte corruptions of real photos
    for (const photo of [baseline, progressive, camera]) {
      for (let i = 0; i < photo.length; i += 7) {
        for (const input of [photo.subarray(0, i), (() => {
          const b = Buffer.from(photo);
          b[i] = (b[i] as number) ^ 0xff;
          return b;
        })()]) {
          try {
            stripPhoto(input);
          } catch (error) {
            expect(error).toBeInstanceOf(PhotoRejectedError);
          }
        }
      }
    }
  });
});
