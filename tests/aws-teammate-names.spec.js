// Teammates' names for every member in the web build (supply-checkout-w5x0): GET
// /teams/{teamId}/photos lists each current member's name beside their photo link, and the
// projects show it next to "Prepared by" (src/aws/photos.js, profiles() in src/aws/account.js),
// with "Someone" only for a member with no name, against the fake backend in tests/fake-aws.js.
// The server's side (who may see whose name, removed members, no emails) is tested in backend/.
import { test, expect } from "./helpers.js";
import { FakeBackend, TEAM, USER, PHOTO, openAws, connected } from "./fake-aws.js";

const JOINED = "2026-09-01T00:00:00.000Z";
const PHOTOS = "/teams/t1/photos";
const ME = { userId: USER.id, email: USER.email, name: "Pat Lee", role: "viewer", joinedAt: JOINED };
const SAM = { userId: "u-sam", email: "sam@example.com", name: "Sam Ortiz", role: "owner", joinedAt: JOINED };
const ANA = { userId: "u-ana", email: "ana@example.com", name: "Ana Diaz", role: "contributor", joinedAt: JOINED };
const BO = { userId: "u-bo", email: "bo@example.com", role: "contributor", joinedAt: JOINED };
const project = (id, createdBy, client) => ({ [`t1/projects/${id}`]: { client, date: "2026-09-24", createdBy, createdAt: "2026-09-24T12:00:00Z", status: "open", items: {} } });
const card = (page, client) => page.locator(".project-card", { hasText: client });
const DOCS = { ...project("p1", "u-sam", "Sam's job"), ...project("p2", "u-ana", "Ana's job"), ...project("p3", "u-bo", "Bo's job") };

async function open(page, backend) {
  await openAws(page, backend);
  await connected(page);
  return backend;
}

test("a viewer sees teammates' names on their projects, with Someone only for a member with no name", async ({ page }) => {
  await open(page, new FakeBackend({ teams: [{ ...TEAM, role: "viewer" }], user: { ...USER, photoUrl: null }, members: { t1: [ME, SAM, ANA, BO] }, photos: { "u-sam": PHOTO }, docs: DOCS }));
  // Sam: a photo and a name; Ana: a name, so her initials; Bo: neither
  await expect(card(page, "Sam's job").locator(".who")).toHaveText("Sam Ortiz");
  await expect(card(page, "Sam's job").locator(".who img.avatar")).toHaveCount(1);
  await expect(card(page, "Ana's job").locator(".who")).toContainText("Ana Diaz");
  await expect(card(page, "Ana's job").locator(".who span.avatar")).toHaveText("AD");
  await expect(card(page, "Bo's job").locator(".who")).toHaveText("Someone");
  await expect(card(page, "Bo's job").locator(".who .avatar")).toHaveCount(0);
  // Searching finds a project by who prepared it
  await page.locator("#projectSearch").fill("ana diaz");
  await expect(page.locator(".project-card")).toHaveCount(1);
  await expect(card(page, "Ana's job")).toBeVisible();
});

test("an API from before the names, or a name that isn't one, shows Someone", async ({ page }) => {
  const backend = new FakeBackend({ user: { ...USER, photoUrl: null }, members: { t1: [ME, SAM, ANA, BO] }, photos: { "u-sam": PHOTO }, docs: DOCS });
  backend.on("GET", PHOTOS, { status: 200, body: { photos: {} } });
  await open(page, backend);
  await expect(card(page, "Sam's job").locator(".who")).toHaveText("Someone");
  await expect(card(page, "Ana's job").locator(".who")).toHaveText("Someone");
});

test("entries without a usable name are left out", async ({ page }) => {
  const backend = new FakeBackend({ user: { ...USER, photoUrl: null }, members: { t1: [ME, SAM, ANA, BO] }, docs: DOCS });
  backend.on("GET", PHOTOS, { status: 200, body: { photos: {}, members: { "u-sam": null, "u-ana": { name: "", photoUrl: null }, "u-bo": { name: 7, photoUrl: null } } } });
  await open(page, backend);
  for (const client of ["Sam's job", "Ana's job", "Bo's job"]) await expect(card(page, client).locator(".who")).toHaveText("Someone");
});

test("a name with a long run of combining marks stays inside its own row", async ({ page }) => {
  const zalgo = "Z" + "́̀̂̃".repeat(20) + "oe";
  await open(page, new FakeBackend({ teams: [{ ...TEAM, role: "viewer" }], user: { ...USER, photoUrl: null }, members: { t1: [ME, { ...SAM, name: zalgo }] }, docs: DOCS }));
  const who = card(page, "Sam's job").locator(".who");
  await expect(who).toContainText("oe");
  // Clipped to its own box, which is no taller than a line with an avatar
  expect(await who.evaluate((el) => getComputedStyle(el).overflow)).not.toBe("visible");
  expect((await who.boundingBox()).height).toBeLessThanOrEqual(32);
});
