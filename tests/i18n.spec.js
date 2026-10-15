// The app's languages (supply-checkout-3ilj, supply-checkout-oopu): the Spanish catalog loads with ?lang=es and is
// kept on the device; the browser's own Spanish doesn't change an app that offers only English; and the
// pseudo-language (?lang=qps) marks every catalog string, so a screen with text still in a template, or a
// string too long for its place, shows up.
import { test, expect, openApp } from "./helpers.js";
import { modal, waitUntilConnected, goToInventory, goToProjects } from "./ui/app.js";
import { usedState } from "./fixtures.js";
import { UI_WORDS, unmarked } from "./ui/language.js";

const open = async (page, search = "") => {
  await openApp(page, { ...usedState, search });
  await waitUntilConnected(page);
};

test.describe("Spanish", () => {
  test("?lang=es speaks Spanish: the page, the lists, the dialogs, and dates, in the language's own form", async ({ page }) => {
    await open(page, "?lang=es");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await expect(page.locator("#tab-projects")).toHaveText("Proyectos");
    await expect(page.locator("#tab-prices")).toHaveText("Inventario");
    await expect(page.getByRole("button", { name: "+ Nuevo proyecto" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Fuera ahora \(1\)/ })).toBeVisible();
    // Dates follow the language: the month is Spanish ("sept"), whatever order the browser puts the day in
    await page.getByRole("button", { name: /Echo Studio/ }).click();
    await expect(page.locator(".project-head .meta")).toContainText(/sept\.? .*2026|24 .*2026/);
    await expect(page.locator(".project-head .meta")).not.toContainText("Sep 24, 2026");
    await expect(page.locator(".project-head .meta")).toContainText("Preparado por");
    await expect(page.getByRole("button", { name: "Terminar devolución" })).toBeVisible();
    // A plural, and a dialog
    await page.getByRole("button", { name: "Editar detalles" }).click();
    await expect(modal(page).getByRole("heading", { name: "Editar proyecto" })).toBeVisible();
    await modal(page).getByRole("button", { name: "Cancelar" }).click();
    await goToProjects(page);
    await expect(page.locator(".project-card .meta")).toContainText("2 artículos · 5 retirados · 1 devueltos");
    await goToInventory(page);
    await expect(page.getByRole("button", { name: "+ Agregar artículo" })).toBeVisible();
    await expect(page.locator("#main")).toContainText("2 artículos. Las cantidades del almacén");
  });

  test("the choice stays on the device, and ?lang=en changes it back", async ({ page }) => {
    await open(page, "?lang=es");
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.language"))).toBe("es");
    await page.reload();
    await waitUntilConnected(page);
    await expect(page.locator("#tab-projects")).toHaveText("Proyectos");
    await page.goto(page.url().split("?")[0] + "?lang=en");
    await waitUntilConnected(page);
    await expect(page.locator("#tab-projects")).toHaveText("Projects");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("a language the app doesn't have is ignored", async ({ page }) => {
    await open(page, "?lang=klingon");
    await expect(page.locator("#tab-projects")).toHaveText("Projects");
    expect(await page.evaluate(() => localStorage.getItem("supplyCheckout.language"))).toBeNull();
  });

  test("storage that can't be read or written leaves the page working in the chosen language", async ({ page }) => {
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error("blocked"); };
      Storage.prototype.setItem = () => { throw new Error("blocked"); };
    });
    await open(page, "?lang=es");
    await expect(page.locator("#tab-projects")).toHaveText("Proyectos");
  });
});

test.describe("a browser set to Spanish", () => {
  test.use({ locale: "es-US" });

  test("gets Spanish", async ({ page }) => {
    await open(page);
    await expect(page.locator("#tab-projects")).toHaveText("Proyectos");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
  });

  test("a language picked on the device beats the browser's", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("supplyCheckout.language", "en"));
    await open(page);
    await expect(page.locator("#tab-projects")).toHaveText("Projects");
  });
});

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe("the pseudo-language", () => {
  const screens = [
    ["the project list", async () => {}],
    ["a project", async (page) => { await page.locator(".project-card").first().click(); }],
    ["Inventory", async (page) => { await goToInventory(page); }],
    ["a new project", async (page) => { await page.locator("#newProject").click(); }, true],
    ["Quick take", async (page) => { await page.locator("#quickTake").click(); }, true],
    ["Return", async (page) => { await page.locator("#returnAny").click(); }, true],
    ["a new item", async (page) => { await goToInventory(page); await page.locator("#addProduct").click(); }, true],
  ];
  for (const [name, go, dialog] of screens) {
    test(`${name} has no text outside the catalog, and fits the screen`, async ({ page }) => {
      await open(page, "?lang=qps");
      await expect(page.locator("html")).toHaveAttribute("lang", "qps");
      await go(page);
      if (dialog) await expect(modal(page)).toBeVisible();
      await expect(page.locator("body")).toContainText("⟦");
      const left = await unmarked(page);
      expect(left.match(UI_WORDS), `${name} still has text outside the catalog: ${left.replace(/\s+/g, " ").slice(0, 300)}`).toBeNull();
      expect(await noOverflow(page), `${name} is wider than the screen`).toBe(true);
    });
  }
});
