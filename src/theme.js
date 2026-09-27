// The System / Light / Dark theme control in the header. styles.css picks the dark
// colors from prefers-color-scheme unless <html data-theme="light">, and always for
// data-theme="dark"; System leaves the attribute off. The choice is kept per device.
// main.js imports this first, so the theme is set in the same task that loads the app,
// before it draws anything.
const KEY = "supplyCheckout.theme";
const THEMES = ["system", "light", "dark"];

// Storage can throw (blocked site data, some sandboxed frames): then it's System
function stored() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : "system";
  } catch { return "system"; }
}

function apply(theme) {
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
  document.querySelectorAll("#theme button").forEach(b => b.setAttribute("aria-pressed", b.dataset.theme === theme));
}

apply(stored());
// Other tabs change the device preference without reloading this page. Re-read
// storage so a queued event can't restore an older choice; clear() resets System.
window.addEventListener("storage", e => {
  if ((e.key === KEY || e.key === null) && e.storageArea === localStorage) apply(stored());
});
document.querySelectorAll("#theme button").forEach(b => b.addEventListener("click", () => {
  const theme = b.dataset.theme;
  apply(theme);
  try { theme === "system" ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, theme); } catch {}
}));
