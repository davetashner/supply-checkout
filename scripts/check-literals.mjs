// Fails when the app's code has user-visible English outside the message catalog (supply-checkout-3ilj):
//
//   node scripts/check-literals.mjs     (npm run lint)
//
// It reads each .js file in src/ and src/aws/ (not src/messages/, which is the catalog) and looks at the
// text of its string and template literals, not at code:
//   - text between tags in HTML a template builds:   `<p>Save the item</p>`
//   - the text of an attribute a reader sees:        `<button aria-label="Close">`, title, placeholder, alt
//   - a literal handed straight to a place a reader sees: toast("Saved"), el.textContent = "Done",
//     el.setAttribute("aria-label", "Close")
// Text with no letter in it (an icon, a bullet, a number) is fine, and so is `${…}` on its own. A line that
// has English on purpose (a CSV header, a name the API defines, text for the model) says why in an
// `i18n-ok: reason` comment on that line or the one before. This catches what a reader sees in a template;
// tests/i18n.spec.js's pseudo-language run catches what only shows once a screen is drawn.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIRS = ["src", "src/aws"];

/** The string and template literals in `source` as { text, line, before }: `text` with each ${…} as "\uE000", `before` the code just ahead of it. */
export function literals(source) {
  const found = [];
  const lineAt = (i) => source.slice(0, i).split("\n").length;
  let i = 0;
  // Scans code from i until `stop` (a "}" that closes a ${…}) and returns; nested literals are found too
  const code = (nested) => {
    let depth = 0;
    while (i < source.length) {
      const c = source[i];
      if (c === "/" && source[i + 1] === "/") { while (i < source.length && source[i] !== "\n") i++; continue; }
      if (c === "/" && source[i + 1] === "*") { const end = source.indexOf("*/", i + 2); i = end < 0 ? source.length : end + 2; continue; }
      if (c === '"' || c === "'") { string(c); continue; }
      if (c === "`") { template(); continue; }
      if (c === "/" && regexAllowed(source, i)) { regex(); continue; }
      if (nested && c === "{") depth++;
      if (nested && c === "}") { if (depth === 0) { i++; return; } depth--; }
      i++;
    }
  };
  const string = (quote) => {
    const start = i;
    i++;
    let text = "";
    while (i < source.length && source[i] !== quote && source[i] !== "\n") { if (source[i] === "\\") { text += source[i + 1] ?? ""; i += 2; } else text += source[i++]; }
    i++;
    found.push({ text, line: lineAt(start), before: source.slice(Math.max(0, start - 60), start) });
  };
  const template = () => {
    const start = i;
    i++;
    let text = "";
    while (i < source.length && source[i] !== "`") {
      if (source[i] === "\\") { text += source[i + 1] ?? ""; i += 2; }
      else if (source[i] === "$" && source[i + 1] === "{") { text += "\uE000"; i += 2; code(true); }
      else text += source[i++];
    }
    i++;
    found.push({ text, line: lineAt(start), before: source.slice(Math.max(0, start - 60), start) });
  };
  const regex = () => {
    i++;
    let inClass = false;
    while (i < source.length && (source[i] !== "/" || inClass) && source[i] !== "\n") {
      if (source[i] === "\\") i++;
      else if (source[i] === "[") inClass = true;
      else if (source[i] === "]") inClass = false;
      i++;
    }
    i++;
  };
  code(false);
  return found;
}

// A "/" starts a regular expression, not a division, after one of these
function regexAllowed(source, i) {
  const before = source.slice(0, i).trimEnd();
  const last = before.slice(-1);
  return before === "" || "(,=:[!&|?{};+-*%<>~^".includes(last) || /\b(?:return|typeof|case|in|of)$/.test(before);
}

const LETTERS = /[A-Za-z]{2,}/;
const VISIBLE_ATTRIBUTE = /\b(?:aria-label|aria-description|title|placeholder|alt)=["']([^"'\uE000]*)["']/g;
const SINK = /(?:\b(?:toast|alert|confirm)\(\s*|\.(?:textContent|innerText|placeholder|title|ariaLabel)\s*=\s*|setAttribute\(\s*["'](?:aria-label|aria-description|title|placeholder|alt)["']\s*,\s*)$/;

/** What in a literal is English a reader would see: an array of the offending texts. */
export function visibleText({ text, before }) {
  const out = [];
  if (SINK.test(before) && LETTERS.test(text.replaceAll("\uE000", ""))) out.push(text);
  // Only markup that carries a tag: the text between its tags, around any ${…}
  if (/<[a-z/][^>]*>/i.test(text)) {
    for (const part of text.split(/<[^>]*>/)) if (LETTERS.test(part.replaceAll("\uE000", " "))) out.push(part.replaceAll("\uE000", " ").trim());
  }
  for (const m of text.matchAll(VISIBLE_ATTRIBUTE)) if (LETTERS.test(m[1])) out.push(m[1]);
  return [...new Set(out)];
}

/** The problems in one file's source: { line, text } for each English literal not marked `i18n-ok`. */
export function problems(source) {
  const lines = source.split("\n");
  const marked = (line) => /i18n-ok:\s*\S/.test(lines[line - 1] ?? "") || /i18n-ok:\s*\S/.test(lines[line - 2] ?? "");
  return literals(source).flatMap((lit) => visibleText(lit).map((text) => ({ line: lit.line, text }))).filter(({ line }) => !marked(line));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = [];
  for (const dir of DIRS) {
    for (const name of readdirSync(join(root, dir)).filter((f) => f.endsWith(".js"))) {
      for (const { line, text } of problems(readFileSync(join(root, dir, name), "utf8"))) bad.push(`${dir}/${name}:${line}: ${JSON.stringify(text.slice(0, 80))}`);
    }
  }
  if (bad.length) {
    console.error(`English text outside the message catalog (move it to src/messages/en/, or say why it stays with an i18n-ok: comment):\n${bad.join("\n")}`);
    process.exit(1);
  }
  console.log("literals: no English text outside the catalog");
}
