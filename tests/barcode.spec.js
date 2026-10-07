import { test, expect, openApp, createProject, modal, lineRow } from "./helpers.js";
import { crc32, deflateSync } from "node:zlib";
import { BarcodeFormat, QRCodeWriter } from "@zxing/library";
import { usedState } from "./fixtures.js";

// A real 1×1 PNG, so the browser can decode it
const png = {
  name: "barcode.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
};
const notAnImage = { name: "barcode.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image") };

// A grayscale PNG, width × height, whose pixel (x, y) is black when dark(x, y).
function grayPng(width, height, dark) {
  const rows = Buffer.alloc(height * (width + 1), 255);
  for (let y = 0; y < height; y++) {
    rows[y * (width + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) if (dark(x, y)) rows[y * (width + 1) + 1 + x] = 0;
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit grayscale
  return {
    name: "barcode.png",
    mimeType: "image/png",
    buffer: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]),
  };
}

// A QR code's modules, drawn with ZXing's own writer (which adds the quiet zone), as rows of "1" (black) and "0"
function qrRows(text) {
  const matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, new Map()), rows = [];
  for (let y = 0; y < matrix.getHeight(); y++) { let row = ""; for (let x = 0; x < matrix.getWidth(); x++) row += matrix.get(x, y) ? "1" : "0"; rows.push(row); }
  return rows;
}
// A PNG of a QR code: black modules on white, scale pixels each.
function qrPng(text, scale = 8) {
  const matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, new Map());
  const size = matrix.getWidth() * scale;
  return grayPng(size, size, (x, y) => matrix.get(Math.floor(x / scale), Math.floor(y / scale)));
}

// Code 39 modules (true = black), quiet zones included: each character is five bars and
// four spaces, three modules where the table says "1" (wide) and one where "0", with a
// one-module space between characters.
const CODE39 = {
  0: "000110100", 1: "100100001", 2: "001100001", 3: "101100000", 4: "000110001", 5: "100110000", 6: "001110000", 7: "000100101",
  8: "100100100", 9: "001100100", A: "100001001", B: "001001001", C: "101001000", D: "000011001", E: "100011000", F: "001011000",
  G: "000001101", H: "100001100", I: "001001100", J: "000011100", K: "100000011", L: "001000011", M: "101000010", N: "000010011",
  O: "100010010", P: "001010010", Q: "000000111", R: "100000110", S: "001000110", T: "000010110", U: "110000001", V: "011000001",
  W: "111000000", X: "010010001", Y: "110010000", Z: "011010000", "*": "010010100",
};
// UPC-A or EAN-8 modules (true = black), without quiet zones: the guard, the first half of the
// digits in L codes, the middle guard, the rest in R codes (L inverted), the end guard.
const UPC_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
function upcA(digits) {
  const half = digits.length / 2, right = (d) => [...UPC_L[d]].map((b) => (b === "1" ? "0" : "1")).join("");
  const bits = "101" + [...digits.slice(0, half)].map((d) => UPC_L[d]).join("") + "01010" + [...digits.slice(half)].map(right).join("") + "101";
  return [...bits].map((b) => b === "1");
}
function code39(text) {
  const modules = Array(10).fill(false);
  for (const ch of `*${text}*`) {
    [...CODE39[ch]].forEach((wide, i) => modules.push(...Array(wide === "1" ? 3 : 1).fill(i % 2 === 0)));
    modules.push(false);
  }
  return modules.concat(Array(9).fill(false));
}

// Controls the browser's barcode reader, so results don't depend on whether this
// browser has a built-in BarcodeDetector, and counts the sizes ZXing is given
// (the app draws the whole photo to a canvas at each size) and the parts of the
// photo it reads (spots and tiles, each drawn from a scaled copy of the photo).
// ZXing itself is the real, bundled one.
//   detector: "none" | "empty" | "throws" | a code to return | a list of detected codes
//   slowClock: every reading of the clock is 4 seconds later (so the time budget runs out)
//   stoppedClock: the clock never moves (so the time budget never runs out)
//   held:     the detector waits for window.__releaseDetect() before answering
//   bitmap:   "real" | "big" (3000×1000 blank canvas) | "blank" (a 1300×120 one) | "tiny" (a 3200×500 canvas with a small
//             Code 39 of `modules` in it, one pixel to the bar: too fine to read when the
//             whole photo is shrunk, readable in a tile at full size) | "label" (a 3000×2250 photo
//             of a busy shelf, with a white label whose code of `modules`, `m` pixels to the bar, is
//             turned `angle` degrees about (1900, 900): the pilot's bin label is angle 90, m 2)
//             | "qr" (a 4000×300 photo with a QR code of `rows`, two pixels to the module, in it:
//             too fine to read when the whole photo is shrunk)
//             | "throws" | "missing"
function installScanner({ detector = "none", bitmap = "real", held = false, slowClock = false, stoppedClock = false, modules = [], rows = [], angle = 90, m = 2, ink = 40, grain = 24 }) {
  if (slowClock) { let t = 0; performance.now = () => (t += 4000); }
  if (stoppedClock) performance.now = () => 0;
  delete window.BarcodeDetector;
  if (detector !== "none") {
    window.BarcodeDetector = class {
      async detect() {
        if (held) await new Promise((resolve) => { window.__releaseDetect = resolve; });
        if (detector === "throws") throw new Error("detector failed");
        if (Array.isArray(detector)) return detector;
        return detector === "empty" ? [] : [{ rawValue: detector }];
      }
    };
  }
  window.__zxingTries = 0;
  window.__tiles = 0;
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  // A part is drawn from one of the app's canvases; a scaled copy, from the photo itself
  const part = (src) => src instanceof HTMLCanvasElement && !src.photo;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) { if (args.length === 5) window.__zxingTries++; if (args.length === 9 && part(args[0])) window.__tiles++; return draw.apply(this, args); };
  const photoOf = (canvas) => { canvas.photo = true; window.createImageBitmap = async () => canvas; };
  if (bitmap === "big" || bitmap === "blank") {
    photoOf(Object.assign(document.createElement("canvas"), bitmap === "big" ? { width: 3000, height: 1000 } : { width: 1300, height: 120 }));
  } else if (bitmap === "tiny") {
    const photo = Object.assign(document.createElement("canvas"), { width: 3200, height: 500 }), g = photo.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 3200, 500);
    g.fillStyle = "#000";
    modules.forEach((black, i) => black && g.fillRect(1500 + i, 200, 1, 60));
    photoOf(photo);
  } else if (bitmap === "label") {
    const W = 3000, H = 2250, photo = Object.assign(document.createElement("canvas"), { width: W, height: H }), g = photo.getContext("2d");
    let seed = 7;
    const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const shade = (v) => `rgb(${v},${v},${v})`;
    const light = g.createLinearGradient(0, 0, W, H);
    light.addColorStop(0, shade(150)); light.addColorStop(1, shade(100));
    g.fillStyle = light; g.fillRect(0, 0, W, H);
    // the shelf: boxes and bins of every shade
    for (let i = 0; i < 400; i++) { g.fillStyle = shade(Math.floor(random() * 256)); g.fillRect(random() * W, random() * H, 10 + random() * 200, 10 + random() * 200); }
    // the label, in its own frame: the code along it, a line of text under it
    const code = modules.length * m, quiet = 12 * m, labelW = code + 2 * quiet + 40, labelH = 260;
    g.save(); g.translate(1900, 900); g.rotate((angle * Math.PI) / 180); g.translate(-labelW / 2, -labelH / 2);
    g.fillStyle = shade(215); g.fillRect(0, 0, labelW, labelH);
    g.fillStyle = shade(ink);
    modules.forEach((black, i) => black && g.fillRect(quiet + 20 + i * m, 30, m, 140));
    for (let x = 20; x < labelW - 20; x += 18) g.fillRect(x, 220, 9, 30);
    g.restore();
    // a phone camera's grain
    const img = g.getImageData(0, 0, W, H);
    for (let i = 0; i < img.data.length; i += 4) { const n = (random() - 0.5) * grain; img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n; }
    g.putImageData(img, 0, 0);
    photoOf(photo);
  } else if (bitmap === "qr") {
    const photo = Object.assign(document.createElement("canvas"), { width: 4000, height: 300 }), g = photo.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 4000, 300);
    g.fillStyle = "#000";
    rows.forEach((row, y) => [...row].forEach((black, x) => black === "1" && g.fillRect(3000 + 2 * x, 100 + 2 * y, 2, 2)));
    photoOf(photo);
  } else if (bitmap === "throws") {
    window.createImageBitmap = async () => { throw new Error("unsupported"); };
  } else if (bitmap === "missing") {
    window.createImageBitmap = undefined;
  }
}

const openProject = async (page, scanner) => {
  await page.addInitScript(installScanner, scanner);
  await openApp(page, usedState);
  await page.getByRole("button", { name: /Echo Studio/ }).click();
};
// (a photo with no barcode is read in tiles until the time budget is spent)
const noBarcode = (page) => expect(page.locator("#toast")).toContainText("No barcode found", { timeout: 15000 });
// A code found past the whole photo, in a spot or a tile, comes within the same bound: the whole
// photo at four sizes, then up to the 6-second budget. (supply-checkout-s3c.15: waiting only 5
// seconds for a read that may take the budget raced the app on a slow runner.)
const found = (page, code) => expect(modal(page)).toContainText(`Barcode ${code}`, { timeout: 15000 });

test("reads a barcode photo with the browser's built-in detector", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: " SKU1 " });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
  await expect(page.locator("#toast")).toBeHidden();
});

const tries = (page) => page.evaluate(() => window.__zxingTries);

test("without a built-in detector, reads the photo with ZXing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, {});
  await page.setInputFiles("#scanFile", qrPng("0789"));
  await expect(modal(page)).toContainText("Barcode 0789");
  expect(await tries(page)).toBe(1);
});

test("falls back to ZXing when the detector finds nothing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "empty" });
  await page.setInputFiles("#scanFile", qrPng("0123"));
  await expect(modal(page)).toContainText("Barcode 0123");
  await page.keyboard.press("Escape");

  // ZXing is loaded and set up once, then reused
  await page.setInputFiles("#scanFile", qrPng("0124"));
  await expect(modal(page)).toContainText("Barcode 0124");
  expect(await tries(page)).toBe(2);
});

test("a detector error also falls back to ZXing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "throws" });
  await page.setInputFiles("#scanFile", qrPng("0456"));
  await expect(modal(page)).toContainText("Barcode 0456");
});

test("a large photo is read at a smaller size", { tag: ["@J4.2"] }, async ({ page }) => {
  // 2,088 pixels square (29 modules of 72), read at 1,280
  await openProject(page, {});
  await page.setInputFiles("#scanFile", qrPng("0321", 72));
  await expect(modal(page)).toContainText("Barcode 0321");
  expect(await tries(page)).toBe(1);
});

test("tries several sizes of a large photo before giving up", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { bitmap: "big" });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tries(page)).toBe(4);
});

test("a small photo without a barcode is tried once at full size", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, {});
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tries(page)).toBe(1);
});

test("loads the photo another way when createImageBitmap fails", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "SKU1", bitmap: "throws" });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("loads the photo another way when createImageBitmap is missing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "SKU1", bitmap: "missing" });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("a file that isn't an image says no barcode was found", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "SKU1", bitmap: "missing" });
  await page.setInputFiles("#scanFile", notAnImage);
  await noBarcode(page);
});

test("cancelling the camera does nothing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "SKU1" });
  await page.setInputFiles("#scanFile", []);
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.locator("#toast")).toBeHidden();
});

test("a photo read while someone else deletes the project opens nothing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "SKU1", held: true });
  await page.setInputFiles("#scanFile", png);
  await page.waitForFunction(() => window.__releaseDetect);
  await page.evaluate(() => { window.__mock.docs.delete("projects/s1"); window.__mock.notify(); });
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await expect(page.locator("#toast")).toHaveText("Reading barcode…");
  await page.evaluate(() => window.__releaseDetect());
  // The read is done when its "Reading barcode…" notice goes
  await expect(page.locator("#toast")).toBeHidden();
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
});

test("scanning in return mode opens the return for that item", { tag: ["@J4.3"] }, async ({ page }) => {
  await openProject(page, { detector: "SKU1" });
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page).getByRole("heading", { name: "Return" })).toBeVisible();
});

test("an item's barcode can be scanned when adding it to inventory", { tag: ["@J2.2"] }, async ({ page }) => {
  await page.addInitScript(installScanner, { detector: "5550001" });
  await openApp(page);
  await page.getByRole("button", { name: "Inventory" }).click();
  await page.getByRole("button", { name: "+ Add item" }).click();
  await modal(page).locator("#fScan").setInputFiles(png);
  await expect(modal(page).getByPlaceholder("Type, scan, or leave blank")).toHaveValue("5550001");

  // A failed scan leaves the field alone
  await page.evaluate(() => { window.BarcodeDetector = class { async detect() { return []; } }; });
  await modal(page).locator("#fScan").setInputFiles(png);
  await noBarcode(page);
  await expect(modal(page).getByPlaceholder("Type, scan, or leave blank")).toHaveValue("5550001");
});

test("a scanned item can be checked out on a new project", { tag: ["@J4.2"] }, async ({ page }) => {
  await page.addInitScript(installScanner, { detector: "7770001" });
  await openApp(page);
  await createProject(page, "November Co");
  await page.setInputFiles("#scanFile", png);
  await modal(page).getByLabel("Item name").fill("Degreaser");
  await modal(page).getByRole("button", { name: "Add 1 to project" }).click();
  await expect(lineRow(page, "Degreaser")).toContainText("Barcode 7770001");
});

const tiles = (page) => page.evaluate(() => window.__tiles);

// The pilot's bin label (supply-checkout-005.7): a UPC-A turned a quarter turn and a little
// more, small in a photo of a busy shelf. Before spots, it wasn't read at any size or in any
// tile within the time budget; now the first spot read is the code.
test("reads a turned, tilted barcode, small in a busy photo, from the spot that looks like a code", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { bitmap: "label", modules: upcA("036000291452"), angle: 98 });
  await page.setInputFiles("#scanFile", png);
  await found(page, "036000291452");
  // (WebKit's smoother shrinking can read it from the whole photo)
  expect(await tiles(page)).toBeLessThanOrEqual(1);
});

// ZXing reads each row both ways, so upside down needs no pass of its own; bars thinner than
// 2 pixels still read from the photo as taken
for (const [angle, m] of [[188, 2], [278, 1.6], [98, 1.6]]) {
  test(`reads a barcode turned ${angle}° with bars ${m} pixels wide from a spot`, { tag: ["@J4.2"] }, async ({ page }) => {
    await openProject(page, { bitmap: "label", modules: upcA("036000291452"), angle, m });
    await page.setInputFiles("#scanFile", png);
    await found(page, "036000291452");
    expect(await tiles(page)).toBeLessThanOrEqual(1);
  });
}

// A code at a slant has edges both ways, so it looks like a code only in the photo turned 45°
test("reads a barcode held at a slant from the photo turned 45°", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { bitmap: "label", modules: upcA("036000291452"), angle: 135 });
  await page.setInputFiles("#scanFile", png);
  await found(page, "036000291452");
});

// (supply-checkout-s3c.15: this used to be found in about the tenth tile, seconds in, and timed
// out on a slow runner; a spot finds it in the first read)
test("reads a small barcode in a big photo from a spot of it", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { bitmap: "tiny", modules: code39("AB12345678") });
  await page.setInputFiles("#scanFile", png);
  await found(page, "AB12345678");
  expect(await tries(page)).toBe(4);
  expect(await tiles(page)).toBe(1);
});

test("stops reading spots when the time budget is spent", { tag: ["@J4.2"] }, async ({ page }) => {
  // bars that look like a code but aren't one
  await openProject(page, { bitmap: "tiny", modules: code39("AB12345678").map((b, i) => b !== (i % 7 === 0)), slowClock: true });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tiles(page)).toBe(1);
});

test("reads a small QR code in a big photo from a tile of it", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { bitmap: "qr", rows: qrRows("QR-0042") });
  await page.setInputFiles("#scanFile", png);
  await found(page, "QR-0042");
  expect(await tiles(page)).toBe(1);
});

test("stops looking through tiles when the time budget is spent", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { bitmap: "big", slowClock: true });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tiles(page)).toBe(1);
});

// With the clock stopped, so the count doesn't depend on how fast the machine is: 2 tiles of the
// photo as taken, then 7, 7 and 9 at the smaller sizes
test("a photo with no barcode in it is read in every tile before giving up", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { bitmap: "blank", stoppedClock: true });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tiles(page)).toBe(25);
});

test("a retail code with a bad check digit is not trusted: ZXing reads the photo instead", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "4006381333932", format: "ean_13" }] });
  await page.setInputFiles("#scanFile", qrPng("0789"));
  await expect(modal(page)).toContainText("Barcode 0789");
});

test("a retail code of the wrong length or with letters is not trusted either", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "40063813", format: "upc_a" }, { rawValue: "4006X81333931", format: "ean_13" }] });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});

test("a retail code with the right check digit is accepted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "012345678905", format: "upc_a" }] });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode 012345678905");
});

test("with several codes in the photo, the biggest one is used", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, {
    detector: [
      { rawValue: "NOBOX" },
      { rawValue: "SMALL1", boundingBox: { width: 10, height: 10 } },
      { rawValue: "BIG1", boundingBox: { width: 100, height: 50 } },
    ],
  });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode BIG1");
});

test("a bad code among several is skipped for the next best", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, {
    detector: [
      { rawValue: "4006381333932", format: "ean_13", boundingBox: { width: 100, height: 50 } },
      { rawValue: "SMALL1", format: "code_128", boundingBox: { width: 10, height: 10 } },
    ],
  });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode SMALL1");
});

test("a short Code 39 from the detector alone is not trusted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "AB12", format: "code_39" }] });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});

test("a short Code 39 that ZXing reads too is trusted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "AB12", format: "code_39" }], bitmap: "tiny", modules: code39("AB12") });
  await page.setInputFiles("#scanFile", png);
  await found(page, "AB12");
});

test("a short Codabar from the detector alone is not trusted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "A123B", format: "codabar" }] });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});

test("a long Code 39 is trusted on its own", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "AB12345", format: "code_39" }] });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode AB12345");
});

test("a blank code from the detector is ignored", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "  " }] });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});


// An 8-digit code can be part of a longer one, read on a slant, so it needs a second read that
// agrees: here the same code found twice in the photo, or by the detector and ZXing.
const twice = (rawValue, format) => [{ rawValue, format }, { rawValue, format }];

test("an EAN-8 from the detector alone is not trusted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "96385074", format: "ean_8" }] });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});

test("an EAN-8 that ZXing reads too is trusted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [{ rawValue: "96385074", format: "ean_8" }], bitmap: "tiny", modules: [...Array(14).fill(false), ...upcA("96385074").flatMap((b) => [b, b]), ...Array(14).fill(false)] });
  await page.setInputFiles("#scanFile", png);
  await found(page, "96385074");
});

test("an EAN-8 with a bad check digit is not trusted, even twice", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: twice("96385075", "ean_8") });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});

// UPC-E: the check digit is the one of the UPC-A it stands for (each way of leaving out zeros)
test("a UPC-E code is checked like the UPC-A it stands for", { tag: ["@J4.2"] }, async ({ page }) => {
  const codes = ["01234505", "01234531", "01234543", "01234565", "19876520"];
  await openProject(page, { detector: "none" });
  for (const code of codes) {
    await page.evaluate((found) => { window.BarcodeDetector = class { async detect() { return found; } }; }, twice(code, "upc_e"));
    await page.setInputFiles("#scanFile", png);
    await expect(modal(page)).toContainText(`Barcode ${code}`);
    await page.keyboard.press("Escape");
  }
});

// A wrong check digit, a number system other than 0 or 1, the wrong length, and a code read only once
for (const detector of [twice("01234566", "upc_e"), twice("21234565", "upc_e"), twice("0123456", "upc_e"), [{ rawValue: "01234565", format: "upc_e" }]]) {
  test(`a UPC-E code ${detector[0].rawValue} found ${detector.length === 1 ? "once" : "twice"} is not trusted`, { tag: ["@J4.2"] }, async ({ page }) => {
    await openProject(page, { detector });
    await page.setInputFiles("#scanFile", png);
    await noBarcode(page);
  });
}

// A photo can be misread, so the number is shown, and can be corrected, before anything is saved
const notThis = (page) => modal(page).getByRole("button", { name: "Not this number?" });
async function correct(page, from, to) {
  await notThis(page).click();
  const field = modal(page).getByLabel("Barcode number");
  await expect(field).toHaveValue(from);
  await expect(field).toBeFocused();
  await field.fill(to);
  await modal(page).getByRole("button", { name: "Use this number" }).click();
}

test("a misread barcode can be corrected before it's checked out", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "9990001" });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(modal(page)).toContainText("Barcode 9990001");
  await expect(modal(page)).toContainText("New barcode");

  // An empty number does nothing
  await notThis(page).click();
  await modal(page).getByLabel("Barcode number").fill(" ");
  await modal(page).getByRole("button", { name: "Use this number" }).click();
  await expect(modal(page).getByLabel("Barcode number")).toBeVisible();

  await modal(page).getByLabel("Barcode number").fill("SKU1");
  await modal(page).getByRole("button", { name: "Use this number" }).click();
  await expect(modal(page)).toContainText("Barcode SKU1");
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
  await modal(page).getByRole("button", { name: "Add 1 to project" }).click();
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(lineRow(page, "Paper towels")).toContainText("4");
  expect(await page.evaluate(() => window.__mock.docs.has("products/9990001"))).toBe(false);
});

test("a misread barcode can be corrected on a return", { tag: ["@J4.3"] }, async ({ page }) => {
  await openProject(page, { detector: "SKU1" });
  // everything taken has come back
  await page.evaluate(() => { window.__mock.docs.get("projects/s1").items.SKU1.returned = 3; window.__mock.notify(); });
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page).getByRole("heading", { name: "Already returned" })).toBeVisible();
  await correct(page, "SKU1", "9990001");
  await expect(modal(page).getByRole("heading", { name: "Not on this project" })).toBeVisible();
  await correct(page, "9990001", "nb-bins");
  await expect(modal(page).getByRole("heading", { name: "Return", exact: true })).toBeVisible();
  await expect(modal(page)).toContainText("Storage bins, 12 qt");
});

test("a misread barcode can be corrected on a quick take", { tag: ["@J14.1"] }, async ({ page }) => {
  await page.addInitScript(installScanner, { detector: "9990001" });
  await openApp(page, usedState);
  await page.getByRole("button", { name: "Quick take" }).click();
  await modal(page).locator("#qScan").setInputFiles(png);
  await expect(modal(page).getByRole("heading", { name: "Quick take" })).toBeVisible();
  await correct(page, "9990001", "SKU1");
  await expect(modal(page).getByRole("heading", { name: "Quick take" })).toBeVisible();
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("a misread barcode can be corrected on a return from the project list", { tag: ["@J14.2"] }, async ({ page }) => {
  await page.addInitScript(installScanner, { detector: "SKU1" });
  await openApp(page, usedState);
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await modal(page).locator("#qScan").setInputFiles(png);
  await expect(modal(page).getByRole("heading", { name: "Return to Echo Studio" })).toBeVisible();
  await correct(page, "SKU1", "9990001");
  await expect(page.locator("#toast")).toHaveText("Nothing of this is checked out right now.");
  await expect(page.locator("#overlay")).toBeHidden();
});
