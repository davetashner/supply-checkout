import { msg } from "./i18n.js";

// The one place the app reaches the runtime (window.claude, which the web build's src/aws/ provides). See docs/adr/0004-runtime-adapter.md.
export const use = n => (window.claude && window.claude.use) ? window.claude.use(n).catch(() => null) : Promise.resolve(null);
// What to suggest when shared storage doesn't connect. The web build's runtime (src/aws/) has its own.
export const help = () => (window.claude && window.claude.help) || { connecting: msg("runtime.connecting"), missing: msg("runtime.missing") };
