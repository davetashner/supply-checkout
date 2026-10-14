// The Spanish text of the app (US Spanish), by key, merged from ./es/*.js the way en.js merges ./en/*.js.
// A key not translated yet falls back to English (src/i18n.js). Signed off by a native speaker who works in
// the trade (supply-checkout-oopu), and offered to everyone (OFFERED in src/i18n.js).
const areas = import.meta.glob("./es/*.js", { eager: true });
export default Object.assign({}, ...Object.values(areas).map((area) => area.default));
