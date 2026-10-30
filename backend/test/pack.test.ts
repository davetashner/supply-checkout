// A product's pack fields (src/data/pack.ts), without a database.
import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../src/data/index.js";
import { checkPackFields, costEach, MAX_PACK_SIZE } from "../src/data/pack.js";

const check = (data: Record<string, unknown>, stored?: Record<string, unknown>) => { checkPackFields(data, stored); return data; };

describe("costEach", () => {
  it("rounds the cost of one to cents, halves up", () => {
    expect(costEach(6.99, 4)).toBe(1.75);
    expect(costEach(6.99, 3)).toBe(2.33);
    expect(costEach(6.99, 12)).toBe(0.58);
    expect(costEach(0.1, 4)).toBe(0.03);
    expect(costEach(10.05, 10)).toBe(1.01);
  });
});

describe("checkPackFields", () => {
  it("leaves a product with no pack alone", () => {
    expect(check({ name: "Rags", cost: 1 })).toEqual({ name: "Rags", cost: 1 });
  });

  it("keeps a pack cost exactly, with the cost of one that goes with it", () => {
    expect(check({ packSize: 4, packCost: 6.99, cost: 1.75 })).toEqual({ packSize: 4, packCost: 6.99, cost: 1.75 });
    expect(check({ packSize: MAX_PACK_SIZE, packCost: 1000, cost: 0.1 })).toEqual({ packSize: MAX_PACK_SIZE, packCost: 1000, cost: 0.1 });
    // Floating-point noise counts as the cents the person saw
    expect(check({ packSize: 2, packCost: 0.1 + 0.2, cost: 0.15 })).toEqual({ packSize: 2, packCost: 0.3, cost: 0.15 });
  });

  it("removes a pack cost written as null", () => {
    expect(check({ packSize: 4, packCost: null, cost: 2 })).toEqual({ packSize: 4, cost: 2 });
  });

  it("lets a write carry over a pack size stored before it was checked, but not change to one", () => {
    expect(check({ name: "Rags", packSize: 2.5 }, { packSize: 2.5 })).toEqual({ name: "Rags", packSize: 2.5 });
    expect(() => check({ packSize: 2.5 }, { packSize: 2 })).toThrow(InvalidInputError);
  });

  it("rounds a stored pack cost a write carries over, and checks a changed one", () => {
    expect(check({ packSize: 2, packCost: 3.004, cost: 1.5 }, { packCost: 3.004 })).toEqual({ packSize: 2, packCost: 3, cost: 1.5 });
    expect(() => check({ packSize: 2, packCost: 3.004, cost: 1.5 }, { packCost: 3 })).toThrow(InvalidInputError);
  });

  it.each([
    [{ packSize: 0 }],
    [{ packSize: -2 }],
    [{ packSize: 2.5 }],
    [{ packSize: "4" }],
    [{ packSize: MAX_PACK_SIZE + 1 }],
    [{ packSize: 4, packCost: -1, cost: 0 }],
    [{ packSize: 4, packCost: 6.999, cost: 1.75 }],
    [{ packSize: 4, packCost: "6.99", cost: 1.75 }],
    [{ packSize: 4, packCost: 1_000_001, cost: 250_000.25 }],
    // A pack cost needs a pack of more than one
    [{ packCost: 6.99, cost: 6.99 }],
    [{ packSize: 1, packCost: 6.99, cost: 6.99 }],
    [{ packSize: "4", packCost: 6.99, cost: 1.75 }],
    // ...and the cost of one that goes with it
    [{ packSize: 4, packCost: 6.99 }],
    [{ packSize: 4, packCost: 6.99, cost: 1.74 }],
    [{ packSize: 4, packCost: 6.99, cost: "1.75" }],
  ])("refuses %j", (data) => {
    expect(() => check(data)).toThrow(InvalidInputError);
  });
});
