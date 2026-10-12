// The legal pages on the website (site/, built from docs/legal/): linked from the sign-in screen,
// at the app's own domain without its "app.", so a test environment links to its own site, each
// in a new tab so the sign-in stays as it was (as help.js does).
const PAGES = [["terms", "Terms of Service"], ["privacy", "Privacy Policy"], ["acceptable-use", "Acceptable Use Policy"]];

export const legalUrl = (page, loc = location) => `https://${loc.hostname.replace(/^app\./, "")}/${page}/`;

/** The sentence for the sign-in screen: signing in is agreeing to the three documents. */
export function legalNotice() {
  const [terms, privacy, use] = PAGES.map(([page, name]) => `<a href="${legalUrl(page)}" target="_blank" rel="noopener">${name}</a>`);
  return `<p class="hint" id="legalNotice">By signing in you agree to the ${terms} and the ${use}. The ${privacy} says what we collect and why.</p>`;
}
