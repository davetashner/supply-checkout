// The Spanish text of the app (US Spanish), by key, merged from ./es/*.js the way en.js merges ./en/*.js.
// A key not translated yet falls back to English (src/i18n.js). Reviewed by the owner (supply-checkout-oopu,
// 2026-10-15), and offered to everyone (OFFERED in src/i18n.js).
const areas = import.meta.glob("./es/*.js", { eager: true });
export default Object.assign({}, ...Object.values(areas).map((area) => area.default));
