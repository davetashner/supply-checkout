import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build, inline, render } from "./legal-pages.mjs";

test("inline Markdown: bold, italic, code and https links; local links lose their link; HTML is escaped", () => {
  assert.equal(inline("**a** and *b* and `c<d>`"), "<strong>a</strong> and <em>b</em> and <code>c&lt;d&gt;</code>");
  assert.equal(inline("[Stripe](https://stripe.com/privacy)"), '<a href="https://stripe.com/privacy" rel="noopener">Stripe</a>');
  assert.equal(inline("[Pilot](pilot-agreement.md) and [Q](#open-questions)"), "Pilot and Q");
  assert.equal(inline("1 < 2 & \"x\""), "1 &lt; 2 &amp; &quot;x&quot;");
});

test("a document becomes headings, paragraphs, lists, tables and notes, and stops at the open questions", () => {
  const { title, html } = render([
    "# Title", "", "> **DRAFT** banner", ">", "> Placeholders in `[X]`", ">", "> **Pilot terms.** Applies.", "",
    "## One", "", "Some text", "continues.", "", "- a", "- b", "  more", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "---", "",
    "## Open questions for the owner", "", "secret",
  ].join("\n"));
  assert.equal(title, "Title");
  assert.match(html, /<aside class="note"><p><strong>Pilot terms\.<\/strong> Applies\.<\/p><\/aside>/);
  assert.doesNotMatch(html, /DRAFT|Placeholders|secret|Open questions/);
  assert.match(html, /<h2 id="s-one">One<\/h2>\n<p>Some text continues\.<\/p>/);
  assert.match(html, /<li>b more<\/li>/);
  assert.match(html, /<th scope="col">A<\/th>.*<td>2<\/td>/);
  assert.match(html, /<hr>/);
  assert.throws(() => render("no title"), /title/);
  assert.throws(() => render("# T\n\nemail [PRIVACY EMAIL]"), /Fill in \[PRIVACY EMAIL\]/);
  assert.throws(() => render("# T\n\nx [If marketing email is added: say so]"), /Fill in/);
});

test("the committed pages match their Markdown", () => {
  for (const { output, html } of build()) {
    assert.equal(readFileSync(new URL(`../${output}`, import.meta.url), "utf8"), html, `${output} is out of date: run node scripts/legal-pages.mjs`);
  }
});
