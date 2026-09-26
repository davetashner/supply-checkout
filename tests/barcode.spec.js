import { test, expect, openApp, createSheet, modal, lineRow } from "./helpers.js";
import { usedState } from "./fixtures.js";

// A real 1×1 PNG, so the browser can decode it
const png = {
  name: "barcode.png",
  mimeType: "image/png",
  buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
};
const notAnImage = { name: "barcode.jpg", mimeType: "image/jpeg", buffer: Buffer.from("not an image") };

// Controls both barcode readers the app can use, so results don't depend on
// whether this browser has a built-in BarcodeDetector.
//   detector: "none" | "empty" | "throws" | a code to return
//   zxing:    "none" | "fail" | "fail-reset" | a code to return
//   bitmap:   "real" | "big" (3000×1000 canvas) | "throws" | "missing"
function installScanner({ detector = "none", zxing = "none", bitmap = "real" }) {
  delete window.BarcodeDetector;
  if (detector !== "none") {
    window.BarcodeDetector = class {
      async detect() {
        if (detector === "throws") throw new Error("detector failed");
        return detector === "empty" ? [] : [{ rawValue: detector }];
      }
    };
  }
  window.__zxingDecodes = 0;
  if (zxing !== "none") {
    window.ZXing = {
      BarcodeFormat: {}, DecodeHintType: { POSSIBLE_FORMATS: 2, TRY_HARDER: 3 },
      BinaryBitmap: class {}, HybridBinarizer: class {}, HTMLCanvasElementLuminanceSource: class {},
      MultiFormatReader: class {
        setHints() {}
        decode() {
          window.__zxingDecodes++;
          if (zxing.startsWith("fail")) throw new Error("NotFoundException");
          return { getText: () => zxing };
        }
        reset() { if (zxing === "fail-reset") throw new Error("reset failed"); }
      },
    };
  }
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

test("falls back to ZXing when the detector finds nothing or fails", async ({ page }) => {
  await openSheet(page, { detector: "empty", zxing: "0123" });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode 0123");
  await page.keyboard.press("Escape");

  // The ZXing reader is set up once and reused
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode 0123");
  expect(await page.evaluate(() => window.__zxingDecodes)).toBe(2);
});

test("a detector error also falls back to ZXing", async ({ page }) => {
  await openSheet(page, { detector: "throws", zxing: "0456" });
  await page.setInputFiles("#scanFile", png);
  await expect(modal(page)).toContainText("Barcode 0456");
});

test("tries several sizes of a large photo before giving up", async ({ page }) => {
  await openSheet(page, { zxing: "fail-reset", bitmap: "big" });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await page.evaluate(() => window.__zxingDecodes)).toBe(4);
});

test("a small photo is tried once at full size", async ({ page }) => {
  await openSheet(page, { zxing: "fail" });
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
  expect(await page.evaluate(() => window.__zxingDecodes)).toBe(1);
});

test("without any barcode reader, says no barcode was found", async ({ page }) => {
  await openSheet(page, {});
  await page.setInputFiles("#scanFile", png);
  await noBarcode(page);
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
