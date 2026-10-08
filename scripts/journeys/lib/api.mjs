// The app's public API, as a signed-in user calls it (docs/api/openapi.yaml), for the /me guard
// and cleanup. Nothing here has more power than the user whose token it holds.
//
// Errors carry the method, the route's shape (IDs replaced) and the status, never a token, an
// ID, a body or the server's message.
import { PROD } from "./config.mjs";

export class ApiError extends Error {
  constructor(method, route, status, code) {
    super(`${method} ${route} answered ${status}${code ? ` ${code}` : ""}`);
    this.status = status;
    this.code = code;
  }
}

/** The app's config.json, checked: its API and sign-in hosts must be prod's own. */
export async function appConfig({ fetch = globalThis.fetch, app = PROD.app } = {}) {
  const res = await fetch(`${app}/config.json`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`The app's config.json answered ${res.status}`);
  const config = await res.json();
  if (config.apiUrl !== PROD.api || config.authUrl !== PROD.auth) throw new Error("The app's config.json names hosts other than prod's");
  if (typeof config.clientId !== "string") throw new Error("The app's config.json has no clientId");
  return config;
}

const enc = encodeURIComponent;

/** An API client for one access token. */
export function createApi({ token, fetch = globalThis.fetch, base = PROD.api, timeoutMs = 15_000 }) {
  async function call(method, path, route, body) {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 204) return null;
    let json = null;
    try { json = await res.json(); } catch {}
    if (!res.ok) {
      const code = typeof json?.error?.code === "string" ? json.error.code : undefined;
      const reason = typeof json?.error?.reason === "string" ? json.error.reason : undefined;
      throw new ApiError(method, route, res.status, [code, reason].filter((s) => s && /^[a-z_]{1,40}$/.test(s)).join(" "));
    }
    return json;
  }
  async function listAll(path, route) {
    const out = [];
    let cursor;
    do {
      const page = await call("GET", `${path}?limit=1000${cursor ? `&cursor=${enc(cursor)}` : ""}`, route);
      out.push(...(page?.documents ?? []));
      cursor = page?.cursor;
    } while (cursor);
    return out;
  }
  return {
    me: () => call("GET", "/me", "/me"),
    listProjects: (teamId) => listAll(`/teams/${enc(teamId)}/projects`, "/teams/{teamId}/projects"),
    listProducts: (teamId) => listAll(`/teams/${enc(teamId)}/products`, "/teams/{teamId}/products"),
    deleteProject: (teamId, id, version) => call("DELETE", `/teams/${enc(teamId)}/projects/${enc(id)}?expectedVersion=${version}`, "/teams/{teamId}/projects/{projectId}"),
    deleteProduct: (teamId, key, version) => call("DELETE", `/teams/${enc(teamId)}/products/${enc(key)}?expectedVersion=${version}`, "/teams/{teamId}/products/{key}"),
    getSettings: (teamId) => call("GET", `/teams/${enc(teamId)}/settings`, "/teams/{teamId}/settings"),
    putSettings: (teamId, equipmentMarkup, expectedVersion) => call("PUT", `/teams/${enc(teamId)}/settings`, "/teams/{teamId}/settings", { equipmentMarkup, expectedVersion }),
    closeTeam: (teamId, name) => call("POST", `/teams/${enc(teamId)}/close`, "/teams/{teamId}/close", { name }),
    deleteMe: () => call("DELETE", "/me", "/me", { confirm: "DELETE" }),
  };
}
