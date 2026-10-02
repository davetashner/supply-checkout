// CloudFront Function (cloudfront-js-2.0), viewer request, on the operator page's own
// distribution (supply-checkout-gxlt, ADR 0015 §6). Serves only ops.<domain>:
//
//   ops.<domain>/                     the ops channel's live release: index.html
//   ops.<domain>/ops-config.json      its config (scripts/publish-web.mjs writes it)
//   ops.<domain>/assets/<name>.<ext>  its hashed script, stylesheet and icon (js, css, svg)
//   anything else                     404, made here
//
// The live version is the "ops" key in the same KeyValueStore as the app and demo channels
// (scripts/publish-web.mjs), and must start with "ops-": a release published for the app or
// the demo can never be served on this origin, even if the key were set to one, so none of
// the customer app's code runs where an operator's token is. Any other host (the
// distribution's cloudfront.net name) gets a 404. The path is matched against that short
// list, so nothing else in the releases bucket (another release, a "..") can be named.
//
// Responses made here (the 404 and the 503) never reach the cache, and carry HSTS, nosniff,
// no-store and a CSP that allows nothing themselves, since the response headers policy is
// documented for cached and origin responses only. No loops or newer syntax: see router.js.
// WebStack drops these comments and fills in the __NAMES__ at synth time.
import cf from "cloudfront";

const kvs = cf.kvs("__KVS_ID__");
const OPS = "__OPS_HOST__";
const HSTS = "__HSTS__";
const VERSION = /^ops-[A-Za-z0-9._-]{1,124}$/;
const PATHS = /^\/(ops-config\.json|assets\/[A-Za-z0-9_-]{1,100}\.(js|css|svg))?$/;

function made(statusCode, statusDescription) {
  return {
    statusCode,
    statusDescription,
    headers: {
      "strict-transport-security": { value: HSTS },
      "x-content-type-options": { value: "nosniff" },
      "cache-control": { value: "no-store" },
      "content-security-policy": { value: "default-src 'none'; frame-ancestors 'none'" },
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls it by name
async function handler(event) {
  const request = event.request;
  const host = ((request.headers.host && request.headers.host.value) || "").toLowerCase();
  if (host !== OPS || !PATHS.test(request.uri)) return made(404, "Not Found");
  // A missing key or a store error means nothing can be served
  const version = await kvs.get("ops").catch(() => null);
  if (!version || !VERSION.test(version)) return made(503, "Service Unavailable");
  request.uri = "/releases/" + version + (request.uri === "/" ? "/index.html" : request.uri);
  return request;
}
