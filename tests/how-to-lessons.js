// The how-to lessons' steps, played in the demo build (tests/how-to.spec.js). Each lesson on
// supplycheckout.com/how-to/ (site/how-to/<slug>/index.html) has one function here per step, in
// order. Step N's function takes the demo from where step N-1 left it to the screen the lesson's
// step N shows: the screenshot is taken there, with each control the step names in bold outlined.
// So a step's function does what the earlier steps told the reader to do, then opens the screen
// the step is about. The spec scrolls a named control that's off screen into view, unless the
// step's function has scrolled the screen to what the step shows.
import { expect } from "@playwright/test";

const modal = (page) => page.locator("#modal");
const typeCode = async (scope, code) => {
  await scope.getByPlaceholder("Or type the barcode").fill(code);
  await scope.getByPlaceholder("Or type the barcode").press("Enter");
};
const more = (page) => modal(page).getByRole("button", { name: "More", exact: true }).click();
const project = (page, name) => page.locator("#main .project-card", { hasText: name });
const line = (page, name) => page.locator("#projectBody tbody tr", { hasText: name });

export const LESSONS = {
  "check-out-and-return": [
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
      await page.getByRole("button", { name: "Add item without a barcode" }).evaluate((el) => { el.scrollIntoView({ block: "start" }); scrollBy(0, -16); });
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

  "quick-take": [
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
};
