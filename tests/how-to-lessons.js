// The how-to lessons' steps, played in the app (tests/how-to.spec.js). Each lesson on
// supplycheckout.com/how-to/ (site/how-to/<slug>/index.html) is an entry here, in the index's
// order, with the app it's played in and one function per step:
//
//   app: "demo"   the demo build, with its demo data (most lessons: what a crew member does)
//   app: "web"    the web build against the fake backend (tests/fake-aws.js), signed in as the
//                 team's owner with the demo data, for what only the web app has (Members,
//                 Import CSV). `backend` makes the backend.
//
// Step N's function takes the app from where step N-1 left it to the screen the lesson's step N
// shows: the screenshot is taken there, with each control the step names in bold outlined. So a
// step's function does what the earlier steps told the reader to do, then opens the screen the
// step is about. The spec scrolls a named control that's off screen into view, unless the step's
// function has scrolled the screen to what the step shows. A function gets the page and a context
// with `backend` (web lessons) and `newPage()`, for a step seen by someone else (the crew member
// an owner invited): it returns the page to take the screenshot of from then on.
import { expect } from "@playwright/test";
import { demoState } from "../demo/data.js";
import { FakeBackend, TEAM, USER } from "./fake-aws.js";

const modal = (page) => page.locator("#modal");
const typeCode = async (scope, code) => {
  await scope.getByPlaceholder("Or type the barcode").fill(code);
  await scope.getByPlaceholder("Or type the barcode").press("Enter");
};
const more = (page, field) => (field ? modal(page).locator("div.field", { has: page.locator(`label[for="${field}"]`) }) : modal(page)).getByRole("button", { name: "More", exact: true }).first().click();
const project = (page, name) => page.locator("#main .project-card", { hasText: name });
const line = (page, name) => page.locator("#projectBody tbody tr", { hasText: name });
const scrollToTop = (locator) => locator.evaluate((el) => { el.scrollIntoView({ block: "start" }); scrollBy(0, -16); });
const tiny = { name: "receipt.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };

// The web lessons' team: the demo's inventory and projects, owned by the signed-in user
const demoDocs = () => Object.fromEntries(Object.entries(demoState().seed).map(([key, data]) => [`${TEAM.id}/${key}`, data]));
const OWNER = { userId: USER.id, email: USER.email, name: "Pat Lee", role: "owner", joinedAt: "2026-09-01T00:00:00.000Z" };
const SAM = { userId: "u-sam", email: "sam@example.com", name: "Sam Ortiz", role: "contributor", joinedAt: "2026-09-02T00:00:00.000Z" };
const IMPORT_CSV = "name,barcode,price,stock\nTrash bags 33 gal,0456,14.25,12\nPaper towels 6 roll,SKU-TOWEL,8.75,20\n";
const IMPORT_PREVIEW = {
  status: "preview",
  rows: [
    { line: 2, name: "Trash bags 33 gal", barcode: "0456", price: 14.25, stock: 12, key: "0456", action: "create", changes: ["name", "price", "stock"] },
    { line: 3, name: "Paper towels 6 roll", barcode: "SKU-TOWEL", price: 8.75, stock: 20, key: "SKU-TOWEL", action: "update", changes: ["price", "stock"] },
  ],
  errors: [],
  errorCount: 0,
  ignoredColumns: [],
  summary: { rows: 2, created: 1, updated: 1, unchanged: 0 },
};

export const LESSONS = {
  "check-out-and-return": {
    app: "demo",
    steps: [
      // 1. The project list
      async () => {},
      // 2. The new project form, filled in
      async (page) => {
        await page.getByRole("button", { name: "+ New project", exact: true }).click();
        await modal(page).getByLabel("Client", { exact: true }).fill("Riverside Clinic");
      },
      // 3. The new project, ready to scan
      async (page) => {
        await modal(page).getByRole("button", { name: "Create project", exact: true }).click();
        await expect(page.getByRole("heading", { name: "Riverside Clinic" })).toBeVisible();
      },
      // 4. The checkout form for a scanned item, with 2 chosen
      async (page) => {
        await typeCode(page, "012345678905");
        await more(page);
        await expect(modal(page).locator("#fQty")).toHaveValue("2");
      },
      // 5. The project with two items on it
      async (page) => {
        await modal(page).getByRole("button", { name: "Add 2 to project", exact: true }).click();
        await typeCode(page, "SKU-TOWEL");
        await more(page);
        await more(page);
        await modal(page).getByRole("button", { name: "Add 3 to project", exact: true }).click();
        // Down to the lines and totals, with Add item without a barcode still at the top
        await scrollToTop(page.getByRole("button", { name: "Add item without a barcode" }));
        await expect(line(page, "Paper towels")).toBeInViewport();
      },
      // 6. Back on the project, switched to Return
      async (page) => {
        await page.getByRole("button", { name: "Return", exact: true }).click();
        await expect(page.locator("#scanLabel")).toHaveText("Scan to return");
      },
      // 7. The return form, 1 of 2 coming back
      async (page) => {
        await typeCode(page, "012345678905");
        await modal(page).locator("#fRet").fill("1");
        await expect(modal(page)).toContainText("Used 1");
      },
      // 8. The project after the return, before Finished Return
      async (page) => {
        await modal(page).getByRole("button", { name: "Save return", exact: true }).click();
        await expect(page.locator(".totals")).toContainText("Returned1");
      },
    ],
  },

  "quick-take": {
    app: "demo",
    steps: [
      // 1. The project list
      async () => {},
      // 2. The Quick take form
      async (page) => {
        await page.getByRole("button", { name: "Quick take", exact: true }).click();
      },
      // 3. A scanned item, 2 chosen
      async (page) => {
        await typeCode(modal(page), "SKU-TOWEL");
        await more(page);
        await expect(modal(page).locator("#fQty")).toHaveValue("2");
      },
      // 4. The project list with General Use at the top
      async (page) => {
        await modal(page).getByRole("button", { name: "Take 2", exact: true }).click();
        await expect(project(page, "General Use (no job)")).toContainText("2 items out");
      },
      // 5. The towels' line on General Use, with Move to a project
      async (page) => {
        await project(page, "General Use (no job)").click();
        await line(page, "Paper towels").click();
        await modal(page).getByRole("button", { name: "Move", exact: true }).scrollIntoViewIfNeeded();
      },
      // 6. General Use, back from the line
      async (page) => {
        await modal(page).getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(modal(page)).toBeHidden();
      },
    ],
  },

  equipment: {
    app: "demo",
    steps: [
      // 1. Inventory
      async (page) => {
        await page.locator("#tab-prices").click();
      },
      // 2. The new item form, as company equipment
      async (page) => {
        await page.getByRole("button", { name: "+ Add item", exact: true }).click();
        await modal(page).getByLabel("Company equipment (reused, not charged)").check();
        await modal(page).getByPlaceholder("Type, scan, or leave blank").fill("LAD-6");
        await modal(page).getByLabel("Item name").fill("Step ladder, 6 ft");
        await modal(page).getByLabel("Value each ($)").fill("120");
        await scrollToTop(modal(page).getByText("What is it?"));
      },
      // 3. Checking the ladder out on Acme Offices
      async (page) => {
        await modal(page).getByRole("button", { name: "Save", exact: true }).click();
        await page.locator("#tab-projects").click();
        await project(page, "Acme Offices").click();
        await typeCode(page, "LAD-6");
        await expect(modal(page)).toContainText("Company equipment · not charged");
      },
      // 4. The project's equipment, apart from the supplies
      async (page) => {
        await modal(page).getByRole("button", { name: "Add 1 to project", exact: true }).click();
        await scrollToTop(page.locator(".totals"));
      },
      // 5. Finished Return asks where the ladder is
      async (page) => {
        await page.getByRole("button", { name: "Finished Return", exact: true }).click();
        await expect(modal(page).getByRole("heading", { name: "Before you finish" })).toBeVisible();
      },
      // 6. Lost or broken, with a charge
      async (page) => {
        await more(page, "fLost0");
        await modal(page).getByLabel(/^Charge the client/).fill("120");
      },
      // 7. Inventory's equipment that's out on jobs (the dialog left without saving, so it's still out)
      async (page) => {
        await modal(page).getByRole("button", { name: "Cancel", exact: true }).click();
        await page.locator("#tab-prices").click();
        await page.getByRole("button", { name: "Equipment", exact: true }).click();
        await page.getByRole("button", { name: "Out on jobs", exact: true }).click();
        await expect(page.locator("#main tbody tr", { hasText: "Step ladder" })).toContainText("Acme Offices");
      },
    ],
  },

  receipts: {
    app: "demo",
    steps: [
      // 1. The project list
      async () => {},
      // 2. Reading the receipt
      async (page) => {
        await page.setInputFiles("#receiptFile", tiny);
        await expect(page.getByText("Reading receipt…")).toBeVisible();
      },
      // 3. The review, with the client for this trip
      async (page) => {
        await expect(page.locator(".rline")).toHaveCount(3);
        // The option's label carries the project's start date, which moves with the day the test runs
        const label = await page.getByRole("combobox", { name: "Project for client 1" }).locator("option", { hasText: "Acme Offices" }).textContent();
        await page.getByRole("combobox", { name: "Project for client 1" }).selectOption({ label });
        await scrollToTop(page.getByText("Clients on this trip", { exact: false }).first());
      },
      // 4. The first line: the suggested match and the price
      async (page) => {
        await scrollToTop(page.locator(".rline").first());
      },
      // 5. The first line's price and where it goes
      async (page) => {
        await scrollToTop(page.locator(".rline").first().getByText("Price changed"));
      },
      // 6. The summary and Save
      async (page) => {
        await scrollToTop(page.getByText("Summary", { exact: true }));
      },
    ],
  },

  "inventory-and-import": {
    app: "web",
    backend: () => new FakeBackend({ docs: demoDocs(), members: { [TEAM.id]: [OWNER, SAM] } }),
    steps: [
      // 1. Inventory
      async (page) => {
        await page.locator("#tab-prices").click();
      },
      // 2. The new item form: barcode and name
      async (page) => {
        await page.getByRole("button", { name: "+ Add item", exact: true }).click();
        await modal(page).getByPlaceholder("Type, scan, or leave blank").fill("0789");
        await modal(page).getByLabel("Item name").fill("Glass cleaner, 32 oz");
      },
      // 3. ...its price and how many are in storage
      async (page) => {
        await modal(page).getByLabel("Price each ($)").fill("6.50");
        await modal(page).getByLabel("Single items in storage now").fill("12");
      },
      // 4. Its row in Inventory
      async (page) => {
        await modal(page).getByRole("button", { name: "Save", exact: true }).click();
        await expect(page.locator("#main tbody tr", { hasText: "Glass cleaner" })).toBeVisible();
      },
      // 5. Running low
      async (page) => {
        await page.getByRole("button", { name: /^Running low/ }).click();
      },
      // 6. Import CSV, in the bar under the header
      async (page) => {
        await page.getByRole("button", { name: "All", exact: true }).click();
      },
      // 7. Import CSV's form
      async (page) => {
        await page.locator(".teambar").getByRole("button", { name: "Import CSV" }).click();
        await expect(modal(page).getByRole("heading", { name: "Import inventory" })).toBeVisible();
      },
      // 8. The file's preview
      async (page, { backend }) => {
        backend.on("POST", `/teams/${TEAM.id}/imports`, { status: 200, body: IMPORT_PREVIEW });
        await modal(page).getByLabel("CSV file").setInputFiles({ name: "inventory.csv", mimeType: "text/csv", buffer: Buffer.from(IMPORT_CSV) });
        await expect(page.locator("#importResult")).toContainText("2 rows");
      },
    ],
  },

  "team-and-roles": {
    app: "web",
    backend: () => new FakeBackend({ docs: demoDocs(), members: { [TEAM.id]: [OWNER, SAM] } }),
    steps: [
      // 1. The bar under the header, with Members
      async () => {},
      // 2. Members: the invite form, filled in
      async (page) => {
        await page.locator(".teambar").getByRole("button", { name: "Members" }).click();
        await expect(modal(page).getByRole("heading", { name: "Invite someone" })).toBeVisible();
        await modal(page).getByLabel("Email").fill("jordan@example.com");
        await modal(page).getByLabel("Role", { exact: true }).selectOption("contributor");
        await scrollToTop(modal(page).getByRole("heading", { name: "Invite someone" }));
      },
      // 3. The invite, sent and waiting
      async (page) => {
        await modal(page).getByRole("button", { name: "Send invite" }).click();
        await expect(modal(page).locator(".invite, .member", { hasText: "jordan@example.com" }).first()).toBeVisible();
        await scrollToTop(modal(page).locator(".invite, .member", { hasText: "jordan@example.com" }).first());
      },
      // 4. The members and their roles
      async (page) => {
        await scrollToTop(modal(page).getByRole("heading", { name: "Members" }));
      },
      // 5. The crew member's side: the invite link opens the app, signed in, to join
      async (page, { newPage }) => {
        const backend = new FakeBackend({ teams: [], user: { id: "u-jordan", email: "jordan@example.com", emailVerified: true }, invites: [{ id: "i1", teamName: TEAM.name, role: "contributor", expiresAt: "2026-12-31T12:00:00.000Z" }], docs: Object.fromEntries(Object.entries(demoDocs()).map(([k, v]) => [k.replace(`${TEAM.id}/`, "t-i1/"), v])) });
        return newPage(backend, {
          storage: { session: { "supplyCheckout.invite": JSON.stringify({ id: "i1", token: "tok" }) } },
          ready: (theirs) => expect(theirs.getByRole("heading", { name: `Join ${TEAM.name}` })).toBeVisible(),
        });
      },
    ],
  },
};
