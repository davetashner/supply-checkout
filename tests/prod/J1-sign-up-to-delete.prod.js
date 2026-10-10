// J1, J3, J5 and J11 against prod, with the run's throwaway accounts (supply-checkout-o60.8;
// docs/journey-tests-plan.md, "Journey by journey"). Desktop only: one new owner and one new crew
// member a try, so a run signs up two accounts (four if the test is retried) and sends about
// eight emails a try, far under Cognito's and SES's limits.
//
// - J1.3: a throwaway owner signs up by email code (Cognito SignUp with no password, confirmed
//   with the code from the test mailbox), gets the welcome email, signs in through Managed Login
//   by email code, and names a team: a 14-day trial, and the "Get your team started" checklist.
// - J3: the owner invites a throwaway crew member as a contributor from Members; the crew member
//   reads the invite email, signs up, opens the link in a browser of their own, signs in and
//   joins; the owner's member list shows them.
// - J5: the owner scans a committed synthetic receipt (tests/prod/fixtures/receipt.jpg: a made-up
//   store, nobody's real purchase), one real read; the lines appear within 60 seconds, each with
//   a name, a quantity and a price (loose: the model's wording isn't asserted), and the owner
//   discards the review, so nothing is saved (J5.3 is left to the local and backend suites).
// - J11: the owner can't delete their account while the crew member is in the team (the server's
//   message names it); the crew member deletes theirs; the owner closes the team, typing its
//   name, and deletes theirs. GET /me then answers 401 with each one's last token.
//
// Safety: every address is `run-<runId>-<role>-<random>@` the test mail domain, which the
// backend marks as test (out of the business metrics), with a run record written before each
// step (lib/throwaway.mjs), so cleanup deletes whatever a failed or killed run leaves. Deleting an
// account or closing a team is refused in the browser unless it's this run's throwaway and a
// team this run made (guardDestructiveCalls). These pages are never traced, filmed or
// screenshotted: they show the throwaway addresses, and the sign-ins type a code. A failed step
// notes each page's redacted description instead (noteScreens).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROD } from "../../scripts/journeys/lib/config.mjs";
import { checkNewTeam, isInviteLink, isWelcomeLink } from "../../scripts/journeys/lib/throwaway.mjs";
import { runName } from "../../scripts/journeys/lib/addresses.mjs";
import { goToProjects, modal } from "../ui/index.js";
import { expect, secretFill, test } from "./fixtures.mjs";
import { apiCall, appReady, watchBearer } from "./steps.mjs";
import { noteScreens, signInByCode, signUp, throwawayContext, throwaways } from "./throwaway.mjs";

const RECEIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "receipt.jpg");

// Nothing of these pages is kept: see above
test.use({ trace: "off", video: "off", screenshot: "off" });

const teambar = (page) => page.locator(".teambar");

test("a new owner signs up and names a team, invites a crew member who joins, reads a receipt, and both delete their accounts", { tag: ["@J1.3", "@J3.1", "@J3.2", "@J5.1", "@J5.2", "@J11.1", "@J11.2", "@prod"] }, async ({ page, harness, identity, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "The throwaway accounts' journeys run on desktop only, to keep each run's sign-ups and emails few");
  test.setTimeout(600_000);
  const { owner, crew } = throwaways(harness, testInfo);
  const teamName = runName(harness.runId, `J1 team r${testInfo.retry}`);
  // The page's destructive-call guard allows only the account it's signed in as
  identity.account = owner.address;
  const ownerToken = watchBearer(page, harness);
  let crewSide = null;
  let crewToken = null;
  let inviteSince = 0;

  try {
    await test.step("J1.3 Sign up by email code; the welcome email arrives within a minute", async () => {
      const { since } = await signUp(harness, owner);
      // Read before the sign-in: the welcome has no code, and the sign-in's code comes after it
      // The welcome email, linking to the app's home (a timeout fails the step)
      await harness.mail({ to: owner.address, since, want: "link", linkMatch: isWelcomeLink });
      await page.goto("/");
      const me = await signInByCode(page, { harness, account: owner });
      expect(me.teams, "a new account is in no team").toEqual([]);
    });

    await test.step("J1.3 Name the team: an empty team on a 14-day trial, with the first-run checklist", async () => {
      await expect(page.getByRole("heading", { name: "Name your team" })).toBeVisible();
      const created = page.waitForResponse((r) => r.url() === `${PROD.api}/teams` && r.request().method() === "POST", { timeout: 30_000 });
      await page.getByLabel("Team name").fill(teamName);
      await page.getByLabel("Team name").press("Enter");
      const res = await created;
      expect(res.ok(), "POST /teams").toBe(true);
      const { team } = await res.json();
      // Recorded before anything else, so cleanup may close it if the run dies from here on
      if (typeof team?.id === "string") {
        harness.masker.add(team.id);
        harness.createdTeams.add(team.id);
        await owner.keeper.update({ teamIds: [team.id] });
      }
      expect(checkNewTeam(team, { name: teamName }), "the new team").toEqual([]);
      await appReady(page, 30_000);
      const checklist = page.locator("#firstRun");
      await expect(checklist.getByRole("heading", { name: "Get your team started" })).toBeVisible();
      await expect(checklist).toContainText("0 of 4 done");
      await expect(teambar(page)).toContainText(teamName);
    });

    await test.step("J3.1 The owner opens Members, enters the crew member's email and picks Contributor", async () => {
      await teambar(page).getByRole("button", { name: "Members" }).click();
      const members = modal(page);
      await secretFill(members.getByLabel("Email", { exact: true }), crew.address);
      await members.getByLabel("Role", { exact: true }).selectOption("contributor");
      inviteSince = Date.now();
      await members.getByRole("button", { name: "Send invite" }).click();
      await expect(page.locator("#toast")).toHaveText(/^Invite sent to /);
      await members.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator("#overlay")).toBeHidden();
    });

    await test.step("J3.2 The crew member gets the email, opens the link, signs up and joins", async () => {
      const { link } = await harness.mail({ to: crew.address, since: inviteSince, want: "link", linkMatch: isInviteLink });
      const { since } = await signUp(harness, crew);
      // Their welcome (for someone invited): read, so it's not left in the mailbox
      await harness.mail({ to: crew.address, since, want: "link", linkMatch: isWelcomeLink });
      crewSide = await throwawayContext({ browser, harness, testInfo }, crew);
      crewToken = watchBearer(crewSide.page, harness);
      await crewSide.page.goto(link);
      await expect(crewSide.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      const me = await signInByCode(crewSide.page, { harness, account: crew });
      expect(me.teams, "not in the team until they join").toEqual([]);
      await expect(crewSide.page.getByRole("heading", { name: `Join ${teamName}` })).toBeVisible();
      await crewSide.page.getByRole("button", { name: "Join", exact: true }).click();
      await appReady(crewSide.page, 30_000);
      await expect(teambar(crewSide.page)).toContainText(teamName);
      await goToProjects(crewSide.page);
      await expect(crewSide.page.getByRole("button", { name: "+ New project" })).toBeVisible();

      // The owner's member list has them, as a contributor
      await teambar(page).getByRole("button", { name: "Members" }).click();
      const roles = modal(page).locator("#membersList li.member select");
      await expect(roles).toHaveCount(2);
      expect((await roles.evaluateAll((all) => all.map((s) => s.value))).sort()).toEqual(["contributor", "owner"]);
      await modal(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator("#overlay")).toBeHidden();
    });

    await test.step("J5.1 Tap Scan receipt and photograph the receipt", async () => {
      await goToProjects(page);
      const chooser = page.waitForEvent("filechooser");
      await page.locator("label[for=receiptFile]", { hasText: /^Scan receipt$/ }).click();
      await (await chooser).setFiles(RECEIPT);
      await expect(page.getByRole("heading", { name: "Reading receipt…" })).toBeVisible();
    });

    await test.step("J5.2 The lines appear within 60 seconds, each with a name, quantity and price; then discard", async () => {
      await expect(page.getByRole("heading", { name: "Review receipt", exact: true })).toBeVisible({ timeout: 75_000 });
      const lines = await page.locator("#rBody .rline").evaluateAll((all) => all.map((l) => ({
        name: (l.querySelector("[data-f=name]")?.value ?? l.querySelector("[data-f=match] option:checked")?.textContent ?? "").trim(),
        qty: Number(l.querySelector("[data-f=qty]")?.value),
        price: Number(l.querySelector("[data-f=price]")?.value),
      })));
      expect(lines.length, "lines read from the receipt").toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        expect(line.name.length, "each line has a name").toBeGreaterThan(0);
        expect(line.qty, "each line has a quantity").toBeGreaterThanOrEqual(1);
        expect(line.price, "each line has a price").toBeGreaterThan(0);
      }
      // Nothing is saved: two taps on Discard
      await page.getByRole("button", { name: "Discard", exact: true }).click();
      await page.getByRole("button", { name: "Tap again to discard" }).click();
      await expect(page.locator("#toast")).toHaveText("Receipt discarded");
      await expect(page.getByRole("heading", { name: "Review receipt", exact: true })).toHaveCount(0);
    });

    await test.step("J11.2 The owner can't delete their account while the crew member is in the team", async () => {
      await page.locator("#accountOpen").click();
      await modal(page).getByLabel("Type DELETE to confirm").fill("DELETE");
      await modal(page).getByRole("button", { name: "Delete account" }).click();
      await expect(modal(page).locator("#deleteFail")).toContainText(`You're the only owner of ${teamName}`);
      await modal(page).getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page.locator("#overlay")).toBeHidden();
    });

    await test.step("J11.1 The crew member opens Account, Delete account, and types DELETE", async () => {
      await crewSide.page.locator("#accountOpen").click();
      await modal(crewSide.page).getByLabel("Type DELETE to confirm").fill("DELETE");
      await modal(crewSide.page).getByRole("button", { name: "Delete account" }).click();
      await expect(crewSide.page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible({ timeout: 30_000 });
      await crew.keeper.update({ state: "deleted" });
    });

    await test.step("J11.2 The owner closes the team from Members, typing its name", async () => {
      await teambar(page).getByRole("button", { name: "Members" }).click();
      await modal(page).getByLabel(/to close it/).fill(teamName);
      await modal(page).getByRole("button", { name: "Close team" }).click();
      await expect(page.getByRole("heading", { name: "Your access changed" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await appReady(page, 30_000);
    });

    await test.step("J11.1 The owner deletes their account too; neither account answers any more", async () => {
      await page.locator("#accountOpen").click();
      await modal(page).getByLabel("Type DELETE to confirm").fill("DELETE");
      await modal(page).getByRole("button", { name: "Delete account" }).click();
      await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible({ timeout: 30_000 });
      await owner.keeper.update({ state: "deleted" });
      // Their last access tokens: the API asks Cognito, which no longer has either account
      for (const [who, p, token] of [["owner", page, ownerToken], ["crew member", crewSide.page, crewToken]]) {
        const res = await apiCall(p, await token(), "GET", "/me");
        expect(res.status, `GET /me as the deleted ${who}`).toBe(401);
      }
    });
  } catch (err) {
    await noteScreens(testInfo, harness, { owner: page, crew: crewSide?.page });
    // The crew member's context goes too; its page errors never hide this failure
    await crewSide?.close().catch(() => {});
    throw err;
  }
  // The crew member's page errors fail the test too
  await crewSide.close();
});
