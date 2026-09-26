// The artifact build (dist/artifact/index.html) is a page fragment: claude.ai
// wraps it in a document skeleton at publish time. This builds the same full
// document for validation and tests.
import { readFileSync } from "node:fs";

// Reads the built file fresh each call.
export function buildPage() {
  let source;
  try {
    source = readFileSync(new URL("../dist/artifact/index.html", import.meta.url), "utf8");
  } catch {
    throw new Error("dist/artifact/index.html is missing. Run: npm run build:artifact");
  }
  const split = source.indexOf('<div class="wrap">');
  if (split < 0) throw new Error('dist/artifact/index.html is missing <div class="wrap">');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${source.slice(0, split).trim()}
</head>
<body>
${source.slice(split).trim()}
</body>
</html>
`;
}
