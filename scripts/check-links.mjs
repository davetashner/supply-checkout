// Checks that every relative Markdown link in README.md, CLAUDE.md and docs/
// points at a file that exists and, for a #fragment into a Markdown file, at a
// heading in it (GitHub's anchor rules). Run by `npm run lint`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function markdownFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.name.endsWith(".md") ? [path] : [];
  });
}

// Text outside fenced code blocks and inline code spans
function prose(text) {
  return text
    .split(/^```.*$/m)
    .filter((_, i) => i % 2 === 0)
    .join("\n")
    .replace(/`[^`\n]*`/g, "");
}

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens,
// and -1, -2… on repeats
const anchorCache = new Map();
function anchors(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map();
    const set = new Set();
    for (const [, heading] of prose(readFileSync(file, "utf8")).matchAll(/^#{1,6}\s+(.+?)\s*#*$/gm)) {
      const base = heading
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]/gu, "")
        .replace(/\s/g, "-");
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      set.add(n ? `${base}-${n}` : base);
    }
    anchorCache.set(file, set);
  }
  return anchorCache.get(file);
}

const files = [join(root, "README.md"), join(root, "CLAUDE.md"), ...markdownFiles(join(root, "docs"))];
const problems = [];
for (const file of files) {
  const text = prose(readFileSync(file, "utf8"));
  for (const [, target] of text.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // https:, mailto: …
    const [path, fragment] = target.split("#");
    const dest = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    const where = `${relative(root, file)}: ${target}`;
    if (!existsSync(dest)) problems.push(`${where} (no such file)`);
    else if (fragment && statSync(dest).isFile() && dest.endsWith(".md") && !anchors(dest).has(fragment))
      problems.push(`${where} (no heading #${fragment})`);
  }
}

if (problems.length) {
  console.error(`Broken Markdown links:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`Markdown links OK (${files.length} files)`);
