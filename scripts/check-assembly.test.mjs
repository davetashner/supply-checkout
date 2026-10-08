// node --test scripts/check-assembly.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assemblyProblems, plainName } from "./check-assembly.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-assembly.mjs");
const root = mkdtempSync(path.join(tmpdir(), "check-assembly-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
/** A small assembly like a real one, with `change` applied to its manifest and files first. */
function assembly(change = () => {}) {
  const dir = path.join(root, `a${n++}`);
  mkdirSync(dir);
  const files = {
    "manifest.json": {
      version: "48.0.0",
      minimumCliVersion: "2.1000.0",
      artifacts: {
        "s.assets": { type: "cdk:asset-manifest", properties: { file: "s.assets.json" } },
        s: { type: "aws:cloudformation:stack", environment: "aws://unknown-account/us-east-1", additionalMetadataFile: "s.metadata.json", properties: { templateFile: "s.template.json" } },
        Tree: { type: "cdk:tree", properties: { file: "tree.json" } },
        flags: { type: "cdk:feature-flag-report", properties: { module: "aws-cdk-lib", flags: {} } },
      },
    },
    "s.template.json": { Resources: { Fn: { Type: "AWS::Lambda::Function", Metadata: { "aws:asset:path": "asset.abc" } } } },
    "s.assets.json": { files: { abc: { source: { path: "asset.abc", packaging: "zip" } } } },
    "s.metadata.json": {},
    "tree.json": {},
  };
  change(files, dir);
  for (const [name, value] of Object.entries(files)) if (value !== undefined) writeFileSync(path.join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
  return dir;
}

test("a well-formed assembly passes, by the module and the command", () => {
  const dir = assembly();
  assert.deepEqual(assemblyProblems(dir), []);
  const run = spawnSync("node", [script, dir], { encoding: "utf8" });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /check-assembly: the manifest names only files/);
});

test("refuses a templateFile that reaches outside the assembly", () => {
  writeFileSync(path.join(root, "outside.json"), "{}");
  const dir = assembly((f) => { f["manifest.json"].artifacts.s.properties.templateFile = "../outside.json"; });
  assert.deepEqual(assemblyProblems(dir), ['stack s\'s templateFile names "../outside.json", not a plain file name in the assembly']);
  const absolute = assembly((f) => { f["manifest.json"].artifacts.s.properties.templateFile = path.join(root, "outside.json"); });
  assert.match(assemblyProblems(absolute)[0], /templateFile names .*not a plain file name/);
  const run = spawnSync("node", [script, dir], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /The assembly isn't one the plan will read:\n {2}- stack s's templateFile/);
});

test("refuses a missing entry (a context lookup)", () => {
  const dir = assembly((f) => { f["manifest.json"].missing = [{ key: "ssm:x", provider: "ssm", props: {} }]; });
  assert.deepEqual(assemblyProblems(dir), ["manifest.json has `missing` entries (context lookups); the plan does none"]);
  // Even an empty one
  assert.equal(assemblyProblems(assembly((f) => { f["manifest.json"].missing = []; })).length, 1);
});

test("refuses other artifact types and unexpected manifest keys", () => {
  const nested = assembly((f) => { f["manifest.json"].artifacts.inner = { type: "cdk:cloud-assembly", properties: { directoryName: "../x" } }; });
  assert.deepEqual(assemblyProblems(nested), ['artifact inner has type "cdk:cloud-assembly"; only aws:cloudformation:stack, cdk:asset-manifest, cdk:tree, cdk:feature-flag-report']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].extra = 1; })), ['manifest.json has an unexpected key "extra"']);
  assert.deepEqual(assemblyProblems(assembly((f) => { delete f["manifest.json"].artifacts; })), ["manifest.json has no artifacts"]);
});

test("refuses files the manifest names that are folders, links, missing or not plain", () => {
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.assets.json"] = undefined; })), ["asset manifest s.assets's file names s.assets.json, which isn't a file in the assembly"]);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].artifacts.Tree.properties.file = "sub/tree.json"; })), ['tree Tree\'s file names "sub/tree.json", not a plain file name in the assembly']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].artifacts.s.additionalMetadataFile = ".hidden"; })), ['artifact s\'s additionalMetadataFile names ".hidden", not a plain file name in the assembly']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].artifacts.flags.properties.file = "../f"; })), ['artifact flags\'s file names "../f", not a plain file name in the assembly']);
  const link = assembly((f, dir) => { f["s.template.json"] = undefined; symlinkSync(path.join(root, "outside.json"), path.join(dir, "s.template.json")); });
  assert.deepEqual(assemblyProblems(link), ["stack s's templateFile names s.template.json, which isn't a file in the assembly"]);
  const folder = assembly((f, dir) => { f["s.template.json"] = undefined; mkdirSync(path.join(dir, "s.template.json")); });
  assert.match(assemblyProblems(folder)[0], /isn't a file in the assembly/);
});

test("checks nested stacks' templates and every aws:asset:path", () => {
  const nested = (assetPath, extra = {}) => assembly((f) => {
    f["s.template.json"].Resources.Nested = { Type: "AWS::CloudFormation::Stack", Metadata: { "aws:asset:path": assetPath } };
    Object.assign(f, extra);
  });
  assert.deepEqual(assemblyProblems(nested("n.nested.template.json", { "n.nested.template.json": { Resources: {} } })), []);
  assert.deepEqual(assemblyProblems(nested("../../outside.json")), ['s.template.json: Nested\'s aws:asset:path names "../../outside.json", not a plain file name in the assembly']);
  // Inside a nested template, too
  const deeper = nested("n.nested.template.json", { "n.nested.template.json": { Resources: { Deep: { Type: "AWS::CloudFormation::Stack", Metadata: { "aws:asset:path": "/etc/passwd" } } } } });
  assert.deepEqual(assemblyProblems(deeper), ['n.nested.template.json: Deep\'s aws:asset:path names "/etc/passwd", not a plain file name in the assembly']);
  // A loop is read once
  assert.deepEqual(assemblyProblems(nested("s.template.json")), []);
  // Other resources' asset paths need only be plain
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.template.json"].Resources.Fn.Metadata["aws:asset:path"] = "../x"; })), ['s.template.json: Fn\'s aws:asset:path is "../x", not a plain name']);
});

test("checks asset manifests' sources", () => {
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.assets.json"].files.abc.source.path = "../../src"; })), ['s.assets.json: asset abc\'s source path is "../../src", not a plain name']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.assets.json"].dockerImages = { img: { source: { directory: "/" } } }; })), ['s.assets.json: asset img\'s source directory is "/", not a plain name']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.assets.json"].files.abc.source = { executable: ["sh", "-c", "env"] }; })), ["s.assets.json: asset abc has an executable source; the plan runs nothing"]);
});

test("refuses what isn't JSON, and a folder without a manifest", () => {
  assert.deepEqual(assemblyProblems(path.join(root, "nowhere")), ["no manifest.json in the assembly"]);
  assert.match(assemblyProblems(assembly((f) => { f["manifest.json"] = "{"; }))[0], /^manifest\.json isn't JSON/);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"] = "[]"; })), ["manifest.json isn't an object"]);
  assert.match(assemblyProblems(assembly((f) => { f["s.template.json"] = "nope"; }))[0], /^s\.template\.json isn't JSON/);
  const run = spawnSync("node", [script], { encoding: "utf8" });
  assert.equal(run.status, 2);
});

test("plain names", () => {
  for (const ok of ["manifest.json", "a.template.json", "asset.abc", "x_y-z"]) assert.equal(plainName(ok), true, ok);
  for (const bad of ["", ".", "..", "../x", "a/b", "/x", ".hidden", "-n", "a\\b", 5, undefined, "x".repeat(202)]) assert.equal(plainName(bad), false, String(bad));
});
