// CloudWatch RUM for the web build (supply-checkout-al0): the app's JavaScript errors and
// page performance from real users, tagged with the release version. src/aws/main.js loads
// this module (its own chunk) only when config.json names an app monitor, so the artifact,
// the demo and the tests' mock runtime never load it.
//
// What it sends, and what it doesn't:
// - JavaScript errors (uncaught errors and unhandled promise rejections: type, message,
//   file, line and a stack trace), page views (the path only, which is always /), the
//   page's navigation and resource timings (script, stylesheet, font and image files, not
//   the API's requests) and web vitals. No HTTP telemetry, clicks, session replay or custom
//   attributes.
// - No cookies: the RUM client's user ID is all zeros and a session lasts one page load.
//   Nothing about the signed-in user or team is added. The client keeps its Cognito guest
//   identity and short-lived credentials in localStorage (cwr_i, cwr_c); they name no one.
// - Every event passes through scrub() before it's queued: query strings and fragments come
//   off every URL (an invite link's token, a sign-in redirect's code), and anything shaped
//   like an email address is masked, in case an error message quotes one.
//
// It signs its requests with the guest credentials of the identity pool in config.json
// (infra/lib/web/rum.ts: that role may only call rum:PutRumEvents on this app monitor).
// Built from @aws-rum/web-slim and the parts of @aws-rum/web-core it needs, rather than
// aws-rum-web, which also bundles session replay.
import { createSigningConfig, EnhancedAuthentication } from "@aws-rum/web-core";
import { AwsRum, defaultCookieAttributes, JsErrorPlugin, NavigationPlugin, PageViewPlugin, ResourcePlugin, WebVitalsPlugin } from "@aws-rum/web-slim";

// Every session, as the app monitor says (RUM_SESSION_SAMPLE_RATE in infra/lib/web/rum.ts).
// The client applies its own rate; the app monitor's only documents it.
export const SESSION_SAMPLE_RATE = 1;

// A URL's query string and fragment: from ? or # to the end of the URL
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>()]*)[?#][^\s"'<>()]*/gi;
const EMAIL = /[\w.%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Removes query strings, fragments and email addresses from every string in an event's details, in place. */
export function scrub(value) {
  if (typeof value === "string") return value.replace(URL_QUERY, "$1").replace(EMAIL, "[email]");
  if (value && typeof value === "object") for (const key of Object.keys(value)) value[key] = scrub(value[key]);
  return value;
}

/** Starts reporting to the app monitor in config.json (rumAppMonitorId, rumIdentityPoolId, rumRegion). */
export function startRum(config, version) {
  const cookieAttributes = defaultCookieAttributes();
  const rum = new AwsRum(config.rumAppMonitorId, version, config.rumRegion, {
    endpoint: `https://dataplane.rum.${config.rumRegion}.amazonaws.com`,
    sessionSampleRate: SESSION_SAMPLE_RATE,
    allowCookies: false,
    enableXRay: false,
    signing: true,
    cookieAttributes,
    // The plugins are added below, once scrub() is in place, so even the first page view
    // passes through it
    disableAutoPageView: true,
    eventPluginsToLoad: [],
  });
  // The hook sees each event's details before they're serialized; it adds no metadata
  rum.setEventMetadataHook((_type, details) => {
    scrub(details);
  });
  rum.setSigningConfigFactory(createSigningConfig);
  rum.setAwsCredentials(new EnhancedAuthentication({ identityPoolId: config.rumIdentityPoolId, cookieAttributes }, config.rumAppMonitorId).ChainAnonymousCredentialsProvider);
  for (const plugin of [new PageViewPlugin(), new JsErrorPlugin(), new NavigationPlugin(), new ResourcePlugin(), new WebVitalsPlugin()]) rum.addPlugin(plugin);
  return rum;
}
