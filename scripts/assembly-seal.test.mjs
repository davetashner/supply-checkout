// node --test scripts/assembly-seal.test.mjs (part of npm run test:scripts)
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { hashHmac, KEY_ENV, MAGIC, open, seal, secretFrom } from "./assembly-seal.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "assembly-seal.mjs");
const root = mkdtempSync(path.join(tmpdir(), "assembly-seal-"));
after(() => rmSync(root, { recursive: true, force: true }));
// A made-up key, built so it reads as nothing like one (gitleaks)
const key = "test key ".repeat(5);
const run = (args, env = { [KEY_ENV]: key }, input = undefined) => spawnSync("node", [script, ...args], { encoding: "utf8", input, env: { PATH: process.env.PATH, ...env } });
const template = '{"Resources":{"R":{"Type":"AWS::SNS::Topic"}}}';
const sha = (text) => createHash("sha256").update(text).digest("hex");

let n = 0;
/** A packed folder like the synth job's: two folders of plain files. */
function packed() {
  const dir = path.join(root, `p${n++}`);
  for (const copy of ["backup-copy-true", "backup-copy-false"]) {
    mkdirSync(path.join(dir, copy), { recursive: true });
    writeFileSync(path.join(dir, copy, "manifest.json"), `{"copy":"${copy}"}`);
    writeFileSync(path.join(dir, copy, "s.template.json"), template);
  }
  return dir;
}

test("seals and opens to the same bytes, and the sealed file shows neither names nor contents nor hashes", () => {
  const dir = packed();
  const file = path.join(root, "a.sealed");
  const sealed = run(["seal", dir, file]);
  assert.equal(sealed.status, 0, sealed.stderr);
  assert.equal(sealed.stdout, "Sealed 4 files\n");
  const bytes = readFileSync(file);
  for (const plain of ["manifest.json", "backup-copy-true", "AWS::SNS::Topic", sha(template)]) assert.equal(bytes.includes(plain), false, plain);
  assert.equal(bytes.toString("latin1").includes(key), false);
  const opened = run(["open", file, path.join(root, "a.out")]);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.stdout, "Opened 4 files\n");
  for (const copy of ["backup-copy-true", "backup-copy-false"]) {
    for (const name of ["manifest.json", "s.template.json"]) {
      assert.deepEqual(readFileSync(path.join(root, "a.out", copy, name)), readFileSync(path.join(dir, copy, name)));
    }
  }
  // A fresh salt and IV each time
  assert.notDeepEqual(seal([["a/b", Buffer.from("x")]], key), seal([["a/b", Buffer.from("x")]], key));
  // Nothing printed names the key
  assert.equal(`${sealed.stdout}${sealed.stderr}${opened.stdout}${opened.stderr}`.includes(key), false);
});

test("fails closed on the wrong key or a changed byte", () => {
  const bytes = seal([["a/b", Buffer.from("x")]], key);
  assert.throws(() => open(bytes, `${key}-other`), /isn't the key that sealed it, or the file was changed/);
  for (const at of [MAGIC.length, MAGIC.length + 20, MAGIC.length + 30, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[at] ^= 1;
    assert.throws(() => open(changed, key), /isn't the key that sealed it, or the file was changed/, String(at));
  }
  const changedMagic = Buffer.from(bytes);
  changedMagic[0] ^= 1;
  assert.throws(() => open(changedMagic, key), /not a sealed assembly/);
  assert.throws(() => open(bytes.subarray(0, MAGIC.length + 44), key), /not a sealed assembly/);
  // By the command, too
  const file = path.join(root, "wrong.sealed");
  writeFileSync(file, bytes);
  const wrong = run(["open", file, path.join(root, "wrong.out")], { [KEY_ENV]: `${key}-other` });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /^assembly-seal: couldn't open it/);
});

test("open takes only <plain>/<plain> names, once each, as base64", () => {
  for (const name of ["../x", "a/../b", "/etc/passwd", "a", "a/b/c", ".a/b", "a/-b", 5]) {
    assert.throws(() => open(seal([[name, Buffer.from("x")]], key), key), /unexpected name in the sealed assembly/, String(name));
  }
  assert.throws(() => open(seal([["a/b", Buffer.from("x")], ["a/b", Buffer.from("y")]], key), key), /a\/b is in the sealed assembly twice/);
  assert.deepEqual(open(seal([["a/b", Buffer.from("x")]], key), key), [["a/b", Buffer.from("x")]]);
});

test("seal takes only folders of plain files", () => {
  const link = packed();
  symlinkSync("/etc/passwd", path.join(link, "backup-copy-true", "passwd"));
  assert.match(run(["seal", link, path.join(root, "x.sealed")]).stderr, /backup-copy-true\/passwd isn't a plain file/);
  const fileAtTop = packed();
  writeFileSync(path.join(fileAtTop, "stray.json"), "{}");
  assert.match(run(["seal", fileAtTop, path.join(root, "x.sealed")]).stderr, /stray\.json isn't a folder/);
  const badName = packed();
  writeFileSync(path.join(badName, "backup-copy-true", "-n"), "{}");
  assert.match(run(["seal", badName, path.join(root, "x.sealed")]).stderr, /unexpected name in backup-copy-true: "-n"/);
  const folder = packed();
  mkdirSync(path.join(folder, "backup-copy-true", "sub"));
  assert.match(run(["seal", folder, path.join(root, "x.sealed")]).stderr, /backup-copy-true\/sub isn't a plain file/);
  const empty = path.join(root, "empty");
  mkdirSync(empty);
  assert.match(run(["seal", empty, path.join(root, "x.sealed")]).stderr, /nothing to seal/);
  assert.match(run(["seal", path.join(root, "nowhere"), path.join(root, "x.sealed")]).stderr, /no folder/);
});

test("won't write over anything", () => {
  const dir = packed();
  const file = path.join(root, "once.sealed");
  assert.equal(run(["seal", dir, file]).status, 0);
  assert.match(run(["seal", dir, file]).stderr, /already exists/);
  assert.equal(run(["open", file, path.join(root, "once.out")]).status, 0);
  assert.match(run(["open", file, path.join(root, "once.out")]).stderr, /already exists/);
  assert.match(run(["open", path.join(root, "nowhere.sealed"), path.join(root, "x.out")]).stderr, /no sealed file/);
  // A link to a sealed file isn't followed
  symlinkSync(file, path.join(root, "link.sealed"));
  assert.match(run(["open", path.join(root, "link.sealed"), path.join(root, "link.out")]).stderr, /no sealed file/);
});

test("refuses a missing or short key, naming the secret, and bad usage", () => {
  assert.throws(() => secretFrom({}), /DEPLOY_ASSEMBLY_KEY isn't set: make the repository secret with {2}openssl rand -base64 32 \| gh secret set DEPLOY_ASSEMBLY_KEY/);
  assert.throws(() => secretFrom({ [KEY_ENV]: "" }), /isn't set/);
  assert.throws(() => secretFrom({ [KEY_ENV]: "short" }), /shorter than 32 characters/);
  assert.equal(secretFrom({ [KEY_ENV]: key }), key);
  const missing = run(["seal", packed(), path.join(root, "y.sealed")], {});
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /DEPLOY_ASSEMBLY_KEY isn't set/);
  assert.match(run(["unseal", "a", "b"]).stderr, /usage/);
  assert.match(run(["seal", "a"]).stderr, /usage/);
});

test("hmac gives HMAC-SHA256(key, hash) of an assembly hash, and nothing for anything else", () => {
  const hash = sha("an assembly");
  const expected = createHmac("sha256", key).update(hash).digest("hex");
  assert.equal(hashHmac(hash, key), expected);
  assert.notEqual(hashHmac(hash, `${key}-other`), expected);
  const cmd = run(["hmac"], { [KEY_ENV]: key }, `${hash}\n`);
  assert.equal(cmd.status, 0, cmd.stderr);
  assert.equal(cmd.stdout, `${expected}\n`);
  assert.equal(cmd.stdout.includes(hash), false);
  for (const bad of ["", "abc", hash.toUpperCase(), `${hash}0`, `${hash} ${hash}`]) {
    const refused = run(["hmac"], { [KEY_ENV]: key }, bad);
    assert.equal(refused.status, 1, bad);
    assert.match(refused.stderr, /hmac takes an assembly hash/);
    assert.equal(refused.stdout, "");
  }
  assert.match(run(["hmac"], {}, hash).stderr, /DEPLOY_ASSEMBLY_KEY isn't set/);
  assert.match(run(["hmac", "extra"], { [KEY_ENV]: key }, hash).stderr, /usage/);
});
