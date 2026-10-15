// A product's size fields (src/data/dimensions.ts), without a database.
import { describe, expect, it } from "vitest";
import { InvalidInputError } from "../src/data/index.js";
import { checkDimensionFields, MAX_DIMENSION } from "../src/data/dimensions.js";

const check = (data: Record<string, unknown>) => { checkDimensionFields(data); return data; };

describe("checkDimensionFields", () => {
  it("leaves a product with no size alone, and drops a stray unit", () => {
    expect(check({ name: "Rags" })).toEqual({ name: "Rags" });
    expect(check({ name: "Rags", dimUnit: "cm" })).toEqual({ name: "Rags" });
    expect(check({ name: "Rags", dimUnit: null })).toEqual({ name: "Rags" });
  });

  it("keeps sides and their unit, and says inches when no unit is given", () => {
    expect(check({ length: 12, width: 6.5, height: 4, dimUnit: "cm" })).toEqual({ length: 12, width: 6.5, height: 4, dimUnit: "cm" });
    expect(check({ length: 12 })).toEqual({ length: 12, dimUnit: "in" });
    expect(check({ height: 0.25, dimUnit: null })).toEqual({ height: 0.25, dimUnit: "in" });
    expect(check({ length: MAX_DIMENSION })).toEqual({ length: MAX_DIMENSION, dimUnit: "in" });
  });

  it("removes a side written as null, and the unit once no side is left", () => {
    expect(check({ length: 12, width: null, height: null, dimUnit: "in" })).toEqual({ length: 12, dimUnit: "in" });
    expect(check({ length: null, width: null, height: null, dimUnit: "cm" })).toEqual({});
  });

  it.each([
    [{ length: "12" }],
    [{ width: 0 }],
    [{ height: -1 }],
    [{ length: Number.NaN }],
    [{ length: Number.POSITIVE_INFINITY }],
    [{ length: true }],
    [{ length: [12] }],
    [{ width: MAX_DIMENSION + 1 }],
    [{ height: 4.001 }],
    [{ length: 12, dimUnit: "ft" }],
    [{ length: 12, dimUnit: 12 }],
    [{ dimUnit: "mm", length: 3 }],
  ])("refuses %j", (data) => {
    expect(() => checkDimensionFields({ ...data })).toThrow(InvalidInputError);
  });
});
