// The sign-in session endpoints (src/api/auth-handler.ts), with a fake
// Cognito OAuth server.

import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearedCookie, cookieToken, createAuthHandler, expectedAuthUrl, refreshCookie } from "../src/api/auth-handler.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";

const APP = "https://app.example.com";
const AUTH = "https://auth.example.com";
const VERIFIER = "v".repeat(43);

interface Sent {
  readonly url: string;
  readonly form: Record<string, string>;
}

let sent: Sent[];
let reply: (url: string) => Response | Promise<Response>;
let handler: ReturnType<typeof createAuthHandler>;

let counted: string[] = [];
const obs = {
  region: "test-local-1",
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  count: (metric: string) => counted.push(metric),
  flush: () => {},
} as unknown as Observability;

const tokens = (extra: Record<string, unknown> = {}) =>
  Response.json({ access_token: "access.jwt", id_token: "id.jwt", refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer", ...extra });

beforeEach(() => {
  sent = [];
  counted = [];
  reply = () => tokens();
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), form: Object.fromEntries(new URLSearchParams(String(init?.body))) });
    return reply(String(url));
  }) as unknown as typeof globalThis.fetch;
  handler = createAuthHandler({ config: { authUrl: AUTH, clientId: "web-client", allowedOrigins: [APP, "http://localhost:5173"] }, obs, fetch });
});

function event(path: string, options: { origin?: string | null; body?: unknown; cookies?: string[] } = {}): APIGatewayProxyEventV2 {
  const origin = options.origin === undefined ? APP : options.origin;
  return {
    version: "2.0",
    routeKey: `POST ${path}`,
    rawPath: path,
    rawQueryString: "",
    headers: origin ? { Origin: origin } : {},
    cookies: options.cookies,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

async function call(path: string, options: Parameters<typeof event>[1] = {}) {
  const response = await handler(event(path, options));
  return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : undefined, cookies: response.cookies };
}

const session = { code: "abc-123", codeVerifier: VERIFIER, redirectUri: `${APP}/` };

describe("the sign-in endpoint (supply-checkout-6uw.23)", () => {
  // The grant and the refresh token go to AUTH_URL, so it must be auth. on the app's own domain, or the function won't start
  const create = (authUrl: string, allowedOrigins: string[] = [APP, "http://localhost:5173"]) => () => createAuthHandler({ config: { authUrl, clientId: "web-client", allowedOrigins }, obs });

  it("is auth. on the app's domain", () => {
    expect(expectedAuthUrl([APP])).toBe(AUTH);
    expect(expectedAuthUrl(["http://localhost:5173", "https://app.staging.example.com"])).toBe("https://auth.staging.example.com");
    expect(create(AUTH)).not.toThrow();
  });

  it("refuses to start with any other AUTH_URL", () => {
    for (const authUrl of ["https://auth.evil.example", "https://auth.example.com.evil.example", "http://auth.example.com", "https://auth.example.com/", "https://auth.example.com/x", "https://ops-auth.example.com", ""]) {
      expect(create(authUrl), authUrl).toThrow(/AUTH_URL/);
    }
  });

  it("refuses to start without an https://app. origin to check it against", () => {
    expect(() => expectedAuthUrl(["http://localhost:5173"])).toThrow(/ALLOWED_ORIGINS/);
    expect(create(AUTH, ["http://localhost:5173"])).toThrow(/ALLOWED_ORIGINS/);
    expect(create(AUTH, ["http://app.example.com"])).toThrow(/ALLOWED_ORIGINS/);
    expect(create(AUTH, [])).toThrow(/ALLOWED_ORIGINS/);
  });
});

describe("POST /auth/session", () => {
  it("redeems the code with PKCE and keeps the refresh token in a locked-down cookie", async () => {
    const response = await call("/auth/session", { body: session });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accessToken: "access.jwt", idToken: "id.jwt", expiresIn: 3600 });
    expect(JSON.stringify(response.body)).not.toContain("refresh-1");
    expect(response.cookies).toEqual(["__Secure-sc_refresh=refresh-1; Path=/auth; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict"]);
    expect(sent).toEqual([
      {
        url: `${AUTH}/oauth2/token`,
        form: { client_id: "web-client", grant_type: "authorization_code", code: "abc-123", code_verifier: VERIFIER, redirect_uri: `${APP}/` },
      },
    ]);
  });

  it("checks the origin, the code, the verifier and the redirect", async () => {
    expect((await call("/auth/session", { origin: null, body: session })).status).toBe(403);
    expect((await call("/auth/session", { origin: "https://evil.example", body: session })).body.error.code).toBe("permission_denied");
    expect((await call("/auth/session", { body: { ...session, code: "a b" } })).status).toBe(400);
    expect((await call("/auth/session", { body: { ...session, codeVerifier: "short" } })).status).toBe(400);
    expect((await call("/auth/session", { body: { ...session, redirectUri: "https://evil.example/" } })).status).toBe(400);
    expect((await call("/auth/session", { body: { ...session, extra: 1 } })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("answers 401 when Cognito refuses the code, and 5xx when it fails", async () => {
    reply = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    const refused = await call("/auth/session", { body: session });
    expect(refused).toMatchObject({ status: 401, body: { error: { code: "unauthenticated" } }, cookies: [clearedCookie()] });
    reply = () => new Response("oops", { status: 401 });
    expect((await call("/auth/session", { body: session })).status).toBe(401);
    reply = () => new Response("down", { status: 500 });
    expect((await call("/auth/session", { body: session })).status).toBe(503);
    reply = () => {
      throw new TypeError("fetch failed");
    };
    expect((await call("/auth/session", { body: session })).status).toBe(503);
    reply = () => Response.json({ access_token: "a" });
    expect((await call("/auth/session", { body: session })).status).toBe(502);
    reply = () => Response.json({ access_token: "a", id_token: "i" });
    expect((await call("/auth/session", { body: session })).status).toBe(502);
  });
});

describe("POST /auth/refresh", () => {
  const cookie = [`other=1`, `__Secure-sc_refresh=refresh-1`];

  it("redeems the cookie's refresh token and stores the rotated one", async () => {
    reply = () => tokens({ refresh_token: "refresh-2" });
    const response = await call("/auth/refresh", { cookies: cookie });
    expect(response).toMatchObject({ status: 200, body: { accessToken: "access.jwt", idToken: "id.jwt" }, cookies: [refreshCookie("refresh-2")] });
    expect(sent[0]).toEqual({ url: `${AUTH}/oauth2/token`, form: { client_id: "web-client", grant_type: "refresh_token", refresh_token: "refresh-1" } });
  });

  it("keeps the cookie when Cognito doesn't rotate", async () => {
    reply = () => tokens({ refresh_token: undefined });
    expect((await call("/auth/refresh", { cookies: cookie })).cookies).toBeUndefined();
  });

  it("answers 401 and clears the cookie when there's none, or it's refused", async () => {
    expect(await call("/auth/refresh")).toMatchObject({ status: 401, cookies: [clearedCookie()] });
    expect(await call("/auth/refresh", { cookies: ["__Secure-sc_refresh=bad token;"] })).toMatchObject({ status: 401 });
    reply = () => Response.json({ error: "invalid_grant" }, { status: 400 });
    expect(await call("/auth/refresh", { cookies: cookie })).toMatchObject({ status: 401, cookies: [clearedCookie()] });
    reply = () => new Response("not json", { status: 400 });
    expect((await call("/auth/refresh", { cookies: cookie })).status).toBe(401);
  });

  it("refuses a request from another origin even with the cookie (CSRF)", async () => {
    expect((await call("/auth/refresh", { origin: "https://evil.example", cookies: cookie })).status).toBe(403);
    expect((await call("/auth/refresh", { origin: null, cookies: cookie })).status).toBe(403);
    expect(sent).toEqual([]);
  });
});

describe("POST /auth/sign-out", () => {
  it("revokes the refresh token and clears the cookie", async () => {
    reply = () => new Response(null, { status: 200 });
    const response = await call("/auth/sign-out", { cookies: ["__Secure-sc_refresh=refresh-1"] });
    expect(response).toEqual({ status: 204, body: undefined, cookies: [clearedCookie()] });
    expect(sent).toEqual([{ url: `${AUTH}/oauth2/revoke`, form: { client_id: "web-client", token: "refresh-1" } }]);
    expect(counted).toEqual([]);
  });

  it("clears the cookie even when there's no token or revoking fails, counting each failed revoke", async () => {
    expect((await call("/auth/sign-out")).status).toBe(204);
    expect(sent).toEqual([]);
    expect(counted).toEqual([]);
    reply = () => new Response("down", { status: 503 });
    expect((await call("/auth/sign-out", { cookies: ["__Secure-sc_refresh=refresh-1"] })).cookies).toEqual([clearedCookie()]);
    reply = () => {
      throw new TypeError("fetch failed");
    };
    expect((await call("/auth/sign-out", { cookies: ["__Secure-sc_refresh=refresh-1"] })).status).toBe(204);
    // For the "Sign-out not revoking" alarm: the token stays valid at Cognito
    expect(counted).toEqual([BusinessMetric.SignOutRevokeFailures, BusinessMetric.SignOutRevokeFailures]);
  });

  it("refuses another origin", async () => {
    expect((await call("/auth/sign-out", { origin: "https://evil.example", cookies: ["__Secure-sc_refresh=r"] })).status).toBe(403);
  });
});

describe("routing and cookies", () => {
  it("answers 404 for other routes", async () => {
    expect((await call("/auth/other")).status).toBe(404);
  });

  it("reads only its own cookie", () => {
    expect(cookieToken({ cookies: ["a=b", "__Secure-sc_refresh=tok.en"] })).toBe("tok.en");
    expect(cookieToken({ cookies: ["x__Secure-sc_refresh=tok"] })).toBeUndefined();
    expect(cookieToken({ cookies: ["=x"] })).toBeUndefined();
    expect(cookieToken({})).toBeUndefined();
  });
});
