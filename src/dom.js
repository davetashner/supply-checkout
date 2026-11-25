import { int } from "./format.js";
import { msg } from "./i18n.js";

export const $ = s => document.querySelector(s);

/* ---------- toast & modal ---------- */
let toastTimer;
export function toast(text, ms = 3200) {
  const t = $("#toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, ms);
}
export function openModal(html, mount) {
  const m = $("#modal"); m.innerHTML = html; $("#overlay").hidden = false;
  mount && mount(m);
  // data-autofocus, not autofocus: WebKit focuses an inserted autofocus field again at the
  // next frame, even after focus has moved on, so a quick tap into the next field typed into it
  const f = m.querySelector("[data-autofocus]") || m.querySelector("input,button"); f && f.focus();
  opened = guardedState();
}
export function closeModal() { $("#overlay").hidden = true; $("#modal").innerHTML = ""; opened = null; }
// A form marked data-guard (the item editor) keeps what's typed in it: tapping outside it, Escape
// or the logo doesn't close it while it has changes, only Cancel or Save does, and leaving the
// page asks first (supply-checkout-6t37). Its fields as the form opened, to compare with.
let opened = null;
function guardedState() {
  const form = $("#modal form[data-guard]");
  return form && JSON.stringify([...form.elements].map(e => e.type === "radio" || e.type === "checkbox" ? e.checked : e.type === "file" ? "" : e.value));
}
export const unsaved = () => opened !== null && guardedState() !== opened;
// Not while the modal's form is saving (saving() in src/main.js): closing it would lose what
// was entered if the save then failed. Nor while a guarded form has changes. Says whether the
// modal is closed now.
export const dismiss = () => {
  if ($("#modal [aria-busy]")) return false;
  if (unsaved()) { toast(msg("app.unsavedChanges")); return false; }
  closeModal(); return true;
};
// Only a tap that starts on the backdrop closes the modal: a drag that starts in the form (selecting
// a field's text, a quick swipe on a trackpad) and ends outside it clicks the backdrop too.
let downOnOverlay = false;
$("#overlay").addEventListener("pointerdown", e => { downOnOverlay = e.target.id === "overlay"; });
$("#overlay").addEventListener("click", e => { if (e.target.id === "overlay" && downOnOverlay) dismiss(); downOnOverlay = false; });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("#overlay").hidden) dismiss(); });
window.addEventListener("beforeunload", e => { if (unsaved()) e.preventDefault(); });

// Two-tap confirm, since the viewer can't show confirm() dialogs. arm() is one tap, for a
// delegated handler; armButton wires it to a button. The second tap disarms the button as it
// runs the action, so a third tap arms it again rather than running the action twice.
const disarms = new WeakMap();
export function arm(btn, label, action) {
  // Not while its action is saving (a click some browsers still deliver to a disabled button)
  if (btn.disabled) return;
  if (btn.classList.contains("armed")) { disarms.get(btn)(); action(); return; }
  const old = btn.textContent;
  const disarm = () => { clearTimeout(timer); btn.classList.remove("armed"); btn.textContent = old; };
  const timer = setTimeout(disarm, 3500);
  disarms.set(btn, disarm);
  btn.classList.add("armed"); btn.textContent = label;
}
export const armButton = (btn, label, action) => btn.addEventListener("click", () => arm(btn, label, action));

/* ---------- modals ---------- */
export function stepperHTML(id, val, max) {
  return `<div class="stepper"><button type="button" data-step="-1" aria-label="${msg("shell.fewer")}">−</button><input type="number" id="${id}" min="0" ${max != null ? `max="${max}"` : ""} value="${val}" inputmode="numeric"><button type="button" data-step="1" aria-label="${msg("shell.more")}">+</button></div>`;
}
export const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
export const setHTML = (el, h) => { if (el.innerHTML !== h) el.innerHTML = h; };
// Like setAttribute, but leaves an unchanged attribute alone (setting the same value is still a DOM change)
export const setAttr = (el, name, v) => { if (el.getAttribute(name) !== String(v)) el.setAttribute(name, v); };
// Makes el's content match html, changing only the nodes that differ. Unlike innerHTML,
// the elements that stay (a button being tapped) are kept: WebKit drops a tap whose
// element is replaced between touchstart and touchend. Wire events by delegation on el.
export function morph(el, html) {
  const t = document.createElement("template"); t.innerHTML = html;
  morphChildren(el, t.content);
}
function morphChildren(to, from) {
  const want = [...from.childNodes];
  want.forEach((n, i) => {
    const old = to.childNodes[i];
    if (!old) to.appendChild(n);
    else if (old.isEqualNode(n)) return;
    else if (old.nodeName !== n.nodeName) old.replaceWith(n);
    else if (n.nodeType !== 1) old.nodeValue = n.nodeValue;
    else {
      if (!old.cloneNode(false).isEqualNode(n.cloneNode(false))) {
        [...old.attributes].forEach(a => old.removeAttribute(a.name));
        [...n.attributes].forEach(a => old.setAttribute(a.name, a.value));
      }
      morphChildren(old, n);
    }
  });
  while (to.childNodes.length > want.length) to.lastChild.remove();
}
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
