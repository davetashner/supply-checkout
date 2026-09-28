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
//   off every URL or path (an invite link's token, a sign-in redirect's code), and anything
//   shaped like a JWT or an email address is masked, in case an error message quotes one.
//   It fails closed: an event whose details can't be scrubbed isn't recorded, and if one the
//   client builds itself can't be, the client stops sending.
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

// JWT-shaped strings (an access or ID token), anything shaped like an email address, and the
// query string and fragment of a URL or path, absolute or relative: from ? or # after a /
// to the next space
const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const EMAIL = /[\w.%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const URL_QUERY = /((?:[a-z][a-z0-9+.-]*:)?\/[^\s?#]*)[?#]\S*/gi;

const scrubText = (text) => text.replace(JWT, "[token]").replace(EMAIL, "[email]").replace(URL_QUERY, "$1");

/**
 * A scrubbed copy of an event's details: every string, at any depth, with tokens, email
 * addresses and URLs' query strings and fragments taken out. Throws if a value can't be read.
 */
export function scrub(value) {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).map((key) => [key, scrub(value[key])]));
  return value;
}

/**
 * Wraps a plugin's record functions so they record a scrubbed copy of each event's details,
 * or, when the details can't be read, nothing at all: it fails closed.
 */
export const scrubbedRecorder = (record) => (type, details, metadata) => {
  let copy;
  try {
    copy = scrub(details);
  } catch {
    return;
  }
  record(type, copy, metadata);
};

/**
 * Scrubs, in place, the details of an event the RUM client builds itself (the page view and
 * session start, which don't come through a plugin). Returns false when it couldn't: a value
 * it couldn't read, or a field it could neither replace nor remove.
 */
export function scrubInPlace(details) {
  let copy;
  try {
    copy = scrub(details);
  } catch {
    return false;
  }
  let clean = true;
  for (const key of Object.keys(copy)) {
    try {
      details[key] = copy[key];
    } catch {
      try {
        delete details[key];
      } catch {
        clean = false;
      }
    }
  }
  return clean;
}

/** The event metadata hook: scrubs an event in place, or stops the client from sending anything. */
export const scrubOrStop = (rum) => (_type, details) => {
  if (!scrubInPlace(details)) rum.disable();
};

// Every event a plugin records goes through scrubbedRecorder
function scrubbing(plugin) {
  const load = plugin.load.bind(plugin);
  plugin.load = (context) => load({ ...context, record: scrubbedRecorder(context.record), recordCandidate: scrubbedRecorder(context.recordCandidate) });
  return plugin;
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
    // The plugins are added below, once the scrubbing is in place, so even the first page
    // view passes through it
    disableAutoPageView: true,
    eventPluginsToLoad: [],
  });
  // Every event's details, before they're serialized: the plugins' events are scrubbed copies
  // already; the client's own (page view, session start) are scrubbed here. If one can't be,
  // the client stops sending anything, so it fails closed. The hook adds no metadata.
  rum.setEventMetadataHook(scrubOrStop(rum));
  rum.setSigningConfigFactory(createSigningConfig);
  rum.setAwsCredentials(new EnhancedAuthentication({ identityPoolId: config.rumIdentityPoolId, cookieAttributes }, config.rumAppMonitorId).ChainAnonymousCredentialsProvider);
  for (const plugin of [new PageViewPlugin(), new JsErrorPlugin(), new NavigationPlugin(), new ResourcePlugin(), new WebVitalsPlugin()]) rum.addPlugin(scrubbing(plugin));
  return rum;
}
