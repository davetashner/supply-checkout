// The journeys in docs/journeys.md, J0 to J11, as scripts for record.mjs. Each follows the
// journey's steps as written, against the web build and the test suite's fakes: the fake
// API in tests/fake-aws.js (as the tests use it), or for J5 the claude.ai runtime stand-in in
// tests/mock-claude.js. Where a step hands off to an outside service (Managed Login, Stripe,
// email) the video shows it up to the handoff and says it's simulated; where a step isn't
// built yet, the caption says so instead of showing anything made up.
import { readFile } from "node:fs/promises";
import { FakeBackend, TEAM, USER, ORIGIN, openAws, connected, emit } from "../../tests/fake-aws.js";
import { installMockClaude } from "../../tests/mock-claude.js";
import { usedState, fakeImage } from "../../tests/fixtures.js";
import { builtFiles } from "../builds.mjs";

const bar = (page) => page.locator(".teambar");
const modal = (page) => page.locator("#modal");
const card = (page, name) => page.getByRole("button", { name: new RegExp(name) });
const line = (page, name) => page.locator("#sheetBody tbody tr", { hasText: name });
const itemRow = (page, name) => page.locator("#main tbody tr", { hasText: name });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// A cleaning company's team, part way through a normal week
const SAM = { id: "u-sam", email: "sam@example.com", emailVerified: true };
const SAM_CLAIMS = { given_name: "Sam", family_name: "Rivera", email: SAM.email };
const TOWELS = "036000291452", GLOVES = "075020036541", CLEANER = "041167066218";
const PRODUCTS = {
  [`products/${TOWELS}`]: { code: TOWELS, name: "Paper towels, 6 roll", price: 8.5, stock: 10 },
  [`products/${GLOVES}`]: { code: GLOVES, name: "Nitrile gloves, box of 100", price: 12.5, stock: 8 },
  [`products/${CLEANER}`]: { code: CLEANER, name: "Glass cleaner, 32 oz", price: 4.25, stock: 12 },
  "products/nb-bins": { code: "", name: "Storage bins, 12 qt", price: 5, stock: 6 },
  "products/nb-mop": { code: "", name: "Mop heads", price: 3, stock: 14 },
};
const SHEETS = {
  "sheets/s1": {
    client: "Echo Studio", date: "2026-09-28", createdBy: SAM.id, createdByName: "Sam Rivera", createdAt: "2026-09-28T12:00:00Z", status: "open",
    items: {
      [TOWELS]: { code: TOWELS, name: "Paper towels, 6 roll", price: 8.5, out: 3, returned: 1 },
      "nb-bins": { code: "", name: "Storage bins, 12 qt", price: 5, out: 2, returned: 0 },
    },
  },
  "sheets/s2": {
    client: "Harbor Dental", date: "2026-09-25", createdBy: SAM.id, createdByName: "Sam Rivera", createdAt: "2026-09-25T12:00:00Z", status: "closed", closedAt: "2026-09-25T21:00:00Z",
    items: {
      [GLOVES]: { code: GLOVES, name: "Nitrile gloves, box of 100", price: 12.5, out: 2, returned: 1 },
      [CLEANER]: { code: CLEANER, name: "Glass cleaner, 32 oz", price: 4.25, out: 3, returned: 1 },
      "nb-mop": { code: "", name: "Mop heads", price: 3, out: 4, returned: 0 },
    },
  },
};
const teamDocs = (team = "t1", docs = { ...PRODUCTS, ...SHEETS }) => Object.fromEntries(Object.entries(docs).map(([k, v]) => [`${team}/${k}`, v]));
const JOINED = "2026-09-01T00:00:00.000Z";
const ME = { userId: USER.id, email: USER.email, role: "owner", joinedAt: JOINED };
const SAM_MEMBER = { userId: SAM.id, email: SAM.email, role: "contributor", joinedAt: JOINED };
const PAYING = { status: "active", plan: "starter", billingAccount: true, cancelsAt: null, subscriptionEnded: false };
const ENDED = { status: "canceled", plan: "starter", subscriptionEnded: true };
const STRIPE_CHECKOUT = "https://checkout.stripe.test/c/pay/cs_test_journey";
const STRIPE_PORTAL = "https://billing.stripe.test/p/session/bps_test_journey";

// Opens the web build signed in (or not) against a fake API. Stripe's pages answer 204, so
// following a link there leaves the page where it is, as Managed Login's do (openAws).
async function openTeam(d, backendOptions = {}, openOptions = {}) {
  const backend = new FakeBackend({ docs: teamDocs(), ...backendOptions });
  await d.page.route(/^https:\/\/[^/]*stripe\.test\//, (route) => route.fulfill({ status: 204 }));
  await openAws(d.page, backend, openOptions);
  await d.ready();
  return backend;
}

// Loads the app again, as a redirect back from Managed Login or Stripe, or a reload, does.
// The fake API answers only the first load with the page unless it's told to start again.
async function reload(d, backend, path = "/") {
  backend.pageLoads = 0;
  await d.page.goto(ORIGIN + path);
  await d.ready();
}

// Something the app does that reloads the page (switching teams, Continue)
async function reloadsAfter(d, backend, action) {
  backend.pageLoads = 0;
  const loaded = d.page.waitForEvent("load");
  await action();
  await loaded;
  await d.ready();
}

// A download the app starts, and its text
async function download(d, locator) {
  const started = d.page.waitForEvent("download");
  await d.click(locator);
  const file = await started;
  return { name: file.suggestedFilename(), text: await readFile(await file.path(), "utf8") };
}

async function showFile(d, { name, text }, note, lines = 12) {
  const shown = text.split("\n").slice(0, lines).join("\n");
  await d.card(`<div class="jv-meta">Downloaded: ${esc(name)}</div>
    <pre style="margin:0;font:15px/1.5 ui-monospace,Menlo,monospace;background:#04121f;border-radius:12px;padding:18px;white-space:pre-wrap;overflow:hidden;max-height:60vh">${esc(shown)}</pre>
    <div class="jv-small">${esc(note)}</div>`, 7000);
  await d.hideCard();
}

// Follows a Stripe link the app made, up to the handoff
async function followToStripe(d, name, what) {
  await d.click(bar(d.page).getByRole("link", { name }));
  await d.simulated(what);
}

export const JOURNEYS = [
  {
    id: "J0",
    slug: "sign-in",
    title: "Sign in",
    persona: "Everyone",
    critical: true,
    status: "Built; Managed Login is Cognito's",
    shown: ["The signed-out screen and its Sign in link", "Coming back from Managed Login with a one-time code, and the team's sheets", "Picking between two teams", "Opening the app again, still signed in"],
    simulated: ["Cognito Managed Login (email code, passkey, Apple, Google)"],
    async run(d) {
      const { page } = d;
      const teams = [TEAM, { ...TEAM, id: "t2", name: "Bravo Co", role: "contributor" }];
      const docs = { ...teamDocs("t1"), "t2/sheets/b1": { client: "Bravo Co warehouse", date: "2026-09-27", createdByName: "Kim Lee", status: "open", items: {} } };
      const backend = await openTeam(d, { signedIn: false, teams, docs });
      await d.say("Open the app on a phone or laptop. Signed out, it asks you to sign in.");
      const signIn = page.getByRole("link", { name: "Sign in" });
      await d.moveTo(signIn);
      await d.say("Sign in takes you to the sign-in page, Amazon Cognito's Managed Login.");
      await d.click(signIn);
      await d.simulated("Managed Login opens here: an email code, a passkey, Apple or Google. It's simulated in this recording.");
      const { state } = await page.evaluate(() => JSON.parse(sessionStorage.getItem("supplyCheckout.signIn")));
      await d.simulated("Once you're signed in, Managed Login sends you back to the app with a one-time code.");
      await reload(d, backend, `/?code=good-code&state=${state}`);
      await connected(page);
      await d.check("The app swaps the code for a session and the team's sheets appear (expected within 3 seconds).");
      await d.moveTo(card(page, "Echo Studio"));
      await d.pause(800);
      const pick = page.getByLabel("Team");
      await d.moveTo(pick);
      await d.say("This person is in two teams, so the team bar has a team picker.");
      await reloadsAfter(d, backend, () => d.select(pick, "t2"));
      await connected(page);
      await d.check("Bravo Co's sheets, not Echo Cleaning's. The app remembers the team for next time.");
      await d.moveTo(card(page, "Bravo Co warehouse"));
      await d.say("Close the app and open it again later on the same device…");
      await reload(d, backend);
      await connected(page);
      await d.check("Still signed in, straight into the team last used, with no sign-in page.");
    },
  },
  {
    id: "J1",
    slug: "sign-up-and-start-a-trial",
    title: "Sign up and start a trial",
    persona: "Owner",
    critical: true,
    status: "Partly built",
    shown: ["Signing in for the first time", "Naming the team", "The new, empty team with its Get your team started checklist"],
    simulated: ["Cognito Managed Login's sign-up"],
    planned: ["The supplycheckout.com landing page, pricing page and Start free trial (supply-checkout-21q)", "Accepting the terms at sign-up (the terms are still being written)"],
    async run(d) {
      const { page } = d;
      await d.note("Step 1, the supplycheckout.com landing and pricing pages with Start free trial, isn't built yet (supply-checkout-21q).");
      const backend = await openTeam(d, { signedIn: false, teams: [], docs: {} });
      await d.say("So this starts in the app itself, signed out.");
      await d.click(page.getByRole("link", { name: "Sign in" }));
      await d.simulated("Managed Login opens here, where a new owner signs up with their email, a passkey, Apple or Google. Simulated.");
      await d.planned("Accepting the terms at sign-up isn't built yet: the terms of service are still being written.");
      const { state } = await page.evaluate(() => JSON.parse(sessionStorage.getItem("supplyCheckout.signIn")));
      await reload(d, backend, `/?code=good-code&state=${state}`);
      await d.say("Signed in for the first time, with no team yet: name the team.");
      await d.type(page.getByLabel("Team name"), "Northside Cleaning");
      await d.click(page.getByRole("button", { name: "Create team" }));
      await connected(page);
      await d.check("An empty team, ready to use, owned by the person who made it.");
      const list = page.locator("#firstRun");
      await d.moveTo(list.getByRole("heading", { name: "Get your team started" }));
      await d.say("A short checklist gets the team going: add supplies, invite the crew, create a first sheet.");
      await d.moveTo(list.getByRole("button", { name: "Import a CSV file" }));
      await d.say("Supplies can be added by hand or imported from a spreadsheet. Journeys J2 and J3 carry on from here.");
      await d.say("The server starts the new team on a 14-day trial with no card needed. The app doesn't show the trial's end date.");
    },
  },
  {
    id: "J2",
    slug: "set-up-the-inventory",
    title: "Set up the inventory",
    persona: "Owner",
    critical: false,
    status: "Built",
    shown: ["Adding an item with a barcode, price and storage count", "Adding an item with no barcode", "Editing an item", "Importing a CSV file, with its template and preview"],
    simulated: ["The phone camera (barcodes are typed)", "The server checking and saving the import"],
    async run(d) {
      const { page } = d;
      const docs = teamDocs("t1", { [`products/${TOWELS}`]: PRODUCTS[`products/${TOWELS}`], "products/nb-bins": PRODUCTS["products/nb-bins"] });
      const backend = await openTeam(d, { docs });
      await connected(page);
      await d.say("The owner opens Inventory, then + Add item.");
      await d.click(page.getByRole("button", { name: "Inventory" }));
      await d.click(page.getByRole("button", { name: "+ Add item" }));
      await d.say("Scan the barcode with the phone camera (Scan), or type it. Here it's typed.");
      await d.type(modal(page).getByPlaceholder("Type, scan, or leave blank"), GLOVES);
      await d.type(modal(page).getByLabel("Item name"), "Nitrile gloves, box of 100");
      await d.type(modal(page).getByLabel("Price each ($)"), "12.50");
      await d.type(modal(page).getByLabel("In storage now"), "8");
      await d.click(modal(page).getByRole("button", { name: "Save" }));
      await d.moveTo(itemRow(page, "Nitrile gloves"));
      await d.check("The item is listed with its barcode, 8 in storage, and their value.");
      await d.say("An item with no barcode: leave the barcode blank.");
      await d.click(page.getByRole("button", { name: "+ Add item" }));
      await d.type(modal(page).getByLabel("Item name"), "Microfiber cloths, 12 pack");
      await d.type(modal(page).getByLabel("Price each ($)"), "9");
      await d.type(modal(page).getByLabel("In storage now"), "5");
      await d.click(modal(page).getByRole("button", { name: "Save" }));
      await d.moveTo(page.locator("#main tfoot"));
      await d.check("Totals update: items in storage and what they're worth. Items without a barcode are found by name when checking out.");
      await d.say("To edit or delete an item later, tap its row.");
      await d.click(itemRow(page, "Microfiber cloths"));
      await d.type(modal(page).getByLabel("In storage now"), "7");
      await d.click(modal(page).getByRole("button", { name: "Save" }));

      await d.say("A whole inventory can come from a spreadsheet instead: Import CSV in the team bar.");
      await d.click(bar(page).getByRole("button", { name: "Import CSV" }));
      await download(d, modal(page).getByRole("button", { name: "Download a template" }));
      await d.say("Download a template to fill in, then choose the filled-in file.");
      const csv = "name,barcode,price,stock\nGlass cleaner 32 oz,041167066218,4.25,12\nMop heads,,3,14\nNitrile gloves box of 100,075020036541,13,10\n";
      backend.on("POST", "/teams/t1/imports", {
        status: 200,
        body: {
          status: "preview",
          rows: [
            { line: 2, name: "Glass cleaner 32 oz", barcode: CLEANER, price: 4.25, stock: 12, key: CLEANER, action: "create", changes: ["name", "price", "stock"] },
            { line: 3, name: "Mop heads", barcode: "", price: 3, stock: 14, key: "nb-mop", action: "create", changes: ["name", "price", "stock"] },
            { line: 4, name: "Nitrile gloves, box of 100", barcode: GLOVES, price: 13, stock: 10, key: GLOVES, action: "update", changes: ["price", "stock"] },
          ],
          errors: [], errorCount: 0, ignoredColumns: [], summary: { rows: 3, created: 2, updated: 1, unchanged: 0 },
        },
      });
      await d.chooseFile(modal(page).getByLabel("CSV file"), { name: "inventory.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
      await d.moveTo(page.locator("#importResult"));
      await d.check("A preview first: what's new, what changes, and any problems, before anything is saved.");
      backend.on("POST", "/teams/t1/imports", { status: 200, body: { status: "imported", importId: "imp-1", replayed: false, summary: { rows: 3, created: 2, updated: 1, unchanged: 0 } } });
      await d.click(modal(page).getByRole("button", { name: "Import", exact: true }));
      await d.simulated("The server checks the file and saves every row or none (the test backend stands in for it here).");
      backend.write("t1", "products", CLEANER, PRODUCTS[`products/${CLEANER}`]);
      backend.write("t1", "products", "nb-mop", PRODUCTS["products/nb-mop"]);
      const gloves = backend.doc("t1", "products", GLOVES);
      backend.write("t1", "products", GLOVES, { ...gloves.data, price: 13, stock: 10 });
      await emit(page, { v: 2, eventId: "imp-1", collection: "products", op: "list", changes: 3, at: Date.now() });
      await d.moveTo(itemRow(page, "Mop heads"));
      await d.check("The imported items are in the inventory, with their storage counts.");
    },
  },
  {
    id: "J3",
    slug: "invite-the-crew",
    title: "Invite the crew",
    persona: "Owner, then a crew member",
    critical: false,
    status: "Built; seat count is Stripe's",
    shown: ["The owner inviting a crew member as a contributor from Members", "The invite pending, with when it expires", "The crew member opening the link, signing in and joining", "The team's sheets right away"],
    simulated: ["The invite email", "Cognito Managed Login", "The seat count on the Stripe subscription"],
    async run(d) {
      const { page } = d;
      const backend = await openTeam(d, { members: { t1: [ME] }, teamInvites: { t1: [] } });
      await connected(page);
      await d.say("The owner opens Members from the team bar.");
      await d.click(bar(page).getByRole("button", { name: "Members" }));
      await d.say("Enter the crew member's email and pick Contributor: they can scan, check out, return and edit.");
      await d.type(modal(page).getByLabel("Email"), SAM.email);
      await d.select(modal(page).getByLabel("Role", { exact: true }), "contributor");
      await d.click(modal(page).getByRole("button", { name: "Send invite" }));
      await d.moveTo(modal(page).locator(".invite-row", { hasText: SAM.email }));
      await d.check("The invite is pending. Its link works once and expires after 7 days; it can be resent or revoked.");
      await d.simulated("The server emails Sam the invite link (no email is sent in this recording).");
      const invite = backend.teamInvites.t1[0];
      await d.click(modal(page).getByRole("button", { name: "Close", exact: true }));

      await d.say("Now Sam, on their phone, taps the link in the email.");
      await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
      await page.unrouteAll({ behavior: "ignoreErrors" });
      const crew = await openTeam(d, {
        signedIn: false, teams: [], user: SAM, claims: SAM_CLAIMS,
        invites: [{ id: invite.id, teamName: TEAM.name, role: "contributor", expiresAt: invite.expiresAt }],
        docs: teamDocs(`t-${invite.id}`),
      }, { path: `/?invite=${invite.id}&token=tok` });
      await d.check("The app keeps the invite and asks Sam to sign in with the address it was sent to.");
      await d.click(page.getByRole("link", { name: "Sign in" }));
      await d.simulated("Managed Login: Sam signs up or signs in. Simulated.");
      const { state } = await page.evaluate(() => JSON.parse(sessionStorage.getItem("supplyCheckout.signIn")));
      await reload(d, crew, `/?code=good-code&state=${state}`);
      await d.say(`Back in the app, the invite to ${TEAM.name} is waiting.`);
      await d.click(page.getByRole("button", { name: "Join" }));
      await connected(page);
      await d.check("Sam is in the team and sees its sheets right away.");
      await d.moveTo(card(page, "Echo Studio"));
      await d.simulated("Adding a contributor adds a seat to the team's Stripe subscription within a minute (server side, not shown).");
    },
  },
  {
    id: "J4",
    slug: "check-supplies-out-and-back-in",
    title: "Check supplies out and back in",
    persona: "Crew member",
    critical: true,
    status: "Built",
    shown: ["Creating a sheet for a client and date", "Checking out an item by barcode, and one without a barcode", "Another person's change arriving live", "Returning what came back and finishing the return", "Storage counts going down and back up"],
    simulated: ["The phone camera (barcodes are typed)", "Another crew member's phone (a live update from the test backend)"],
    async run(d) {
      const { page } = d;
      const backend = await openTeam(d, { teams: [{ ...TEAM, role: "contributor" }], user: SAM, claims: SAM_CLAIMS });
      await connected(page);
      await d.say("Early morning: Sam opens the app and creates a sheet for today's client.");
      await d.click(page.getByRole("button", { name: "+ New sheet" }));
      await d.type(page.getByLabel("Client", { exact: true }), "Pine Street Offices");
      await d.click(page.getByRole("button", { name: "Create sheet" }));
      await d.check("The sheet records the client, the date and who prepared it.");
      const code = page.getByPlaceholder("Or type the barcode");
      await d.say("Scan each item's barcode with the phone camera, or type the number. Here it's typed.");
      await d.type(code, TOWELS, { enter: true });
      await d.check("The item is found in inventory, with how many are in storage. Choose how many.");
      await d.type(modal(page).locator("#fQty"), "3");
      await d.click(modal(page).getByRole("button", { name: "Add 3 to sheet" }));
      await d.click(page.getByRole("button", { name: "Add item without a barcode" }));
      await d.show("An item with no barcode: pick it from the inventory by name.");
      await d.type(modal(page).getByLabel("Or pick from inventory"), "mop");
      await d.click(modal(page).locator("#pick").getByRole("button", { name: /Mop heads/ }));
      await d.type(modal(page).locator("#fQty"), "4");
      await d.click(modal(page).getByRole("button", { name: "Add 4 to sheet" }));
      await d.check("Both lines are on the sheet, each saved only once the server confirmed it.");

      await d.simulated("Meanwhile, another crew member adds gloves to this sheet on their own phone.");
      const [key, sheet] = [...backend.docs].find(([k, v]) => k.startsWith("t1/sheets/") && v.data.client === "Pine Street Offices");
      const id = key.split("/").pop();
      const items = { ...sheet.data.items, [GLOVES]: { code: GLOVES, name: "Nitrile gloves, box of 100", price: 12.5, out: 2, returned: 0 } };
      const version = backend.write("t1", "sheets", id, { ...sheet.data, items });
      await emit(page, { v: 1, eventId: "live-1", collection: "sheets", id, op: "put", version, at: Date.now() });
      await d.moveTo(line(page, "Nitrile gloves"));
      await d.check("Their change shows here within 2 seconds, without a reload.");

      await d.say("Back from the job: switch to Return and scan what came back unused.");
      await d.click(page.getByRole("button", { name: "Return", exact: true }));
      await d.type(code, TOWELS, { enter: true });
      await d.type(modal(page).locator("#fRet"), "1");
      await d.click(modal(page).getByRole("button", { name: "Save return" }));
      await d.moveTo(page.locator(".totals"));
      await d.check("The sheet shows taken, returned, used, and the charge for what was used.");
      await d.click(page.getByRole("button", { name: "Finished Return" }));
      await d.moveTo(page.locator(".sheet-head .pill"));
      await d.show("The sheet is marked Returned.", "check");
      await d.pause(1500);
      await d.click(page.getByRole("button", { name: "Inventory" }));
      await d.moveTo(itemRow(page, "Paper towels"));
      await d.check("Storage counts follow: paper towels went from 10 to 7 on checkout, and back up to 8 on return.");
    },
  },
  {
    id: "J5",
    slug: "read-a-receipt",
    title: "Read a receipt",
    persona: "Crew member or owner",
    critical: false,
    status: "Built on claude.ai; AWS version planned",
    shown: ["Scan receipt and the review of each line", "A suggested inventory match and the price choice", "Splitting lines between a client's sheet and general inventory", "The sheet and storage counts after Save"],
    simulated: ["The receipt photo and its reading (canned by the claude.ai runtime stand-in the tests use)"],
    planned: ["Receipt reading in the AWS web app, on Bedrock (supply-checkout-kx8)"],
    async run(d) {
      const { page } = d;
      await d.note("Receipt reading on AWS (Bedrock) isn't built yet (supply-checkout-kx8), so the web app hides Scan receipt for now.");
      await d.note("This shows the claude.ai version, with the tests' stand-in for claude.ai and a canned reading of the receipt.", "simulated");
      const files = builtFiles("web");
      const receipt = { ...usedState.receipt, items: usedState.receipt.items.map((it, i) => (i === 0 ? { ...it, match: "i2" } : it)) };
      await page.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.abort());
      await page.route(ORIGIN + "/**", (route) => {
        const file = files.get(new URL(route.request().url()).pathname);
        return file ? route.fulfill(file) : route.fulfill({ status: 404 });
      });
      await page.addInitScript(installMockClaude, { seed: usedState.seed, receipt, userName: "Sam Rivera" });
      await page.goto(ORIGIN + "/");
      await d.ready();
      await page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });
      await d.say("After buying supplies, tap Scan receipt and photograph the receipt.");
      await d.chooseFile(page.locator("label", { hasText: "Scan receipt" }), fakeImage);
      await page.getByRole("heading", { name: "Review receipt" }).waitFor();
      await d.simulated("The photo is read (canned here). Nothing is saved until Save.");
      const bins = page.locator(".rline").nth(0);
      await d.moveTo(bins.getByText("Suggested match"));
      await d.say("Check each line: name, quantity, price, and the suggested inventory match.");
      await d.moveTo(bins.getByText("Price changed"));
      await d.say("The receipt price differs from the item's: charge the receipt price, or keep the client price.");
      await d.click(bins.getByRole("button", { name: /Keep the client price/ }));
      await d.say("Assign each line: these bins go to storage, as General inventory.");
      await d.select(bins.locator('select[data-f="dest"]'), { label: "General inventory (storage)" });
      await d.say("The painter's tape is for a client: a new sheet for Delta Inc.");
      await d.type(page.getByLabel("Client name"), "Delta Inc");
      await d.click(page.getByRole("button", { name: "Save", exact: true }));
      await d.moveTo(line(page, "Painter's tape"));
      await d.check("Delta Inc's sheet has the tape at the receipt's price.");
      await d.click(page.getByRole("button", { name: "Inventory" }));
      await d.moveTo(itemRow(page, "Storage bins"));
      await d.check("Storage bins went up by 4, from 2 to 6.");
    },
  },
  {
    id: "J6",
    slug: "export-a-sheet-to-bill-a-client",
    title: "Export a sheet to bill a client",
    persona: "Owner or bookkeeper",
    critical: false,
    status: "Built",
    shown: ["Opening a finished sheet and downloading its CSV", "What the CSV holds", "Export data: every sheet, the inventory, or everything"],
    async run(d) {
      const { page } = d;
      await openTeam(d);
      await connected(page);
      await d.say("Open a finished sheet: the Returned list has them.");
      await d.click(page.getByRole("button", { name: "Returned", exact: true }));
      await d.click(card(page, "Harbor Dental"));
      await d.say("Tap Download CSV.");
      const file = await download(d, page.getByRole("button", { name: "Download CSV" }));
      await showFile(d, file, "Named after the client and date, with each item's price, taken, returned, used and charge, and a total.");
      await d.check(`Downloaded as “${file.name}”.`);
      await d.click(page.getByRole("button", { name: "← All sheets" }));
      await d.say("Owners can also export all of the team's data: Export data.");
      await d.click(page.getByRole("button", { name: "Export data" }));
      await d.moveTo(modal(page).getByRole("button", { name: "Sheets (CSV)" }));
      await d.say("Every sheet as CSV (one row per item), the inventory as CSV, or everything as JSON.");
      const all = await download(d, modal(page).getByRole("button", { name: "Sheets (CSV)" }));
      await showFile(d, all, "Every sheet, one row per item, ready for a spreadsheet.", 8);
      await d.click(modal(page).getByRole("button", { name: "Close" }));
    },
  },
  {
    id: "J7",
    slug: "subscribe-add-seats-and-see-invoices",
    title: "Subscribe, add seats and see invoices",
    persona: "Owner",
    critical: true,
    status: "Partly built",
    shown: ["A team whose trial ended, read-only, with Subscribe", "Starting Stripe Checkout, with no seat count to pick", "The team active again after paying", "Inviting another person (a seat)", "Invoices from Stripe, and Billing to the Customer Portal"],
    simulated: ["Stripe Checkout and the Customer Portal", "Stripe's webhook making the team active", "Seat changes on the Stripe subscription"],
    planned: ["Choosing a plan in the app during the trial (supply-checkout-8jc.5)"],
    async run(d) {
      const { page } = d;
      const backend = await openTeam(d, { members: { t1: [ME, SAM_MEMBER] }, teamInvites: { t1: [] } });
      await connected(page);
      await d.planned("On the free trial, choosing a plan in the app isn't built yet (supply-checkout-8jc.5). Today an owner subscribes when the trial ends.");
      backend.teams[0] = { ...TEAM, ...ENDED };
      await reload(d, backend);
      await connected(page);
      await d.moveTo(bar(page).locator(".closed-note"));
      await d.check("Once the trial ends without a card, the team is read-only, nothing is deleted, and the owner can subscribe.");
      backend.on("POST", "/teams/t1/billing/checkout", { status: 201, body: { checkout: { url: STRIPE_CHECKOUT, expiresAt: "2026-09-30T12:00:00.000Z", trialEndsAt: null } } });
      await d.click(bar(page).getByRole("button", { name: "Subscribe" }));
      await d.check("No seat count to pick: the subscription covers the team's owners and contributors. Viewers are free.");
      await followToStripe(d, "Continue to checkout", "Stripe Checkout opens here: card, Apple Pay or Google Pay. Simulated in this recording.");
      backend.teams[0] = { ...TEAM, ...PAYING };
      await d.simulated("Stripe tells the server the payment went through; the team is active within a minute.");
      await reload(d, backend);
      await connected(page);
      await d.moveTo(page.getByRole("button", { name: "+ New sheet" }));
      await d.check("Active again: everything can be changed, and the team bar has Billing and Invoices.");

      await d.say("Later, the owner invites someone else from Members.");
      await d.click(bar(page).getByRole("button", { name: "Members" }));
      await d.type(modal(page).getByLabel("Email"), "lee@example.com");
      await d.click(modal(page).getByRole("button", { name: "Send invite" }));
      await d.simulated("Once they join, the server adds a seat to the Stripe subscription, with proration (not shown).");
      await d.click(modal(page).getByRole("button", { name: "Close", exact: true }));

      backend.on("GET", "/teams/t1/billing/invoices", {
        status: 200,
        body: {
          hasMore: false,
          invoices: [
            { id: "in_test_2", number: "ECHO-0002", status: "paid", createdAt: "2026-09-29T12:00:00.000Z", currency: "usd", total: 600, amountDue: 600, amountPaid: 600, hostedUrl: "https://invoice.stripe.test/i/2", pdfUrl: "https://pay.stripe.test/invoice/2/pdf" },
            { id: "in_test_1", number: "ECHO-0001", status: "paid", createdAt: "2026-08-29T12:00:00.000Z", currency: "usd", total: 600, amountDue: 600, amountPaid: 600, hostedUrl: "https://invoice.stripe.test/i/1", pdfUrl: "https://pay.stripe.test/invoice/1/pdf" },
          ],
        },
      });
      await d.click(bar(page).getByRole("button", { name: "Invoices" }));
      await d.moveTo(modal(page).locator(".invoice").first());
      await d.check("The latest invoices from Stripe, each with Stripe's page and a PDF. Stripe also emails them.");
      await d.click(modal(page).getByRole("button", { name: "Close" }));
      backend.on("POST", "/teams/t1/billing/portal", { status: 201, body: { portal: { url: STRIPE_PORTAL } } });
      await d.say("Billing opens Stripe's Customer Portal: card, monthly or annual, all invoices.");
      await d.click(bar(page).getByRole("button", { name: "Billing" }));
      await followToStripe(d, "Continue to billing", "The Stripe Customer Portal opens here. Simulated in this recording.");
    },
  },
  {
    id: "J8",
    slug: "a-payment-fails-and-is-fixed",
    title: "A payment fails and is fixed",
    persona: "Owner",
    critical: true,
    status: "Partly built",
    shown: ["Billing, to update the card in the Customer Portal", "The read-only team once the subscription has ended, with nothing deleted", "Full access back once payment succeeds"],
    simulated: ["The failed renewal, the payment-failed email and Stripe's webhooks", "The Stripe Customer Portal"],
    planned: ["A banner in the app when a payment fails, and the 7-day grace period before read-only (supply-checkout-qdx)"],
    async run(d) {
      const { page } = d;
      const backend = await openTeam(d, { teams: [{ ...TEAM, ...PAYING }] });
      await connected(page);
      await d.simulated("A renewal payment fails at Stripe. The server hears of it and emails the owner (no email is sent here).");
      await d.planned("The in-app banner for a failed payment and the 7-day grace period aren't built yet (supply-checkout-qdx).");
      await d.say("Meanwhile the team keeps working. The owner fixes the card from Billing.");
      backend.on("POST", "/teams/t1/billing/portal", { status: 201, body: { portal: { url: STRIPE_PORTAL } } });
      await d.click(bar(page).getByRole("button", { name: "Billing" }));
      await followToStripe(d, "Continue to billing", "The Stripe Customer Portal opens here, where the owner updates the card. Simulated.");
      await d.say("If the payment is never made, the subscription ends…");
      backend.teams[0] = { ...TEAM, ...ENDED, billingAccount: true };
      await reload(d, backend);
      await connected(page);
      await d.moveTo(bar(page).locator(".closed-note"));
      await d.check("…and the team becomes read-only. Nothing is deleted, and it can still be exported.");
      await d.moveTo(page.locator("#notice"));
      await d.pause(1500);
      backend.teams[0] = { ...TEAM, ...PAYING };
      await d.simulated("The owner pays (Subscribe or the Customer Portal). Stripe tells the server within a minute.");
      await reload(d, backend);
      await connected(page);
      await d.moveTo(page.getByRole("button", { name: "+ New sheet" }));
      await d.check("Full access is back.");
    },
  },
  {
    id: "J9",
    slug: "a-viewer-can-see-but-not-change",
    title: "A viewer can see but not change",
    persona: "Bookkeeper",
    critical: false,
    status: "Built",
    shown: ["The view-only notice", "Sheets and their lines, with no scan, edit or delete controls", "Inventory, with no add or edit"],
    async run(d) {
      const { page } = d;
      await openTeam(d, { teams: [{ ...TEAM, role: "viewer" }], user: { id: "u-bea", email: "bea@example.com", emailVerified: true }, claims: { given_name: "Bea", family_name: "Park", email: "bea@example.com" } });
      await connected(page);
      await d.say("Bea, the bookkeeper, signs in. She's a viewer on the team.");
      await d.moveTo(page.locator("#notice"));
      await d.check("Signed in as a viewer: everything is visible, with a view-only notice. No + New sheet.");
      await d.click(page.getByRole("button", { name: "All", exact: true }));
      await d.click(card(page, "Harbor Dental"));
      await d.check("The sheet shows every line and the charge, with no scan bar and no Edit details.");
      await d.click(line(page, "Glass cleaner"));
      await d.check("Tapping a line opens nothing to edit.");
      await d.click(page.getByRole("button", { name: "Inventory" }));
      await d.check("Inventory is visible too, with no + Add item.");
      await d.click(itemRow(page, "Paper towels"));
      await d.check("Tapping an item opens nothing to edit. The server refuses a viewer's writes too (checked in the API's tests).");
    },
  },
  {
    id: "J10",
    slug: "cancel-and-take-the-data",
    title: "Cancel and take the data",
    persona: "Owner",
    critical: false,
    status: "Partly built",
    shown: ["Billing to the Customer Portal to cancel", "The team bar saying when the subscription ends", "The read-only team after it ends, with Export data"],
    simulated: ["The Stripe Customer Portal and its webhook"],
    planned: ["Deleting a canceled team's data after its 30 read-only days (supply-checkout-qdx)"],
    async run(d) {
      const { page } = d;
      const backend = await openTeam(d, { teams: [{ ...TEAM, ...PAYING }] });
      await connected(page);
      await d.say("The owner opens Billing to cancel.");
      backend.on("POST", "/teams/t1/billing/portal", { status: 201, body: { portal: { url: STRIPE_PORTAL } } });
      await d.click(bar(page).getByRole("button", { name: "Billing" }));
      await followToStripe(d, "Continue to billing", "In the Stripe Customer Portal the owner cancels at the end of the period. Simulated.");
      backend.teams[0] = { ...TEAM, ...PAYING, cancelsAt: "2026-10-27T12:00:00.000Z" };
      await reload(d, backend);
      await connected(page);
      await d.moveTo(bar(page).locator("#cancelNote"));
      await d.check("The team bar says when it ends. Everything keeps working until then.");
      backend.teams[0] = { ...TEAM, ...ENDED, billingAccount: true };
      await d.say("After the end of the period…");
      await reload(d, backend);
      await connected(page);
      await d.moveTo(bar(page).locator(".closed-note"));
      await d.check("The team is read-only, with nothing deleted, and the owner can export it.");
      await d.click(page.getByRole("button", { name: "Export data" }));
      const everything = await download(d, modal(page).getByRole("button", { name: "Everything (JSON)" }));
      await showFile(d, everything, "Everything, as JSON: each sheet with its totals, and the inventory. Sheets and inventory also come as CSV.", 14);
      await d.click(modal(page).getByRole("button", { name: "Close" }));
      await d.planned("Deleting the data after 30 days read-only, as the privacy policy says, isn't built yet (supply-checkout-qdx).");
    },
  },
  {
    id: "J11",
    slug: "delete-an-account",
    title: "Delete an account",
    persona: "Anyone",
    critical: false,
    status: "Built",
    shown: ["Account, Delete account, typing DELETE", "The server's reason when the only owner of a team with others tries", "Closing the team by typing its name", "Deleting the account"],
    simulated: ["The hourly purge that deletes a closed team's data after 30 days (server side)"],
    async run(d) {
      const { page } = d;
      const backend = await openTeam(d, { members: { t1: [ME, SAM_MEMBER] }, teamInvites: { t1: [] } });
      await connected(page);
      await d.say("Open Account in the team bar.");
      await d.click(bar(page).getByRole("button", { name: "Account" }));
      await d.say("Type DELETE, then Delete account.");
      await d.type(modal(page).getByLabel("Type DELETE to confirm"), "DELETE");
      await d.click(modal(page).getByRole("button", { name: "Delete account" }));
      await d.moveTo(modal(page).locator("#deleteFail"));
      await d.check("Refused, with the server's reason: Pat is the only owner of a team Sam is still in.");
      await d.click(modal(page).getByRole("button", { name: "Cancel" }));
      await d.say("Pat could make Sam an owner, or close the team. Members → Close the team.");
      await d.click(bar(page).getByRole("button", { name: "Members" }));
      await d.type(modal(page).getByLabel(`Type the team's name, ${TEAM.name}, to close it`), TEAM.name);
      await d.click(modal(page).getByRole("button", { name: "Close team" }));
      await d.moveTo(page.locator("#account"));
      await d.check("Closed: the team is read-only now, and everything in it is deleted after 30 days.");
      await reloadsAfter(d, backend, () => d.click(page.getByRole("button", { name: "Continue" })));
      await connected(page);
      await d.say("Now Account → Delete account again.");
      await d.click(bar(page).getByRole("button", { name: "Account" }));
      await d.type(modal(page).getByLabel("Type DELETE to confirm"), "DELETE");
      await d.click(modal(page).getByRole("button", { name: "Delete account" }));
      await page.getByRole("heading", { name: "Your account is deleted" }).waitFor();
      await d.check("Done without contacting support: out of every team, invites and sign-in gone.");
    },
  },
];
