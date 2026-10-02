// The /ops routes, as the page calls them (supply-checkout-gxlt). The same requests as
// `npm run ops` (scripts/ops.mjs): no other route, and no new data access.
//
// - The token goes only in the Authorization header, to the API's origin, never with cookies.
// - Every write (a comp or ending one) carries the version of the team the operator read as
//   expectedVersion and an Idempotency-Key, so a comp never overwrites a change it didn't see,
//   and a retry of the same request after a lost answer is applied once.

export const TEAM_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const TIMEOUT_MS = 15_000;
/** The most requests one search makes while its pages come back empty (as the CLI). */
export const SEARCH_REQUESTS = 20;
export const PAGE_SIZE = 25;

export class ApiError extends Error {
  constructor(status, body) {
    const error = body && typeof body === "object" ? body.error : undefined;
    const message = typeof error?.message === "string" ? error.message.slice(0, 300) : `The API answered ${status}`;
    super(message);
    this.status = status;
    this.code = typeof error?.code === "string" ? error.code : "";
    this.reason = typeof error?.reason === "string" ? error.reason : "";
  }
}

/** No answer at all (offline, timed out): the same request may be sent again. */
export class NetworkError extends Error {}

export const teamPath = (teamId) => {
  if (!TEAM_ID.test(String(teamId))) throw new ApiError(400, { error: { message: "That isn't a team ID" } });
  return `/ops/teams/${teamId}`;
};

/**
 * getToken() returns the current access token or undefined (signed out or expired).
 * onUnauthorized() runs on a 401, after which the page asks the operator to sign in again.
 */
export function createApi({ apiUrl, getToken, onUnauthorized = () => {}, fetchFn, timeoutMs = TIMEOUT_MS }) {
  async function call(method, path, { query, body, idempotencyKey } = {}) {
    const token = getToken();
    if (!token) {
      onUnauthorized();
      throw new ApiError(401, { error: { message: "Sign in again" } });
    }
    const url = new URL(path, apiUrl);
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers = { authorization: `Bearer ${token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchFn(url.toString(), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      throw new NetworkError("No answer from the API. Check the connection and try again.");
    } finally {
      clearTimeout(timer);
    }
    const answer = await response.json().catch(() => ({}));
    if (response.status === 401) onUnauthorized();
    if (!response.ok) throw new ApiError(response.status, answer);
    return answer;
  }

  return {
    /** One page of teams, or of a search; a search follows empty pages for a while, as the CLI does. */
    async listTeams({ q, cursor } = {}) {
      const query = (c) => ({ q: q || undefined, cursor: c, limit: String(PAGE_SIZE) });
      let page = await call("GET", "/ops/teams", { query: query(cursor) });
      for (let n = 1; q && !page.teams?.length && page.cursor && n < SEARCH_REQUESTS; n++) {
        page = await call("GET", "/ops/teams", { query: query(page.cursor) });
      }
      return { teams: Array.isArray(page.teams) ? page.teams : [], cursor: typeof page.cursor === "string" ? page.cursor : undefined };
    },
    getTeam: async (teamId) => call("GET", teamPath(teamId)),
    setComp: async (teamId, body, idempotencyKey) => call("PUT", `${teamPath(teamId)}/comp`, { body, idempotencyKey }),
    endComp: async (teamId, body, idempotencyKey) => call("DELETE", `${teamPath(teamId)}/comp`, { body, idempotencyKey }),
    async audit({ teamId, month, cursor } = {}) {
      if (teamId !== undefined) teamPath(teamId);
      const page = await call("GET", "/ops/audit", { query: { teamId, month, cursor } });
      return { events: Array.isArray(page.events) ? page.events : [], cursor: typeof page.cursor === "string" ? page.cursor : undefined };
    },
  };
}
