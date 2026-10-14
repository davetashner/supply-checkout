import { test } from "node:test";
import assert from "node:assert/strict";
import { literals, problems } from "./check-literals.mjs";

const texts = (source) => problems(source).map((p) => p.text);

test("finds English between tags in a template", () => {
  assert.deepEqual(texts("const x = `<p>Save the item</p>`;"), ["Save the item"]);
  assert.deepEqual(texts("const x = `<button class=\"btn\">Close</button>`;"), ["Close"]);
  assert.deepEqual(texts("const x = `<li>${name} is low</li>`;"), ["is low"]);
});

test("finds English in attributes a reader sees", () => {
  assert.deepEqual(texts('const x = `<button aria-label="Close dialog">${icon}</button>`;'), ["Close dialog"]);
  assert.deepEqual(texts("const x = `<input placeholder='Search items'>`;"), ["Search items"]);
  assert.deepEqual(texts('const x = `<img alt="A photo">`;'), ["A photo"]);
});

test("finds English handed straight to a place a reader sees", () => {
  assert.deepEqual(texts('toast("Saved");'), ["Saved"]);
  assert.deepEqual(texts("el.textContent = 'Done';"), ["Done"]);
  assert.deepEqual(texts('el.setAttribute("aria-label", "Close");'), ["Close"]);
  assert.deepEqual(texts("el.title = `Back`;"), ["Back"]);
});

test("looks inside a ${…} for more templates", () => {
  assert.deepEqual(texts("const x = `<ul>${items.map((i) => `<li>Item ${i}</li>`).join(\"\")}</ul>`;"), ["Item"]);
});

test("leaves catalog text, code, class names and text without letters alone", () => {
  assert.deepEqual(texts('const x = `<p>${msg("a.b")}</p>`;'), []);
  assert.deepEqual(texts('const x = `<span class="hint">${n}</span> · <b>1</b>`;'), []);
  assert.deepEqual(texts('toast(msg("a.saved"));'), []);
  assert.deepEqual(texts('el.textContent = "";'), []);
  assert.deepEqual(texts('el.textContent = "•";'), []);
  assert.deepEqual(texts("if (a > b && c < d) run();"), []);
  assert.deepEqual(texts('const re = /<p>Save<\\/p>/; const y = a / b;'), []);
  assert.deepEqual(texts('const id = "saveButton"; const kind = "primary";'), []);
});

test("skips comments, and a line marked i18n-ok with its reason", () => {
  assert.deepEqual(texts("// toast(\"Saved\")\n/* `<p>Hello</p>` */\nconst x = 1;"), []);
  assert.deepEqual(texts('toast("Saved"); // i18n-ok: a test hook'), []);
  assert.deepEqual(texts('// i18n-ok: the API names it\nel.textContent = "DELETE";'), []);
  assert.deepEqual(texts('toast("Saved"); // i18n-ok:'), ["Saved"]);
});

test("reports the line", () => {
  assert.deepEqual(problems("const a = 1;\n\nconst x = `<p>Hello</p>`;").map((p) => p.line), [3]);
});

test("reads quotes, escapes and nested templates without losing its place", () => {
  assert.deepEqual(literals("a('it\\'s', \"say \\\"hi\\\"\", `x${`y${1}`}z`);").map((l) => l.text), ["it's", 'say "hi"', "y\uE000", "x\uE000z"]);
});
