// The console errors the app logs in prod that aren't failures, for the prod fixtures' error
// check (tests/prod/fixtures.mjs and steps.mjs). Chromium logs "Failed to load resource" for
// every answer of 400 or more, with the resource's URL as the message's location.
import { PROD } from "./config.mjs";

const RUM = /^https:\/\/dataplane\.rum\.[a-z0-9-]+\.amazonaws\.com\//;
/**
 * Whether a console error isn't a failure:
 * - an aborted request to the RUM data plane (the fixtures abort them);
 * - the 401 of the token refresh before sign-in.
 * A 404 for a project or item is a failure: the app doesn't fetch a document it deleted, or one
 * a live event said was deleted, again for a late event about an earlier save (src/aws/db.js).
 */
export function isExpectedConsoleError(text, url) {
  if (RUM.test(url ?? "") && /Failed to load resource|net::ERR_FAILED/.test(text)) return true;
  if (url === `${PROD.api}/auth/refresh` && /status of 401/.test(text)) return true;
  return false;
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
