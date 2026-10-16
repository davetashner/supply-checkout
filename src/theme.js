// The theme: a palette (Work Order, Evergreen, Slate, Dusk or High contrast) and System / Light / Dark,
// both chosen in Account's Appearance section (src/aws/appearance.js) and kept per device.
// styles.css has Work Order on :root and the others under <html data-palette>; it picks the
// dark colors from prefers-color-scheme unless <html data-theme="light">, and always for
// data-theme="dark". System and Work Order leave their attribute off. main.js imports this
// first, so the theme is set in the same task that loads the app, before it draws anything.
const MODE_KEY = "supplyCheckout.theme";
const PALETTE_KEY = "supplyCheckout.palette";
export const MODES = ["system", "light", "dark"];
export const PALETTES = ["workorder", "evergreen", "slate", "dusk", "contrast"];
const DEFAULT_MODE = "system", DEFAULT_PALETTE = "workorder";

// Storage can throw (blocked site data, some sandboxed frames): then it's the default
function stored(key, choices, fallback) {
  try {
    const v = localStorage.getItem(key);
    return choices.includes(v) ? v : fallback;
  } catch { return fallback; }
}

let mode = stored(MODE_KEY, MODES, DEFAULT_MODE);
let palette = stored(PALETTE_KEY, PALETTES, DEFAULT_PALETTE);
export const currentMode = () => mode;
export const currentPalette = () => palette;

function setAttr(name, value, none) {
  if (value === none) document.documentElement.removeAttribute(name);
  else document.documentElement.setAttribute(name, value);
}

// Sets the page's colors, and Account's choices when it's open
function apply() {
  setAttr("data-theme", mode, DEFAULT_MODE);
  setAttr("data-palette", palette, DEFAULT_PALETTE);
  document.querySelectorAll('input[name="themeMode"]').forEach(r => { r.checked = r.value === mode; });
  document.querySelectorAll('input[name="themePalette"]').forEach(r => { r.checked = r.value === palette; });
}

// The default is kept by removing the key, so clearing storage and choosing it are the same
function save(key, value, fallback) {
  try { value === fallback ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch {}
}

// `value` is one of MODES or PALETTES: Account's radios are made from them
export function chooseMode(value) {
  mode = value;
  apply();
  save(MODE_KEY, value, DEFAULT_MODE);
}

export function choosePalette(value) {
  palette = value;
  apply();
  save(PALETTE_KEY, value, DEFAULT_PALETTE);
}

apply();
// Other tabs change the device preference without reloading this page. Re-read
// storage so a queued event can't restore an older choice; clear() resets both.
window.addEventListener("storage", e => {
  if (e.storageArea !== localStorage || (e.key !== null && e.key !== MODE_KEY && e.key !== PALETTE_KEY)) return;
  mode = stored(MODE_KEY, MODES, DEFAULT_MODE);
  palette = stored(PALETTE_KEY, PALETTES, DEFAULT_PALETTE);
  apply();
});
