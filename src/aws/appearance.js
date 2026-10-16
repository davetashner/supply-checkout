// Account's Appearance section: the theme's palette and System / Light / Dark (src/theme.js),
// kept on this device and applied as soon as they change. Each palette shows three of its
// colors (its main button, Check out and its page) beside its name; they're decoration, so
// the name is what's read out.
import { MODES, PALETTES, chooseMode, choosePalette, currentMode, currentPalette } from "../theme.js";
import { msg } from "../i18n.js";

// The light colors of each palette in styles.css: --accent-fill, --out-fill, --ground
const SWATCHES = {
  workorder: ["#1F4FD1", "#F59E0B", "#EEF1F6"],
  evergreen: ["#0B5D4B", "#F2B544", "#F1F4F1"],
  slate: ["#273249", "#E9A93B", "#F6F6F6"],
  contrast: ["#0035C9", "#FFB300", "#FFFFFF"],
};

const radio = (name, value, checked, label) =>
  `<label class="theme-pick"><input type="radio" name="${name}" value="${value}"${checked ? " checked" : ""}> ${label}</label>`;

const swatches = (palette) => `<span class="swatches" aria-hidden="true">${SWATCHES[palette].map((c) => `<i style="background:${c}"></i>`).join("")}</span>`;

export function appearanceSection() {
  return `<h3>${msg("appearance.heading")}</h3>
    <fieldset class="theme-picks"><legend>${msg("appearance.palette")}</legend>
    ${PALETTES.map((p) => radio("themePalette", p, p === currentPalette(), `${swatches(p)}<span>${msg(`appearance.${p}`)}</span>`)).join("")}
    </fieldset>
    <fieldset class="theme-picks modes"><legend>${msg("appearance.mode")}</legend>
    ${MODES.map((m) => radio("themeMode", m, m === currentMode(), `<span>${msg(`appearance.${m}`)}</span>`)).join("")}
    </fieldset>
    <p class="hint">${msg("appearance.hint")}</p>`;
}

export function wireAppearance(m) {
  m.querySelectorAll('input[name="themePalette"]').forEach((r) => r.addEventListener("change", () => choosePalette(r.value)));
  m.querySelectorAll('input[name="themeMode"]').forEach((r) => r.addEventListener("change", () => chooseMode(r.value)));
}
