// The lint rules that keep DynamoDB, and the module's internals, behind the
// data-access module's entry point (ADR 0005). Each case is linted as if it
// were a handler file outside src/data.

import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd });

async function ruleIds(code: string, filePath: string) {
  const [result] = await eslint.lintText(`${code}\nexport {};`, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId).filter((r) => r?.startsWith("no-restricted-"));
}

const HANDLER = "src/handlers/sheets.ts";

describe("direct DynamoDB client use", () => {
  it.each([
    ['import { DynamoDBClient } from "@aws-sdk/client-dynamodb";', "no-restricted-imports"],
    ['import { GetCommand } from "@aws-sdk/lib-dynamodb";', "no-restricted-imports"],
    ['import { GetCommand } from "@aws-sdk/lib-dynamodb/dist-cjs/index.js";', "no-restricted-imports"],
    ['import { DynamoDBClient } from "@aws-sdk/client-dynamodb/dist-es/index.js";', "no-restricted-imports"],
    ['import { unmarshall } from "@aws-sdk/util-dynamodb";', "no-restricted-imports"],
    ['import { DynamoDBStreamsClient } from "@aws-sdk/client-dynamodb-streams";', "no-restricted-imports"],
    ['export { QueryCommand } from "@aws-sdk/lib-dynamodb";', "no-restricted-imports"],
    ['export const m = await import("@aws-sdk/client-dynamodb");', "no-restricted-syntax"],
    ['export const m = await import("@aws-sdk/lib-dynamodb/dist-cjs/index.js");', "no-restricted-syntax"],
    ['export const m = require("@aws-sdk/lib-dynamodb");', "no-restricted-syntax"],
  ])("is banned outside src/data: %s", async (code, rule) => {
    expect(await ruleIds(code, HANDLER)).toContain(rule);
  });

  it("leaves other AWS SDK clients alone", async () => {
    expect(await ruleIds('import { S3Client } from "@aws-sdk/client-s3";', HANDLER)).toEqual([]);
  });

  it("is allowed inside src/data", async () => {
    expect(await ruleIds('import { GetCommand } from "@aws-sdk/lib-dynamodb";', "src/data/new-entity.ts")).toEqual([]);
  });
});

describe("the data-access module's internals", () => {
  it.each([
    // The review's forgery: a deep import of the context file
    ['import { authorizeTeam } from "../data/team-context.js";', "no-restricted-imports"],
    ['import { connection } from "../data/client.js";', "no-restricted-imports"],
    ['import { keys } from "../data/keys.js";', "no-restricted-imports"],
    ['import { connection } from "../../src/data/client.js";', "no-restricted-imports"],
    ['export * from "../data/team-context.js";', "no-restricted-imports"],
    ['export const m = await import("../data/client.js");', "no-restricted-syntax"],
    ['export const m = require("../data/team-context.js");', "no-restricted-syntax"],
  ])("are banned outside src/data: %s", async (code, rule) => {
    expect(await ruleIds(code, HANDLER)).toContain(rule);
  });

  it("are open through the entry point", async () => {
    expect(await ruleIds('import { getSheet } from "../data/index.js";', HANDLER)).toEqual([]);
    expect(await ruleIds('export const m = await import("../data/index.js");', HANDLER)).toEqual([]);
  });

  it("are open to the module itself", async () => {
    expect(await ruleIds('import { connection } from "./client.js";\nimport { keys } from "../data/keys.js";', "src/data/new-entity.ts")).toEqual([]);
  });
});
