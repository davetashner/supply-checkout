#!/usr/bin/env node
// Seals the deploy workflow's packed cloud assemblies for the public `cloud-assembly` artifact,
// and opens them again in the plan job (supply-checkout-pbp.39). assembly-pack.sh swaps the
// account ID for a placeholder, but the assembly also carries hashes computed over templates that
// held it (asset keys and object keys, stackTemplateAssetObjectUrl, nested templates' names), and
// a 12-digit ID can be brute-forced from one of those. So the whole packed folder is encrypted
// with a key only this repository's jobs hold: the repository secret DEPLOY_ASSEMBLY_KEY.
//
//   DEPLOY_ASSEMBLY_KEY=… node scripts/assembly-seal.mjs seal <packed folder> <sealed file>
//   DEPLOY_ASSEMBLY_KEY=… node scripts/assembly-seal.mjs open <sealed file> <new folder>
//
// seal  takes a folder of folders (backup-copy-true/, backup-copy-false/) of plain files, as
//       assembly-pack.sh writes them, and writes one file: AES-256-GCM over the files' names and
//       bytes, under a key derived from the secret with scrypt and a random salt.
// open  is for the plan job, which holds the production OIDC token: GCM's tag must check out
//       before anything is parsed, so a wrong key or a changed file fails closed. Then it takes
//       only names of the form <plain>/<plain>, once each, and writes them into a new folder.
//       The plan's hash check against the synth job's hash (on the unpacked assembly) is still
//       what proves the bytes; this only keeps them from the public.
//
// The key comes from the environment, never argv, and nothing here prints it. The synth job holds
// it too, so it hides the assembly from the public, not from the release's code (which knows the
// account anyway: it deploys into it).
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const KEY_ENV = "DEPLOY_ASSEMBLY_KEY";
export const MAGIC = Buffer.from("supply-checkout sealed assembly v1\n");
const SALT = 16;
const IV = 12;
const TAG = 16;
const SCRYPT = { N: 2 ** 14, r: 8, p: 1 };
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/;

export class SealError extends Error {}
const fail = (message) => {
  throw new SealError(message);
};

/** The secret from the environment, refused if it's missing or too short to be a real key. */
export function secretFrom(env) {
  const secret = env[KEY_ENV];
  if (!secret) fail(`${KEY_ENV} isn't set: make the repository secret with  openssl rand -base64 32 | gh secret set ${KEY_ENV}`);
  if (secret.length < 32) fail(`${KEY_ENV} is shorter than 32 characters: make a new one with  openssl rand -base64 32 | gh secret set ${KEY_ENV}`);
  return secret;
}

const keyFor = (secret, salt) => scryptSync(secret, salt, 32, SCRYPT);

/** Every file in a packed folder, as [relative path, bytes], refusing anything but folders of plain files. */
export function packedFiles(dir) {
  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) fail(`no folder ${dir}`);
  const files = [];
  for (const sub of readdirSync(dir).sort()) {
    if (!PLAIN.test(sub)) fail(`unexpected name in ${dir}: ${JSON.stringify(sub)}`);
    if (!lstatSync(path.join(dir, sub)).isDirectory()) fail(`${sub} isn't a folder`);
    for (const name of readdirSync(path.join(dir, sub)).sort()) {
      const file = path.join(dir, sub, name);
      if (!PLAIN.test(name)) fail(`unexpected name in ${sub}: ${JSON.stringify(name)}`);
      if (!lstatSync(file).isFile()) fail(`${sub}/${name} isn't a plain file`);
      files.push([`${sub}/${name}`, readFileSync(file)]);
    }
  }
  if (!files.length) fail(`nothing to seal in ${dir}`);
  return files;
}

/** The sealed bytes for these files. */
export function seal(files, secret) {
  const salt = randomBytes(SALT);
  const iv = randomBytes(IV);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret, salt), iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.from(JSON.stringify({ files: files.map(([name, bytes]) => [name, bytes.toString("base64")]) }));
  const sealed = Buffer.concat([cipher.update(body), cipher.final()]);
  return Buffer.concat([MAGIC, salt, iv, cipher.getAuthTag(), sealed]);
}

/** The files in sealed bytes, as [relative path, bytes]; throws unless the key and every byte check out. */
export function open(bytes, secret) {
  const head = MAGIC.length + SALT + IV + TAG;
  if (bytes.length <= head || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) fail("not a sealed assembly");
  const salt = bytes.subarray(MAGIC.length, MAGIC.length + SALT);
  const iv = bytes.subarray(MAGIC.length + SALT, MAGIC.length + SALT + IV);
  const tag = bytes.subarray(MAGIC.length + SALT + IV, head);
  let body;
  try {
    const decipher = createDecipheriv("aes-256-gcm", keyFor(secret, salt), iv, { authTagLength: TAG });
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(tag);
    body = Buffer.concat([decipher.update(bytes.subarray(head)), decipher.final()]);
  } catch {
    fail(`couldn't open it: ${KEY_ENV} isn't the key that sealed it, or the file was changed`);
  }
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    fail("what's sealed isn't a list of files");
  }
  if (!Array.isArray(parsed?.files)) fail("what's sealed isn't a list of files");
  const seen = new Set();
  return parsed.files.map((entry) => {
    const [name, data] = Array.isArray(entry) && entry.length === 2 ? entry : [];
    const parts = typeof name === "string" ? name.split("/") : [];
    if (parts.length !== 2 || !parts.every((p) => PLAIN.test(p))) fail(`unexpected name in the sealed assembly: ${JSON.stringify(name)}`);
    if (seen.has(name)) fail(`${name} is in the sealed assembly twice`);
    seen.add(name);
    if (typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) fail(`${name} isn't base64 in the sealed assembly`);
    return [name, Buffer.from(data, "base64")];
  });
}

/** Writes opened files into `dir`, which mustn't exist yet. */
export function writeFiles(files, dir) {
  if (lstatSync(dir, { throwIfNoEntry: false })) fail(`${dir} already exists`);
  mkdirSync(dir);
  for (const [name, bytes] of files) {
    const [sub] = name.split("/");
    if (!lstatSync(path.join(dir, sub), { throwIfNoEntry: false })) mkdirSync(path.join(dir, sub));
    writeFileSync(path.join(dir, name), bytes, { flag: "wx" });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [mode, from, to] = process.argv.slice(2);
  try {
    if (!["seal", "open"].includes(mode) || !from || !to) fail("usage: assembly-seal.mjs seal|open <from> <to>");
    const secret = secretFrom(process.env);
    if (mode === "seal") {
      const files = packedFiles(from);
      if (lstatSync(to, { throwIfNoEntry: false })) fail(`${to} already exists`);
      writeFileSync(to, seal(files, secret), { flag: "wx" });
      console.log(`Sealed ${files.length} files`);
    } else {
      if (!lstatSync(from, { throwIfNoEntry: false })?.isFile()) fail(`no sealed file ${from}`);
      const files = open(readFileSync(from), secret);
      writeFiles(files, to);
      console.log(`Opened ${files.length} files`);
    }
  } catch (e) {
    if (!(e instanceof SealError)) throw e;
    console.error(`assembly-seal: ${e.message}`);
    process.exit(1);
  }
}
