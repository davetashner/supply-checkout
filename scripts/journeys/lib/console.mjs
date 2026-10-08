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
 * - the 401 of the token refresh before sign-in.
 * A 404 for one project or item isn't one either, but isn't expected: see isDocumentNotFound.
 */
export function isExpectedConsoleError(text, url) {
  if (RUM.test(url ?? "") && /Failed to load resource|net::ERR_FAILED/.test(text)) return true;
  if (url === `${PROD.api}/auth/refresh` && /status of 401/.test(text)) return true;
  return false;
}

/** The annotation a test adds for each 404 for a project or item, counted in the run summary. */
export const NOT_FOUND_WARNING = "journeys-not-found";

/**
 * Whether a console error is a 404 for one project or item. The app doesn't fetch a document it
 * deleted, or one a live event said was deleted, again for a late event about an earlier save
 * (src/aws/db.js), but a race can still get one: a fetch in flight when the document is deleted,
 * or a delete and a new document under the same ID in the same second. The app takes the 404 as
 * "deleted", as it should, and the browser logs it. It's a warning in the summary, not a
 * failure: a failed run after a deploy fails the deploy, and this race mustn't fail a release.
 */
export function isDocumentNotFound(text, url) {
  return /^Failed to load resource: the server responded with a status of 404\b/.test(text) && DOCUMENT.test(pathOf(url, PROD.api) ?? "");
}

// The RUM web client gets guest credentials from Cognito Identity before it sends anything.
// WebKit reports that request failing when the team switch's reload cuts it off ("due to
// access control checks"), and the browser, not the app, reports it. The client's own failure
// that follows ("CWR: Failed to retrieve Cognito identity") is handled (src/aws/rum.js), so
// it's a failure if it's ever uncaught again.
const RUM_CREDENTIALS = /^(Fetch API cannot load )?(https:\/)?\/cognito-identity\.[a-z0-9-]+\.amazonaws\.com\/ due to access control checks\.$/;

/**
 * Whether an uncaught page error isn't a failure: only WebKit's report of the RUM client's
 * Cognito request cut off (the fixtures abort its data plane anyway, so a test session sends
 * no RUM events).
 */
export function isExpectedPageError(message) {
  return RUM_CREDENTIALS.test(String(message ?? ""));
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
