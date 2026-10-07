import { zxReader, zxRead, grays, turned, verdict, spots, blankCanvas, part, deliver } from "./barcode.js";

/* ---------- live barcode scanning (supply-checkout-005.7.1) ----------
   Tapping a barcode Scan button opens the camera in a scanner over the page, instead of
   the phone's photo picker. Each frame is read (the browser's BarcodeDetector, then ZXing
   on the aiming box, as is and turned, and every few frames on spots that look like a 1D
   code anywhere in the frame), and a code is taken only once separate frames agree on it.
   It goes to the Scan button's file input (deliver), so the form that asked shows it, and
   its number can still be corrected there before anything is saved. "Take a photo instead"
   opens the photo picker, as does a browser without a camera. */

const FRAME_MS = 125; // at most 8 frames a second, to spare the phone's battery
const LIMIT_MS = 30000; // then the camera stops, with Try again and Take a photo instead
const AGREE_MS = 1500; // the reads that agree come from this long a stretch of frames
const AGREE = 2, AGREE_WEAK = 3; // separate frames that must agree (more for a short code, an EAN-8 or a UPC-E)
const SPOT_EVERY = 4; // frames between looks at the whole frame for spots
const AIM_W = 0.8, AIM_H = 0.4; // the aiming box, as a part of the view (styles.css: .scanner .aim)
const GROW = 1.25; // read a little past the aiming box: a code half in it still reads
const MAX_EDGE = 960; // the longest edge a frame or its aiming box is read at

const media = navigator.mediaDevices;
// Whether the device has a camera, checked once: a tap must open the photo picker at once
// (a browser won't open it later, outside the tap), so this can't wait for the answer
let hasCamera = true;
async function lookForCamera() {
  try { hasCamera = (await media.enumerateDevices()).some((d) => d.kind === "videoinput"); } catch {}
}
if (media && media.getUserMedia) lookForCamera();
const canScan = () => !!(media && media.getUserMedia) && hasCamera;

// Scans into a barcode photo input: with the camera when there is one, or the photo picker
export function startScan(input) {
  if (canScan()) open(input); else input.click();
}
// A Scan button is a label for its file input (data-barcode); tapping it opens the scanner instead
document.addEventListener("click", (e) => {
  const label = e.target.closest("label[for]"), input = label && document.getElementById(label.htmlFor);
  if (!input || !input.hasAttribute("data-barcode") || !canScan()) return;
  e.preventDefault();
  open(input);
});

const MESSAGES = {
  starting: "Starting the camera…",
  live: "Hold the barcode inside the frame.",
  steady: "Hold steady…",
  limit: "No barcode read yet. Move closer, add light, or take a photo instead.",
  paused: "Scanning paused.",
  denied: "The camera is blocked for this site. Allow it in your browser's settings, or take a photo instead.",
  none: "The camera isn't available. Take a photo instead.",
};

let el = null, video = null, s = null;
function scanner() {
  if (el) return el;
  el = document.createElement("div");
  el.className = "scanner";
  el.id = "scanner";
  el.hidden = true;
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  el.setAttribute("aria-labelledby", "scanTitle");
  el.innerHTML = `
    <div class="view"><video id="scanVideo" playsinline muted></video><div class="aim" aria-hidden="true"></div></div>
    <div class="bar">
      <h2 id="scanTitle">Scan a barcode</h2>
      <p id="scanStatus" role="status"></p>
      <div class="actions">
        <button type="button" class="btn" id="scanLight" aria-pressed="false" hidden>Flashlight</button>
        <button type="button" class="btn" id="scanAgain" hidden>Try again</button>
        <button type="button" class="btn" id="scanPhoto">Take a photo instead</button>
        <button type="button" class="btn primary" id="scanCancel">Cancel</button>
      </div>
    </div>`;
  document.body.append(el);
  video = el.querySelector("video");
  el.querySelector("#scanCancel").addEventListener("click", close);
  el.querySelector("#scanAgain").addEventListener("click", () => start(s));
  // Opened in the tap, which the photo picker needs
  el.querySelector("#scanPhoto").addEventListener("click", () => { const input = current(s.input); close(); input.click(); });
  el.querySelector("#scanLight").addEventListener("click", light);
  return el;
}
const $s = (id) => el.querySelector(id);
// The input to hand the code to: the page under the scanner may have been drawn again while it
// was open (the receipt review, when new data arrives), replacing the input with a new one
const current = (input) => (input.isConnected ? input : document.getElementById(input.id) || input);
function show(state) {
  $s("#scanStatus").textContent = MESSAGES[state];
  $s("#scanAgain").hidden = !(state === "limit" || state === "paused");
  if (state !== "live" && state !== "steady") $s("#scanLight").hidden = true;
}

function open(input) {
  scanner().hidden = false;
  s = { input, back: document.activeElement, stream: null, timer: 0 };
  $s("#scanCancel").focus();
  start(s);
}
function close() {
  stop(s);
  el.hidden = true;
  const { back } = s;
  s = null;
  if (back && back.isConnected) back.focus();
}
// The camera off (its light goes off) and no more frames
function stop(session) {
  clearTimeout(session.timer);
  if (session.stream) session.stream.getTracks().forEach((t) => t.stop());
  session.stream = null;
  video.srcObject = null;
}

async function start(session) {
  show("starting");
  Object.assign(session, { reads: [], frame: 0, detector: "BarcodeDetector" in window ? new BarcodeDetector() : null });
  let stream;
  try {
    stream = await media.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    // Closed while the browser asked for the camera, or while it started
    if (s !== session) throw stream;
    session.stream = stream;
    video.srcObject = stream;
    await video.play();
  } catch (e) {
    if (e === stream) { stream.getTracks().forEach((t) => t.stop()); return; }
    if (s !== session) return;
    stop(session);
    show(e && e.name === "NotAllowedError" ? "denied" : "none");
    return;
  }
  const track = stream.getVideoTracks()[0], can = track.getCapabilities ? track.getCapabilities() : {};
  $s("#scanLight").hidden = !can.torch;
  setLight(false);
  show("live");
  session.until = performance.now() + LIMIT_MS;
  session.timer = setTimeout(() => frame(session));
}

const setLight = (on) => $s("#scanLight").setAttribute("aria-pressed", on);
async function light() {
  const on = $s("#scanLight").getAttribute("aria-pressed") !== "true";
  try {
    await s.stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] });
    setLight(on);
  } catch {}
}

// Stops the camera while the page is hidden (another app, the lock screen), so its light goes off
document.addEventListener("visibilitychange", () => {
  if (document.hidden && s && s.stream) { stop(s); show("paused"); }
});
// Escape closes the scanner, not the form under it; Tab stays in the scanner
window.addEventListener("keydown", (e) => {
  if (!s) return;
  if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
  if (e.key !== "Tab") return;
  const buttons = [...el.querySelectorAll("button:not([hidden])")], i = buttons.indexOf(document.activeElement);
  e.preventDefault();
  buttons[(i + (e.shiftKey ? buttons.length - 1 : 1)) % buttons.length].focus();
}, true);

async function frame(session) {
  const began = performance.now();
  if (began > session.until) { stop(session); show("limit"); return; }
  const code = await read(session);
  if (s !== session || !session.stream) return; // closed, paused or stopped meanwhile
  if (code) { const input = current(session.input); close(); deliver(input, code); return; }
  session.timer = setTimeout(() => frame(session), Math.max(0, FRAME_MS - (performance.now() - began)));
}

// A frame's codes, then whether separate frames now agree on one
async function read(session) {
  session.frame++;
  const found = [];
  if (session.detector) {
    try { for (const f of await session.detector.detect(video)) found.push({ fmt: f.format, text: f.rawValue }); } catch {}
  }
  if (!found.length && video.videoWidth) {
    const zx = await zxReader();
    const aim = grays(drawn(aimBox()));
    const r = zxRead(zx, zx.anyQuick, aim) || zxRead(zx, zx.lineQuick, turned(aim));
    if (r) found.push(r);
    else if (session.frame % SPOT_EVERY === 0) {
      const whole = drawn({ x: 0, y: 0, w: video.videoWidth, h: video.videoHeight });
      for (const p of spots(grays(whole)).slice(0, 2)) {
        const px = grays(part(whole, p.x, p.y, p.w, p.h)), r = zxRead(zx, zx.line, p.turn ? turned(px) : px);
        if (r) { found.push(r); break; }
      }
    }
  }
  return agree(session, found);
}
// The part of the frame under the aiming box (and a little more). The video fills its box
// (object-fit: cover), so the frame is cut to the view's shape, and the box is a part of that.
function aimBox() {
  const fw = video.videoWidth, fh = video.videoHeight, k = Math.max(video.clientWidth / fw, video.clientHeight / fh);
  const w = Math.min(fw, (AIM_W * GROW * video.clientWidth) / k), h = Math.min(fh, (AIM_H * GROW * video.clientHeight) / k);
  return { x: (fw - w) / 2, y: (fh - h) / 2, w, h };
}
// That part of the frame, shrunk to MAX_EDGE at most, as a canvas
function drawn({ x, y, w, h }) {
  const k = Math.min(1, MAX_EDGE / Math.max(w, h)), c = blankCanvas(Math.round(w * k), Math.round(h * k));
  c.getContext("2d").drawImage(video, x, y, w, h, 0, 0, c.width, c.height);
  return c;
}
function agree(session, found) {
  const now = performance.now();
  session.reads = session.reads.filter((r) => now - r.at <= AGREE_MS);
  for (const { fmt, text: raw } of found) {
    const text = String(raw).trim(), v = text ? verdict(fmt, text) : "bad";
    if (v === "bad" || session.reads.some((r) => r.frame === session.frame && r.text === text)) continue;
    session.reads.push({ text, at: now, frame: session.frame });
    if (session.reads.filter((r) => r.text === text).length >= (v === "weak" ? AGREE_WEAK : AGREE)) return text;
    show("steady");
  }
  return null;
}
