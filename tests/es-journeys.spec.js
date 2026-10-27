// Core journeys with the app in Spanish (supply-checkout-oopu): the project list, a new project, checking an item
// out and returning it (J4), adding an item with its size (J2), Account's language, and an import preview (J2.4).
// Every screen is read for the app's own English words (tests/ui/language.js). Names the tests type, and the
// seeded projects and items, stay as they are. Run in the Playwright projects every spec runs in.
import { test, expect, openApp } from "./helpers.js";
import { modal, waitUntilConnected, goToInventory } from "./ui/app.js";
import { ENGLISH_WORDS, unmarked } from "./ui/language.js";
import { usedState } from "./fixtures.js";
import { FakeBackend, openAws, connected } from "./fake-aws.js";

test.use({ locale: "es-US", reducedMotion: "reduce" });

/** Fails if the screen has any of the app's English words in its text. */
async function noEnglish(page, screen) {
  const text = await unmarked(page);
  expect(text.match(ENGLISH_WORDS), `${screen} still has English: ${text.replace(/\s+/g, " ").slice(0, 400)}`).toBeNull();
}

const open = async (page, state = {}) => {
  await openApp(page, state);
  await waitUntilConnected(page);
  await expect(page.locator("html")).toHaveAttribute("lang", "es");
};

test("the project list and a new project are in Spanish", { tag: ["@J4.1"] }, async ({ page }) => {
  await open(page, usedState);
  await expect(page.locator("#tab-projects")).toHaveText("Proyectos");
  await noEnglish(page, "the project list");
  await page.getByRole("button", { name: "+ Nuevo proyecto", exact: true }).click();
  await expect(modal(page).getByRole("heading", { name: "Nuevo proyecto" })).toBeVisible();
  await noEnglish(page, "the new project dialog");
  await modal(page).getByRole("button", { name: "Cancelar", exact: true }).click();
});

test("creates a project, checks an item out and returns part of it, all in Spanish", { tag: ["@J4.1", "@J4.2", "@J4.3"] }, async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "+ Nuevo proyecto", exact: true }).click();
  await page.getByLabel("Cliente", { exact: true }).fill("Oficinas Acme");
  await page.getByRole("button", { name: "Crear proyecto", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Oficinas Acme", exact: true })).toBeVisible();
  await expect(page.locator(".project-head")).toContainText("Preparado por");
  await noEnglish(page, "a new project");

  const scan = page.getByPlaceholder(/código de barras/i);
  await scan.fill("012345678905");
  await scan.press("Enter");
  await expect(modal(page)).toBeVisible();
  await modal(page).getByLabel("Nombre del artículo").fill("Guantes de nitrilo");
  await modal(page).getByLabel("Precio al cliente c/u ($)").fill("12.50");
  await modal(page).locator("#fQty").fill("3");
  await noEnglish(page, "the checkout dialog");
  await modal(page).getByRole("button", { name: "Agregar 3 al proyecto", exact: true }).click();
  // Money is es-US: the dollar sign first, a period for the decimals
  await expect(page.locator(".totals .charge")).toHaveText("$37.50");
  await expect(page.locator("#projectBody tbody tr", { hasText: "Guantes de nitrilo" })).toContainText("Código de barras 012345678905");
  await noEnglish(page, "a project with a line");

  await page.getByRole("button", { name: "Devolver", exact: true }).click();
  await scan.fill("012345678905");
  await scan.press("Enter");
  await modal(page).locator("#fRet").fill("1");
  await noEnglish(page, "the return dialog");
  await modal(page).getByRole("button", { name: "Guardar devolución", exact: true }).click();
  await expect(page.locator(".totals .charge")).toHaveText("$25.00");
  await page.getByRole("button", { name: "Terminar devolución", exact: true }).click();
  await expect(page.locator(".project-head .pill")).toHaveText("Devuelto");
  await noEnglish(page, "a finished project");
});

test("adds an item with its size in Spanish, in es-US units", { tag: ["@J2.1", "@J2.2"] }, async ({ page }) => {
  await open(page, usedState);
  await goToInventory(page);
  await noEnglish(page, "Inventory");
  await page.getByRole("button", { name: "+ Agregar artículo", exact: true }).click();
  const form = modal(page);
  await expect(form.getByRole("heading", { name: "Agregar artículo" })).toBeVisible();
  await form.getByLabel("Nombre del artículo", { exact: true }).fill("Caja transparente");
  await form.getByLabel("Largo", { exact: true }).fill("12");
  await form.getByLabel("Ancho", { exact: true }).fill("6.5");
  await form.getByLabel("Alto", { exact: true }).fill("4");
  await expect(form.getByLabel("Unidad", { exact: true })).toHaveText(/pulg/);
  await noEnglish(page, "the item form");
  await form.getByRole("button", { name: "Guardar", exact: true }).click();
  const row = page.locator("#main tbody tr", { hasText: "Caja transparente" });
  // The sides are labeled in Spanish, and decimals use a period, as in es-US; the unit is the form's own ("pulg")
  await expect(row).toContainText("L 12 × An 6.5 × Al 4 pulg");
  await noEnglish(page, "Inventory with the new item");
});

test("Account shows the language in Spanish and lists both languages by their own names", async ({ page }) => {
  const backend = new FakeBackend();
  await openAws(page, backend, { path: "/?lang=es" });
  await connected(page);
  await page.locator("#accountOpen").click();
  await expect(modal(page).getByRole("heading", { name: "Su cuenta", exact: true })).toBeVisible();
  await expect(modal(page).getByLabel("Idioma").locator("option")).toHaveText(["English", "Español"]);
  // "English" and "Español" are the languages' own names, so they are left out of the check
  const text = (await unmarked(page)).replace(/\bEnglish\b/g, " ");
  expect(text.match(ENGLISH_WORDS), `Account still has English: ${text.replace(/\s+/g, " ").slice(0, 400)}`).toBeNull();
});

test.describe("the import preview", () => {
  const PATH = "/teams/t1/imports";
  const PREVIEW = {
    status: "preview",
    rows: [
      { line: 2, name: "Nitrile gloves", brand: "Ansell", barcode: "0123", price: 13, stock: 10, reorderAt: 5, reorderQty: 24, key: "0123", action: "update", changes: ["brand", "price", "reorderAt", "reorderQty", "length", "width", "height", "dimUnit", "stock"] },
      { line: 3, name: "Rags", barcode: "", price: 1.5, key: "nb-1", action: "create", changes: ["name", "price"] },
      { line: 4, name: "Bins", barcode: "", price: 3, stock: 2, reorderAt: 1, reorderQty: 6, key: "nb-2", action: "unchanged", changes: [] },
    ],
    errors: [],
    errorCount: 0,
    ignoredColumns: ["Notes"],
    summary: { rows: 3, created: 1, updated: 1, unchanged: 1 },
  };

  test("is in Spanish, with money in es-US and the changes named in Spanish", { tag: ["@J2.4"] }, async ({ page }) => {
    const backend = new FakeBackend();
    backend.on("POST", PATH, { status: 200, body: PREVIEW });
    await openAws(page, backend, { path: "/?lang=es" });
    await connected(page);
    await page.locator(".teambar").getByRole("button", { name: "Importar CSV" }).click();
    await expect(modal(page).getByRole("heading", { name: "Importar inventario" })).toBeVisible();
    await page.getByLabel("Archivo CSV").setInputFiles({ name: "inventario.csv", mimeType: "text/csv", buffer: Buffer.from("name,barcode,price\nRags,,1.5\n") });
    const result = page.locator("#importResult");
    await expect(result).toContainText("3 filas: 1 nuevos, 1 por actualizar, 1 sin cambios.");
    await expect(result).toContainText("No se importa: “Notes”.");
    await expect(result.locator("tbody tr").nth(0)).toContainText("$13.00");
    await expect(result.locator("tbody tr").nth(0)).toContainText("Actualizar marca, precio, nivel de reorden");
    await expect(result.locator("tbody tr").nth(1)).toContainText("Nuevo");
    // The file's own column name ("Notes") and the names in the file stay as they are
    const text = (await unmarked(page)).replace(/Nitrile gloves|Ansell|Notes/g, " ");
    expect(text.match(ENGLISH_WORDS), `the import preview still has English: ${text.replace(/\s+/g, " ").slice(0, 400)}`).toBeNull();
  });
});
