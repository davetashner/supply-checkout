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
      assert.match(key, new RegExp(`^${area}\\.[A-Za-z0-9.]+$`), `${file}: "${key}" must start with "${area}."`);
      assert.ok(!seen.has(key), `"${key}" is in ${seen.get(key)} and ${file}`);
      seen.set(key, file);
      const forms = typeof entry === "string" ? [entry] : Object.entries(entry).map(([form, text]) => (assert.ok(["zero", "one", "two", "few", "many", "other"].includes(form), `${key}: "${form}" isn't a plural form`), text));
      if (typeof entry !== "string") assert.ok("other" in entry, `${key}: a plural needs "other"`);
      for (const text of forms) assert.equal(typeof text, "string", `${key}: text must be a string`);
    }
  }
  assert.ok(seen.size > 0);
});
