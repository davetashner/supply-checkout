// The one place the app reaches the claude.ai runtime (window.claude). See docs/adr/0004-runtime-adapter.md.
export const use = n => (window.claude && window.claude.use) ? window.claude.use(n).catch(() => null) : Promise.resolve(null);
