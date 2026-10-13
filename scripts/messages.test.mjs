// The English catalog (src/messages/en/*.js, supply-checkout-3ilj): each file's keys start with its
// own name and no key repeats, so the files can merge without one quietly overwriting another, and
// every {name} an entry uses is written the way msg() fills it. Plurals have one and other.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";

const dir = new URL("../src/messages/en/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();

test("every English catalog file's keys start with its name, and no key repeats", async () => {
  const seen = new Map();
  for (const file of files) {
    const area = file.replace(/\.js$/, "");
    const { default: entries } = await import(new URL(file, dir));
    for (const [key, entry] of Object.entries(entries)) {
      assert.match(key, new RegExp(`^${area}\\.[A-Za-z0-9._]+$`), `${file}: "${key}" must start with "${area}."`);
      assert.ok(!seen.has(key), `"${key}" is in ${seen.get(key)} and ${file}`);
      seen.set(key, file);
      const forms = typeof entry === "string" ? [entry] : Object.entries(entry).map(([form, text]) => (assert.ok(["zero", "one", "two", "few", "many", "other"].includes(form), `${key}: "${form}" isn't a plural form`), text));
      if (typeof entry !== "string") assert.ok("other" in entry, `${key}: a plural needs "other"`);
      for (const text of forms) assert.equal(typeof text, "string", `${key}: text must be a string`);
    }
  }
  assert.ok(seen.size > 0);
});

// The Spanish catalog (src/messages/es/*.js, supply-checkout-oopu): each file is named for an English one, holds
// only keys that English has, and keeps every {name} and every HTML tag of the English text, so a translation
// can't drop a value or break the markup around it. A plural has the forms Spanish needs: one and other.
const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
const tags = (text) => [...text.matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)].map((m) => m[0].replace(/\s+/g, " ")).sort().join("|");

test("every Spanish catalog entry matches its English one: same key, placeholders and markup, and the plural forms", async () => {
  const esDir = new URL("../src/messages/es/", import.meta.url);
  for (const file of readdirSync(esDir).filter((f) => f.endsWith(".js")).sort()) {
    assert.ok(files.includes(file), `${file} has no English file`);
    const { default: en } = await import(new URL(file, dir));
    const { default: es } = await import(new URL(file, esDir));
    for (const [key, entry] of Object.entries(es)) {
      assert.ok(key in en, `${file}: "${key}" isn't in English`);
      const from = en[key];
      assert.equal(typeof entry, typeof from, `${file}: "${key}" must be ${typeof from === "string" ? "a string" : "a plural"} like English`);
      const pairs = typeof entry === "string" ? [[entry, from]] : Object.entries(entry).map(([form, text]) => [text, from[form] ?? from.other]);
      if (typeof entry !== "string") {
        assert.ok("other" in entry, `${file}: "${key}" needs "other"`);
        for (const form of Object.keys(entry)) assert.ok(["one", "many", "other"].includes(form), `${file}: "${key}" has a form Spanish doesn't use: ${form}`);
      }
      for (const [text, source] of pairs) {
        assert.equal(typeof text, "string", `${file}: "${key}" must be text`);
        assert.equal(placeholders(text), placeholders(source), `${file}: "${key}" must keep the English placeholders`);
        assert.equal(tags(text), tags(source), `${file}: "${key}" must keep the English markup`);
      }
    }
  }
});

test("the Spanish catalog has every English entry (an entry it lacks would show in English)", async () => {
  const esDir = new URL("../src/messages/es/", import.meta.url);
  const missing = [];
  for (const file of files) {
    const { default: en } = await import(new URL(file, dir));
    const es = await import(new URL(file, esDir)).then((m) => m.default, () => ({}));
    for (const key of Object.keys(en)) if (!(key in es)) missing.push(`${file}: ${key}`);
  }
  assert.deepEqual(missing, []);
});
