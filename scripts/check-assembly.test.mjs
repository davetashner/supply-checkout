// node --test scripts/check-assembly.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { assemblyProblems, bootstrapNames, hasControl, parseIdentity, PLACEHOLDER, plainName, q } from "./check-assembly.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-assembly.mjs");
const root = mkdtempSync(path.join(tmpdir(), "check-assembly-"));
after(() => rmSync(root, { recursive: true, force: true }));
const account = "111122223333"; // public-safety: allow (a fake ID)
const identity = { account, region: "us-east-1", qualifier: "hnb659fds" };
const args = ["--account", account, "--region", "us-east-1", "--qualifier", "hnb659fds"];
const role = (kind, acct = account) => `arn:\${AWS::Partition}:iam::${acct}:role/cdk-hnb659fds-${kind}-role-${acct}-us-east-1`;
const version = "/cdk-bootstrap/hnb659fds/version";

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
        "s.assets": { type: "cdk:asset-manifest", properties: { file: "s.assets.json", requiresBootstrapStackVersion: 6, bootstrapStackVersionSsmParameter: version } },
        s: {
          type: "aws:cloudformation:stack",
          environment: `aws://${account}/us-east-1`,
          additionalMetadataFile: "s.metadata.json",
          properties: {
            templateFile: "s.template.json",
            assumeRoleArn: role("deploy"),
            cloudFormationExecutionRoleArn: role("cfn-exec"),
            stackTemplateAssetObjectUrl: `s3://cdk-hnb659fds-assets-${account}-us-east-1/${"a".repeat(64)}.json`,
            requiresBootstrapStackVersion: 6,
            bootstrapStackVersionSsmParameter: version,
            lookupRole: { arn: role("lookup"), requiresBootstrapStackVersion: 8, bootstrapStackVersionSsmParameter: version },
          },
        },
        Tree: { type: "cdk:tree", properties: { file: "tree.json" } },
        flags: { type: "cdk:feature-flag-report", properties: { module: "aws-cdk-lib", flags: {} } },
      },
    },
    "s.template.json": { Resources: { Fn: { Type: "AWS::Lambda::Function", Metadata: { "aws:asset:path": "asset.abc" } } } },
    "s.assets.json": {
      files: {
        abc: {
          source: { path: "asset.abc", packaging: "zip" },
          destinations: { d: { bucketName: `cdk-hnb659fds-assets-${account}-us-east-1`, objectKey: "abc.zip", region: "us-east-1", assumeRoleArn: role("file-publishing") } },
        },
      },
    },
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
  assert.deepEqual(assemblyProblems(dir, identity), []);
  const run = spawnSync("node", [script, dir, ...args], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /check-assembly: the manifest names only files/);
});

test("refuses a templateFile that reaches outside the assembly", () => {
  writeFileSync(path.join(root, "outside.json"), "{}");
  const dir = assembly((f) => { f["manifest.json"].artifacts.s.properties.templateFile = "../outside.json"; });
  assert.deepEqual(assemblyProblems(dir), ['stack "s"\'s templateFile names "../outside.json", not a plain file name in the assembly']);
  const absolute = assembly((f) => { f["manifest.json"].artifacts.s.properties.templateFile = path.join(root, "outside.json"); });
  assert.match(assemblyProblems(absolute)[0], /templateFile names .*not a plain file name/);
  const run = spawnSync("node", [script, dir, ...args], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /The assembly isn't one the plan will read:\n {2}- stack "s"'s templateFile/);
});

test("refuses a missing entry (a context lookup)", () => {
  const dir = assembly((f) => { f["manifest.json"].missing = [{ key: "ssm:x", provider: "ssm", props: {} }]; });
  assert.deepEqual(assemblyProblems(dir), ["manifest.json has `missing` entries (context lookups); the plan does none"]);
  // Even an empty one
  assert.equal(assemblyProblems(assembly((f) => { f["manifest.json"].missing = []; })).length, 1);
});

test("refuses other artifact types and unexpected manifest keys", () => {
  const nested = assembly((f) => { f["manifest.json"].artifacts.inner = { type: "cdk:cloud-assembly", properties: { directoryName: "../x" } }; });
  assert.deepEqual(assemblyProblems(nested), ['artifact "inner" has type "cdk:cloud-assembly"; only aws:cloudformation:stack, cdk:asset-manifest, cdk:tree, cdk:feature-flag-report']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].extra = 1; })), ['manifest.json has an unexpected key "extra"']);
  assert.deepEqual(assemblyProblems(assembly((f) => { delete f["manifest.json"].artifacts; })), ["manifest.json has no artifacts"]);
});

test("refuses files the manifest names that are folders, links, missing or not plain", () => {
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.assets.json"] = undefined; })), ['asset manifest "s.assets"\'s file names "s.assets.json", which isn\'t a file in the assembly']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].artifacts.Tree.properties.file = "sub/tree.json"; })), ['tree "Tree"\'s file names "sub/tree.json", not a plain file name in the assembly']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].artifacts.s.additionalMetadataFile = ".hidden"; })), ['artifact "s"\'s additionalMetadataFile names ".hidden", not a plain file name in the assembly']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].artifacts.flags.properties.file = "../f"; })), ['artifact "flags"\'s file names "../f", not a plain file name in the assembly']);
  const link = assembly((f, dir) => { f["s.template.json"] = undefined; symlinkSync(path.join(root, "outside.json"), path.join(dir, "s.template.json")); });
  assert.deepEqual(assemblyProblems(link), ['stack "s"\'s templateFile names "s.template.json", which isn\'t a file in the assembly']);
  const folder = assembly((f, dir) => { f["s.template.json"] = undefined; mkdirSync(path.join(dir, "s.template.json")); });
  assert.match(assemblyProblems(folder)[0], /isn't a file in the assembly/);
});

test("checks nested stacks' templates and every aws:asset:path", () => {
  const nested = (assetPath, extra = {}) => assembly((f) => {
    f["s.template.json"].Resources.Nested = { Type: "AWS::CloudFormation::Stack", Metadata: { "aws:asset:path": assetPath } };
    Object.assign(f, extra);
  });
  assert.deepEqual(assemblyProblems(nested("n.nested.template.json", { "n.nested.template.json": { Resources: {} } })), []);
  assert.deepEqual(assemblyProblems(nested("../../outside.json")), ['"s.template.json": "Nested"\'s aws:asset:path names "../../outside.json", not a plain file name in the assembly']);
  // Inside a nested template, too
  const deeper = nested("n.nested.template.json", { "n.nested.template.json": { Resources: { Deep: { Type: "AWS::CloudFormation::Stack", Metadata: { "aws:asset:path": "/etc/passwd" } } } } });
  assert.deepEqual(assemblyProblems(deeper), ['"n.nested.template.json": "Deep"\'s aws:asset:path names "/etc/passwd", not a plain file name in the assembly']);
  // A loop is read once
  assert.deepEqual(assemblyProblems(nested("s.template.json")), []);
  // Other resources' asset paths need only be plain
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.template.json"].Resources.Fn.Metadata["aws:asset:path"] = "../x"; })), ['"s.template.json": "Fn"\'s aws:asset:path is "../x", not a plain name']);
});

test("checks asset manifests' sources", () => {
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.assets.json"].files.abc.source.path = "../../src"; })), ['"s.assets.json": asset "abc"\'s source path is "../../src", not a plain name']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.assets.json"].dockerImages = { img: { source: { directory: "/" } } }; })), ['"s.assets.json": asset "img"\'s source directory is "/", not a plain name']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.assets.json"].files.abc.source = { executable: ["sh", "-c", "env"] }; })), ['"s.assets.json": asset "abc" has an executable source; the plan runs nothing']);
});

test("refuses what isn't JSON, and a folder without a manifest", () => {
  assert.deepEqual(assemblyProblems(path.join(root, "nowhere")), ["no manifest.json in the assembly"]);
  assert.match(assemblyProblems(assembly((f) => { f["manifest.json"] = "{"; }))[0], /^manifest\.json isn't JSON/);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"] = "[]"; })), ["manifest.json isn't an object"]);
  assert.match(assemblyProblems(assembly((f) => { f["s.template.json"] = "nope"; }))[0], /^s\.template\.json isn't JSON/);
  const run = spawnSync("node", [script], { encoding: "utf8" });
  assert.equal(run.status, 2);
  // The command needs the identity
  for (const bad of [[], ["--account", "12345", "--region", "us-east-1", "--qualifier", "hnb659fds"], ["--account", account, "--region", "east", "--qualifier", "hnb659fds"], ["--account", account, "--region", "us-east-1", "--qualifier", "no/slash"], [...args, "--extra"]]) {
    const usage = spawnSync("node", [script, assembly(), ...bad], { encoding: "utf8" });
    assert.equal(usage.status, 2, bad.join(" "));
    assert.match(usage.stderr, /^usage: check-assembly\.mjs/);
  }
});

test("refuses control characters in identifiers, which the diff prints", () => {
  const nl = assembly((f) => { f["s.template.json"].Resources["Fn\n::error::x"] = { Type: "AWS::SNS::Topic" }; });
  assert.deepEqual(assemblyProblems(nl), ['"s.template.json": a name in Resources has a control character']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.template.json"].Outputs = { "O\r": {} }; })), ['"s.template.json": a name in Outputs has a control character']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.template.json"].Resources.Fn.Type = "AWS::X\u001b[2J"; })), ['"s.template.json": a resource type in Resources has a control character']);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].artifacts.s.displayName = "s\n::set-output name=x::y"; })), ["manifest.json.artifacts.s.displayName has a control character"]);
  assert.deepEqual(assemblyProblems(assembly((f) => { f["manifest.json"].artifacts.s.dependencies = ["a\u2028b"]; })), ["manifest.json.artifacts.s.dependencies[0] has a control character"]);
  // An artifact ID; the message itself carries no control character
  const id = assemblyProblems(assembly((f) => { f["manifest.json"].artifacts["t\n"] = { type: "cdk:tree", properties: { file: "tree.json" } }; }));
  assert.deepEqual(id, ["manifest.json.artifacts key has a control character"]);
  // Values inside a template (inline code, say) may have newlines
  assert.deepEqual(assemblyProblems(assembly((f) => { f["s.template.json"].Resources.Fn.Properties = { Code: { ZipFile: "a\nb" } }; })), []);
});

test("refuses bidi controls and other invisible formatting, and asset manifests' control characters", () => {
  for (const c of ["\u200e", "\u200f", "\u202a", "\u202b", "\u202c", "\u202d", "\u202e", "\u2066", "\u2067", "\u2068", "\u2069"]) {
    assert.equal(hasControl(`a${c}b`), true, c.codePointAt(0).toString(16));
  }
  for (const ok of ["plain", "caf\u00e9", "\u2030", "\u2065", "\u206a"]) assert.equal(hasControl(ok), false, ok);
  const rlo = assembly((f) => { f["s.template.json"].Resources["Fn\u202eTopic"] = { Type: "AWS::SNS::Topic" }; });
  assert.deepEqual(assemblyProblems(rlo), ['"s.template.json": a name in Resources has a control character']);
  const inAssets = assembly((f) => { f["s.assets.json"].files.abc.displayName = "x\n::error::y"; });
  assert.deepEqual(assemblyProblems(inAssets), ["s.assets.json.files.abc.displayName has a control character"]);
  const assetKey = assembly((f) => { f["s.assets.json"].files["a\u2066b"] = { source: { path: "asset.abc" } }; });
  assert.deepEqual(assemblyProblems(assetKey), ["s.assets.json.files key has a control character"]);
});

test("names from the assembly are quoted, printable ASCII only", () => {
  assert.equal(q("a\nb"), '"a\\nb"');
  assert.equal(q("x\u202ey"), '"x\\u202ey"');
  assert.equal(q(undefined), "undefined");
  assert.equal(q("x".repeat(300)).length, 201);
  // An artifact ID with a newline and a bidi control can't start a line or flip one in a problem
  const dir = assembly((f) => { f["manifest.json"].artifacts["t\n::error::\u202ex"] = { type: "cdk:cloud-assembly" }; });
  const problems = assemblyProblems(dir).filter((p) => p.startsWith("artifact"));
  assert.deepEqual(problems, ['artifact "t\\n::error::\\u202ex" has type "cdk:cloud-assembly"; only aws:cloudformation:stack, cdk:asset-manifest, cdk:tree, cdk:feature-flag-report']);
  for (const p of assemblyProblems(dir)) assert.match(p, /^[\x20-\x7e]*$/);
});

test("pins each stack to its ID, this account and region, and the CDK bootstrap's roles", () => {
  const stack = (change) => assemblyProblems(assembly((f) => change(f["manifest.json"].artifacts.s)), identity);
  assert.deepEqual(stack((s) => { s.properties.stackName = "s"; }), []);
  assert.deepEqual(stack((s) => { s.properties.stackName = "other"; }), ['stack "s"\'s stackName is "other", not its artifact ID; the plan diffs stacks by their IDs']);
  assert.deepEqual(stack((s) => { s.environment = "aws://210987654321/us-east-1"; }), ['stack "s"\'s environment isn\'t this account and the release\'s region']); // public-safety: allow (a fake ID)
  assert.deepEqual(stack((s) => { s.environment = `aws://${account}/us-west-2`; }), ['stack "s"\'s environment isn\'t this account and the release\'s region']);
  assert.deepEqual(stack((s) => { s.properties.assumeRoleArn = `arn:aws:iam::${account}:role/admin`; }), ['stack "s"\'s assumeRoleArn isn\'t the CDK bootstrap\'s deploy role for this account and region']);
  assert.deepEqual(stack((s) => { delete s.properties.assumeRoleArn; }), ['stack "s"\'s assumeRoleArn isn\'t the CDK bootstrap\'s deploy role for this account and region']);
  // The aws partition spelled out is the same role
  assert.deepEqual(stack((s) => { s.properties.assumeRoleArn = s.properties.assumeRoleArn.replace("${AWS::Partition}", "aws"); }), []);
  assert.deepEqual(stack((s) => { s.properties.cloudFormationExecutionRoleArn = role("deploy"); }), ['stack "s"\'s cloudFormationExecutionRoleArn isn\'t the CDK bootstrap\'s cfn-exec role for this account and region']);
  assert.deepEqual(stack((s) => { s.properties.lookupRole.arn = role("lookup", "210987654321"); }), ['stack "s"\'s lookupRole isn\'t the CDK bootstrap\'s lookup role for this account and region']); // public-safety: allow (a fake ID)
  assert.deepEqual(stack((s) => { s.properties.lookupRole = role("lookup"); }), ['stack "s"\'s lookupRole isn\'t the CDK bootstrap\'s lookup role for this account and region']);
  assert.deepEqual(stack((s) => { s.properties.lookupRole.assumeRoleExternalId = "x"; }), ['stack "s"\'s lookupRole has an unexpected key "assumeRoleExternalId"']);
  assert.deepEqual(stack((s) => { s.properties.assumeRoleAdditionalOptions = { Tags: [] }; }), ['stack "s" has assumeRoleAdditionalOptions; the plan assumes the bootstrap roles plainly']);
  assert.deepEqual(stack((s) => { s.properties.bootstrapStackVersionSsmParameter = "/other"; }), ['stack "s"\'s bootstrapStackVersionSsmParameter isn\'t /cdk-bootstrap/hnb659fds/version']);
  assert.deepEqual(stack((s) => { s.properties.stackTemplateAssetObjectUrl = "s3://someone-elses-bucket/x.json"; }), ['stack "s"\'s stackTemplateAssetObjectUrl isn\'t a template in the CDK bootstrap\'s bucket for this account and region']);
  // Another qualifier's roles aren't these
  assert.equal(assemblyProblems(assembly(), { ...identity, qualifier: "other" }).length, 9);
  // No problem names the account
  const all = stack((s) => { s.environment = "x"; s.properties.assumeRoleArn = "x"; s.properties.lookupRole = {}; s.properties.stackTemplateAssetObjectUrl = "x"; });
  assert.equal(all.length, 4);
  assert.equal(all.join("\n").includes(account), false);
  const asset = (change) => assemblyProblems(assembly((f) => change(f["s.assets.json"].files.abc.destinations.d, f)), identity);
  assert.deepEqual(asset((d) => { d.assumeRoleArn = role("deploy"); }), ['"s.assets.json": asset "abc"\'s destination "d"\'s assumeRoleArn isn\'t the CDK bootstrap\'s file-publishing role for this account and region']);
  assert.deepEqual(asset((d) => { d.bucketName = "elsewhere"; }), ['"s.assets.json": asset "abc"\'s destination "d"\'s bucketName isn\'t the CDK bootstrap\'s for this account and region']);
  assert.deepEqual(asset((d) => { d.region = "eu-west-1"; }), ['"s.assets.json": asset "abc"\'s destination "d"\'s region isn\'t the release\'s']);
  assert.deepEqual(asset((d) => { d.assumeRoleExternalId = "x"; }), ['"s.assets.json": asset "abc"\'s destination "d" has assumeRoleExternalId; the plan assumes the bootstrap roles plainly']);
  assert.deepEqual(asset((d, f) => { f["s.assets.json"].files.abc.destinations = undefined; }), ['"s.assets.json": asset "abc" has no destinations']);
  assert.deepEqual(asset((d, f) => { f["s.assets.json"].files.abc.destinations.e = "x"; }), ['"s.assets.json": asset "abc"\'s destination "e" isn\'t an object']);
  const image = (dest) => assemblyProblems(assembly((f) => { f["s.assets.json"].dockerImages = { img: { source: { directory: "asset.img" }, destinations: { d: dest } } }; }), identity);
  assert.deepEqual(image({ repositoryName: `cdk-hnb659fds-container-assets-${account}-us-east-1`, imageTag: "t", region: "us-east-1", assumeRoleArn: role("image-publishing") }), []);
  assert.deepEqual(image({ repositoryName: "other", assumeRoleArn: role("file-publishing") }), [
    '"s.assets.json": asset "img"\'s destination "d"\'s assumeRoleArn isn\'t the CDK bootstrap\'s image-publishing role for this account and region',
    '"s.assets.json": asset "img"\'s destination "d"\'s repositoryName isn\'t the CDK bootstrap\'s for this account and region',
  ]);
  const manifestParam = assemblyProblems(assembly((f) => { f["manifest.json"].artifacts["s.assets"].properties.bootstrapStackVersionSsmParameter = "/x"; }), identity);
  assert.deepEqual(manifestParam, ['asset manifest "s.assets"\'s bootstrapStackVersionSsmParameter isn\'t /cdk-bootstrap/hnb659fds/version']);
});

test("the identity can be the placeholder's, and the options are checked", () => {
  const placeholder = assembly((f) => {
    const text = JSON.stringify(f).replaceAll(account, PLACEHOLDER);
    Object.assign(f, JSON.parse(text));
  });
  assert.deepEqual(assemblyProblems(placeholder, { ...identity, account: PLACEHOLDER }), []);
  assert.equal(assemblyProblems(placeholder, identity).length > 0, true);
  assert.deepEqual(parseIdentity(args), { identity });
  assert.deepEqual(parseIdentity(["--account", PLACEHOLDER, "--region", "us-west-2", "--qualifier", "abc123"]), { identity: { account: PLACEHOLDER, region: "us-west-2", qualifier: "abc123" } });
  assert.match(parseIdentity(["--bogus", "x"]).error, /unexpected argument "--bogus"/);
  assert.match(parseIdentity(["--account"]).error, /unexpected argument "--account"/);
  assert.equal(bootstrapNames(identity).environment, `aws://${account}/us-east-1`);
});

test("plain names", () => {
  for (const ok of ["manifest.json", "a.template.json", "asset.abc", "x_y-z"]) assert.equal(plainName(ok), true, ok);
  for (const bad of ["", ".", "..", "../x", "a/b", "/x", ".hidden", "-n", "a\\b", 5, undefined, "x".repeat(202)]) assert.equal(plainName(bad), false, String(bad));
});
