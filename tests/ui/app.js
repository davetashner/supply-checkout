// Screen-level steps shared by the local suites and the prod journey suite
// (docs/journey-tests-plan.md, Reusing the local tests). They only click and
// read the UI, so they work against the mock and fake runtimes and a deployed
// app alike: nothing in tests/ui/ imports a fake, a mock or a fixture.

/** The open dialog. */
export const modal = (page) => page.locator("#modal");

/**
 * Waits until the page has connected: the "Connecting…" notice clears once
 * both collections have loaded, and the page draws again.
 */
export const waitUntilConnected = (page) =>
  page.waitForFunction(() => { const n = document.getElementById("notice"); return n.hidden || !n.textContent.startsWith("Connecting"); });

/** The Inventory tab (by ID: its name carries a low-stock count, and other buttons say "inventory"). */
export const goToInventory = (page) => page.locator("#tab-prices").click();

/** The Projects tab (by ID: a project's "← All projects" button also says "projects"). */
export const goToProjects = (page) => page.locator("#tab-projects").click();
