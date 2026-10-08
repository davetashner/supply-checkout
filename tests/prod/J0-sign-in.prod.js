// J0 Sign in, against prod (supply-checkout-o60.5, o60.7). J0.2 by password through Managed
// Login as crew; J0.3 by switching between the two journey teams crew belongs to. Google, Apple
// and passkeys aren't automated in prod (docs/journey-tests-plan.md, owner decision 10).
import { goToProjects, teamPicker } from "../ui/index.js";
import { expect, test } from "./fixtures.mjs";
import { appReady } from "./steps.mjs";

test("crew signs in with a password and sees the app", { tag: ["@J0.1", "@J0.2", "@prod"] }, async ({ page, signIn }) => {
  await test.step("J0.1 Open the app, and J0.2 sign in through Managed Login as crew", async () => {
    // Through Managed Login every time, not a saved session: this is the sign-in journey
    await signIn(page, "crew", { fresh: true });
  });
  await goToProjects(page);
  await expect(page.getByRole("button", { name: "Projects", exact: true })).toBeVisible();
});

test("crew picks between their two teams, and each team's projects appear within 3 seconds", { tag: ["@J0.3", "@prod"] }, async ({ page, signIn, harness, journeyTeam }) => {
  await signIn(page, "crew");
  const other = Object.values(harness.config.teams).find((t) => t !== journeyTeam);
  await test.step("J0.3 Pick the other team, then back", async () => {
    await appReady(page);
    await expect(teamPicker(page).locator("option")).toHaveCount(2);
    const first = await teamPicker(page).inputValue();
    for (const team of [first === journeyTeam ? other : journeyTeam, first]) {
      const loaded = page.waitForEvent("load");
      const picked = Date.now();
      await teamPicker(page).selectOption(team);
      await loaded;
      await appReady(page, Math.max(1, 3_000 - (Date.now() - picked)));
      await expect(teamPicker(page)).toHaveValue(team);
      expect(Date.now() - picked, "projects appear within 3 seconds of picking the team").toBeLessThanOrEqual(3_000);
    }
  });
});
