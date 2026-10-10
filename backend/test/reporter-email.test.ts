// A report's sender's verified email for the operator page (src/operator/reporter-email.ts,
// supply-checkout-3sv.26): AdminGetUser only, by the sender's sub, and the API's own rule
// for a trusted address (noticeAddressOf), as `npm run feedback -- show` uses.

import { describe, expect, it } from "vitest";
import { reporterEmailLookup } from "../src/operator/reporter-email.js";
import { REGION } from "./helpers.js";

const POOL = "test-local-1_AppPool1";
const SUB = "4f1c2b7e-9a3d-4e5f-8b6a-1c2d3e4f5a6b";
const attrs = (o: Record<string, string>) => Object.entries(o).map(([Name, Value]) => ({ Name, Value }));

/** A fake Cognito endpoint answering AdminGetUser with `answer` (and `status`). */
function cognito(answer: unknown, status = 200) {
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const doFetch = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ action: String(init.headers["x-amz-target"]).split(".").pop() as string, body: JSON.parse(init.body) as Record<string, unknown> });
    return new Response(JSON.stringify(answer), { status });
  }) as unknown as typeof fetch;
  const find = reporterEmailLookup({ region: REGION, userPoolId: POOL, fetch: doFetch, credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret" } });
  return { calls, find };
}

describe("reporterEmailLookup", () => {
  it("asks AdminGetUser for the sub, and nothing else, and answers the verified address, normalized", async () => {
    const { calls, find } = cognito({ Username: SUB, UserAttributes: attrs({ sub: SUB, email: "Sender@Example.COM", email_verified: "true" }) });
    expect(await find(SUB)).toEqual({ email: "sender@example.com" });
    expect(calls).toEqual([{ action: "AdminGetUser", body: { UserPoolId: POOL, Username: SUB } }]);
  });

  it("answers unverified for an address the API wouldn't trust", async () => {
    expect(await cognito({ Username: SUB, UserAttributes: attrs({ sub: SUB, email: "a@example.com", email_verified: "false" }) }).find(SUB)).toEqual({ email: null, why: "unverified" });
    expect(await cognito({ Username: SUB, UserAttributes: attrs({ sub: SUB, email: "a@example.com", email_verified: "true", "custom:downgrade_pending": "1" }) }).find(SUB)).toEqual({ email: null, why: "unverified" });
  });

  it("answers not found for no such user, someone else, or a user ID that isn't a sub (asking nothing)", async () => {
    expect(await cognito({ __type: "UserNotFoundException", message: "User does not exist." }, 400).find(SUB)).toEqual({ email: null, why: "not_found" });
    expect(await cognito({ Username: "x", UserAttributes: attrs({ sub: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", email: "a@example.com", email_verified: "true" }) }).find(SUB)).toEqual({ email: null, why: "not_found" });
    expect(await cognito({ Username: "x" }).find(SUB)).toEqual({ email: null, why: "not_found" });
    const bad = cognito({});
    expect(await bad.find('x" or sub = "y')).toEqual({ email: null, why: "not_found" });
    expect(bad.calls).toEqual([]);
  });

  it("throws any other failure, naming only the action, status and error type", async () => {
    const error = await cognito({ __type: "AccessDeniedException", message: `User ${SUB} is not allowed` }, 400).find(SUB).catch((e: unknown) => e as Error);
    expect((error as Error).message).toBe("AdminGetUser failed: 400 AccessDeniedException");
  });
});
