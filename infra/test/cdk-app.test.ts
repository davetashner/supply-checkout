import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CDK_JSON_CONTEXT, testApp } from "./cdk-app.js";

const cdkJson = JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")) as { context: Record<string, unknown> };
// Feature flags are the namespaced keys (`@aws-cdk/...`); the rest is our own config
const flags = (context: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(context).filter(([key]) => key.startsWith("@aws-cdk")));

describe("the test App", () => {
  it("has exactly cdk.json's feature flags, as bin/app.ts does under `cdk synth`", () => {
    const flagKeys = Object.keys(flags(cdkJson.context));
    expect(flagKeys.length).toBeGreaterThan(0);
    const app = testApp();
    const applied = Object.fromEntries(flagKeys.map((key) => [key, app.node.tryGetContext(key)]));
    expect(applied).toEqual(flags(cdkJson.context));
    expect(flags(CDK_JSON_CONTEXT)).toEqual(flags(cdkJson.context));
  });

  it("has the rest of cdk.json's context too", () => {
    const app = testApp();
    for (const [key, value] of Object.entries(cdkJson.context)) expect(app.node.tryGetContext(key), key).toEqual(value);
  });

  it("turns off version reporting and bundling, and lets a test add or override context", () => {
    const app = testApp({ envName: "staging", backupCopy: "false" });
    expect(app.node.tryGetContext("aws:cdk:version-reporting")).toBe(false);
    expect(app.node.tryGetContext("aws:cdk:bundling-stacks")).toEqual([]);
    expect(app.node.tryGetContext("envName")).toBe("staging");
    expect(app.node.tryGetContext("backupCopy")).toBe("false");
    // Overriding doesn't change what other tests get
    expect(testApp().node.tryGetContext("envName")).toBe(cdkJson.context.envName);
  });
});
