import { readFileSync } from "node:fs";
import { App } from "aws-cdk-lib";

// cdk.json's context: our own settings (envName) and CDK's feature flags. The
// CDK CLI hands it to bin/app.ts (and the other apps in bin/) on every synth
// and deploy, so tests build their App with it too; without it, snapshots
// would miss what the flags change in the real templates.
export const CDK_JSON_CONTEXT: Readonly<Record<string, unknown>> = Object.freeze(
  JSON.parse(readFileSync(new URL("../cdk.json", import.meta.url), "utf8")).context,
);

// An App with cdk.json's context, as `cdk synth` builds it, plus:
// - version reporting off, which keeps snapshots stable across CDK upgrades
// - no bundling (tests don't run esbuild for the Lambda code)
// `context` adds to or overrides any of it.
export function testApp(context: Record<string, unknown> = {}): App {
  return new App({
    context: { ...CDK_JSON_CONTEXT, "aws:cdk:version-reporting": false, "aws:cdk:bundling-stacks": [], ...context },
  });
}
