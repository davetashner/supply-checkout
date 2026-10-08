// Project steps: create and open a project, check out, return and finish (J4).
// See tests/ui/app.js.
import { expect } from "@playwright/test";
import { modal } from "./app.js";

/** Creates a project for `client` and waits for it to open. */
export async function createProject(page, client) {
  await page.getByRole("button", { name: "+ New project", exact: true }).click();
  await page.getByLabel("Client", { exact: true }).fill(client);
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("heading", { name: client, exact: true })).toBeVisible();
}

/** Opens the project whose card names `client`, from the projects list. */
export const openProject = (page, client) => page.getByRole("button", { name: new RegExp(client) }).click();

/** Back from a project to the projects list. */
export const backToProjects = (page) => page.getByRole("button", { name: "← All projects", exact: true }).first().click();

/** Types a barcode into the scan bar, which opens the checkout or return dialog. */
export async function enterBarcode(page, code) {
  await page.getByPlaceholder("Or type the barcode").fill(code);
  await page.getByPlaceholder("Or type the barcode").press("Enter");
}

/** The checkout dialog's add button, for `qty` items. */
export const addToProject = (page, qty = 1) => modal(page).getByRole("button", { name: `Add ${qty} to project`, exact: true }).click();

/** Switches the open project's scan bar to returns. */
export const startReturn = (page) => page.getByRole("button", { name: "Return", exact: true }).click();

/** The return dialog's save button. */
export const saveReturn = (page) => modal(page).getByRole("button", { name: "Save return", exact: true }).click();

/** Finished Return on the open project. */
export const finishReturn = (page) => page.getByRole("button", { name: "Finished Return", exact: true }).click();

/** The open project's line for `name`. */
export const lineRow = (page, name) => page.locator("#projectBody tbody tr", { hasText: name });
