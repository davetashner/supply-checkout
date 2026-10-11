// J7, J8 and J10 against prod's Stripe sandbox (supply-checkout-o60.9; docs/journey-tests-plan.md,
// "Billing in prod"), on a throwaway owner and team of their own (bowner and bcrew, so J1's J11
// needn't wait for billing). Desktop only: it signs up two accounts a try, like J1.
//
// The mode comes first and fails closed. Global setup reads `stripeMode` from every long-lived
// account's GET /me (lib/setup.mjs) into JOURNEYS_STRIPE_MODE, and the throwaway's own /me must say
// the same before it does anything with billing:
// - `test`: the sandbox journeys below.
// - `live`: only the read-only checks (the second test), and the summary says so. No throwaway is
//   signed up, no Checkout is started, no card is typed: nothing in live Stripe is written.
// - anything else (the api that reports it isn't deployed yet): neither test runs, with a warning.
//
// The sandbox journey:
// - Two-step sign-in (supply-checkout-8jc.12): the owner signs up and in by email code, names a
//   team, and turns two-step on in Account (a password, the app's secret, a code), is signed out
//   everywhere, and signs in again with the password and a code. Billing routes need it.
// - J7.2: Checkout is started as the Subscribe button does (that button shows only on a read-only
//   team; the in-app plan picker, J7.1, isn't built), and completed on Stripe's sandbox page. A
//   team in its free trial is asked for no card (`if_required`), so the subscription starts
//   trialing; within a minute /me shows the Starter plan. With the sandbox key (below) the
//   harness gives the subscription Stripe's 4242 test card and ends the trial, so the first
//   payment is taken and the team is `active`.
// - J7.3: the crew member joins as a contributor; /me counts two members, and with the key the
//   subscription's quantity follows within two minutes. Invoices opens.
// - J8.1 and J8.3, only with the sandbox key (JOURNEYS_STRIPE_SANDBOX_KEY, an owner step): the
//   harness swaps in Stripe's always-declining test card and starts a new billing cycle, so the
//   next payment fails; the webhook turns the team past due and the team bar says so. Then the
//   owner replaces the card in the Customer Portal and full access returns. Without the key
//   these steps don't run and the summary warns.
// - J10.1 and J10.2: Billing opens the Customer Portal, the owner cancels (at the period's end),
//   the team bar shows the end date, and Export data downloads everything.
// - Then the J11 clean-up: the crew member deletes their account, the owner closes the team and
//   deletes theirs; with the key, the sandbox subscription is ended first.
//
// Safety: addresses are `run-<runId>-bowner-…@` the test mail domain (marked test: out of the
// business metrics), recorded before each step so cleanup finds what a failed run leaves; the
// owner's password and authenticator secret are sealed into its record (lib/seal.mjs); deleting
// an account or closing a team is refused unless it's this run's throwaway and team
// (guardDestructiveCalls); a Stripe page is opened only after its URL is checked to be a sandbox
// session; the key must be a restricted `rk_test_` key and every Stripe answer `livemode: false`.
// The pages are never traced, filmed or screenshotted: they show the throwaway's address and the
// two-step secret; a failed step notes each page's redacted description instead.
//
// Per try: 2 Cognito sign-ups, 3 Managed Login sign-ins (the owner twice, the crew once), about 12
// emails, one Stripe customer, Checkout session, subscription and Customer Portal session or two
// in the sandbox, and with the key about 15 Stripe API calls.
import { runName } from "../../scripts/journeys/lib/addresses.mjs";
import { isSubscribed, invoicesAnswerOk, newPassword } from "../../scripts/journeys/lib/billing.mjs";
import { PROD } from "../../scripts/journeys/lib/config.mjs";
import { createSandboxStripe } from "../../scripts/journeys/lib/stripe-sandbox.mjs";
import { checkNewTeam, isInviteLink, isWelcomeLink } from "../../scripts/journeys/lib/throwaway.mjs";
import { goToProjects, modal } from "../ui/index.js";
import { cancelInPortal, completeCheckout, leavePortal, openCheckout, openPortal, signInWithTwoStep, teamNow, turnOnTwoStep, updateCardInPortal } from "./billing.mjs";
import { expect, secretFill, test } from "./fixtures.mjs";
import { apiCall, appReady, download, watchBearer } from "./steps.mjs";
import { noteScreens, signInByCode, signUp, throwawayContext, throwaways } from "./throwaway.mjs";

test.use({ trace: "off", video: "off", screenshot: "off" });

const teambar = (page) => page.locator(".teambar");
const mode = () => process.env.JOURNEYS_STRIPE_MODE ?? "unknown";
const warn = (testInfo, description) => testInfo.annotations.push({ type: "journeys-warning", description });

test("a new owner turns on two-step sign-in, subscribes in the sandbox, adds a seat, sees invoices, cancels and exports, then deletes the team and both accounts", { tag: ["@J7.2", "@J7.3", "@J10.1", "@J10.2", "@prod"] }, async ({ page, harness, identity, browser }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "The billing journey runs on desktop only, to keep each run's sign-ups and emails few");
  if (mode() !== "test") {
    warn(testInfo, mode() === "live"
      ? "Prod is on Stripe's live mode: the billing journeys ran only their read-only checks (no sign-up, no Checkout, no card, no charge)"
      : "GET /me doesn't say which Stripe mode prod is on (the api that reports it isn't deployed yet): the billing journeys didn't run");
    test.skip(true, "The billing journeys run only against the Stripe sandbox");
  }
  test.setTimeout(900_000);
  const key = harness.config.stripeSandboxKey;
  const stripe = key ? createSandboxStripe({ key }) : null;
  if (!stripe) warn(testInfo, "J8.1 and J8.3 didn't run: they need the restricted Stripe sandbox key (JOURNEYS_STRIPE_SANDBOX_KEY, docs/journey-tests-plan.md, Billing in prod). Without it the subscription also stays in its free trial");
  const { owner, crew } = throwaways(harness, testInfo, { billing: true });
  const teamName = runName(harness.runId, `J7 team r${testInfo.retry}`);
  const password = newPassword();
  identity.account = owner.address;
  const ownerToken = watchBearer(page, harness);
  let crewSide = null;
  let inviteSince = 0;
  let teamId = null;
  let secret = null;
  let customer = null;
  let subscription = null;
  const team = () => teamNow(page, ownerToken, teamId);
  const sandboxSubscription = async () => {
    await expect.poll(async () => (customer ??= await stripe.customerOfTeam(teamId)), { message: "the team's sandbox customer", timeout: 120_000, intervals: [5_000] }).not.toBeNull();
    harness.masker.add(customer);
    await expect.poll(async () => (subscription = await stripe.subscriptionOf(customer)), { message: "the team's sandbox subscription", timeout: 120_000, intervals: [5_000] }).not.toBeNull();
    harness.masker.add(subscription.id);
    return subscription;
  };

  try {
    await test.step("Sign up by email code, sign in, and name a team", async () => {
      const { since } = await signUp(harness, owner);
      await harness.mail({ to: owner.address, since, want: "link", linkMatch: isWelcomeLink });
      await page.goto("/");
      const me = await signInByCode(page, { harness, account: owner });
      // The mode again, from the throwaway's own /me: the billing steps need both to say test
      expect(me.stripeMode, "GET /me says the Stripe mode is test").toBe("test");
      await expect(page.getByRole("heading", { name: "Name your team" })).toBeVisible();
      await owner.keeper.update({ teamName });
      const created = page.waitForResponse((r) => r.url() === `${PROD.api}/teams` && r.request().method() === "POST", { timeout: 30_000 });
      await page.getByLabel("Team name").fill(teamName);
      await page.getByLabel("Team name").press("Enter");
      const res = await created;
      expect(res.ok(), "POST /teams").toBe(true);
      const body = await res.json();
      teamId = body.team?.id;
      harness.masker.add(teamId);
      harness.createdTeams.add(teamId);
      await owner.keeper.update({ teamIds: [teamId] });
      expect(checkNewTeam(body.team, { name: teamName }), "the new team").toEqual([]);
      await appReady(page, 30_000);
    });

    await test.step("Two-step sign-in: turn it on in Account, sign in again with the password and a code", async () => {
      secret = await turnOnTwoStep(page, { harness, account: owner, password });
      const me = await signInWithTwoStep(page, { harness, account: owner, password, secret });
      expect(me.stripeMode, "GET /me says the Stripe mode is test").toBe("test");
      await appReady(page, 30_000);
    });

    await test.step("J7.2 Checkout on Stripe's sandbox page; within a minute /me shows the Starter plan", async () => {
      await openCheckout(page, { harness, token: ownerToken, teamId });
      await completeCheckout(page, { harness, email: owner.address });
      await appReady(page, 60_000);
      await expect.poll(async () => isSubscribed(await team()), { message: "the team is on the Starter plan", timeout: 90_000, intervals: [5_000] }).toBe(true);
      if (stripe) {
        const sub = await sandboxSubscription();
        // Pays the first invoice with Stripe's 4242 test card, as a card on Checkout would
        await stripe.useGoodCard(customer, sub.id);
        await stripe.endTrial(sub.id);
        await expect.poll(async () => (await team()).status, { message: "the team is active after the first payment", timeout: 120_000, intervals: [5_000] }).toBe("active");
      }
      await page.reload();
      await appReady(page, 30_000);
      // Billing and Invoices are there now: the team has a Stripe customer
      await expect(teambar(page).locator("#manageBilling")).toBeVisible();
      await expect(teambar(page).locator("#invoices")).toBeVisible();
    });

    await test.step("J7.3 The crew member joins as a contributor; the seat count follows; Invoices opens", async () => {
      await teambar(page).getByRole("button", { name: "Members" }).click();
      const members = modal(page);
      await secretFill(members.getByLabel("Email", { exact: true }), crew.address);
      await members.getByLabel("Role", { exact: true }).selectOption("contributor");
      inviteSince = Date.now();
      await members.getByRole("button", { name: "Send invite" }).click();
      await expect(page.locator("#toast")).toHaveText(/^Invite sent to /);
      await members.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator("#overlay")).toBeHidden();

      const { link } = await harness.mail({ to: crew.address, since: inviteSince, want: "link", linkMatch: isInviteLink });
      const { since } = await signUp(harness, crew);
      await harness.mail({ to: crew.address, since, want: "link", linkMatch: isWelcomeLink });
      crewSide = await throwawayContext({ browser, harness, testInfo }, crew);
      await crewSide.page.goto(link);
      await expect(crewSide.page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await signInByCode(crewSide.page, { harness, account: crew });
      await expect(crewSide.page.getByRole("heading", { name: `Join ${teamName}` })).toBeVisible();
      await crewSide.page.getByRole("button", { name: "Join", exact: true }).click();
      await appReady(crewSide.page, 30_000);

      await expect.poll(async () => (await team()).members, { message: "the team counts two members", timeout: 60_000, intervals: [5_000] }).toBe(2);
      if (stripe) {
        await expect.poll(async () => (await stripe.subscriptionOf(customer))?.quantity, { message: "the sandbox subscription's seats follow the members", timeout: 120_000, intervals: [5_000] }).toBe(2);
      }
      // Past invoices, through the two-step-protected route
      await teambar(page).locator("#invoices").click();
      const invoices = modal(page);
      await expect(invoices.locator("#invoiceList")).not.toContainText("Loading invoices", { timeout: 30_000 });
      await expect(invoices.locator("#invoicesFail")).toBeHidden();
      await invoices.getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator("#overlay")).toBeHidden();
    });

    if (stripe) {
      await test.step("J8.1 The next payment fails: the webhook turns the team past due and the team bar says so", async () => {
        const sub = await sandboxSubscription();
        await stripe.useFailingCard(customer, sub.id);
        await stripe.invoiceNow(sub.id);
        await expect.poll(async () => (await team()).status, { message: "the team is past due after the failed payment", timeout: 180_000, intervals: [5_000] }).toBe("past_due");
        await page.reload();
        await appReady(page, 30_000);
        // J8.2's banner: full access for the grace period, and a way to fix it
        await expect(teambar(page).locator("#graceNote")).toContainText("didn't go through");
      });

      await test.step("J8.3 The owner replaces the card in the Customer Portal; full access returns", async () => {
        await openPortal(page, { harness });
        await updateCardInPortal(page, { harness });
        await leavePortal(page);
        await expect.poll(async () => (await team()).status, { message: "the team is active again", timeout: 180_000, intervals: [5_000] }).toBe("active");
        await page.reload();
        await appReady(page, 30_000);
        await expect(teambar(page).locator("#graceNote")).toHaveCount(0);
      });
    }

    await test.step("J10.1 Billing opens the Customer Portal; cancel; the team bar shows the end date", async () => {
      await openPortal(page, { harness });
      await cancelInPortal(page, { harness });
      await leavePortal(page);
      await expect.poll(async () => (await team()).cancelsAt, { message: "the team has the date its subscription ends", timeout: 120_000, intervals: [5_000] }).not.toBeNull();
      await page.reload();
      await appReady(page, 30_000);
      await expect(teambar(page).locator("#cancelNote")).toContainText("subscription was canceled");
    });

    await test.step("J10.2 Export all projects and inventory", async () => {
      await goToProjects(page);
      await page.getByRole("button", { name: "Export data" }).click();
      const { filename, text } = await download(page, modal(page).getByRole("button", { name: "Everything (JSON)" }));
      expect(filename, "the export's file name").toMatch(/\.json$/);
      const all = JSON.parse(text);
      expect(Array.isArray(all.projects), "the export lists projects").toBe(true);
      await modal(page).getByRole("button", { name: "Close", exact: true }).click();
      await expect(page.locator("#overlay")).toBeHidden();
    });

    // The J11 clean-up of the throwaways: the sandbox subscription first, then the team and accounts
    await test.step("Clean-up: end the sandbox subscription, delete the crew member's account, close the team, delete the owner's", async () => {
      if (stripe) {
        const sub = await sandboxSubscription();
        await stripe.cancel(sub.id);
      }
      await crewSide.page.locator("#accountOpen").click();
      await modal(crewSide.page).getByLabel("Type DELETE to confirm").fill("DELETE");
      await modal(crewSide.page).getByRole("button", { name: "Delete account" }).click();
      await expect(crewSide.page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible({ timeout: 30_000 });
      await crew.keeper.update({ state: "deleted" });

      await teambar(page).getByRole("button", { name: "Members" }).click();
      await modal(page).getByLabel(/to close it/).fill(teamName);
      await modal(page).getByRole("button", { name: "Close team" }).click();
      await expect(page.getByRole("heading", { name: "Your access changed" })).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await appReady(page, 30_000);

      await page.locator("#accountOpen").click();
      await modal(page).getByLabel("Type DELETE to confirm").fill("DELETE");
      await modal(page).getByRole("button", { name: "Delete account" }).click();
      await expect(page.getByRole("heading", { name: "Your account is deleted" })).toBeVisible({ timeout: 30_000 });
      await owner.keeper.update({ state: "deleted", sealed: undefined });
      const res = await apiCall(page, await ownerToken(), "GET", "/me");
      expect(res.status, "GET /me as the deleted owner").toBe(401);
    });
  } catch (err) {
    await noteScreens(testInfo, harness, { owner: page, crew: crewSide?.page });
    await crewSide?.close().catch(() => {});
    throw err;
  }
  await crewSide.close();
});

test("in live mode only read-only checks run: the invoice route answers, and no subscription, card or charge is made", { tag: ["@J7.3", "@prod"] }, async ({ page, signIn, harness, journeyTeam }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chrome", "Billing checks run on desktop only");
  test.skip(mode() !== "live", "Prod is on the Stripe sandbox, so the sandbox journeys ran instead");
  warn(testInfo, "Prod is on Stripe's live mode: the billing journeys ran only their read-only checks on the long-lived team (GET billing/invoices). No throwaway was signed up, no Checkout or Customer Portal session was made, no card was typed, nothing was charged");
  const token = watchBearer(page, harness);
  await signIn(page, "owner");
  // A GET only: a list of invoices, or the answer that the team has no billing account yet
  const res = await apiCall(page, await token(), "GET", `/teams/${encodeURIComponent(journeyTeam)}/billing/invoices`);
  expect(invoicesAnswerOk(res), `GET billing/invoices answered ${res.status}`).toBe(true);
});
