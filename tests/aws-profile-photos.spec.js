// Profile photos in the web build (supply-checkout-6uw.30): uploading, cropping and removing your
// own on Account (src/aws/profile-photo.js), and everyone's photo, or their initials, on the team
// bar, in Members and next to "Prepared by" (src/avatar.js, src/aws/photos.js), against the fake
// backend in tests/fake-aws.js, whose bucket links expire on demand. The server's side (the JPEG
// checks, the bucket, who may see whose photo) is tested in backend/.
import AxeBuilder from "@axe-core/playwright";
import { test, expect, modalViolations } from "./helpers.js";
import { FakeBackend, USER, PHOTO, PHOTO_HOST, openAws, connected, jpegSize } from "./fake-aws.js";

// The modal's entrance animation fades it in; axe must see its final colors
test.use({ reducedMotion: "reduce" });

const JOINED = "2026-09-01T00:00:00.000Z";
// An API with photos says so in /me (photoUrl, null for none)
const ME_USER = { ...USER, photoUrl: null };
const ME = { userId: USER.id, email: USER.email, name: "Pat Lee", role: "owner", joinedAt: JOINED };
const SAM = { userId: "u-sam", email: "sam@example.com", name: "Sam Ortiz", role: "contributor", joinedAt: JOINED };
const PHOTOS = "/teams/t1/photos";
const project = (id, createdBy, client) => ({ [`t1/projects/${id}`]: { client, date: "2026-09-24", createdBy, createdAt: "2026-09-24T12:00:00Z", status: "open", items: {} } });
const dialog = (page) => page.locator("#modal");
const chip = (page) => page.locator("#accountOpen");
const card = (page, client) => page.locator(".project-card", { hasText: client });
const fail = (page) => page.locator("#photoFail");

async function open(page, backend) {
  await openAws(page, backend);
  await connected(page);
  return backend;
}
async function openAccount(page) {
  await chip(page).click();
  await expect(dialog(page).getByRole("heading", { name: "Profile photo" })).toBeVisible();
}
// The photo has loaded (not a broken image)
const loaded = (img) => expect.poll(() => img.evaluate((i) => i.complete && i.naturalWidth > 0)).toBe(true);

// A 512 × 256 PNG: green for the first 64 columns, then red to the middle, then blue
async function stripes(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 256;
    const g = c.getContext("2d");
    g.fillStyle = "#00ff00"; g.fillRect(0, 0, 64, 256);
    g.fillStyle = "#ff0000"; g.fillRect(64, 0, 192, 256);
    g.fillStyle = "#0000ff"; g.fillRect(256, 0, 256, 256);
    return c.toDataURL("image/png").split(",")[1];
  });
  return { name: "me.png", mimeType: "image/png", buffer: Buffer.from(b64, "base64") };
}
// Which colour the crop shows at a point of its 256 × 256 canvas
const colorAt = (page, x, y) => page.locator("#cropCanvas").evaluate((c, [x, y]) => {
  const [r, g, b] = c.getContext("2d").getImageData(x, y, 1, 1).data;
  return r > 200 && g < 60 && b < 60 ? "red" : g > 200 && r < 60 && b < 60 ? "green" : b > 200 && r < 60 && g < 60 ? "blue" : `${r},${g},${b}`;
}, [x, y]);

test.describe("your own photo", () => {
  test("uploads a cropped photo, which then shows on the team bar, Account and your projects", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ user: ME_USER, members: { t1: [ME, SAM] }, docs: project("p1", USER.id, "Echo Studio") }));
    // Initials until there's a photo, the same size
    await expect(chip(page).locator("span.avatar")).toHaveText("PL");
    await expect(card(page, "Echo Studio").locator(".who span.avatar")).toHaveText("PL");
    const before = await chip(page).boundingBox();

    await openAccount(page);
    await expect(dialog(page).locator("#photoNow [role=img]")).toHaveAccessibleName("Your profile photo");
    await expect(dialog(page).getByRole("button", { name: "Remove" })).toBeHidden();
    expect(await modalViolations(page)).toEqual([]);

    const file = await stripes(page);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), dialog(page).getByRole("button", { name: "Upload photo" }).click()]);
    await chooser.setFiles(file);
    const frame = page.getByRole("group", { name: "Photo position" });
    await expect(frame).toBeFocused();
    await expect(dialog(page).getByRole("button", { name: "Upload photo" })).toBeHidden();
    expect(await modalViolations(page)).toEqual([]);
    // Centred: the middle 256 columns
    expect([await colorAt(page, 10, 128), await colorAt(page, 250, 128)]).toEqual(["red", "blue"]);

    // The keyboard moves it, and it never leaves the square uncovered
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowRight");
    expect([await colorAt(page, 10, 128), await colorAt(page, 250, 128)]).toEqual(["green", "red"]);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowLeft");
    for (let i = 0; i < 9; i++) await page.keyboard.press("Shift+ArrowLeft");
    expect([await colorAt(page, 10, 128), await colorAt(page, 250, 128)]).toEqual(["blue", "blue"]);

    // Dragging it back halfway across the frame moves it half the canvas
    const box = await frame.boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 20 + box.width / 4, box.y + 20, { steps: 2 });
    await page.mouse.move(box.x + 20 + box.width / 2, box.y + 20, { steps: 2 });
    await page.mouse.up();
    await page.mouse.move(box.x + 30, box.y + 30);
    expect([await colorAt(page, 10, 128), await colorAt(page, 250, 128)]).toEqual(["red", "blue"]);

    // Zooming, with the slider or the keys, about the middle
    const zoom = dialog(page).getByLabel("Zoom");
    await zoom.fill("2");
    await frame.focus();
    await page.keyboard.press("+");
    await page.keyboard.press("=");
    await expect(zoom).toHaveValue("2.2");
    await page.keyboard.press("-");
    await page.keyboard.press("-");
    await page.keyboard.press("a");
    await expect(zoom).toHaveValue("2");
    for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowRight");
    // At twice the size, the green stripe fills the first 128 columns
    expect([await colorAt(page, 100, 128), await colorAt(page, 200, 128)]).toEqual(["green", "red"]);

    await dialog(page).getByRole("button", { name: "Save photo" }).click();
    await expect(dialog(page).getByRole("button", { name: "Change photo" })).toBeFocused();
    const [put] = backend.requests("PUT", "/me/photo");
    expect(Object.keys(put.body)).toEqual(["image"]);
    const jpeg = Buffer.from(put.body.image, "base64");
    expect(jpegSize(jpeg)).toEqual({ width: 256, height: 256 });
    expect(jpeg.length).toBeLessThanOrEqual(60 * 1024);

    const preview = dialog(page).locator("#photoNow img.avatar");
    await expect(preview).toHaveAttribute("alt", "Your profile photo");
    await expect(preview).toHaveAttribute("src", new RegExp(`^${PHOTO_HOST}/`));
    await loaded(preview);
    await expect(dialog(page).locator("#photoCrop")).toBeHidden();
    await expect(dialog(page).getByRole("button", { name: "Remove" })).toBeVisible();
    expect(await modalViolations(page)).toEqual([]);
    await page.keyboard.press("Escape");

    // Everywhere else too, without moving anything
    await loaded(chip(page).locator("img.avatar"));
    await expect(chip(page).locator("img.avatar")).toHaveAttribute("alt", "");
    expect((await chip(page).boundingBox()).height).toBe(before.height);
    await loaded(card(page, "Echo Studio").locator(".who img.avatar"));
    await expect(card(page, "Echo Studio").locator(".who")).toHaveText("Pat Lee");
  });

  test("nothing of the original's metadata goes up: the photo is drawn again", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ user: ME_USER }));
    await openAccount(page);
    // A JPEG with a comment and an EXIF segment carrying text that mustn't leave the device
    const plain = Buffer.from(await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 300; c.height = 400;
      c.getContext("2d").fillRect(0, 0, 300, 400);
      return c.toDataURL("image/jpeg", 0.9).split(",")[1];
    }), "base64");
    const segment = (marker, text) => {
      const body = Buffer.from(text, "latin1");
      const head = Buffer.from([0xff, marker, 0, 0]);
      head.writeUInt16BE(body.length + 2, 2);
      return Buffer.concat([head, body]);
    };
    const tagged = Buffer.concat([plain.subarray(0, 2), segment(0xe1, "Exif\0\0SECRET-GPS-38.88N-77.03W"), segment(0xfe, "SECRET-COMMENT"), plain.subarray(2)]);
    await page.setInputFiles("#photoFile", { name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: tagged });
    await dialog(page).getByRole("button", { name: "Save photo" }).click();
    await loaded(dialog(page).locator("#photoNow img"));
    const jpeg = Buffer.from(backend.requests("PUT", "/me/photo")[0].body.image, "base64");
    expect(jpegSize(jpeg)).toEqual({ width: 256, height: 256 });
    expect(jpeg.includes("SECRET")).toBe(false);
  });

  test("removes the photo with two taps, and shows the initials again", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ user: ME_USER, photos: { [USER.id]: PHOTO } }));
    await loaded(chip(page).locator("img.avatar"));
    await openAccount(page);
    await loaded(dialog(page).locator("#photoNow img"));
    const remove = dialog(page).getByRole("button", { name: "Remove" });
    // One that fails says so, and stays
    backend.on("DELETE", "/me/photo", { abort: true });
    await remove.click();
    expect(backend.requests("DELETE", "/me/photo")).toHaveLength(0);
    await dialog(page).getByRole("button", { name: "Tap again to remove" }).click();
    await expect(fail(page)).toHaveText("Couldn't remove your photo. Check your connection and try again.");
    await expect(remove).toBeEnabled();
    await remove.click();
    await dialog(page).getByRole("button", { name: "Tap again to remove" }).click();
    await expect(dialog(page).getByRole("button", { name: "Upload photo" })).toBeFocused();
    await expect(fail(page)).toBeHidden();
    expect(backend.requests("DELETE", "/me/photo")).toHaveLength(2);
    await expect(dialog(page).locator("#photoNow [role=img]")).toHaveText("PL");
    await expect(remove).toBeHidden();
    await expect(chip(page).locator("span.avatar")).toHaveText("PL");
  });

  test("Cancel puts the photo back as it was, and an empty choice does nothing", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ user: ME_USER }));
    await openAccount(page);
    await page.setInputFiles("#photoFile", await stripes(page));
    await expect(dialog(page).locator("#photoCrop")).toBeVisible();
    await dialog(page).getByRole("button", { name: "Cancel" }).first().click();
    await expect(dialog(page).locator("#photoCrop")).toBeHidden();
    await expect(dialog(page).getByRole("button", { name: "Upload photo" })).toBeFocused();
    await page.setInputFiles("#photoFile", []);
    await expect(dialog(page).locator("#photoCrop")).toBeHidden();
    await expect(fail(page)).toBeHidden();
    expect(backend.requests("PUT", "/me/photo")).toHaveLength(0);
  });

  test.describe("a photo that can't be used says why", () => {
    const cases = [
      ["another kind of file", { name: "me.gif", mimeType: "image/gif", buffer: Buffer.from("GIF89a") }, "Choose a JPEG, PNG or WebP photo."],
      ["an SVG", { name: "me.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>") }, "Choose a JPEG, PNG or WebP photo."],
      ["a file over 20 MB", { name: "big.jpg", mimeType: "image/jpeg", buffer: Buffer.alloc(20 * 1024 * 1024 + 1) }, "That photo is too large to open. Choose one under 20 MB."],
      ["one the browser can't decode", { name: "broken.png", mimeType: "image/png", buffer: Buffer.from("not really a PNG") }, "That photo couldn't be opened. Try another JPEG, PNG or WebP photo."],
    ];
    for (const [what, file, message] of cases) {
      test(what, async ({ page }) => {
        const backend = await open(page, new FakeBackend({ user: ME_USER }));
        await openAccount(page);
        await page.setInputFiles("#photoFile", file);
        await expect(fail(page)).toHaveText(message);
        await expect(dialog(page).locator("#photoCrop")).toBeHidden();
        expect(backend.requests("PUT", "/me/photo")).toHaveLength(0);
      });
    }

    const refusals = [
      ["the server finds it isn't a valid photo", { status: 400, body: { error: { code: "bad_request", message: "That isn't a 256×256 JPEG photo", reason: "photo_invalid" } } }, "That photo couldn't be used. Try another JPEG, PNG or WebP photo."],
      ["it's too large", { status: 413, body: { error: { code: "quota_exceeded", message: "That photo is too large", reason: "photo_too_large" } } }, "That photo is too large to save. Zoom in a little, or try another photo."],
      ["the photo didn't go", { abort: true }, "Couldn't save your photo. Check your connection and try again."],
    ];
    for (const [what, answer, message] of refusals) {
      test(`when ${what}`, async ({ page }) => {
        const backend = await open(page, new FakeBackend({ user: ME_USER }));
        backend.on("PUT", "/me/photo", answer);
        await openAccount(page);
        await page.setInputFiles("#photoFile", await stripes(page));
        await dialog(page).getByRole("button", { name: "Save photo" }).click();
        await expect(fail(page)).toHaveText(message);
        // Still there to try again
        await expect(dialog(page).getByRole("button", { name: "Save photo" })).toBeEnabled();
        await expect(chip(page).locator("span.avatar")).toHaveText("PL");
      });
    }

    test("after 20 changes in a day", async ({ page }) => {
      const backend = await open(page, new FakeBackend({ user: ME_USER, photoUploads: 20 }));
      await openAccount(page);
      await page.setInputFiles("#photoFile", await stripes(page));
      await dialog(page).getByRole("button", { name: "Save photo" }).click();
      await expect(fail(page)).toHaveText("You've changed your photo as many times as you can today. Try again tomorrow.");
      expect(backend.requests("PUT", "/me/photo")).toHaveLength(1);
    });
  });

  test("before a team is open, Account has the photo too", async ({ page }) => {
    const backend = new FakeBackend({ user: ME_USER, teams: [] });
    await openAws(page, backend);
    await page.getByRole("button", { name: "Delete account" }).click();
    await expect(dialog(page).getByRole("heading", { name: "Profile photo" })).toBeVisible();
    // Initials from the email address
    await expect(dialog(page).locator("#photoNow [role=img]")).toHaveText("P");
    await page.setInputFiles("#photoFile", await stripes(page));
    await dialog(page).getByRole("button", { name: "Save photo" }).click();
    await loaded(dialog(page).locator("#photoNow img"));
    expect(backend.requests("GET", PHOTOS)).toHaveLength(0);
  });

  test("fits a 320px phone in dark mode, and is accessible", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.emulateMedia({ colorScheme: "dark" });
    await open(page, new FakeBackend({ user: ME_USER }));
    await openAccount(page);
    await page.setInputFiles("#photoFile", await stripes(page));
    await expect(page.getByRole("group", { name: "Photo position" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(await page.locator("#modal").evaluate((m) => m.scrollWidth - m.clientWidth)).toBeLessThanOrEqual(0);
    expect(await modalViolations(page)).toEqual([]);
  });
});

test.describe("everyone's photos", () => {
  test("teammates' photos show in Members and on their projects; anyone without one has initials", async ({ page }) => {
    const backend = await open(page, new FakeBackend({
      user: ME_USER, members: { t1: [ME, SAM, { userId: "u-ana", email: "ana@example.com", role: "viewer", joinedAt: JOINED }] }, photos: { "u-sam": PHOTO },
      docs: { ...project("p1", "u-sam", "Sam's job"), ...project("p2", "u-ana", "Ana's job") },
    }));
    expect(backend.requests("GET", PHOTOS)).toHaveLength(1);
    // Sam's photo, with the name the app has for them; Ana has no photo and no name it can show
    await loaded(card(page, "Sam's job").locator(".who img.avatar"));
    await expect(card(page, "Sam's job").locator(".who")).toHaveText("Someone");
    await expect(card(page, "Ana's job").locator(".who .avatar")).toHaveCount(0);
    await expect(card(page, "Ana's job").locator(".who")).toHaveText("Someone");
    await expect(chip(page).locator("span.avatar")).toHaveText("PL");

    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    const row = (text) => dialog(page).locator(".member", { hasText: text });
    await loaded(row("sam@example.com").locator("img.avatar"));
    await expect(row("pat@example.com").locator("span.avatar")).toHaveText("PL");
    await expect(row("ana@example.com").locator("span.avatar")).toHaveText("A");
    expect(await modalViolations(page)).toEqual([]);
    const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(violations.map((v) => v.id)).toEqual([]);
  });

  test("a link that expired is asked for again, and the photo shows", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ user: ME_USER, members: { t1: [ME, SAM] }, photos: { [USER.id]: PHOTO, "u-sam": PHOTO }, docs: project("p1", USER.id, "Echo Studio") }));
    await loaded(chip(page).locator("img.avatar"));
    backend.expirePhotoLinks();
    // Members draws the links it has, which have expired: they're asked for again, once for both
    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    const row = (text) => dialog(page).locator(".member", { hasText: text });
    await expect.poll(() => backend.requests("GET", PHOTOS).length).toBe(2);
    await loaded(row("sam@example.com").locator("img.avatar"));
    await loaded(row("pat@example.com").locator("img.avatar"));
    expect(backend.requests("GET", PHOTOS)).toHaveLength(2);
    // The rest of the page has the new links too
    await loaded(chip(page).locator("img.avatar"));
    expect(await chip(page).locator("img.avatar").getAttribute("src")).toBe(await row("pat@example.com").locator("img.avatar").getAttribute("src"));
  });

  test("a photo that still won't load gives way to the initials, without asking again and again", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ user: ME_USER, members: { t1: [ME, SAM] }, photos: { "u-sam": PHOTO } }));
    expect(backend.requests("GET", PHOTOS)).toHaveLength(1);
    const stale = backend.photoList["u-sam"];
    backend.expirePhotoLinks();
    // The list answers with the same link, which doesn't work any more
    backend.on("GET", PHOTOS, { status: 200, body: { photos: { "u-sam": stale } } });
    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    const sam = dialog(page).locator(".member", { hasText: "sam@example.com" });
    await expect(sam.locator("span.avatar")).toHaveText("SO");
    await expect(sam.locator(".avatar")).toHaveCount(1);
    expect(backend.requests("GET", PHOTOS)).toHaveLength(2);
    // Members again: the link that failed isn't tried again
    await page.keyboard.press("Escape");
    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    await expect(sam.locator("span.avatar")).toHaveText("SO");
    expect(backend.requests("GET", PHOTOS)).toHaveLength(2);
  });

  test("links that expired before they were drawn (a device that slept) are asked for once, for every photo", async ({ page }) => {
    const backend = new FakeBackend({ user: ME_USER, members: { t1: [ME, SAM] }, photos: { "u-sam": PHOTO }, docs: { ...project("p1", "u-sam", "Sam's job"), ...project("p2", "u-sam", "Sam's other job") } });
    const stale = backend.photoLink("u-sam");
    backend.expirePhotoLinks();
    backend.on("GET", PHOTOS, { status: 200, body: { photos: { "u-sam": stale } } });
    await open(page, backend);
    await loaded(card(page, "Sam's job").locator("img.avatar"));
    await loaded(card(page, "Sam's other job").locator("img.avatar"));
    expect(backend.requests("GET", PHOTOS)).toHaveLength(2);
    // Another image that doesn't load is none of its business
    await page.evaluate(() => { const img = document.createElement("img"); img.src = "/no-such-image.png"; img.alt = ""; document.body.append(img); });
    await page.waitForTimeout(200);
    expect(backend.requests("GET", PHOTOS)).toHaveLength(2);
  });

  test("a photo missing from the bucket is asked for once more, then shows the initials, however often it's drawn", async ({ page }) => {
    const backend = new FakeBackend({ user: ME_USER, members: { t1: [ME, SAM] }, photos: { "u-sam": PHOTO } });
    // Every list signs a fresh link to it, and every link fails
    backend.missingPhotos.add("u-sam");
    await open(page, backend);
    const sam = dialog(page).locator(".member", { hasText: "sam@example.com" });
    for (let i = 0; i < 3; i++) {
      await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
      await expect(sam.locator("span.avatar")).toHaveText("SO");
      await expect(sam.locator(".avatar")).toHaveCount(1);
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(500);
    expect(backend.requests("GET", PHOTOS)).toHaveLength(2);
  });

  test("when the list can't be had again, a broken photo shows the initials", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ user: ME_USER, members: { t1: [ME, SAM] }, photos: { "u-sam": PHOTO } }));
    backend.expirePhotoLinks();
    backend.on("GET", PHOTOS, { abort: true });
    await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
    await expect(dialog(page).locator(".member", { hasText: "sam@example.com" }).locator("span.avatar")).toHaveText("SO");
  });

  test("the links are asked for again before they expire", async ({ page }) => {
    await page.clock.install();
    const backend = await open(page, new FakeBackend({ user: ME_USER, photos: { [USER.id]: PHOTO } }));
    await loaded(chip(page).locator("img.avatar"));
    const first = await chip(page).locator("img.avatar").getAttribute("src");
    expect(backend.requests("GET", PHOTOS)).toHaveLength(1);
    await page.clock.fastForward(50 * 60e3);
    await expect.poll(() => backend.requests("GET", PHOTOS).length).toBe(2);
    await expect(chip(page).locator("img.avatar")).not.toHaveAttribute("src", first);
    await loaded(chip(page).locator("img.avatar"));
  });

  test("the projects don't wait long for a slow list, and the photos come in when it answers", async ({ page }) => {
    const backend = new FakeBackend({ user: ME_USER, members: { t1: [ME, SAM] }, photos: { [USER.id]: PHOTO, "u-sam": PHOTO }, docs: project("p1", "u-sam", "Sam's job") });
    const release = backend.hold("GET", PHOTOS);
    await open(page, backend);
    await expect(card(page, "Sam's job")).toBeVisible();
    // Your own photo from /me meanwhile; Sam's isn't known yet
    await loaded(chip(page).locator("img.avatar"));
    await expect(card(page, "Sam's job").locator(".avatar")).toHaveCount(0);
    const fromMe = await chip(page).locator("img.avatar").getAttribute("src");
    release();
    await expect(chip(page).locator("img.avatar")).not.toHaveAttribute("src", fromMe);
    await loaded(chip(page).locator("img.avatar"));
  });

  test("an API without photos is never asked, and Account has no photo", async ({ page }) => {
    const backend = await open(page, new FakeBackend({ docs: { ...project("p1", USER.id, "Echo Studio"), ...project("p2", "u-sam", "Sam's job") } }));
    await expect(chip(page).locator("span.avatar")).toHaveText("PL");
    await expect(card(page, "Sam's job").locator(".who")).toHaveText("Someone");
    await expect(card(page, "Sam's job").locator(".avatar")).toHaveCount(0);
    await expect(card(page, "Echo Studio").locator(".who span.avatar")).toHaveText("PL");
    await chip(page).click();
    await expect(dialog(page).getByRole("heading", { name: "Your account", exact: true })).toBeVisible();
    await expect(dialog(page).getByRole("heading", { name: "Profile photo" })).toHaveCount(0);
    expect(backend.requests("GET", PHOTOS)).toHaveLength(0);
  });
});
