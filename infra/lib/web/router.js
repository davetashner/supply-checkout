// CloudFront Function (cloudfront-js-2.0), viewer request, on the web
// distribution (supply-checkout-qk1). It picks the live release for the host:
//
//   app.<domain>            channel "app"   (the real web app)
//   <domain>, anything else channel "demo"  (the demo, supply-checkout-sy6)
//   www.<domain>            301 to <domain>
//
// and rewrites the path into that release: /x -> /releases/<version>/x. The
// live version of each channel is a key in the CloudFront KeyValueStore
// (scripts/publish-web.mjs sets it), so switching versions is one KVS write
// that reaches every edge in seconds, with no cache invalidation: the cache key
// is the rewritten path, so each version has its own cache entries.
//
// Paths ending in "/" get index.html (the default root object). There is no
// client-side routing, so any other missing path is a 404 from the bucket.
// A version of "none" means nothing is live yet.
// WebStack drops these comments and puts in the store's ID at synth time.
import cf from "cloudfront";

const kvs = cf.kvs("__KVS_ID__");
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- CloudFront calls it by name
async function handler(event) {
  const request = event.request;
  const host = ((request.headers.host && request.headers.host.value) || "").toLowerCase();

  if (host.startsWith("www.")) {
    return {
      statusCode: 301,
      statusDescription: "Moved Permanently",
      headers: { location: { value: "https://" + host.slice(4) + request.uri } },
    };
  }

  const channel = host.startsWith("app.") ? "app" : "demo";
  // A missing key or a store error means nothing can be served
  const version = await kvs.get(channel).catch(() => null);
  if (!version || version === "none" || !VERSION.test(version)) {
    return {
      statusCode: 503,
      statusDescription: "Service Unavailable",
      headers: { "cache-control": { value: "no-store" }, "retry-after": { value: "60" } },
    };
  }

  const uri = request.uri.endsWith("/") ? request.uri + "index.html" : request.uri;
  request.uri = "/releases/" + version + uri;
  return request;
}
