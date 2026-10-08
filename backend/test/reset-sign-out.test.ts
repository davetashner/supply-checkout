// After a confirmed password reset (supply-checkout-6uw.32): the user pool's
// post confirmation trigger, which Cognito runs after ConfirmForgotPassword
// from the app or Managed Login, signs the account out everywhere
// (AdminUserGlobalSignOut) and hands the security notices function the
// user's sub; a sign-up does neither; a failure never fails the reset, and is
// logged with the error's name only and counted.

import type { PostConfirmationTriggerEvent } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { globalSignOut } from "../src/identity/cognito-admin.js";
import type { PasswordResetNoticeRequest } from "../src/identity/names.js";
import { createPostConfirmationHandler, SIGN_OUT_TIMEOUT_MS, WELCOME_BUDGET_MS, WELCOME_INVOKE_TIMEOUT_MS } from "../src/identity/post-confirmation-handler.js";
import { eventInvoker } from "../src/identity/welcome-invoke.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { REGION } from "./helpers.js";

const POOL = "test-local-1_AppPool1";
const SUB = "4f1c2b7e-9a3d-4e5f-8b6a-1c2d3e4f5a6b";
const USERNAME = "owner-username";
const EMAIL = "owner@example.com";
const NOW = Date.parse("2026-10-08T09:00:00Z");

type Logged = { level: string; message: string; data: Record<string, unknown> };

let logs: Logged[];
let metrics: { metric: string; metadata: Record<string, unknown> }[];

beforeEach(() => {
  logs = [];
  metrics = [];
});

function fakeObservability(): Observability {
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push({ level, message, data });
  return {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} } as unknown as Observability["logger"],
    count: (metric, value = 1, metadata = {}) => {
      expect(value).toBe(1);
      metrics.push({ metric, metadata });
    },
    gauge: () => {},
    flush: () => {},
  };
}

/** No address or username anywhere in the logs or metrics. */
function expectNothingPersonal() {
  const text = JSON.stringify({ logs, metrics });
  expect(text).not.toContain(EMAIL);
  expect(text).not.toContain(USERNAME);
}

const event = (triggerSource = "PostConfirmation_ConfirmForgotPassword", over: Record<string, unknown> = {}) =>
  ({
    version: "1",
    triggerSource,
    region: REGION,
    userPoolId: POOL,
    userName: USERNAME,
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "web" },
    request: { userAttributes: { sub: SUB, email: EMAIL, email_verified: "true", "cognito:user_status": "CONFIRMED" } },
    response: {},
    ...over,
  }) as unknown as PostConfirmationTriggerEvent;

function setup(options: { signOutFails?: unknown; sendFails?: unknown; now?: () => number; signOut?: boolean; send?: boolean } = {}) {
  const signedOut: [string, string][] = [];
  const queued: PasswordResetNoticeRequest[] = [];
  const handler = createPostConfirmationHandler({
    rememberNoticeAddress: async () => "present",
    obs: fakeObservability(),
    ...(options.signOut === false
      ? {}
      : {
          signOutEverywhere: async (pool: string, username: string) => {
            if (options.signOutFails !== undefined) throw options.signOutFails;
            signedOut.push([pool, username]);
          },
        }),
    ...(options.send === false
      ? {}
      : {
          sendResetNotice: async (request: PasswordResetNoticeRequest) => {
            if (options.sendFails !== undefined) throw options.sendFails;
            queued.push(request);
          },
        }),
    now: options.now ?? (() => NOW),
  });
  return { handler, signedOut, queued };
}

const summary = () => logs.find((l) => l.message === "Notice address")?.data;

describe("the post confirmation trigger after a password reset", () => {
  it("signs the account out everywhere and hands the notice over, with the sub, the time and the sign-out", async () => {
    const { handler, signedOut, queued } = setup();
    const confirmed = event();
    expect(await handler(confirmed)).toBe(confirmed);
    expect(signedOut).toEqual([[POOL, USERNAME]]);
    expect(queued).toEqual([{ type: "passwordReset", userId: SUB, at: new Date(NOW).toISOString(), signedOut: true }]);
    expect(summary()).toEqual({ triggerSource: "PostConfirmation_ConfirmForgotPassword", outcome: "present", signOut: "done", resetNotice: "queued" });
    expect(metrics).toEqual([]);
    expectNothingPersonal();
  });

  it("does neither for a sign-up", async () => {
    const { handler, signedOut, queued } = setup();
    await handler(event("PostConfirmation_ConfirmSignUp"));
    expect(signedOut).toEqual([]);
    expect(queued).toEqual([]);
    expect(summary()).toEqual({ triggerSource: "PostConfirmation_ConfirmSignUp", outcome: "present" });
  });

  it("never fails the reset: a failed sign-out is logged by the error's name, counted, and the notice says nothing of it", async () => {
    for (const failure of [Object.assign(new Error(`AdminUserGlobalSignOut failed: 400 ${USERNAME}`), { name: "UserNotFoundException" }), null]) {
      logs = [];
      metrics = [];
      const { handler, queued } = setup({ signOutFails: failure });
      const confirmed = event();
      expect(await handler(confirmed)).toBe(confirmed);
      const code = failure ? "UserNotFoundException" : "Unknown";
      expect(logs).toContainEqual({ level: "error", message: "Not signed out after a password reset", data: { code } });
      expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "passwordReset", reason: "sign_out", via: "reset" } }]);
      expect(queued).toEqual([{ type: "passwordReset", userId: SUB, at: new Date(NOW).toISOString(), signedOut: false }]);
      expect(summary()).toMatchObject({ signOut: "failed", resetNotice: "queued" });
      expectNothingPersonal();
    }
  });

  it("counts an event that names no user or pool, signing nobody out", async () => {
    for (const over of [{ userName: "" }, { userName: undefined }, { userPoolId: 7 }, { userPoolId: "" }]) {
      metrics = [];
      const { handler, signedOut } = setup();
      await handler(event(undefined, over));
      expect(signedOut).toEqual([]);
      expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "passwordReset", reason: "sign_out", via: "reset" } }]);
    }
  });

  it("needs a sub to hand the notice over, and counts one without", async () => {
    for (const request of [{ userAttributes: { sub: "not-a-sub" } }, { userAttributes: undefined }, undefined]) {
      metrics = [];
      const { handler, queued, signedOut } = setup();
      await handler(event(undefined, { request }));
      expect(signedOut).toEqual([[POOL, USERNAME]]);
      expect(queued).toEqual([]);
      expect(summary()).toMatchObject({ resetNotice: "no-sub" });
      expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "passwordReset", reason: "no_user", via: "reset" } }]);
    }
  });

  it("counts a failed hand-over by the error's name", async () => {
    for (const failure of [Object.assign(new Error("Invoke failed: 404 ResourceNotFoundException"), { name: "ResourceNotFoundException" }), "odd"]) {
      logs = [];
      metrics = [];
      const { handler } = setup({ sendFails: failure });
      await handler(event());
      expect(logs).toContainEqual({ level: "error", message: "Password reset notice not queued", data: { code: failure instanceof Error ? "ResourceNotFoundException" : "Unknown" } });
      expect(metrics).toEqual([{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "passwordReset", reason: "invoke", via: "reset" } }]);
      expect(summary()).toMatchObject({ signOut: "done", resetNotice: "failed" });
    }
  });

  it("hands over only while the invoke fits the trigger's budget, and counts it when it doesn't", async () => {
    for (const spent of [WELCOME_BUDGET_MS - WELCOME_INVOKE_TIMEOUT_MS, WELCOME_BUDGET_MS - WELCOME_INVOKE_TIMEOUT_MS + 1]) {
      metrics = [];
      const times = [NOW, NOW + spent];
      const { handler, queued } = setup({ now: () => times.shift() ?? NOW + spent });
      await handler(event());
      const fits = spent + WELCOME_INVOKE_TIMEOUT_MS <= WELCOME_BUDGET_MS;
      expect(queued).toHaveLength(fits ? 1 : 0);
      expect(metrics).toEqual(fits ? [] : [{ metric: BusinessMetric.SecurityNoticeFailures, metadata: { kind: "passwordReset", reason: "deferred", via: "reset" } }]);
    }
    // The sign-out, the notice address's two calls and the invoke fit inside Cognito's 5 seconds
    expect(SIGN_OUT_TIMEOUT_MS + 2_000 + WELCOME_INVOKE_TIMEOUT_MS).toBeLessThanOrEqual(WELCOME_BUDGET_MS);
  });

  it("does nothing more without the sign-out or the notice function", async () => {
    const { handler } = setup({ signOut: false, send: false });
    await handler(event());
    expect(summary()).toEqual({ triggerSource: "PostConfirmation_ConfirmForgotPassword", outcome: "present" });
    expect(metrics).toEqual([]);
  });
});

describe("globalSignOut", () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" };
  const client = (respond: () => Response) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const signOut = globalSignOut({
      region: REGION,
      credentials,
      timeoutMs: SIGN_OUT_TIMEOUT_MS,
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return respond();
      }) as typeof fetch,
    });
    return { signOut, calls };
  };

  it("POSTs AdminUserGlobalSignOut for the one user, signed for cognito-idp", async () => {
    const { signOut, calls } = client(() => new Response("{}", { status: 200 }));
    await signOut(POOL, USERNAME);
    const [{ url, init }] = calls as [{ url: string; init: RequestInit }];
    expect(url).toBe(`https://cognito-idp.${REGION}.amazonaws.com/`);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-amz-target"]).toBe("AWSCognitoIdentityProviderService.AdminUserGlobalSignOut");
    expect(headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/\\d{8}/${REGION}/cognito-idp/aws4_request, `));
    expect(JSON.parse(init.body as string)).toEqual({ UserPoolId: POOL, Username: USERNAME });
  });

  it("throws with Cognito's error type only", async () => {
    const { signOut } = client(() => new Response(JSON.stringify({ __type: "com.amazonaws#UserNotFoundException", message: `User ${USERNAME} does not exist` }), { status: 400 }));
    await expect(signOut(POOL, USERNAME)).rejects.toThrow(/^AdminUserGlobalSignOut failed: 400 UserNotFoundException$/);
  });
});

describe("the reset notice's invoke", () => {
  it("is an asynchronous invoke of the security notices function, carrying only the request", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const send = eventInvoker({
      region: REGION,
      functionName: "supply-checkout-prod-security-notices",
      timeoutMs: WELCOME_INVOKE_TIMEOUT_MS,
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" },
      fetch: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
        calls.push({ url, headers: init.headers, body: init.body });
        return new Response("", { status: 202 });
      }) as unknown as typeof fetch,
    });
    const request: PasswordResetNoticeRequest = { type: "passwordReset", userId: SUB, at: new Date(NOW).toISOString(), signedOut: true };
    await send(request);
    expect(calls[0]?.url).toBe(`https://lambda.${REGION}.amazonaws.com/2015-03-31/functions/supply-checkout-prod-security-notices/invocations`);
    expect(calls[0]?.headers["x-amz-invocation-type"]).toBe("Event");
    expect(JSON.parse(calls[0]?.body as string)).toEqual(request);
  });
});
