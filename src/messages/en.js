// The English text of the app, by key (see ../i18n.js): one file per area in ./en/, merged here, so
// moving a file's strings over adds a file and never edits a shared one. Keys are "area.what", and a
// file's keys all start with its own name (scripts/messages.test.mjs checks that, and that no key repeats).
// A plural entry has the forms the language needs: English has one and other. Written as the user reads it.
const areas = import.meta.glob("./en/*.js", { eager: true });
export default Object.assign({}, ...Object.values(areas).map((area) => area.default));
