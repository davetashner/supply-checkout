// Campaign tags on the site and the demo (supply-checkout-kajm, src/campaign.js): the utm_source,
// utm_medium and utm_campaign of the link a visitor arrived by are kept for this tab (the demo is
// the same origin, so it shares them) and put on the links into the app, which is another origin
// and can't read them. Nothing leaves the browser except on those links; no third party sees them.
import { PARAMS, loadCampaign, readCampaign, saveCampaign } from "../src/campaign.js";

// `url` with the tags on it as utm_* parameters
function withCampaign(url, tags) {
  const out = new URL(url);
  for (const [param, tag] of Object.entries(PARAMS)) if (tags[tag]) out.searchParams.set(param, tags[tag]);
  return out.toString();
}

// Links into the app (https://app.<domain>/): the only kind of link this page has to another origin of ours
const intoApp = (a) => a.protocol === "https:" && a.hostname.startsWith("app.");

function carryCampaign() {
  const fresh = readCampaign(location.search);
  let storage = null;
  try { storage = sessionStorage; } catch { /* blocked site data: this page's own tags still go on its links */ }
  if (storage) saveCampaign(storage, fresh);
  const tags = fresh ?? (storage && loadCampaign(storage));
  if (!tags) return;
  for (const a of document.querySelectorAll("a[href]")) if (intoApp(a)) a.href = withCampaign(a.href, tags);
}

carryCampaign();
