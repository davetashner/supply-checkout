// Builds the public legal pages (site/privacy/, site/subprocessors/) from their Markdown in
// docs/legal/, so the page and the document can't drift apart.
//
//   node scripts/legal-pages.mjs           write the pages
//   node scripts/legal-pages.mjs --check   fail if a committed page differs from its Markdown (npm run lint)
//
// Only the Markdown these documents use is understood: headings, paragraphs, bullet lists, tables,
// blockquotes, rules, and bold, italic, code and links inline. Everything from the "Open questions"
// heading on is for the owner and stays out of the page, as does the draft banner.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const PAGES = [
  { source: "docs/legal/privacy-policy.md", output: "site/privacy/index.html", description: "What Supply Checkout collects, why, who handles it, how long we keep it and your choices." },
  { source: "docs/legal/subprocessors.md", output: "site/subprocessors/index.html", description: "The companies that handle customer data for Supply Checkout, and what each one does." },
];

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline Markdown to HTML. Links to other files or headings in the repo become plain text: they aren't published. */
export function inline(text) {
  const codes = [];
  let out = escapeHtml(text).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code>${c}</code>`) - 1}\u0000`);
  out = out
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener">$1</a>')
    .replace(/\[([^\]]+)\]\((?!https:\/\/)[^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*]+)\*(?![*\w])/g, "$1<em>$2</em>");
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

const slug = (s) => s.toLowerCase().replace(/<[^>]*>/g, "").replace(/&[a-z]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The Markdown's body (below the title) as HTML, and the title. */
export function render(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const title = lines.find((l) => l.startsWith("# "))?.slice(2).trim();
  if (!title) throw new Error("The document needs a # title");
  const end = lines.findIndex((l) => /^## Open questions/i.test(l));
  const body = lines.slice(lines.findIndex((l) => l.startsWith("# ")) + 1, end === -1 ? undefined : end);
  const html = [];
  const used = new Set();
  let i = 0;
  const startsBlock = (l) => /^(#{2,3} |> |- |\| |---$)/.test(l);
  while (i < body.length) {
    const line = body[i];
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{2,3}) (.+)$/.exec(line);
    if (heading) {
      let id = slug(heading[2]);
      while (used.has(id)) id += "-2";
      used.add(id);
      html.push(`<h${heading[1].length} id="${id}">${inline(heading[2])}</h${heading[1].length}>`);
      i++;
    } else if (line === "---") {
      html.push("<hr>");
      i++;
    } else if (line.startsWith("> ")) {
      const paragraphs = [[]];
      for (; i < body.length && body[i].startsWith(">"); i++) {
        const text = body[i].replace(/^>\s?/, "");
        if (text.trim()) paragraphs.at(-1).push(text); else paragraphs.push([]);
      }
      // The draft banner is for the owner; a note that the document applies as pilot terms stays
      const kept = paragraphs.filter((p) => p.length && !/^\*\*DRAFT/.test(p[0]) && !p.join(" ").includes("Placeholders in"));
      if (kept.length) html.push(`<aside class="note">${kept.map((p) => `<p>${inline(p.join(" "))}</p>`).join("")}</aside>`);
    } else if (line.startsWith("- ")) {
      const items = [];
      for (; i < body.length && (body[i].startsWith("- ") || /^\s+\S/.test(body[i])); i++) {
        if (body[i].startsWith("- ")) items.push(body[i].slice(2)); else items[items.length - 1] += ` ${body[i].trim()}`;
      }
      html.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</ul>`);
    } else if (line.startsWith("|")) {
      const rows = [];
      for (; i < body.length && body[i].startsWith("|"); i++) rows.push(body[i].replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      const [head, , ...rest] = rows;
      html.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else {
      const text = [];
      for (; i < body.length && body[i].trim() && !startsBlock(body[i]); i++) text.push(body[i]);
      html.push(`<p>${inline(text.join(" "))}</p>`);
    }
  }
  // What the page would show: an unfilled placeholder or a note to the owner left in the text
  const unfilled = html.join("\n").match(/\[(?:[A-Z][A-Z ]{3,}|If |When )[^\]\n]*\]/);
  if (unfilled) throw new Error(`Fill in ${unfilled[0]} before publishing`);
  return { title, html: html.join("\n") };
}

const NAV = (current) => `<nav aria-label="Main">
    <a href="/how-to/">How-to</a>
    <a href="/demo/">Demo</a>
    <a href="https://app.supplycheckout.com/">Sign in</a>
  </nav>`;

/** The whole page for one document. */
export function page({ title, html }, { description }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Supply Checkout</title>
<meta name="description" content="${escapeHtml(description)}">
<meta name="theme-color" content="#EDF1EE">
<link rel="icon" href="../icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700&family=Public+Sans:wght@400;600;700&display=swap">
<link rel="stylesheet" href="../site.css">
<link rel="stylesheet" href="../legal.css">
</head>
<body>
<a class="skip" href="#doc">Skip to the text</a>
<header class="top">
  <a class="brand" href="/" aria-label="Supply Checkout home">
    <span class="bars" aria-hidden="true"><i style="width:3px"></i><i style="width:1px"></i><i style="width:2px"></i><i style="width:4px"></i><i style="width:1px"></i><i style="width:3px"></i></span>
    <span class="name">Supply Checkout</span>
  </a>
  ${NAV()}
</header>

<main class="legal" id="doc">
<h1>${escapeHtml(title)}</h1>
${html}
</main>

<footer>
  <p>Supply Checkout</p>
  <p><a href="/privacy/">Privacy</a> · <a href="/subprocessors/">Subprocessors</a> · <a href="/how-to/">How-to</a> · <a href="/demo/">Demo</a> · <a href="https://app.supplycheckout.com/">Sign in</a></p>
</footer>
</body>
</html>
`;
}

export function build({ base = root } = {}) {
  return PAGES.map((p) => ({ ...p, html: page(render(readFileSync(resolve(base, p.source), "utf8")), p) }));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const { output, html } of build()) {
    const path = resolve(root, output);
    if (check) {
      if (!existsSync(path) || readFileSync(path, "utf8") !== html) { console.error(`${output} is out of date: run node scripts/legal-pages.mjs`); stale++; }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, html);
      console.log(`Wrote ${output}`);
    }
  }
  if (stale) process.exit(1);
  if (check) console.log("legal pages: up to date");
}
