// Help, in the bar under the header (supply-checkout-vrm7): the how-to lesson on the website for
// the screen the person is on (site/how-to/), at the app's own domain without its "app.", so a
// test environment's app links to its own site. A new tab, so the app stays as it was.
import { currentScreen } from "./report.js";

// The lesson for each screen report.js tells apart; the project list has every lesson
const LESSON = { receipt: "receipts/", project: "check-out-and-return/", prices: "inventory-and-import/", projects: "" };

export const helpUrl = (loc = location, doc = document) => `https://${loc.hostname.replace(/^app\./, "")}/how-to/${LESSON[currentScreen(doc)]}`;

/** The link's markup, for the bar. */
export const helpLink = () => `<a class="btn ghost" id="help" href="${helpUrl()}" target="_blank" rel="noopener">Help</a>`;

/** Keeps the link's lesson the screen's, whenever it's used. */
export function wireHelp(bar) {
  const link = bar.querySelector("#help");
  const update = () => { link.href = helpUrl(); };
  link.addEventListener("click", update);
  link.addEventListener("focus", update);
  link.addEventListener("pointerenter", update);
}
