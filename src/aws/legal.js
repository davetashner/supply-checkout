// The legal pages on the website (site/, built from docs/legal/): linked from the sign-in screen,
// at the app's own domain without its "app.", so a test environment links to its own site, each
// in a new tab so the sign-in stays as it was (as help.js does).
import { msg } from "../i18n.js";

const PAGES = [["terms", "legal.terms"], ["privacy", "legal.privacy"], ["acceptable-use", "legal.use"]];

export const legalUrl = (page, loc = location) => `https://${loc.hostname.replace(/^app\./, "")}/${page}/`;

/** The sentence for the sign-in screen: signing in is agreeing to the three documents. */
export function legalNotice() {
  const [terms, privacy, use] = PAGES.map(([page, key]) => `<a href="${legalUrl(page)}" target="_blank" rel="noopener">${msg(key)}</a>`);
  return `<p class="hint" id="legalNotice">${msg("legal.notice", { terms, privacy, use })}</p>`;
}
