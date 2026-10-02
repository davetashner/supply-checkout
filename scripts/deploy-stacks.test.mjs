// node --test scripts/deploy-stacks.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { GROUPS, main, stackPatterns } from "./deploy-stacks.mjs";
import { DEFAULT_REGION } from "./publish-web.mjs";

const stacksDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "infra", "lib", "stacks");

/** Each stack's component and layer, as its constructor passes them to SupplyCheckoutStack. */
function stackLayers() {
  const layers = {};
  for (const file of readdirSync(stacksDir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(path.join(stacksDir, file), "utf8");
    for (const m of text.matchAll(/component: "([a-z-]+)", layer: "(stateful|stateless)"/g)) layers[m[1]] = m[2];
  }
  return layers;
}

test("each group's kinds are stacks in the app", () => {
  const layers = stackLayers();
  for (const kinds of Object.values(GROUPS)) {
    for (const kind of kinds) assert.ok(layers[kind], `no stack has component "${kind}"`);
  }
});

test("the stateless group holds only stateless stacks", () => {
  const layers = stackLayers();
  for (const kind of GROUPS.stateless) assert.equal(layers[kind], "stateless", kind);
  assert.deepEqual(GROUPS.stateless, ["api", "realtime", "observability"]);
});

test("patterns pick each kind in every region of the environment", () => {
  assert.deepEqual(stackPatterns("stateless"), [
    "supply-checkout-prod-*-api",
    "supply-checkout-prod-*-realtime",
    "supply-checkout-prod-*-observability",
  ]);
  assert.deepEqual(stackPatterns("web", "staging"), ["supply-checkout-staging-*-web"]);
});

test("refuses an unknown group or a malformed environment", () => {
  assert.throws(() => stackPatterns("data"), /Unknown group "data"/);
  assert.throws(() => stackPatterns("toString"), /Unknown group/);
  assert.throws(() => stackPatterns("stateless", "Prod*"), /--env must be/);
});

test("the command line prints space-separated patterns, or the region", () => {
  assert.equal(main(["stateless", "--env", "prod"]), "supply-checkout-prod-*-api supply-checkout-prod-*-realtime supply-checkout-prod-*-observability");
  assert.equal(main(["web"]), "supply-checkout-prod-*-web");
  assert.equal(main(["region"]), DEFAULT_REGION);
  assert.throws(() => main(["stateless", "--frob"]), /Unknown argument: --frob/);
  assert.throws(() => main(["stateless", "--env"]), /Unknown argument: --env/);
});
