// The one place the app reaches the claude.ai runtime (window.claude). See docs/adr/0004-runtime-adapter.md.
export const use = n => (window.claude && window.claude.use) ? window.claude.use(n).catch(() => null) : Promise.resolve(null);
// What to suggest when shared storage doesn't connect. The web build's runtime (src/aws/) has its own.
export const help = () => (window.claude && window.claude.help) || { connecting: "open this page on claude.ai while signed in", missing: "Open this page on claude.ai while signed in." };
