// A stand-in camera for the live barcode scanner (src/live-scan.js), for tests/live-scan.spec.js
// and tests/content-security-policy.spec.js. installCamera runs in the page (addInitScript).
// A stand-in camera: a 640×480 canvas streamed as the camera's video (redrawn each animation
// frame, so the stream keeps sending frames), and a stand-in BarcodeDetector.
//   camera:   "ok" | "denied" (permission refused) | "missing" (no camera found) | "held" (the
//             browser is still asking until window.__answerCamera(ok)) | "unsupported" (no
//             navigator.mediaDevices) | "none" (no camera in enumerateDevices) | "unlisted"
//             (enumerateDevices fails; the camera works)
//   detector: "none" (no BarcodeDetector) | "throws" | a list of what each frame finds (the
//             last repeats), each a list of { rawValue, format }
//   picture:  { modules, m, x, y, h, turned } a 1D code drawn on the camera (bars m pixels
//             wide, from x, y, h tall; turned: bars lie flat)
//   torch:    "yes" | "no" | "fails" (applyConstraints rejects) | "unknown" (no getCapabilities)
export function installCamera({ camera = "ok", detector = "none", picture = null, torch = "no" }) {
  const cam = (window.__camera = { opened: 0, stopped: 0, torch: [], detects: 0 });
  if (detector === "none") delete window.BarcodeDetector;
  else {
    window.BarcodeDetector = class {
      async detect() {
        cam.detects++;
        if (detector === "throws") throw new Error("detector failed");
        return detector[Math.min(cam.detects - 1, detector.length - 1)];
      }
    };
  }
  if (camera === "unsupported") { Object.defineProperty(Navigator.prototype, "mediaDevices", { get: () => undefined, configurable: true }); return; }
  const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 480 }), g = canvas.getContext("2d");
  let tick = 0;
  const paint = () => {
    g.fillStyle = "#fff"; g.fillRect(0, 0, 640, 480);
    g.fillStyle = `rgb(${tick++ % 2 ? 250 : 255},255,255)`; g.fillRect(0, 0, 1, 1); // a new frame each time
    g.fillStyle = "#000";
    if (picture) picture.modules.forEach((black, i) => black && (picture.turned ? g.fillRect(picture.x, picture.y + i * picture.m, picture.h, picture.m) : g.fillRect(picture.x + i * picture.m, picture.y, picture.m, picture.h)));
    requestAnimationFrame(paint);
  };
  // On the prototype: WebKit hands out a new object for a track each time it's asked for
  const track = MediaStreamTrack.prototype, stop = track.stop;
  track.stop = function () { cam.stopped++; stop.call(this); };
  track.getCapabilities = torch === "unknown" ? undefined : () => (torch === "no" ? {} : { torch: true });
  track.applyConstraints = async (c) => { if (torch === "fails") throw new Error("no torch"); cam.torch.push(c.advanced[0].torch); };
  const answer = (ok) => {
    if (!ok) throw new DOMException("No camera", camera === "denied" ? "NotAllowedError" : "NotFoundError");
    paint();
    cam.opened++;
    return canvas.captureStream(30);
  };
  const devices = {
    enumerateDevices: async () => { if (camera === "unlisted") throw new Error("not allowed"); return camera === "none" ? [] : [{ kind: "videoinput" }]; },
    getUserMedia: async () => {
      if (camera === "held") return answer(await new Promise((resolve) => { window.__answerCamera = resolve; }));
      return answer(camera === "ok" || camera === "unlisted");
    },
  };
  Object.defineProperty(Navigator.prototype, "mediaDevices", { get: () => devices, configurable: true });
}

// UPC-A modules (true = black), with quiet zones
const UPC_L = ["0001101", "0011001", "0010011", "0111101", "0100011", "0110001", "0101111", "0111011", "0110111", "0001011"];
export function upcA(digits) {
  const right = (d) => [...UPC_L[d]].map((b) => (b === "1" ? "0" : "1")).join("");
  const bits = "0".repeat(9) + "101" + [...digits.slice(0, 6)].map((d) => UPC_L[d]).join("") + "01010" + [...digits.slice(6)].map(right).join("") + "101" + "0".repeat(9);
  return [...bits].map((b) => b === "1");
}
