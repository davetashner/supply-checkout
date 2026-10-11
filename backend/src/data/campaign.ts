// Where a team came from (supply-checkout-kajm): the campaign tags on the link
// that brought its first owner to the site, kept so the owner can tell which
// channel each sign-up, trial and paying team came from. First-party only: the
// site and the app read the tags from their own URL (src/campaign.js), pass
// them on the link into the app, and the app sends them once, with
// POST /teams. No pixel, no cookie, no third party ever sees them.
//
// Three names are kept, as the ad platforms' own tags: utm_source (where, e.g.
// google), utm_medium (how, e.g. cpc) and utm_campaign (which ad group or
// outreach). Each value is lower-case letters, digits, `_` and `-`, 1 to 64
// characters, so a tag is a label, never a URL, an address or free text. The
// client cleans them and so does this module, because the request is the
// caller's to write: anything else is left out, not repaired, and never makes
// the request fail (attribution must not stop a sign-up). Nothing else is
// stored: no full URL, no referrer, no IP address.
//
// Stored in two places, both written in the transaction that creates the team:
//
//   the team's META item   utmSource, utmMedium, utmCampaign   (read by the operators with BatchGetItem)
//   the owner's account    PK USER#<sub>  SK CAMPAIGN   the same three, and `capturedAt`; the first
//                          team's tags only (`if_not_exists`), so a second team never rewrites them
//
// A referral code (supply-checkout-6os6) joins them the same way: add its name
// to CAMPAIGN_TAGS (and CAMPAIGN_ATTRIBUTES in schema.ts), and the client's
// list in src/campaign.js.

import { InvalidInputError } from "./errors.js";

/** The tags, by the name the API and the stored attribute use. */
export const CAMPAIGN_TAGS = ["source", "medium", "campaign"] as const;
export type CampaignTag = (typeof CAMPAIGN_TAGS)[number];

/** A validated set of tags: any of them, never empty. */
export type Campaign = Readonly<Partial<Record<CampaignTag, string>>>;

/** The stored attribute for each tag, on the team's META item and the account's CAMPAIGN item. */
export const CAMPAIGN_ATTRIBUTE: Readonly<Record<CampaignTag, string>> = { source: "utmSource", medium: "utmMedium", campaign: "utmCampaign" };

const VALUE = /^[a-z0-9_-]{1,64}$/;

/**
 * The valid tags in `input` (a request's `campaign` field, or anything), or
 * undefined when there are none. An unknown name, a value that isn't a
 * string or doesn't match, or an input that isn't a plain object is dropped.
 * Values are lower-cased first, as the client does.
 */
export function parseCampaign(input: unknown): Campaign | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const out: Partial<Record<CampaignTag, string>> = {};
  for (const tag of CAMPAIGN_TAGS) {
    // Own properties only: a prototype's are never the caller's
    const value = Object.hasOwn(input, tag) ? (input as Record<string, unknown>)[tag] : undefined;
    if (typeof value !== "string" || value.length > 64) continue;
    const lower = value.toLowerCase();
    if (VALUE.test(lower)) out[tag] = lower;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Tags read from a stored item, defensively: whatever isn't a valid value is left out. */
export function storedCampaign(item: Record<string, unknown> | undefined): Campaign | undefined {
  if (!item) return undefined;
  const out: Partial<Record<CampaignTag, string>> = {};
  for (const tag of CAMPAIGN_TAGS) {
    const value = item[CAMPAIGN_ATTRIBUTE[tag]];
    if (typeof value === "string" && VALUE.test(value)) out[tag] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The attributes to put on an item for `campaign`. */
export function campaignAttributes(campaign: Campaign | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of CAMPAIGN_TAGS) {
    const value = campaign?.[tag];
    if (value !== undefined) out[CAMPAIGN_ATTRIBUTE[tag]] = value;
  }
  return out;
}

/** createTeam's input, checked again: a caller that skipped parseCampaign still can't store anything else. */
export function checkedCampaign(campaign: Campaign | undefined): Campaign | undefined {
  if (campaign === undefined) return undefined;
  const parsed = parseCampaign(campaign);
  if (!parsed || Object.keys(campaign).some((k) => (campaign as Record<string, unknown>)[k] !== (parsed as Record<string, unknown>)[k])) throw new InvalidInputError("Invalid campaign tags");
  return parsed;
}
