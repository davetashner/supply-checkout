// The web build's runtime (ADR 0004): window.claude.use() on the AWS backend, so the
// same app (src/main.js) runs at app.<domain>. vite.config.js loads this before the app,
// in the web build only; the artifact keeps claude.ai's runtime and the demo its mock.
//
// Where the backend is comes from config.json, which the publish step writes next to
// index.html (scripts/publish-web.mjs), so one build serves every environment and no
// environment's IDs are in the source. Without it, or when a runtime is already there
// (the tests' mock), this does nothing, and the app behaves as it always has.
import "./account.css";
import { start } from "./account.js";

// Receipt reading (use("sample")) needs the receipt endpoint, supply-checkout-kx8. Until
// it's built, sample is null and the app hides "Scan receipt". Switch this on when that
// endpoint's client is added to the capabilities in account.js.
export const RECEIPT_READING = false;

const FIELDS = ["apiUrl", "authUrl", "clientId", "realtimeUrl", "realtimeHost"];

export async function loadConfig() {
  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    const config = res.ok ? await res.json() : {};
    return FIELDS.every((k) => typeof config[k] === "string" && config[k]) ? config : null;
  } catch {
    return null;
  }
}

if (!window.claude) {
  const ready = loadConfig().then((config) => config && start(config));
  window.claude = {
    use: async (name) => {
      const caps = await ready;
      if (name === "sample" && !RECEIPT_READING) return null;
      return (caps && caps[name]) || null;
    },
    // What the app's notice suggests when storage doesn't connect
    help: { connecting: "reload the page", missing: "Reload the page, or try again in a few minutes." },
  };
}
