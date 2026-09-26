import { int } from "./format.js";

export const $ = s => document.querySelector(s);

/* ---------- toast & modal ---------- */
let toastTimer;
export function toast(msg, ms = 3200) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
}
export function openModal(html, mount) {
  const m = $("#modal"); m.innerHTML = html; $("#overlay").hidden = false;
  mount && mount(m);
  const f = m.querySelector("[autofocus]") || m.querySelector("input,button"); f && f.focus();
}
export function closeModal() { $("#overlay").hidden = true; $("#modal").innerHTML = ""; }
$("#overlay").addEventListener("click", e => { if (e.target.id === "overlay") closeModal(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#overlay").hidden) closeModal(); });

export function armButton(btn, label, action) {
  // Two-tap confirm, since the viewer can't show confirm() dialogs
  btn.addEventListener("click", () => {
    if (btn.classList.contains("armed")) { action(); return; }
    btn.classList.add("armed"); const old = btn.textContent; btn.textContent = label;
    setTimeout(() => { btn.classList.remove("armed"); btn.textContent = old; }, 3500);
  });
}

/* ---------- modals ---------- */
export function stepperHTML(id, val, max) {
  return `<div class="stepper"><button type="button" data-step="-1" aria-label="Fewer">−</button><input type="number" id="${id}" min="0" ${max != null ? `max="${max}"` : ""} value="${val}" inputmode="numeric"><button type="button" data-step="1" aria-label="More">+</button></div>`;
}
export const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
export const setHTML = (el, h) => { if (el.innerHTML !== h) el.innerHTML = h; };
export function wireStepper(m, id, onChange) {
  const inp = m.querySelector("#" + id);
  // Only touch the DOM when something changed: iOS Safari drops a tap if the page
  // changes under it, and blurring this field fires "change" mid-tap.
  const clamp = () => { let v = int(inp.value); if (inp.max !== "") v = Math.min(v, int(inp.max)); if (inp.value !== String(v)) inp.value = v; onChange && onChange(v); };
  m.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => { inp.value = int(inp.value) + Number(b.dataset.step); clamp(); }));
  inp.addEventListener("input", () => onChange && onChange(int(inp.value)));
  inp.addEventListener("change", clamp);
  return () => { clamp(); return int(inp.value); };
}
