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

// The RUM web client gets guest credentials from Cognito Identity before it sends anything.
// When that request fails (WebKit reports a request cut off by the team switch's reload as
// failing "due to access control checks"), the client rejects without a handler.
const RUM_CREDENTIALS = [
  /^Error: CWR: Failed to retrieve Cognito identity\b/,
  /^(Fetch API cannot load )?(https:\/)?\/cognito-identity\.[a-z0-9-]+\.amazonaws\.com\/ due to access control checks\.$/,
];

/**
 * Whether an uncaught page error isn't a failure: only the RUM client failing to get its guest
 * credentials (the fixtures abort its data plane anyway, so a test session sends no RUM events).
 */
export function isExpectedPageError(message) {
  return RUM_CREDENTIALS.some((re) => re.test(String(message ?? "")));
}

/**
 * A console error as a test reports it: the text, and the resource's origin and path when the
 * message has one (no query or fragment, which can carry a token or code). The fixtures redact
 * it before it's shown, which masks the team IDs in a path.
 */
export function consoleFailure(text, url) {
  let where = "";
  try { const u = new URL(url); if (/^https?:$/.test(u.protocol)) where = ` (${u.origin}${u.pathname})`; } catch { /* no URL */ }
  return `console: ${text}${where}`;
}
