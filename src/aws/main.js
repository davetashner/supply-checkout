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
// The release version RUM tags every event with (release-please sets it); only this field
// of package.json is bundled
import { version } from "../../package.json";

// Receipt reading (use("sample")): the receipt endpoint, POST /teams/{teamId}/receipts/read
// (src/aws/receipts.js, supply-checkout-kx8). Switched off, sample is null and the app hides
// "Scan receipt".
export const RECEIPT_READING = true;

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

// CloudWatch RUM (src/aws/rum.js): where to report errors and page performance. Optional, so
// a config.json without them still runs the app, just unmonitored. The identity pool's ID
// starts with its region, which must be the app monitor's.
const RUM_FIELDS = ["rumAppMonitorId", "rumIdentityPoolId", "rumRegion"];

/** Loads the RUM client, in its own chunk, when config.json names an app monitor. Never throws. */
export function startMonitoring(config) {
  const configured = RUM_FIELDS.every((k) => typeof config[k] === "string" && config[k]) && config.rumIdentityPoolId.startsWith(config.rumRegion + ":");
  if (!configured) return null;
  // A monitor that can't load or start must not stop the app. It resolves to the module
  // itself, so the build keeps its scrubbing exported, where tests/aws-rum.spec.js reaches it
  return import("./rum.js").then((rum) => (rum.startRum(config, version), rum)).catch(() => null);
}

if (!window.claude) {
  const ready = loadConfig().then((config) => config && (startMonitoring(config), start(config)));
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
