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

// A PNG of a QR code, drawn with ZXing's own writer (which adds the quiet zone):
// black modules on white, scale pixels each.
function qrPng(text, scale = 8) {
  const matrix = new QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, new Map());
  const size = matrix.getWidth() * scale;
  const rows = Buffer.alloc(size * (size + 1), 255);
  for (let y = 0; y < size; y++) {
    rows[y * (size + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      if (matrix.get(Math.floor(x / scale), Math.floor(y / scale))) rows[y * (size + 1) + 1 + x] = 0;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // 8-bit grayscale
  return {
    name: "barcode.png",
    mimeType: "image/png",
    buffer: Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]),
  };
}

// Controls the browser's barcode reader, so results don't depend on whether this
// browser has a built-in BarcodeDetector, and counts the sizes ZXing is given
// (the app draws the photo to a canvas at each size; ZXing's own drawing, to
// rotate, takes three arguments). ZXing itself is the real, bundled one.
//   detector: "none" | "empty" | "throws" | a code to return
//   held:     the detector waits for window.__releaseDetect() before answering
//   bitmap:   "real" | "big" (3000×1000 blank canvas) | "throws" | "missing"
function installScanner({ detector = "none", bitmap = "real", held = false }) {
  delete window.BarcodeDetector;
  if (detector !== "none") {
    window.BarcodeDetector = class {
      async detect() {
        if (held) await new Promise((resolve) => { window.__releaseDetect = resolve; });
        if (detector === "throws") throw new Error("detector failed");
        return detector === "empty" ? [] : [{ rawValue: detector }];
      }
    };
  }
  window.__zxingTries = 0;
  const draw = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) { if (args.length === 5) window.__zxingTries++; return draw.apply(this, args); };
  if (bitmap === "big") {
    window.createImageBitmap = async () => Object.assign(document.createElement("canvas"), { width: 3000, height: 1000 });
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
const noBarcode = (page) => expect(page.locator("#toast")).toContainText("No barcode found");

test("reads a barcode photo with the browser's built-in detector", async ({ page }) => {
  await openSheet(page, { detector: " SKU1 " });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
  await expect(page.locator("#toast")).toBeHidden();
});

const tries = (page) => page.evaluate(() => window.__zxingTries);

test("without a built-in detector, reads the photo with ZXing", async ({ page }) => {
  await openSheet(page, {});
  await page.setInputFiles("#scanFile", qrPng("0789"));
  await expect(modal(page)).toContainText("Barcode 0789");
  expect(await tries(page)).toBe(1);
});

test("falls back to ZXing when the detector finds nothing", async ({ page }) => {
  await openSheet(page, { detector: "empty" });
  await page.setInputFiles("#scanFile", qrPng("0123"));
  await expect(modal(page)).toContainText("Barcode 0123");
  await page.keyboard.press("Escape");

  // ZXing is loaded and set up once, then reused
  await page.setInputFiles("#scanFile", qrPng("0124"));
  await expect(modal(page)).toContainText("Barcode 0124");
  expect(await tries(page)).toBe(2);
});

test("a detector error also falls back to ZXing", async ({ page }) => {
  await openSheet(page, { detector: "throws" });
  await page.setInputFiles("#scanFile", qrPng("0456"));
  await expect(modal(page)).toContainText("Barcode 0456");
});

test("a large photo is read at a smaller size", async ({ page }) => {
  // 2,088 pixels square (29 modules of 72), read at 1,280
  await openSheet(page, {});
  await page.setInputFiles("#scanFile", qrPng("0321", 72));
  await expect(modal(page)).toContainText("Barcode 0321");
  expect(await tries(page)).toBe(1);
});

test("tries several sizes of a large photo before giving up", async ({ page }) => {
  await openSheet(page, { bitmap: "big" });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tries(page)).toBe(4);
});

test("a small photo without a barcode is tried once at full size", async ({ page }) => {
  await openSheet(page, {});
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await tries(page)).toBe(1);
});

test("loads the photo another way when createImageBitmap fails", async ({ page }) => {
  await openSheet(page, { detector: "SKU1", bitmap: "throws" });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("loads the photo another way when createImageBitmap is missing", async ({ page }) => {
  await openSheet(page, { detector: "SKU1", bitmap: "missing" });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("a file that isn't an image says no barcode was found", async ({ page }) => {
  await openSheet(page, { detector: "SKU1", bitmap: "missing" });
  await page.setInputFiles("#scanFile", notAnImage);
  await noBarcode(page);
});

test("cancelling the camera does nothing", async ({ page }) => {
  await openSheet(page, { detector: "SKU1" });
  await page.setInputFiles("#scanFile", []);
  await expect(page.locator("#overlay")).toBeHidden();
  await expect(page.locator("#toast")).toBeHidden();
});

test("a photo read while someone else deletes the sheet opens nothing", async ({ page }) => {
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

test("scanning in return mode opens the return for that item", async ({ page }) => {
  await openSheet(page, { detector: "SKU1" });
  await page.getByRole("button", { name: "Return", exact: true }).click();
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page).getByRole("heading", { name: "Return" })).toBeVisible();
});

test("an item's barcode can be scanned when adding it to inventory", async ({ page }) => {
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

test("a scanned item can be checked out on a new sheet", async ({ page }) => {
  await page.addInitScript(installScanner, { detector: "7770001" });
  await openApp(page);
  await createSheet(page, "November Co");
  await page.setInputFiles("#scanFile", png);
  await modal(page).getByLabel("Item name").fill("Degreaser");
  await modal(page).getByRole("button", { name: "Add 1 to sheet" }).click();
  await expect(lineRow(page, "Degreaser")).toContainText("Barcode 7770001");
});
