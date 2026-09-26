// The lint rule that keeps DynamoDB behind the data-access module (ADR 0005).

import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleIds(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.map((m) => m.ruleId) ?? [];
}

describe("direct DynamoDB client use", () => {
  it.each([
    ['import { DynamoDBClient } from "@aws-sdk/client-dynamodb";', "no-restricted-imports"],
    ['import { GetCommand } from "@aws-sdk/lib-dynamodb";', "no-restricted-imports"],
    ['export { QueryCommand } from "@aws-sdk/lib-dynamodb";', "no-restricted-imports"],
    ['export const m = await import("@aws-sdk/client-dynamodb");', "no-restricted-syntax"],
    ['export const m = require("@aws-sdk/lib-dynamodb");', "no-restricted-syntax"],
  ])("is banned outside src/data: %s", async (code, rule) => {
    expect(await ruleIds(code, "src/handlers/sheets.ts")).toContain(rule);
  });

  it("is allowed inside src/data", async () => {
    expect(await ruleIds('import { GetCommand } from "@aws-sdk/lib-dynamodb";\nexport { GetCommand };', "src/data/new-entity.ts")).toEqual([]);
  });

  it("leaves the data-access module itself open to handlers", async () => {
    expect(await ruleIds('import { getSheet } from "../data/index.js";\nexport { getSheet };', "src/handlers/sheets.ts")).toEqual([]);
  });
});
