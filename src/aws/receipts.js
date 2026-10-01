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

// The server's reasons as the app's error codes (sampleErr in src/receipt-prompt.js)
const REASONS = {
  image_rejected: "image_rejected",
  receipt_limit: "receipt_limit",
  model_busy: "rate_limited",
  model_timeout: "timeout",
  invalid_output: "invalid_json",
};

// The Stop button's cancel stays as it is; a code the app has no words for gets its general
// "check your connection" message
const appError = (e) => (e.code === "cancelled" ? e : { code: Object.hasOwn(REASONS, e.reason) ? REASONS[e.reason] : e.code === "unauthenticated" ? "session_expired" : "failed", message: e.message });

async function base64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  // In chunks: String.fromCharCode takes a limited number of arguments
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** The runtime capability for a team: json(prompt, { images, signal }) and limits(). */
export function receiptsFor(api, team) {
  const path = `/teams/${encodeURIComponent(team.id)}/receipts/read`;
  return {
    async json(_prompt, { images, signal }) {
      // src/main.js passes the one photo src/photo.js made
      if (!MEDIA_TYPES.includes(images.type) || images.size > MAX_IMAGE_BYTES) throw { code: "image_rejected", message: "Not a JPEG or PNG photo the endpoint takes" };
      const image = { mediaType: images.type, data: await base64(images) };
      // Stop tapped while the photo was being read: nothing is sent, so no receipt is used
      if (signal.aborted) throw { code: "cancelled", message: "cancelled" };
      try {
        // byKey: `match` is a product key, not one of the prompt's ids (src/main.js)
        return { ...await api("POST", path, { image }, undefined, { timeout: RECEIPT_TIMEOUT, signal }), byKey: true };
      } catch (e) {
        throw appError(e);
      }
    },
    limits: async () => ({ images: { maxCount: 1, maxInputBytes: MAX_IMAGE_BYTES, mediaTypes: [...MEDIA_TYPES] } }),
  };
}
