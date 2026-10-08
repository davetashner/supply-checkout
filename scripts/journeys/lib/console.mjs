// The console errors the app logs in prod that aren't failures, for the prod fixtures' error
// check (tests/prod/fixtures.mjs and steps.mjs). Chromium logs "Failed to load resource" for
// every answer of 400 or more, with the resource's URL as the message's location.
import { PROD } from "./config.mjs";

const RUM = /^https:\/\/dataplane\.rum\.[a-z0-9-]+\.amazonaws\.com\//;
// One project or item: GET /teams/{teamId}/projects/{id} or /products/{key}
const DOCUMENT = /^\/teams\/[^/?#]+\/(?:projects|products)\/[^/?#]+$/;

const pathOf = (url, origin) => {
  try {
    const u = new URL(url);
    return u.origin === origin && !u.search ? u.pathname : null;
  } catch { return null; }
};

/**
 * Whether a console error isn't a failure:
 * - an aborted request to the RUM data plane (the fixtures abort them);
 * - the 401 of the token refresh before sign-in;
 * - a 404 for one project or item. The app fetches a document again when a live event says it
 *   changed (src/aws/db.js fetchDoc), and takes a 404 as "deleted": an event for an item's
 *   earlier save that arrives after the item was deleted (J2.3) fetches it once more and gets
 *   one. The page then drops the item, as it should, but Chromium still logs the 404.
 */
export function isExpectedConsoleError(text, url) {
  if (RUM.test(url ?? "") && /Failed to load resource|net::ERR_FAILED/.test(text)) return true;
  if (url === `${PROD.api}/auth/refresh` && /status of 401/.test(text)) return true;
  if (/^Failed to load resource: the server responded with a status of 404\b/.test(text) && DOCUMENT.test(pathOf(url, PROD.api) ?? "")) return true;
  return false;
}
