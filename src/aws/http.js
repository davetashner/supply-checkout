// One JSON request to the API (docs/api/openapi.yaml). Rejects with an error whose
// `code` is the error body's code, as is, so the app's existing handling applies:
// `invalid_argument` means view-only, `quota_exceeded` means storage is full.
export async function request(url, init) {
  let res;
  try { res = await fetch(url, init); }
  catch (e) { throw { code: "unavailable", message: String(e) }; }
  if (res.status === 204) return null;
  const body = await res.json().catch(() => null);
  if (res.ok) return body;
  // API Gateway's own 401 is {"message":"Unauthorized"}, with no error code
  const err = (body && body.error) || {};
  throw { code: err.code || (res.status === 401 ? "unauthenticated" : "internal"), message: err.message || `HTTP ${res.status}`, status: res.status };
}

export const json = (method, body, headers) => ({ method, headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
