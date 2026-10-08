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
//   - in every asset manifest, each source path or directory is a plain name, and nothing has an
//     `executable` source (a command to run)
//
//   node scripts/check-assembly.mjs <cdk.out directory>
//
// Exits 1 with the problems listed, 0 when there are none.
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ARTIFACT_TYPES = ["aws:cloudformation:stack", "cdk:asset-manifest", "cdk:tree", "cdk:feature-flag-report"];
export const MANIFEST_KEYS = ["version", "artifacts", "minimumCliVersion", "runtime"];
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

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

/** Every problem with the assembly in `dir`. */
export function assemblyProblems(dir) {
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
    if (!plainName(name)) problems.push(`${what} names ${JSON.stringify(name)}, not a plain file name in the assembly`);
    else if (!isFile(name)) problems.push(`${what} names ${name}, which isn't a file in the assembly`);
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
    if (key !== "missing" && !MANIFEST_KEYS.includes(key)) problems.push(`manifest.json has an unexpected key ${JSON.stringify(key)}`);
  }
  const artifacts = isMap(manifest.artifacts) ? manifest.artifacts : {};
  if (!isMap(manifest.artifacts)) problems.push("manifest.json has no artifacts");

  const templates = [];
  const assetManifests = [];
  for (const [id, artifact] of Object.entries(artifacts)) {
    const props = isMap(artifact?.properties) ? artifact.properties : {};
    const type = artifact?.type;
    if (!ARTIFACT_TYPES.includes(type)) {
      problems.push(`artifact ${id} has type ${JSON.stringify(type)}; only ${ARTIFACT_TYPES.join(", ")}`);
      continue;
    }
    if (artifact.additionalMetadataFile !== undefined) named(`artifact ${id}'s additionalMetadataFile`, artifact.additionalMetadataFile);
    if (type === "aws:cloudformation:stack") {
      if (named(`stack ${id}'s templateFile`, props.templateFile)) templates.push(props.templateFile);
    } else if (type === "cdk:asset-manifest") {
      if (named(`asset manifest ${id}'s file`, props.file)) assetManifests.push(props.file);
    } else if (type === "cdk:tree") {
      named(`tree ${id}'s file`, props.file);
    } else if (props.file !== undefined) {
      named(`artifact ${id}'s file`, props.file);
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
        if (hasControl(logicalId)) problems.push(`${name}: a name in ${section} has a control character`);
        if (section === "Resources" && hasControl(value?.Type)) problems.push(`${name}: a resource type in ${section} has a control character`);
      }
    }
    const resources = isMap(template?.Resources) ? template.Resources : {};
    for (const [logicalId, resource] of Object.entries(resources)) {
      const assetPath = isMap(resource?.Metadata) ? resource.Metadata["aws:asset:path"] : undefined;
      if (assetPath === undefined) continue;
      const what = `${name}: ${logicalId}'s aws:asset:path`;
      if (resource.Type === "AWS::CloudFormation::Stack") {
        if (named(what, assetPath)) templates.push(assetPath);
      } else if (!plainName(assetPath)) {
        problems.push(`${what} is ${JSON.stringify(assetPath)}, not a plain name`);
      }
    }
  }

  for (const name of assetManifests) {
    const assets = readJson(name);
    for (const [kind, key] of [["files", "path"], ["dockerImages", "directory"]]) {
      for (const [assetId, asset] of Object.entries(isMap(assets?.[kind]) ? assets[kind] : {})) {
        const source = isMap(asset?.source) ? asset.source : {};
        if (source.executable !== undefined) problems.push(`${name}: asset ${assetId} has an executable source; the plan runs nothing`);
        if (source[key] !== undefined && !plainName(source[key])) problems.push(`${name}: asset ${assetId}'s source ${key} is ${JSON.stringify(source[key])}, not a plain name`);
      }
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: check-assembly.mjs <cdk.out directory>");
    process.exit(2);
  }
  const problems = assemblyProblems(dir);
  if (problems.length) {
    console.error(`The assembly isn't one the plan will read:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  console.log("check-assembly: the manifest names only files in the assembly, and asks for no lookups");
}
