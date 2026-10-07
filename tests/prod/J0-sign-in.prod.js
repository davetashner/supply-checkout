// J0 Sign in, against prod: the harness's first smoke test (supply-checkout-o60.5). The rest of
// J0 (switching teams, projects within 3 seconds) comes with supply-checkout-o60.7.
import { goToProjects } from "../ui/app.js";
import { expect, test } from "./fixtures.mjs";

test("crew signs in with a password and sees the app", { tag: ["@J0.2", "@prod"] }, async ({ page, signIn }) => {
  await test.step("J0.2 Sign in through Managed Login as crew", async () => {
    await signIn(page, "crew");
  });
  await goToProjects(page);
  await expect(page.getByRole("button", { name: "Projects" })).toBeVisible();
});
