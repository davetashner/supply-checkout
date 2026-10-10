// The Profile photo section of Account (supply-checkout-6uw.30): the user's photo, or their
// initials, with Upload (or Change) and Remove. A chosen photo (JPEG, PNG or WebP) is decoded
// here, never sent as it is: the user positions it in a square (drag it, or the arrow keys;
// zoom with the slider, or + and -), and the square is drawn into a 256 × 256 canvas and sent
// as a JPEG (PUT /me/photo), which carries none of the original's metadata (no location). The
// server checks it again, and keeps only a plain 256 × 256 JPEG. Remove is DELETE /me/photo.
import { armButton } from "../dom.js";
import { avatarHTML } from "../avatar.js";
import { decodePhoto, toJpeg } from "../photo.js";

export const TYPES = ["image/jpeg", "image/png", "image/webp"];
// A larger file isn't opened: a phone's photo is well under it
export const MAX_FILE = 20 * 1024 * 1024;
// The photo sent: SIZE pixels square, as small as these qualities make it under MAX_SENT (the
// server takes up to 64 KB)
export const SIZE = 256, QUALITIES = [0.85, 0.7, 0.5], MAX_SENT = 60 * 1024;
const ZOOM_MAX = 4, STEP = 8, BIG_STEP = 32, ZOOM_STEP = 0.1;

const PICK = "Choose a JPEG, PNG or WebP photo.";
// What went wrong, in words, by the API's reason
const FAILURES = new Map([
  ["photo_invalid", "That photo couldn't be used. Try another JPEG, PNG or WebP photo."],
  ["photo_too_large", "That photo is too large to save. Zoom in a little, or try another photo."],
  ["photo_limit", "You've changed your photo as many times as you can today. Try again tomorrow."],
]);
const failure = (e, what) => FAILURES.get(e.reason) || `Couldn't ${what} your photo. Check your connection and try again.`;

// `photo.url()` is the user's photo now (null for none), and `photo.set(url)` records a new
// one, so every avatar on the page follows. `photo.name` is who they are, for the initials.
const preview = (photo) => avatarHTML(photo.url(), photo.name, 96, photo.userId, "Your profile photo");

export function photoSection(photo) {
  const url = photo.url();
  return `<h3>Profile photo</h3>
    <div class="photo-row">
      <span id="photoNow">${preview(photo)}</span>
      <div class="actions">
        <button type="button" class="btn" id="photoPick">${url ? "Change photo" : "Upload photo"}</button>
        <button type="button" class="btn danger" id="photoRemove"${url ? "" : " hidden"}>Remove</button>
      </div>
    </div>
    <input type="file" id="photoFile" accept="${TYPES.join(",")}" hidden>
    <p class="hint" id="photoHint">Your teammates see it next to your name. A JPEG, PNG or WebP photo.</p>
    <div class="cropper" id="photoCrop" hidden>
      <div class="crop-frame" id="cropFrame" tabindex="0" role="group" aria-label="Photo position" aria-describedby="cropHelp">
        <canvas id="cropCanvas" width="${SIZE}" height="${SIZE}"></canvas>
      </div>
      <p class="hint" id="cropHelp">Drag the photo, or use the arrow keys, to choose what's in the circle. Zoom with the slider, or + and -.</p>
      <div class="field crop-zoom"><label for="cropZoom">Zoom</label><input type="range" id="cropZoom" min="1" max="${ZOOM_MAX}" step="0.01" value="1"></div>
      <div class="actions"><button type="button" class="btn" id="cropCancel">Cancel</button><button type="button" class="btn primary" id="cropSave">Save photo</button></div>
    </div>
    <p class="error" role="alert" id="photoFail" hidden></p>`;
}

export function wirePhoto(m, api, photo) {
  const pick = m.querySelector("#photoPick"), remove = m.querySelector("#photoRemove"), file = m.querySelector("#photoFile");
  const crop = m.querySelector("#photoCrop"), frame = m.querySelector("#cropFrame"), canvas = m.querySelector("#cropCanvas");
  const zoom = m.querySelector("#cropZoom"), save = m.querySelector("#cropSave"), fail = m.querySelector("#photoFail");
  const say = (text) => { fail.textContent = text; fail.hidden = !text; };
  const ctx = canvas.getContext("2d");
  // The photo being placed, and where: its top-left corner on the canvas, and its scale
  let bmp = null, x = 0, y = 0, scale = 1, fit = 1;

  // The photo as it is now, everywhere on the screen
  function shown() {
    const url = photo.url();
    m.querySelector("#photoNow").innerHTML = preview(photo);
    pick.textContent = url ? "Change photo" : "Upload photo";
    remove.hidden = !url;
  }

  // Keeps the square covered, and draws it: white behind, for a photo with transparent parts
  function draw() {
    const w = bmp.width * scale, h = bmp.height * scale;
    x = Math.min(0, Math.max(SIZE - w, x));
    y = Math.min(0, Math.max(SIZE - h, y));
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(bmp, x, y, w, h);
  }
  // Zooms about the middle of the square
  function zoomTo(z) {
    const next = fit * Math.min(ZOOM_MAX, Math.max(1, z)), k = next / scale;
    x = SIZE / 2 - (SIZE / 2 - x) * k;
    y = SIZE / 2 - (SIZE / 2 - y) * k;
    scale = next;
    zoom.value = String(next / fit);
    draw();
  }
  const move = (dx, dy) => { x += dx; y += dy; draw(); };

  function close() {
    crop.hidden = true;
    pick.hidden = false;
    bmp.close();
    bmp = null;
  }

  pick.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const chosen = file.files[0];
    file.value = "";
    say("");
    if (!chosen) return;
    if (!TYPES.includes(chosen.type)) { say(PICK); return; }
    if (chosen.size > MAX_FILE) { say("That photo is too large to open. Choose one under 20 MB."); return; }
    const opened = await decodePhoto(chosen);
    if (!opened) { say("That photo couldn't be opened. Try another JPEG, PNG or WebP photo."); return; }
    bmp = opened;
    // Covering the square, centred
    fit = scale = SIZE / Math.min(bmp.width, bmp.height);
    x = (SIZE - bmp.width * scale) / 2;
    y = (SIZE - bmp.height * scale) / 2;
    zoom.value = "1";
    draw();
    crop.hidden = false;
    pick.hidden = true;
    frame.focus();
  });

  zoom.addEventListener("input", () => zoomTo(Number(zoom.value)));
  // Dragging, with a mouse, a finger or a pen: the frame is shown smaller than the canvas
  let drag = null;
  frame.addEventListener("pointerdown", (e) => {
    drag = { px: e.clientX, py: e.clientY, k: SIZE / frame.getBoundingClientRect().width };
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener("pointermove", (e) => {
    if (!drag) return;
    move((e.clientX - drag.px) * drag.k, (e.clientY - drag.py) * drag.k);
    drag.px = e.clientX;
    drag.py = e.clientY;
  });
  const drop = () => { drag = null; };
  frame.addEventListener("pointerup", drop);
  frame.addEventListener("pointercancel", drop);
  // The keyboard: the arrows move the photo (with Shift, further), + and - zoom
  const KEYS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  frame.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? BIG_STEP : STEP;
    if (KEYS[e.key]) move(KEYS[e.key][0] * step, KEYS[e.key][1] * step);
    else if (e.key === "+" || e.key === "=") zoomTo(scale / fit + ZOOM_STEP);
    else if (e.key === "-") zoomTo(scale / fit - ZOOM_STEP);
    else return;
    e.preventDefault();
  });

  m.querySelector("#cropCancel").addEventListener("click", () => { close(); say(""); pick.focus(); });
  save.addEventListener("click", async () => {
    save.disabled = true;
    // The modal stays open while it saves (dismiss in src/dom.js)
    save.setAttribute("aria-busy", "true");
    say("");
    try {
      const jpeg = await toJpeg(canvas, QUALITIES, MAX_SENT);
      const { photoUrl } = await api("PUT", "/me/photo", { image: await base64(jpeg) });
      photo.set(photoUrl);
      close();
      shown();
      pick.focus();
    } catch (e) {
      say(failure(e, "save"));
    }
    save.disabled = false;
    save.removeAttribute("aria-busy");
  });

  armButton(remove, "Tap again to remove", async () => {
    remove.disabled = true;
    say("");
    try {
      await api("DELETE", "/me/photo");
      photo.set(null);
      shown();
      pick.focus();
    } catch (e) {
      say(failure(e, "remove"));
    }
    remove.disabled = false;
  });
}

// A blob's bytes as base64
async function base64(blob) {
  let text = "";
  for (const b of new Uint8Array(await blob.arrayBuffer())) text += String.fromCharCode(b);
  return btoa(text);
}
