// Receipt reading in the web build (ADR 0008): the runtime's use("sample") for src/main.js,
// backed by POST /teams/{teamId}/receipts/read (docs/api/openapi.yaml), where the server reads
// the photo with Claude on Amazon Bedrock. The browser sends only the photo: the server builds
// the prompt from the team's own inventory, so the prompt src/main.js passes is ignored, and the
// lines come back with `match` as the team's product keys, which `byKey` tells the app. The claude.ai artifact keeps
// claude.ai's sample.

// The server gives the model 25 seconds; this leaves room for the upload on a slow phone
// connection and the rest of the request.
export const RECEIPT_TIMEOUT = 40_000;
// What the endpoint takes: the photo src/photo.js made, at most this many bytes
export const MEDIA_TYPES = ["image/jpeg", "image/png"];
export const MAX_IMAGE_BYTES = 1_500_000;

// The server's reasons as the app's error codes (sampleErr in src/receipt-prompt.js).
// `rate_limited` is the caller's own rate limit (supply-checkout-wxx): its message comes from
// the server, which says how long to wait (the Retry-After it sends, which the browser can't
// read across origins) or that today's free trial scans are used up, so the app shows it as it is.
const REASONS = {
  image_rejected: "image_rejected",
  receipt_limit: "receipt_limit",
  rate_limited: "receipt_rate",
  model_busy: "rate_limited",
  model_timeout: "timeout",
  invalid_output: "invalid_json",
};

// The Stop button's cancel stays as it is; a code the app has no words for gets its general
// "check your connection" message. A team out of receipts says whether it was its trial's or
// its month's, from the last usage the server sent
const appError = (e, period) => {
  if (e.code === "cancelled") return e;
  const code = Object.hasOwn(REASONS, e.reason) ? REASONS[e.reason] : e.code === "unauthenticated" ? "session_expired" : "failed";
  return { code: code === "receipt_limit" && period === "trial" ? "trial_receipt_limit" : code, message: e.message };
};

async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  // In chunks: String.fromCharCode takes a limited number of arguments
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** The line src/main.js shows under Scan receipt, and Team settings shows owners: the scans left. */
export function usageLabel(usage) {
  const { period, limit, remaining } = usage;
  if (period === "trial") return remaining > 0 ? `${remaining} of ${limit} free trial receipt scans left` : "No free trial receipt scans left. An owner can subscribe to scan more.";
  return remaining > 0 ? `${remaining} of ${limit} receipt scans left this month` : "No receipt scans left this month";
}

// The server's usage, with its label; null for anything that isn't one
const labeled = (usage) => usage && typeof usage === "object" && typeof usage.remaining === "number" ? { ...usage, label: usageLabel(usage) } : null;

/** The team's receipt usage from GET /teams/{teamId}/receipts/usage, labeled, or null if it can't be read. */
export async function readUsage(api, team) {
  try { return labeled((await api("GET", `/teams/${encodeURIComponent(team.id)}/receipts/usage`)).usage); } catch { return null; }
}

/**
 * The runtime capability for a team: json(prompt, { images, signal }), limits(), and usage():
 * the team's receipt scans against its allowance (GET /teams/{teamId}/receipts/usage),
 * `{ period: "month" | "trial", used, limit, remaining, label }`, or null if it can't be read. A
 * read's answer carries the same `usage`, which src/main.js shows without asking again.
 */
export function receiptsFor(api, team) {
  const path = `/teams/${encodeURIComponent(team.id)}/receipts/read`;
  let period = null;
  const seen = (usage) => { if (usage) period = usage.period; return usage; };
  return {
    usage: async () => seen(await readUsage(api, team)),
    async json(_prompt, { images, signal }) {
      // src/main.js passes the one photo src/photo.js made
      if (!MEDIA_TYPES.includes(images.type) || images.size > MAX_IMAGE_BYTES) throw { code: "image_rejected", message: "Not a JPEG or PNG photo the endpoint takes" };
      const image = { mediaType: images.type, data: await base64(images) };
      // Stop tapped while the photo was being read: nothing is sent, so no receipt is used
      if (signal.aborted) throw { code: "cancelled", message: "cancelled" };
      try {
        // byKey: `match` is a product key, not one of the prompt's ids (src/main.js)
        const res = await api("POST", path, { image }, undefined, { timeout: RECEIPT_TIMEOUT, signal });
        return { ...res, usage: seen(labeled(res.usage)), byKey: true };
      } catch (e) {
        throw appError(e, period);
      }
    },
    limits: async () => ({ images: { maxCount: 1, maxInputBytes: MAX_IMAGE_BYTES, mediaTypes: [...MEDIA_TYPES] } }),
  };
}
