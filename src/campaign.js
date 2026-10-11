// Campaign tags (supply-checkout-kajm): which link a sign-up came from, so the owner can tell which
// channel each sign-up, trial and paying team came from. First-party only: the site, the demo and
// the app read utm_source, utm_medium and utm_campaign from their own URL, keep the cleaned values
// in this browser's own storage (sessionStorage on the site and the demo, localStorage in the app),
// and pass them on the link into the app (the site and the demo are another origin than app.<domain>).
// The app sends them once, with the request that creates the team, and forgets them. No pixel, no
// cookie, no third party ever sees them, and nothing else is kept: no full URL, no referrer.
//
// A value is a label: lower-case letters, digits, `_` and `-`, 1 to 64 characters (the API checks
// the same, backend/src/data/campaign.ts). Anything else is dropped. To carry a referral code later
// (supply-checkout-6os6), add its URL parameter to PARAMS here and its name to the backend's tags.
export const PARAMS = { utm_source: "source", utm_medium: "medium", utm_campaign: "campaign" };
export const STORAGE_KEY = "supplyCheckout.campaign";
// A tag is forgotten this long after it was seen: long enough to sign up, verify an email and come back
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const VALUE = /^[a-z0-9_-]{1,64}$/;

// The valid tags in a query string, or null: { source, medium, campaign }, any of them
export function readCampaign(search) {
  const params = new URLSearchParams(search);
  const tags = {};
  for (const [param, tag] of Object.entries(PARAMS)) {
    const value = (params.get(param) ?? "").toLowerCase();
    if (VALUE.test(value)) tags[tag] = value;
  }
  return Object.keys(tags).length ? tags : null;
}

// Storage can throw (blocked site data, a full quota): then nothing is kept, and the page works as before
const guard = (fn) => { try { return fn(); } catch { return null; } };

// Keeps `tags` in `storage` with the time. A newer tagged link replaces an older one; a visit
// without tags changes nothing.
export function saveCampaign(storage, tags, now = Date.now()) {
  if (tags) guard(() => storage.setItem(STORAGE_KEY, JSON.stringify({ tags, at: now })));
}

// The tags kept in `storage` and not yet too old, checked again (anyone can write to their own
// storage), or null
export function loadCampaign(storage, now = Date.now()) {
  const kept = guard(() => JSON.parse(storage.getItem(STORAGE_KEY)));
  if (!kept || typeof kept.at !== "number" || now - kept.at > KEEP_MS || now < kept.at) return null;
  return readCampaign(new URLSearchParams(Object.entries(PARAMS).map(([param, tag]) => [param, kept.tags?.[tag] ?? ""])));
}
