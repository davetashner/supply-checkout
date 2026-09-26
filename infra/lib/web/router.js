// CloudFront Function (cloudfront-js-2.0), viewer request, on the web
// distribution (supply-checkout-qk1, supply-checkout-59p). By host and path:
//
//   app.<domain>/...          channel "app": the real web app
//   <domain>/                 302 to https://app.<domain>/ (until the landing page)
//   <domain>/demo             301 to /demo/
//   <domain>/demo/...         channel "demo", with /demo stripped: the demo
//   <domain>/anything else    302 to https://app.<domain>/
//   www.<domain>/demo...      301 to https://<domain>/demo/
//   www.<domain>/anything     301 to https://<domain>/
//
// Any other host (the distribution's cloudfront.net name) is treated as the apex.
// Every Location is a fixed URL built from the configured hosts: nothing from
// the request (its Host, path or query string) is ever copied into one, so
// there's no open redirect. Query strings are dropped: the app's own links
// (invites) point at app. directly.
//
// Serving rewrites the path into the channel's live release: /x ->
// /releases/<version>/x. The live version of each channel is a key in the
// CloudFront KeyValueStore (scripts/publish-web.mjs sets it), so switching
// versions is one KVS write that reaches every edge in seconds, with no cache
// invalidation: the cache key is the rewritten path, so each version has its
// own cache entries.
//
// Paths ending in "/" get index.html. There is no client-side routing, so any
// other missing path is a 404 from the bucket. A version of "none" means
// nothing is live yet.
//
// Responses made here never reach the cache. The 302s say no-store, so the
// home page can later become the landing page without browsers remembering
// the redirect. Every response made here (the redirects and the 503) carries
// HSTS and nosniff itself, since the response headers policy is documented for
// cached and origin responses only.
//
// The host is compared exactly, after lowercasing: "app.<domain>." (a
// trailing dot) or "app.<domain>:443" isn't app., so it's treated as the apex.
// WebStack drops these comments and fills in the __NAMES__ at synth time.
import cf from "cloudfront";

const kvs = cf.kvs("__KVS_ID__");
const APEX = "__APEX_HOST__";
const WWW = "__WWW_HOST__";
const APP = "__APP_HOST__";
const HSTS = "__HSTS__";
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// On every response made here; a fresh copy each time, so none share an object
const SECURITY_HEADERS = {
  "strict-transport-security": HSTS,
  "x-content-type-options": "nosniff",
};

function headers(extra) {
  const all = Object.assign({}, SECURITY_HEADERS, extra);
  const out = {};
  for (const name of Object.keys(all)) out[name] = { value: all[name] };
  return out;
}

function redirect(statusCode, location, cacheControl) {
  return {
    statusCode,
    statusDescription: statusCode === 301 ? "Moved Permanently" : "Found",
    headers: headers({ location, "cache-control": cacheControl }),
  };
}

// Permanent: browsers may keep these for a day
const moved = (location) => redirect(301, location, "max-age=86400");
// Temporary: never stored
const found = (location) => redirect(302, location, "no-store");

const isDemo = (uri) => uri === "/demo" || uri.startsWith("/demo/");

async function serve(request, channel, uri) {
  // A missing key or a store error means nothing can be served
  const version = await kvs.get(channel).catch(() => null);
  if (!version || version === "none" || !VERSION.test(version)) {
    return {
      statusCode: 503,
      statusDescription: "Service Unavailable",
      headers: headers({ "cache-control": "no-store", "retry-after": "60" }),
    };
  }
  request.uri = "/releases/" + version + (uri.endsWith("/") ? uri + "index.html" : uri);
  return request;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls it by name
async function handler(event) {
  const request = event.request;
  const host = ((request.headers.host && request.headers.host.value) || "").toLowerCase();
  const uri = request.uri;

  if (host === APP) return serve(request, "app", uri);
  if (host === WWW) return moved(isDemo(uri) ? "https://" + APEX + "/demo/" : "https://" + APEX + "/");
  if (uri === "/demo") return moved("/demo/");
  if (uri.startsWith("/demo/")) return serve(request, "demo", uri.slice("/demo".length));
  return found("https://" + APP + "/");
}
