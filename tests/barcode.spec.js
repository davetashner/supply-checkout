import { test, expect, openApp, createSheet, modal, lineRow } from "./helpers.js";
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

// A PNG of a QR code, drawn with ZXing's own writer (which adds the quiet zone):
// black modules on white, scale pixels each.
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
// (the app draws the photo to a canvas at each size; ZXing's own drawing, to
// rotate, takes three arguments). ZXing itself is the real, bundled one.
//   detector: "none" | "empty" | "throws" | a code to return | a list of detected codes
//   slowClock: every reading of the clock is 4 seconds later (so the time budget runs out)
//   held:     the detector waits for window.__releaseDetect() before answering
//   bitmap:   "real" | "big" (3000×1000 blank canvas) | "tiny" (a 3200×500 canvas with a small
//             Code 39 of `modules` in it, one pixel to the bar: too fine to read when the
//             whole photo is shrunk, readable in a tile at full size) | "throws" | "missing"
function installScanner({ detector = "none", bitmap = "real", held = false, slowClock = false, modules = [] }) {
  if (slowClock) { let t = 0; performance.now = () => (t += 4000); }
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
  CanvasRenderingContext2D.prototype.drawImage = function (...args) { if (args.length === 5) window.__zxingTries++; if (args.length === 9) window.__tiles++; return draw.apply(this, args); };
  if (bitmap === "big") {
    window.createImageBitmap = async () => Object.assign(document.createElement("canvas"), { width: 3000, height: 1000 });
  } else if (bitmap === "tiny") {
    const photo = Object.assign(document.createElement("canvas"), { width: 3200, height: 500 }), g = photo.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 3200, 500);
    g.fillStyle = "#000";
    modules.forEach((black, i) => black && g.fillRect(1500 + i, 200, 1, 60));
    window.createImageBitmap = async () => photo;
  } else if (bitmap === "throws") {
    window.createImageBitmap = async () => { throw new Error("unsupported"); };
  } else if (bitmap === "missing") {
    window.createImageBitmap = undefined;
  }
}

const openSheet = async (page, scanner) => {
  await page.addInitScript(installScanner, scanner);
  await openApp(page, usedState);
  await page.getByRole("button", { name: /Echo Studio/ }).click();
};
// (a photo with no barcode is read in tiles until the time budget is spent)
const noBarcode = (page) => expect(page.locator("#toast")).toContainText("No barcode found", { timeout: 15000 });

test("reads a barcode photo with the browser's built-in detector", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: " SKU1 " });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
  await expect(page.locator("#toast")).toBeHidden();
});

const tries = (page) => page.evaluate(() => window.__zxingTries);

test("without a built-in detector, reads the photo with ZXing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, {});
  await page.setInputFiles("#scanFile", qrPng("0789"));
  await expect(modal(page)).toContainText("Barcode 0789");
  expect(await tries(page)).toBe(1);
});

test("falls back to ZXing when the detector finds nothing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: "empty" });
  await page.setInputFiles("#scanFile", qrPng("0123"));
  await expect(modal(page)).toContainText("Barcode 0123");
  await page.keyboard.press("Escape");

  // ZXing is loaded and set up once, then reused
  await page.setInputFiles("#scanFile", qrPng("0124"));
  await expect(modal(page)).toContainText("Barcode 0124");
  expect(await tries(page)).toBe(2);
});

test("a detector error also falls back to ZXing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: "throws" });
  await page.setInputFiles("#scanFile", qrPng("0456"));
  await expect(modal(page)).toContainText("Barcode 0456");
});

test("a large photo is read at a smaller size", { tag: ["@J4.2"] }, async ({ page }) => {
  // 2,088 pixels square (29 modules of 72), read at 1,280
  await openSheet(page, {});
  await page.setInputFiles("#scanFile", qrPng("0321", 72));
  await expect(modal(page)).toContainText("Barcode 0321");
  expect(await tries(page)).toBe(1);
});

test("tries several sizes of a large photo before giving up", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { bitmap: "big" });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tries(page)).toBe(4);
});

test("a small photo without a barcode is tried once at full size", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, {});
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tries(page)).toBe(1);
});

test("loads the photo another way when createImageBitmap fails", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: "SKU1", bitmap: "throws" });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("loads the photo another way when createImageBitmap is missing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: "SKU1", bitmap: "missing" });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("a file that isn't an image says no barcode was found", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: "SKU1", bitmap: "missing" });
  await page.setInputFiles("#scanFile", notAnImage);
  await noBarcode(page);
});

test("cancelling the camera does nothing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: "SKU1" });
  await page.setInputFiles("#scanFile", []);
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.locator("#toast")).toBeHidden();
});

test("a photo read while someone else deletes the sheet opens nothing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: "SKU1", held: true });
  await page.setInputFiles("#scanFile", png);
  await page.waitForFunction(() => window.__releaseDetect);
  await page.evaluate(() => { window.__mock.docs.delete("sheets/s1"); window.__mock.notify(); });
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
  await expect(page.locator("#toast")).toHaveText("Reading barcode…");
  await page.evaluate(() => window.__releaseDetect());
  // The read is done when its "Reading barcode…" notice goes
  await expect(page.locator("#toast")).toBeHidden();
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.getByText("Nothing is checked out right now.")).toBeVisible();
});

test("scanning in return mode opens the return for that item", { tag: ["@J4.3"] }, async ({ page }) => {
  await openSheet(page, { detector: "SKU1" });
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

test("a scanned item can be checked out on a new sheet", { tag: ["@J4.2"] }, async ({ page }) => {
  await page.addInitScript(installScanner, { detector: "7770001" });
  await openApp(page);
  await createSheet(page, "November Co");
  await page.setInputFiles("#scanFile", png);
  await modal(page).getByLabel("Item name").fill("Degreaser");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Degreaser")).toContainText("Barcode 7770001");
});

const tiles = (page) => page.evaluate(() => window.__tiles);

test("reads a small barcode in a big photo from a tile of it", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { bitmap: "tiny", modules: code39("AB12345678") });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode AB12345678");
  expect(await tries(page)).toBe(4);
  expect(await tiles(page)).toBeGreaterThan(1);
});

test("stops looking through tiles when the time budget is spent", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { bitmap: "tiny", modules: code39("AB12345678"), slowClock: true });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tiles(page)).toBeLessThan(4);
});

test("a photo with no barcode in it is read in every tile before giving up", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { bitmap: "big" });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tiles(page)).toBeGreaterThan(10);
});

test("a retail code with a bad check digit is not trusted: ZXing reads the photo instead", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: [{ rawValue: "4006381333932", format: "ean_13" }] });
  await page.setInputFiles("#scanFile", qrPng("0789"));
  await expect(modal(page)).toContainText("Barcode 0789");
});

test("a retail code of the wrong length or with letters is not trusted either", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: [{ rawValue: "40063813", format: "upc_a" }, { rawValue: "4006X81333931", format: "ean_13" }] });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});

test("a retail code with the right check digit is accepted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: [{ rawValue: "012345678905", format: "upc_a" }] });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode 012345678905");
});

test("with several codes in the photo, the biggest one is used", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, {
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
  await openSheet(page, {
    detector: [
      { rawValue: "4006381333932", format: "ean_13", boundingBox: { width: 100, height: 50 } },
      { rawValue: "SMALL1", format: "code_128", boundingBox: { width: 10, height: 10 } },
    ],
  });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode SMALL1");
});

test("a short Code 39 from the detector alone is not trusted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: [{ rawValue: "AB12", format: "code_39" }] });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});

test("a short Code 39 that ZXing reads too is trusted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: [{ rawValue: "AB12", format: "code_39" }], bitmap: "tiny", modules: code39("AB12") });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode AB12");
});

test("a short Codabar from the detector alone is not trusted", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: [{ rawValue: "A123B", format: "codabar" }] });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});

test("a long Code 39 is trusted on its own", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: [{ rawValue: "AB12345", format: "code_39" }] });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode AB12345");
});

test("a blank code from the detector is ignored", { tag: ["@J4.2"] }, async ({ page }) => {
  await openSheet(page, { detector: [{ rawValue: "  " }] });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
});
