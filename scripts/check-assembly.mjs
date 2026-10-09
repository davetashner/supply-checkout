#!/usr/bin/env node
// Checks a cloud assembly that release code wrote before main's CDK CLI reads it in the deploy
// workflow's plan job (supply-checkout-pbp.39), which holds AWS credentials. cdk.out isn't inert
// to the CLI: manifest.json names the files it reads (a stack's templateFile, an asset manifest's
// file), so "../../elsewhere.json" would read outside the assembly, and its `missing` entries
// start context lookups (SSM, Cloud Control) with the job's credentials, whose answers could then
// reach the public diff. So, before the diff (which also runs with --no-lookups):
//
//   - manifest.json has only the keys CDK writes for this app, and no `missing` entry
//   - every artifact is a stack, an asset manifest, the tree or the feature flag report
//   - every file the manifest names (templateFile, file, additionalMetadataFile) is a plain name
//     (no folder, no ..) of a regular file in the assembly's folder
//   - in every template (nested ones too), each aws:asset:path is a plain name, and a nested
//     stack's is a regular file in the folder, checked in turn
//   - no control character (newline, carriage return, escape…) in manifest.json's keys or string
//     values (artifact IDs, displayName, dependencies…), or in a template's logical IDs, resource
//     types, or its outputs', parameters', conditions' and mappings' names: the diff prints them,
//     and a newline in one could start a line that looks like a workflow command
//   - in every asset manifest, each source path or directory is a plain name, nothing has an
//     `executable` source (a command to run), and no key or string value has a control character
//   - each stack is the one it says, in this account and the release's region: its stackName (if
//     it has one) is its artifact ID, its environment is aws://<account>/<region>, and its
//     roles (assumeRoleArn, cloudFormationExecutionRoleArn, lookupRole), its template's S3 URL,
//     its bootstrap version parameter and every asset destination's role, bucket, repository
//     and region are the standard CDK bootstrap ones for the qualifier, with no external ID or
//     other assume-role options. The CLI assumes those roles (with the lookup role's
//     credentials, so it can't reach more), and a stack named for another one would show the
//     approver another stack's diff.
//
// "Control character" includes the Unicode line separators and bidi controls (U+200E, U+200F,
// U+202A to U+202E, U+2066 to U+2069), which can make printed text read other than it is. Every
// name from the assembly in a problem is quoted with JSON.stringify, non-ASCII escaped, and no
// problem names the account.
//
//   node scripts/check-assembly.mjs <cdk.out directory> --account <ID> --region <region> --qualifier <qualifier>
//
// The account is the real one (in the plan job, after assembly-pack.sh unpack) or
// assembly-pack.sh's placeholder (before it).
//
// Exits 1 with the problems listed, 0 when there are none.
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACT_TYPES = ["aws:cloudformation:stack", "cdk:asset-manifest", "cdk:tree", "cdk:feature-flag-report"];
export const MANIFEST_KEYS = ["version", "artifacts", "minimumCliVersion", "runtime"];
export const PLACEHOLDER = "__SUPPLY_CHECKOUT_DEPLOY_ACCOUNT__";
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
// eslint-disable-next-line no-control-regex -- control characters are what it looks for
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A value from the assembly, quoted for a message: JSON, printable ASCII only, at most 200 characters. */
export const q = (value) => {
  const text = (value === undefined ? "undefined" : JSON.stringify(value)).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
};

/** The CDK bootstrap's names for an account, region and qualifier (DefaultStackSynthesizer). */
export function bootstrapNames({ account, region, qualifier }) {
  const role = (kind) => `iam::${account}:role/cdk-${qualifier}-${kind}-role-${account}-${region}`;
  return {
    environment: `aws://${account}/${region}`,
    deploy: role("deploy"),
    cfnExec: role("cfn-exec"),
    lookup: role("lookup"),
    filePublishing: role("file-publishing"),
    imagePublishing: role("image-publishing"),
    bucket: `cdk-${qualifier}-assets-${account}-${region}`,
    repository: `cdk-${qualifier}-container-assets-${account}-${region}`,
    versionParameter: `/cdk-bootstrap/${qualifier}/version`,
  };
}

/** Whether an ARN is this IAM resource, in the partition CDK writes (${AWS::Partition}) or aws. */
const isArn = (arn, resource) => arn === `arn:\${AWS::Partition}:${resource}` || arn === `arn:aws:${resource}`;
/** Keys that would change how the CLI assumes a role. */
const ASSUME_OPTIONS = ["assumeRoleExternalId", "assumeRoleAdditionalOptions"];
const LOOKUP_ROLE_KEYS = ["arn", "requiresBootstrapStackVersion", "bootstrapStackVersionSsmParameter"];

/** Whether a name is a plain file name: no folder, no .., no leading dot or dash. */
export const plainName = (name) => typeof name === "string" && PLAIN.test(name);

/** Whether a string has a control character in it. */
export const hasControl = (text) => typeof text === "string" && CONTROL.test(text);

/** Every key and string value in a parsed JSON value, with where it is. */
function* strings(value, where) {
  if (typeof value === "string") yield [value, where];
  else if (Array.isArray(value)) for (const [i, v] of value.entries()) yield* strings(v, `${where}[${i}]`);
  else if (isMap(value)) for (const [k, v] of Object.entries(value)) { yield [k, `${where} key`]; yield* strings(v, `${where}.${k}`); }
}

/** Every problem with the assembly in `dir`; with `identity` ({ account, region, qualifier }), its stacks' identity too. */
export function assemblyProblems(dir, identity) {
  const names = identity ? bootstrapNames(identity) : undefined;
  const problems = [];
  const isFile = (name) => {
    try {
      return lstatSync(path.join(dir, name)).isFile();
    } catch {
      return false;
    }
  };
  const readJson = (name) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, name), "utf8"));
    } catch (e) {
      problems.push(`${name} isn't JSON (${e.message.split("\n")[0]})`);
      return undefined;
    }
  };
  // A file the manifest names: a plain name of a regular file here
  const named = (what, name) => {
    if (!plainName(name)) problems.push(`${what} names ${q(name)}, not a plain file name in the assembly`);
    else if (!isFile(name)) problems.push(`${what} names ${q(name)}, which isn't a file in the assembly`);
    else return true;
    return false;
  };

  if (!isFile("manifest.json")) return ["no manifest.json in the assembly"];
  const manifest = readJson("manifest.json");
  if (!isMap(manifest)) return problems.length ? problems : ["manifest.json isn't an object"];
  for (const [text, where] of strings(manifest, "manifest.json")) {
    if (hasControl(text)) problems.push(`${where.replace(/[^\x20-\x7e]/g, "?")} has a control character`);
  }
  if (manifest.missing !== undefined) problems.push("manifest.json has `missing` entries (context lookups); the plan does none");
  for (const key of Object.keys(manifest)) {
    if (key !== "missing" && !MANIFEST_KEYS.includes(key)) problems.push(`manifest.json has an unexpected key ${q(key)}`);
  }
  const artifacts = isMap(manifest.artifacts) ? manifest.artifacts : {};
  if (!isMap(manifest.artifacts)) problems.push("manifest.json has no artifacts");

  const templates = [];
  const assetManifests = [];
  for (const [id, artifact] of Object.entries(artifacts)) {
    const props = isMap(artifact?.properties) ? artifact.properties : {};
    const type = artifact?.type;
    if (!ARTIFACT_TYPES.includes(type)) {
      problems.push(`artifact ${q(id)} has type ${q(type)}; only ${ARTIFACT_TYPES.join(", ")}`);
      continue;
    }
    if (artifact.additionalMetadataFile !== undefined) named(`artifact ${q(id)}'s additionalMetadataFile`, artifact.additionalMetadataFile);
    if (type === "aws:cloudformation:stack") {
      if (named(`stack ${q(id)}'s templateFile`, props.templateFile)) templates.push(props.templateFile);
      if (names) problems.push(...stackIdentityProblems(id, artifact, props, names));
    } else if (type === "cdk:asset-manifest") {
      if (named(`asset manifest ${q(id)}'s file`, props.file)) assetManifests.push(props.file);
      if (names && props.bootstrapStackVersionSsmParameter !== undefined && props.bootstrapStackVersionSsmParameter !== names.versionParameter) {
        problems.push(`asset manifest ${q(id)}'s bootstrapStackVersionSsmParameter isn't ${names.versionParameter}`);
      }
    } else if (type === "cdk:tree") {
      named(`tree ${q(id)}'s file`, props.file);
    } else if (props.file !== undefined) {
      named(`artifact ${q(id)}'s file`, props.file);
    }
  }

  // Templates, nested ones included (an AWS::CloudFormation::Stack's aws:asset:path)
  const seen = new Set();
  while (templates.length) {
    const name = templates.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const template = readJson(name);
    for (const section of ["Resources", "Outputs", "Parameters", "Conditions", "Mappings"]) {
      for (const [logicalId, value] of Object.entries(isMap(template?.[section]) ? template[section] : {})) {
        if (hasControl(logicalId)) problems.push(`${q(name)}: a name in ${section} has a control character`);
        if (section === "Resources" && hasControl(value?.Type)) problems.push(`${q(name)}: a resource type in ${section} has a control character`);
      }
    }
    const resources = isMap(template?.Resources) ? template.Resources : {};
    for (const [logicalId, resource] of Object.entries(resources)) {
      const assetPath = isMap(resource?.Metadata) ? resource.Metadata["aws:asset:path"] : undefined;
      if (assetPath === undefined) continue;
      const what = `${q(name)}: ${q(logicalId)}'s aws:asset:path`;
      if (resource.Type === "AWS::CloudFormation::Stack") {
        if (named(what, assetPath)) templates.push(assetPath);
      } else if (!plainName(assetPath)) {
        problems.push(`${what} is ${q(assetPath)}, not a plain name`);
      }
    }
  }

  for (const name of assetManifests) {
    const assets = readJson(name);
    for (const [text, where] of strings(assets, name)) {
      if (hasControl(text)) problems.push(`${where.replace(/[^\x20-\x7e]/g, "?")} has a control character`);
    }
    for (const [kind, key] of [["files", "path"], ["dockerImages", "directory"]]) {
      for (const [assetId, asset] of Object.entries(isMap(assets?.[kind]) ? assets[kind] : {})) {
        const source = isMap(asset?.source) ? asset.source : {};
        const what = `${q(name)}: asset ${q(assetId)}`;
        if (source.executable !== undefined) problems.push(`${what} has an executable source; the plan runs nothing`);
        if (source[key] !== undefined && !plainName(source[key])) problems.push(`${what}'s source ${key} is ${q(source[key])}, not a plain name`);
        if (names) problems.push(...destinationProblems(what, kind, asset?.destinations, names, identity.region));
      }
    }
  }
  return problems;
}

/** A stack that isn't the one it says, or isn't in this account and region with the bootstrap's roles. Names no account. */
function stackIdentityProblems(id, artifact, props, names) {
  const problems = [];
  const what = `stack ${q(id)}`;
  if (props.stackName !== undefined && props.stackName !== id) problems.push(`${what}'s stackName is ${q(props.stackName)}, not its artifact ID; the plan diffs stacks by their IDs`);
  if (artifact.environment !== names.environment) problems.push(`${what}'s environment isn't this account and the release's region`);
  if (!isArn(props.assumeRoleArn, names.deploy)) problems.push(`${what}'s assumeRoleArn isn't the CDK bootstrap's deploy role for this account and region`);
  if (!isArn(props.cloudFormationExecutionRoleArn, names.cfnExec)) problems.push(`${what}'s cloudFormationExecutionRoleArn isn't the CDK bootstrap's cfn-exec role for this account and region`);
  const lookup = props.lookupRole;
  if (!isMap(lookup) || !isArn(lookup.arn, names.lookup)) problems.push(`${what}'s lookupRole isn't the CDK bootstrap's lookup role for this account and region`);
  for (const key of Object.keys(isMap(lookup) ? lookup : {})) {
    if (!LOOKUP_ROLE_KEYS.includes(key)) problems.push(`${what}'s lookupRole has an unexpected key ${q(key)}`);
  }
  for (const key of ASSUME_OPTIONS) {
    if (props[key] !== undefined) problems.push(`${what} has ${key}; the plan assumes the bootstrap roles plainly`);
  }
  for (const parameter of [props.bootstrapStackVersionSsmParameter, isMap(lookup) ? lookup.bootstrapStackVersionSsmParameter : undefined]) {
    if (parameter !== undefined && parameter !== names.versionParameter) problems.push(`${what}'s bootstrapStackVersionSsmParameter isn't ${names.versionParameter}`);
  }
  const url = props.stackTemplateAssetObjectUrl;
  if (url !== undefined && !(typeof url === "string" && url.startsWith(`s3://${names.bucket}/`) && /^[0-9a-f]{64}\.json$/.test(url.slice(`s3://${names.bucket}/`.length)))) {
    problems.push(`${what}'s stackTemplateAssetObjectUrl isn't a template in the CDK bootstrap's bucket for this account and region`);
  }
  return problems;
}

/** An asset destination that isn't the bootstrap's bucket or repository, publishing role and region. Names no account. */
function destinationProblems(what, kind, destinations, names, region) {
  if (!isMap(destinations)) return [`${what} has no destinations`];
  const problems = [];
  const [role, roleName, place, placeKey] = kind === "files"
    ? [names.filePublishing, "file-publishing", names.bucket, "bucketName"]
    : [names.imagePublishing, "image-publishing", names.repository, "repositoryName"];
  for (const [destId, dest] of Object.entries(destinations)) {
    const where = `${what}'s destination ${q(destId)}`;
    if (!isMap(dest)) {
      problems.push(`${where} isn't an object`);
      continue;
    }
    if (!isArn(dest.assumeRoleArn, role)) problems.push(`${where}'s assumeRoleArn isn't the CDK bootstrap's ${roleName} role for this account and region`);
    if (dest[placeKey] !== place) problems.push(`${where}'s ${placeKey} isn't the CDK bootstrap's for this account and region`);
    if (dest.region !== undefined && dest.region !== region) problems.push(`${where}'s region isn't the release's`);
    for (const key of ASSUME_OPTIONS) {
      if (dest[key] !== undefined) problems.push(`${where} has ${key}; the plan assumes the bootstrap roles plainly`);
    }
  }
  return problems;
}

/** The --account, --region and --qualifier options, or the problem with them. */
export function parseIdentity(args) {
  const identity = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = { "--account": "account", "--region": "region", "--qualifier": "qualifier" }[args[i]];
    if (!key || args[i + 1] === undefined) return { error: `unexpected argument ${q(args[i])}` };
    identity[key] = args[i + 1];
  }
  if (!(/^[0-9]{12}$/.test(identity.account ?? "") || identity.account === PLACEHOLDER)) return { error: "--account must be a 12-digit account ID or assembly-pack.sh's placeholder" };
  if (!/^[a-z]{2}(-[a-z]+)+-[0-9]$/.test(identity.region ?? "")) return { error: "--region must be an AWS region" };
  if (!/^[A-Za-z0-9]{1,10}$/.test(identity.qualifier ?? "")) return { error: "--qualifier must be a CDK bootstrap qualifier (up to 10 letters and digits)" };
  return { identity };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [dir, ...rest] = process.argv.slice(2);
  const { identity, error } = parseIdentity(rest);
  if (!dir || error) {
    console.error(`usage: check-assembly.mjs <cdk.out directory> --account <ID> --region <region> --qualifier <qualifier>${error ? ` (${error})` : ""}`);
    process.exit(2);
  }
  const problems = assemblyProblems(dir, identity);
  if (problems.length) {
    console.error(`The assembly isn't one the plan will read:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("check-assembly: the manifest names only files in the assembly, asks for no lookups, and its stacks are this account's and region's, with the CDK bootstrap's roles");
}
