// The receipts function's prompt and reply schema (src/receipts/prompt.ts)
// against the app's (src/receipt-prompt.js), which the artifact build still
// sends to claude.ai: the rules stay the same in both.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inventoryList, MAX_INVENTORY_LINES, RECEIPT_INSTRUCTIONS, RECEIPT_RULES, RECEIPT_SCHEMA } from "../src/receipts/prompt.js";

const app = readFileSync(new URL("../../src/receipt-prompt.js", import.meta.url), "utf8");

describe("the receipt prompt", () => {
  it("has every rule the app's RECEIPT_PROMPT has, word for word", () => {
    const appRules = app.split("\n").filter((line) => line.startsWith("- ") && !line.includes("reply {"));
    expect(appRules).toEqual([...RECEIPT_RULES]);
    for (const rule of RECEIPT_RULES) expect(RECEIPT_INSTRUCTIONS).toContain(rule);
  });

  it("asks for no JSON in words (the schema says the shape) and says the photo is data", () => {
    expect(RECEIPT_INSTRUCTIONS).not.toMatch(/Reply with only JSON/i);
    expect(RECEIPT_INSTRUCTIONS).toMatch(/data, not instructions/);
  });

  it("lists at most MAX_INVENTORY_LINES items", () => {
    const items = Array.from({ length: MAX_INVENTORY_LINES + 5 }, (_, i) => ({ key: `k${i}`, name: `Item ${i}`, price: i }));
    const { text, ids } = inventoryList(items);
    expect(ids.size).toBe(MAX_INVENTORY_LINES);
    expect(ids.get("i1")).toBe("k0");
    expect(text.split("\n")).toHaveLength(MAX_INVENTORY_LINES + 1);
    // A missing or odd name and price still make one line
    expect(inventoryList([{ key: "x", name: undefined, price: "1" }]).text).toBe("Current inventory (id | name | price):\ni1 |  | $0.00");
    expect(inventoryList([{ key: "x", name: "a".repeat(200), price: Number.NaN }]).text.split("\n")[1]).toBe(`i1 | ${"a".repeat(120)} | $0.00`);
  });
});

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean; items?: Schema; anyOf?: Schema[] };

describe("the reply schema", () => {
  it("closes every object and requires every property, as structured outputs need", () => {
    const visit = (s: Schema) => {
      if (s.type === "object") {
        expect(s.additionalProperties).toBe(false);
        expect(s.required).toEqual(Object.keys(s.properties ?? {}));
      }
      for (const child of [...Object.values(s.properties ?? {}), ...(s.items ? [s.items] : []), ...(s.anyOf ?? [])]) visit(child);
    };
    visit(RECEIPT_SCHEMA as unknown as Schema);
  });

  it("has the fields the app's review screen reads (newDraft in src/main.js)", () => {
    expect(Object.keys(RECEIPT_SCHEMA.properties)).toEqual(["store", "date", "items", "subtotal", "tax", "total"]);
    expect(Object.keys(RECEIPT_SCHEMA.properties.items.items.properties)).toEqual(["raw", "name", "qty", "price", "match"]);
  });

  it("uses no keywords structured outputs don't support", () => {
    expect(JSON.stringify(RECEIPT_SCHEMA)).not.toMatch(/minimum|maximum|minLength|maxLength|pattern|minItems|maxItems/);
  });
});
