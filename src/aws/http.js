// How long a request may take before it's given up as unavailable
export const TIMEOUT = 15_000;

// One JSON request to the API (docs/api/openapi.yaml). Rejects with an error whose
// `code` is the error body's code, as is, so the app's existing handling applies:
// `invalid_argument` means view-only, `quota_exceeded` means storage is full. A request
// that takes longer than TIMEOUT is aborted and rejects as `unavailable`, so a stalled
// call (a refresh, a sign-out) can't hang the app with no feedback.
export async function request(url, init) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TIMEOUT);
  try {
    let res;
    try { res = await fetch(url, { ...init, signal: abort.signal }); }
    catch (e) { throw { code: "unavailable", message: abort.signal.aborted ? "Timed out" : String(e) }; }
    if (res.status === 204) return null;
    const body = await res.json().catch(() => null);
    if (res.ok) return body;
    // API Gateway's own 401 is {"message":"Unauthorized"}, with no error code
    const err = (body && body.error) || {};
    throw { code: err.code || (res.status === 401 ? "unauthenticated" : "internal"), message: err.message || `HTTP ${res.status}`, status: res.status };
  } finally { clearTimeout(timer); }
}

export const json = (method, body, headers) => ({ method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
