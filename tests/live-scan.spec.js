// Live barcode scanning (src/live-scan.js, supply-checkout-005.7.1): the camera opens in a
// scanner, frames are read, and a code is taken once separate frames agree on it.
import { test, expect, openApp } from "./helpers.js";
import { modal, goToInventory, addToProject, lineRow, startAddItem, uploadReceipt } from "./ui/index.js";
import AxeBuilder from "@axe-core/playwright";
import { usedState, fakeImage } from "./fixtures.js";
import { installCamera, upcA } from "./camera.js";

// A real 1×1 PNG, so the browser can decode it (the stand-in detector reads it)
const png = { name: "barcode.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") };

const code = (rawValue, format = "code_128") => ({ rawValue, format });

const scanner = (page) => page.locator("#scanner");
const status = (page) => page.locator("#scanStatus");
const opened = (page) => page.evaluate(() => window.__camera.opened);
const stopped = (page) => page.evaluate(() => window.__camera.stopped);
// Echo Studio, ready to check out, with the stand-in camera
async function openProject(page, camera) {
  await page.addInitScript(installCamera, camera);
  await openApp(page, usedState);
  await page.getByRole("button", { name: /Echo Studio/ }).click();
}
const scan = (page) => page.getByText("Scan to check out").click();

test("the camera reads a code once two frames agree, and goes off", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [[code("SKU1")]] });
  await scan(page);
  await expect(modal(page).getByRole("heading", { name: "Check out" })).toBeVisible();
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
  await expect(scanner(page)).toBeHidden();
  expect(await page.evaluate(() => window.__camera.detects)).toBe(2);
  expect(await stopped(page)).toBe(1);
  expect(await page.locator("#scanVideo").evaluate((v) => v.srcObject)).toBeNull();
});

test("frames that disagree, misreads and repeats in one frame don't count", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, {
    detector: [
      [code("7770001")],
      // a retail code with a bad check digit, a blank, and the same code twice in a frame
      [code("4006381333932", "ean_13"), code(" "), code("SKU1"), code("SKU1")],
      [code("5550001")],
      [code("SKU1")],
    ],
  });
  await scan(page);
  await expect(modal(page)).toContainText("Barcode SKU1");
  expect(await page.evaluate(() => window.__camera.detects)).toBe(4);
});

test("an 8-digit code needs three frames that agree", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [[code("96385074", "ean_8")]] });
  await scan(page);
  await expect(modal(page)).toContainText("Barcode 96385074");
  expect(await page.evaluate(() => window.__camera.detects)).toBe(3);
});

test("while a read waits for another frame, the scanner says to hold steady", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [[code("SKU1")], []] });
  await scan(page);
  await expect(status(page)).toHaveText("Hold steady…");
  await page.keyboard.press("Escape");
});

// The pilot's bin label: a UPC-A turned a quarter turn, read by ZXing (no BarcodeDetector)
test("without a detector, ZXing reads the code in the aiming box, turned", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { picture: { modules: upcA("036000291452"), m: 2, x: 260, y: 140, h: 120, turned: true } });
  await scan(page);
  await expect(modal(page)).toContainText("Barcode 036000291452");
  await expect(scanner(page)).toBeHidden();
});

test("a detector that fails is passed over for ZXing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "throws", picture: { modules: upcA("036000291452"), m: 2, x: 225, y: 200, h: 80 } });
  await scan(page);
  await expect(modal(page)).toContainText("Barcode 036000291452");
});

test("a small code outside the aiming box is found as a spot", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { picture: { modules: upcA("036000291452"), m: 2, x: 20, y: 20, h: 60 } });
  await scan(page);
  await expect(modal(page)).toContainText("Barcode 036000291452");
});

test("bars that look like a code but aren't one are never taken", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: "throws", picture: { modules: upcA("036000291452").map((b, i) => b !== (i % 7 === 0)), m: 2, x: 20, y: 20, h: 60 } });
  await scan(page);
  // past a look for spots (every fourth frame)
  await expect.poll(() => page.evaluate(() => window.__camera.detects)).toBeGreaterThan(5);
  await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("a blocked camera says so, and a photo can be taken instead", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { camera: "denied", detector: [[code("SKU1")]] });
  await scan(page);
  await expect(status(page)).toHaveText("The camera is blocked for this site. Allow it in your browser's settings, or take a photo instead.");
  await expect(page.getByRole("button", { name: "Try again" })).toBeHidden();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Take a photo instead" }).click();
  await expect(scanner(page)).toBeHidden();
  await (await chooser).setFiles(png);
  // (one detection is enough in a photo: a retail code's check digit, or none, is all there is)
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("with no camera found, the scanner says so", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { camera: "missing" });
  await scan(page);
  await expect(status(page)).toHaveText("The camera isn't available. Take a photo instead.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(scanner(page)).toBeHidden();
});

for (const camera of ["unsupported", "none"]) {
  test(`without a camera (${camera}), Scan opens the photo picker`, { tag: ["@J4.2"] }, async ({ page }) => {
    await openProject(page, { camera, detector: [[code("SKU1")]] });
    const chooser = page.waitForEvent("filechooser");
    await scan(page);
    await (await chooser).setFiles(png);
    await expect(modal(page)).toContainText("Paper towels, 6 roll");
    await expect(scanner(page)).toHaveCount(0);
  });
}

test("a camera the browser won't list is still tried", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { camera: "unlisted", detector: [[code("SKU1")]] });
  await scan(page);
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("closed while the browser asks for the camera, the camera goes off when it starts", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { camera: "held", detector: [[]] });
  await scan(page);
  await expect(status(page)).toHaveText("Starting the camera…");
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.evaluate(() => window.__answerCamera(true));
  await expect.poll(() => stopped(page)).toBe(1);
  await expect(scanner(page)).toBeHidden();
});

test("closed while the browser asks, a refusal shows nothing", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { camera: "held", detector: [[]] });
  await scan(page);
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__answerCamera(false));
  await expect(scanner(page)).toBeHidden();
  // A scan after that starts afresh
  await scan(page);
  await expect(status(page)).toHaveText("Starting the camera…");
});

test("Escape closes the scanner, not the form under it, and Tab stays in the scanner", { tag: ["@J14.1"] }, async ({ page }) => {
  await page.addInitScript(installCamera, { detector: [[]] });
  await openApp(page, usedState);
  await page.getByRole("button", { name: "Quick take" }).click();
  await modal(page).getByText("Scan to take").click();
  await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
  await expect(page.getByRole("button", { name: "Cancel" }).last()).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Take a photo instead" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#scanner #scanCancel")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Take a photo instead" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(scanner(page)).toBeHidden();
  await expect(modal(page).getByRole("heading", { name: "Quick take" })).toBeVisible();
  expect(await stopped(page)).toBe(1);
});

test("the camera stops after its time limit, and can try again", { tag: ["@J4.2"] }, async ({ page }) => {
  await page.clock.install();
  await openProject(page, { detector: [[]] });
  await scan(page);
  await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
  await page.clock.fastForward(31000);
  await expect(status(page)).toHaveText("No barcode read yet. Move closer, add light, or take a photo instead.");
  expect(await stopped(page)).toBe(1);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
  expect(await opened(page)).toBe(2);
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("the camera stops while the page is hidden", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [[]] });
  await scan(page);
  await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
  const hide = (hidden) => page.evaluate((h) => { Object.defineProperty(document, "hidden", { value: h, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); }, hidden);
  await hide(true);
  await expect(status(page)).toHaveText("Scanning paused.");
  expect(await stopped(page)).toBe(1);
  // Hidden again with the camera already off, and shown: nothing changes until Try again
  await hide(true);
  await hide(false);
  await expect(status(page)).toHaveText("Scanning paused.");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
});

// supply-checkout-005.7.2: hidden before the camera has started, it stops as soon as it starts
test("the camera stops if the page is hidden while it starts, and no frame is read", { tag: ["@J4.2"] }, async ({ page }) => {
  await page.clock.install();
  await openProject(page, { camera: "held", detector: [[code("SKU1")]] });
  await scan(page);
  await expect(status(page)).toHaveText("Starting the camera…");
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.evaluate(() => window.__answerCamera(true));
  await expect(status(page)).toHaveText("Scanning paused.");
  expect(await stopped(page)).toBe(1);
  // Any frame the scanner had scheduled would run now
  await page.clock.runFor(2000);
  expect(await page.evaluate(() => window.__camera.detects)).toBe(0);
  expect(await page.locator("#scanVideo").evaluate((v) => v.srcObject)).toBeNull();
  // Back on the page, Try again starts it
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: false, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await page.getByRole("button", { name: "Try again" }).click();
  await page.evaluate(() => window.__answerCamera(true));
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

// A camera that starts but never sends a picture (in use elsewhere, say) still turns off at the time limit
test("a camera that sends no picture is read from no frames, and stops at the time limit", { tag: ["@J4.2"] }, async ({ page }) => {
  await page.clock.install();
  await openProject(page, { camera: "dark", detector: [[code("SKU1")]] });
  await scan(page);
  await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
  await page.clock.runFor(2000);
  expect(await page.evaluate(() => [window.__camera.detects, window.__camera.draws])).toEqual([0, 0]);
  await page.clock.fastForward(31000);
  await expect(status(page)).toHaveText("No barcode read yet. Move closer, add light, or take a photo instead.");
  expect(await stopped(page)).toBe(1);
});

test("closed before a camera's first picture, the scanner just closes", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { camera: "dark" });
  await scan(page);
  await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(scanner(page)).toBeHidden();
  expect(await stopped(page)).toBe(1);
});

// The camera stops (the page hidden) while the first frame waits for ZXing to load: that frame
// isn't drawn from a video that no longer has a picture (which threw in Firefox and Android)
test("a frame read when the camera stops goes no further", { tag: ["@J4.2"] }, async ({ page }) => {
  let release, requested;
  const asked = new Promise((resolve) => { requested = resolve; });
  await openProject(page, { detector: [[]] });
  await page.route(/\/assets\/zxing-[^/]*\.js$/, async (route) => { requested(); await new Promise((resolve) => { release = resolve; }); await route.fallback(); });
  await scan(page);
  await asked;
  await page.evaluate(() => { Object.defineProperty(document, "hidden", { value: true, configurable: true }); document.dispatchEvent(new Event("visibilitychange")); });
  await expect(status(page)).toHaveText("Scanning paused.");
  release();
  await expect.poll(() => page.evaluate(() => [...performance.getEntriesByType("resource")].some((e) => /zxing-/.test(e.name)))).toBe(true);
  await expect(status(page)).toHaveText("Scanning paused.");
  expect(await page.evaluate(() => window.__camera.draws)).toBe(0);
});

test("the flashlight toggles where the camera has one", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [[]], torch: "yes" });
  await scan(page);
  const lightBtn = page.getByRole("button", { name: "Flashlight" });
  await expect(lightBtn).toHaveAttribute("aria-pressed", "false");
  await lightBtn.click();
  await expect(lightBtn).toHaveAttribute("aria-pressed", "true");
  await lightBtn.click();
  await expect(lightBtn).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => window.__camera.torch)).toEqual([true, false]);
});

for (const torch of ["no", "unknown"]) {
  test(`no flashlight button without one (${torch})`, { tag: ["@J4.2"] }, async ({ page }) => {
    await openProject(page, { detector: [[]], torch });
    await scan(page);
    await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
    await expect(page.getByRole("button", { name: "Flashlight" })).toBeHidden();
  });
}

test("a flashlight that won't turn on stays off", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [[]], torch: "fails" });
  await scan(page);
  await page.getByRole("button", { name: "Flashlight" }).click();
  await expect(page.getByRole("button", { name: "Flashlight" })).toHaveAttribute("aria-pressed", "false");
});

test("an item's barcode can be scanned live into the item form", { tag: ["@J2.2"] }, async ({ page }) => {
  await page.addInitScript(installCamera, { detector: [[code("5550001")]] });
  await openApp(page);
  await goToInventory(page);
  await startAddItem(page);
  await modal(page).getByText("Scan", { exact: true }).click();
  await expect(modal(page).getByPlaceholder("Type, scan, or leave blank")).toHaveValue("5550001");
});

async function openReceipt(page, camera) {
  await page.addInitScript(installCamera, camera);
  await openApp(page, usedState);
  await expect(page.getByText("Connecting…")).toBeHidden();
  await uploadReceipt(page, fakeImage);
}
const lineCode = (page) => page.locator(".rline").nth(1).locator('[data-f="code"]');

test("a receipt line's barcode can be scanned live", { tag: ["@J5.2"] }, async ({ page }) => {
  await openReceipt(page, { detector: [[code("SKU1")]] });
  await page.locator(".rline").nth(1).getByRole("button", { name: "Scan" }).click();
  await expect(lineCode(page)).toHaveValue("SKU1");
});

// The review can be drawn again while the scanner is open (new data arriving), with a new input
test("a code scanned while the page under the scanner is drawn again still arrives", { tag: ["@J5.2"] }, async ({ page }) => {
  await openReceipt(page, { camera: "held", detector: [[code("SKU1")]] });
  await page.locator(".rline").nth(1).getByRole("button", { name: "Scan" }).click();
  await page.evaluate(() => { const input = document.getElementById("rScanFile"); input.replaceWith(input.cloneNode()); });
  await page.evaluate(() => window.__answerCamera(true));
  await expect(lineCode(page)).toHaveValue("SKU1");
});

test("so does the photo picker", { tag: ["@J5.2"] }, async ({ page }) => {
  await openReceipt(page, { camera: "held" });
  await page.locator(".rline").nth(1).getByRole("button", { name: "Scan" }).click();
  await page.evaluate(() => { const input = document.getElementById("rScanFile"); input.replaceWith(input.cloneNode()); });
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Take a photo instead" }).click();
  expect(await (await chooser).element().evaluate((input) => input.isConnected)).toBe(true);
});

// Gone with nothing in its place, the input still gets the code (here its own listener opens the checkout)
test("an input that's gone with nothing in its place still gets the code", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { camera: "held", detector: [[code("SKU1")]] });
  await scan(page);
  await page.evaluate(() => document.getElementById("scanFile").remove());
  await page.evaluate(() => window.__answerCamera(true));
  await expect(scanner(page)).toBeHidden();
  await expect(modal(page)).toContainText("Paper towels, 6 roll");
});

test("a code scanned live is checked out like a photo's", { tag: ["@J4.2"] }, async ({ page }) => {
  await openProject(page, { detector: [[code("SKU1")]] });
  await scan(page);
  await addToProject(page);
  await expect(lineRow(page, "Paper towels")).toContainText("4");
});

for (const scheme of ["light", "dark"]) {
  test(`the scanner fits a phone and passes axe (${scheme})`, { tag: ["@J4.2"] }, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.emulateMedia({ colorScheme: scheme });
    await openProject(page, { detector: [[]], torch: "yes" });
    await scan(page);
    await expect(status(page)).toHaveText("Hold the barcode inside the frame.");
    const { violations } = await new AxeBuilder({ page }).include("#scanner").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
    for (const b of await page.locator("#scanner button:visible").all()) {
      const box = await b.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(375);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  });
}
