// Phase 2 changes writeRegionFor to return a team's home region. Until the
// data layer can forward, a write routed elsewhere must fail, not land locally.

import { describe, expect, it, vi } from "vitest";
import { createDb } from "../src/data/index.js";
import { writable } from "../src/data/team-context.js";
import { contextFor, REGION } from "./helpers.js";

vi.mock("../src/data/region.js", async (original) => ({
  ...(await original<typeof import("../src/data/region.js")>()),
  writeRegionFor: (team: { homeRegion: string }) => team.homeRegion,
}));

describe("writable routes through writeRegionFor", () => {
  const db = createDb({ tableName: "offline", region: REGION, env: {} });

  it("allows a write routed to this region", async () => {
    const ctx = await contextFor("owner", REGION);
    expect(writable(db, ctx)).toBe(ctx);
  });

  it("refuses a write routed to another region", async () => {
    const ctx = await contextFor("owner", "home-elsewhere-1");
    expect(() => writable(db, ctx)).toThrow(/forwarding is phase 2/);
  });
});
