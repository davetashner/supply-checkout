// The Spanish text of the app (US Spanish), by key, merged from ./es/*.js the way en.js merges ./en/*.js.
// A key not translated yet falls back to English (src/i18n.js). A DRAFT until a native speaker who works in
// the trade has signed it off (supply-checkout-oopu): Spanish is reached with ?lang=es until then.
const areas = import.meta.glob("./es/*.js", { eager: true });
export default Object.assign({}, ...Object.values(areas).map((area) => area.default));
