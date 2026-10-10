// How long a request may take before it's given up as unavailable
export const TIMEOUT = 15_000;

// One JSON request to the API (docs/api/openapi.yaml). Rejects with an error whose
// `code` is the error body's code, as is, and `reason` when the body has one (why a
// `permission_denied` or `aborted`; db.js turns a viewer's refused write into the app's
// view-only code), so `quota_exceeded` means storage is full, and so on. A request
// that takes longer than TIMEOUT is aborted and rejects as `unavailable`, so a stalled
// call (a refresh, a sign-out) can't hang the app with no feedback. A slower call (reading a
// receipt) passes its own `timeout`; `signal` is the caller's Stop, which rejects as `cancelled`.
export async function request(url, init, { timeout = TIMEOUT, signal } = {}) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  const stop = () => abort.abort();
  signal?.addEventListener("abort", stop);
  // Stopped before the request starts (while a refresh ran, say): it never goes out
  if (signal?.aborted) abort.abort();
  const gone = () => signal?.aborted ? { code: "cancelled", message: "cancelled" } : { code: "unavailable", message: "Timed out" };
  try {
    let res;
    try { res = await fetch(url, { ...init, signal: abort.signal }); }
    catch (e) { throw abort.signal.aborted ? gone() : { code: "unavailable", message: String(e) }; }
    if (res.status === 204) return null;
    // The timeout covers the body too: a body that stalls rejects, rather than reading as null
    const body = await res.json().catch(() => { if (abort.signal.aborted) throw gone(); return null; });
    if (res.ok) return body;
    // API Gateway's own 401 is {"message":"Unauthorized"}, with no error code. A bare code
    // ({"error":"photo_invalid"}, the profile photo routes) is the code.
    const raw = body && body.error, err = typeof raw === "string" ? { code: raw } : raw || {};
    throw { code: err.code || (res.status === 401 ? "unauthenticated" : "internal"), message: err.message || `HTTP ${res.status}`, status: res.status, ...(err.reason ? { reason: err.reason } : {}) };
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", stop); }
}

export const json = (method, body, headers) => ({ method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
