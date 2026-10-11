// Campaign tags (supply-checkout-kajm, src/data/campaign.ts): what is accepted, what is stored, and
// that the data role can never write them.

import { describe, expect, it } from "vitest";
import { CAMPAIGN_ATTRIBUTE, CAMPAIGN_TAGS, campaignAttributes, checkedCampaign, parseCampaign, storedCampaign } from "../src/data/campaign.js";
import { createTeam, InvalidInputError } from "../src/data/index.js";
import { CAMPAIGN_ATTRIBUTES, DATA_ROLE_DENIED_ATTRIBUTES, TEST_MARK_ATTRIBUTES } from "../src/data/schema.js";
import { MemoryTable } from "./memory-table.js";

describe("campaign tags", () => {
  it("name the same attributes the schema lists for IAM", () => {
    expect(CAMPAIGN_TAGS.map((t) => CAMPAIGN_ATTRIBUTE[t])).toEqual([...CAMPAIGN_ATTRIBUTES]);
    for (const a of CAMPAIGN_ATTRIBUTES) {
      // The data role may never write them, and the operators may read them from a team's META item
      expect(DATA_ROLE_DENIED_ATTRIBUTES).toContain(a);
      expect(TEST_MARK_ATTRIBUTES).toContain(a);
    }
    expect([...TEST_MARK_ATTRIBUTES]).toEqual(["PK", "SK", "test", "utmSource", "utmMedium", "utmCampaign"]);
  });

  it("are stored as attributes, only those present", () => {
    expect(campaignAttributes(undefined)).toEqual({});
    expect(campaignAttributes({ source: "a" })).toEqual({ utmSource: "a" });
    expect(campaignAttributes({ source: "a", medium: "b", campaign: "c" })).toEqual({ utmSource: "a", utmMedium: "b", utmCampaign: "c" });
  });

  it("are read back defensively from a stored item", () => {
    expect(storedCampaign(undefined)).toBeUndefined();
    expect(storedCampaign({})).toBeUndefined();
    expect(storedCampaign({ utmSource: "google", utmMedium: "Bad Value", utmCampaign: 3 })).toEqual({ source: "google" });
  });

  it("are checked again by createTeam, which refuses anything parseCampaign would have changed or dropped", async () => {
    expect(checkedCampaign(undefined)).toBeUndefined();
    expect(checkedCampaign({ source: "google" })).toEqual({ source: "google" });
    for (const bad of [{ source: "Google" }, { source: "a b" }, { source: "x".repeat(65) }, {}, { ref: "abc" }] as never[]) {
      expect(() => checkedCampaign(bad), JSON.stringify(bad)).toThrow(InvalidInputError);
    }
    const table = new MemoryTable();
    await expect(createTeam(table.db(), { userId: "u1" }, { name: "Echo", campaign: { source: "https://x.example" } as never })).rejects.toThrow(InvalidInputError);
    expect([...table.items.keys()]).toEqual([]);
    const ok = await createTeam(table.db(), { userId: "u1" }, { name: "Echo", campaign: parseCampaign({ source: "Google", medium: "cpc" }) });
    expect(table.get(`TEAM#${ok.team.teamId}`, "META")).toMatchObject({ utmSource: "google", utmMedium: "cpc" });
    expect(table.get(`TEAM#${ok.team.teamId}`, "META")).not.toHaveProperty("utmCampaign");
  });
});
