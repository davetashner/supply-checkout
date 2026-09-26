// The pre authentication trigger: federated-only users sign in only through
// their provider, so the email_verified trigger's inputs always come from the
// provider (supply-checkout-6v9).

import type { PreAuthenticationTriggerEvent } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createSignInGuardHandler, isFederatedOnly, NATIVE_SIGN_IN_REFUSED } from "../src/identity/sign-in-guard-handler.js";
import type { Observability } from "../src/observability/index.js";
import { REGION } from "./helpers.js";

const GOOGLE_ID = "107691234567890123456";
const APPLE_ID = "001234.0a1b2c3d4e5f.1234";
const NATIVE = "8f0e5b1c-0000-4000-8000-000000000001";

const identities = (providerName: string, userId: string) =>
  JSON.stringify([{ userId, providerName, providerType: providerName, issuer: null, primary: true, dateCreated: 1_700_000_000_000 }]);

function guard() {
  const logs: { level: string; message: string; data: Record<string, unknown> }[] = [];
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push({ level, message, data });
  const obs = {
    region: REGION,
    logger: { info: log("info"), warn: log("warn"), error: log("error"), addContext: () => {} },
    count: () => {},
    flush: () => {},
  } as unknown as Observability;
  return { handler: createSignInGuardHandler({ obs }), logs };
}

function event(userName: string, attributes: Record<string, string>, userNotFound?: boolean): PreAuthenticationTriggerEvent {
  return {
    version: "1",
    triggerSource: "PreAuthentication_Authentication",
    region: REGION,
    userPoolId: `${REGION}_pool`,
    userName,
    callerContext: { awsSdkVersion: "aws-sdk-unknown-unknown", clientId: "web" },
    request: { userAttributes: { sub: NATIVE, email: "pat@example.com", ...attributes }, ...(userNotFound === undefined ? {} : { userNotFound }) },
    response: {},
  } as PreAuthenticationTriggerEvent;
}

describe("pre authentication trigger", () => {
  it("refuses a native sign-in (password, email code, passkey) by a Google or Apple user", async () => {
    for (const [userName, ids] of [
      [`google_${GOOGLE_ID}`, identities("Google", GOOGLE_ID)],
      [`Google_${GOOGLE_ID}`, identities("Google", GOOGLE_ID)],
      [`signinwithapple_${APPLE_ID}`, identities("SignInWithApple", APPLE_ID)],
    ] as const) {
      const { handler, logs } = guard();
      await expect(handler(event(userName, { identities: ids, "cognito:user_status": "EXTERNAL_PROVIDER" }))).rejects.toThrow(NATIVE_SIGN_IN_REFUSED);
      // Even with a status other than EXTERNAL_PROVIDER: the identity is enough
      await expect(handler(event(userName, { identities: ids, "cognito:user_status": "CONFIRMED" }))).rejects.toThrow(NATIVE_SIGN_IN_REFUSED);
      expect(logs.map((l) => [l.level, l.data])).toEqual([
        ["warn", { outcome: "refused-federated" }],
        ["warn", { outcome: "refused-federated" }],
      ]);
      expect(JSON.stringify(logs)).not.toMatch(/pat@example|107691|001234/);
    }
  });

  it("refuses any user Cognito marks EXTERNAL_PROVIDER, whatever its identities say", async () => {
    const { handler } = guard();
    await expect(handler(event(`oidc_${GOOGLE_ID}`, { "cognito:user_status": "EXTERNAL_PROVIDER" }))).rejects.toThrow(NATIVE_SIGN_IN_REFUSED);
    await expect(handler(event(`google_${GOOGLE_ID}`, { identities: "not json", "cognito:user_status": "EXTERNAL_PROVIDER" }))).rejects.toThrow(NATIVE_SIGN_IN_REFUSED);
  });

  it("lets native users sign in, including one with a linked Google or Apple identity", async () => {
    const { handler, logs } = guard();
    const cases = [
      event(NATIVE, { "cognito:user_status": "CONFIRMED" }),
      event(NATIVE, { "cognito:user_status": "CONFIRMED", identities: "[]" }),
      // Linked by supply-checkout-0b1: the username is the native user's, not the provider identity's
      event(NATIVE, { "cognito:user_status": "CONFIRMED", identities: identities("Google", GOOGLE_ID) }),
      event(NATIVE, { "cognito:user_status": "CONFIRMED", identities: identities("SignInWithApple", APPLE_ID) }),
      event(NATIVE, {}),
    ];
    for (const e of cases) expect(await handler(e)).toBe(e);
    expect(logs.every((l) => l.level === "info" && l.data.outcome === "allowed")).toBe(true);
    const noAttributes = event(NATIVE, {});
    (noAttributes as unknown as { request: unknown }).request = undefined;
    expect(await handler(noAttributes)).toBe(noAttributes);
  });

  it("leaves unknown users to Cognito", async () => {
    const { handler, logs } = guard();
    const e = event("someone@example.com", {}, true);
    expect(await handler(e)).toBe(e);
    expect(logs[0]?.data).toEqual({ outcome: "unknown-user" });
  });

  it("isFederatedOnly matches the email_verified trigger's idea of a federated user", () => {
    expect(isFederatedOnly(`google_${GOOGLE_ID}`, { identities: identities("Google", GOOGLE_ID) })).toBe(true);
    expect(isFederatedOnly(NATIVE, { identities: identities("Google", GOOGLE_ID), "cognito:user_status": "CONFIRMED" })).toBe(false);
    expect(isFederatedOnly(NATIVE, { "cognito:user_status": "EXTERNAL_PROVIDER" })).toBe(true);
    expect(isFederatedOnly(undefined, {})).toBe(false);
  });
});
