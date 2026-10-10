// The operator reopen function (supply-checkout-6uw.6): what it accepts from
// the ops function, and the signed Lambda Invoke the ops function sends it.
// The reopen itself runs end to end in ops-api.test.ts and on DynamoDB Local
// in ops-ddb.test.ts.

import { describe, expect, it } from "vitest";
import type { Observability } from "../src/observability/index.js";
import { lambdaReopener } from "../src/operator/reopen-client.js";
import { createReopenHandler, reopenRequest } from "../src/operator/reopen-handler.js";
import { REGION } from "./helpers.js";
import { MemoryTable } from "./memory-table.js";
import { reopenPolicy } from "./ops-policy.js";

const logs: unknown[][] = [];
const obs: Observability = {
  region: REGION,
  logger: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a) } as unknown as Observability["logger"],
  count: () => {},
  gauge: () => {},
  flush: () => {},
};
const request = { operatorSub: "op-1", teamId: "team-1", reason: "Disputed closure", expectedVersion: 2, idempotencyKey: "reopen-key-0001" };

describe("the reopen function's input", () => {
  it("takes exactly the fields the ops function sends, with IDs that look like IDs", () => {
    expect(reopenRequest(request)).toEqual(request);
    for (const bad of [null, "x", [request], { ...request, UpdateExpression: "SET closedAt = :x" }, { ...request, teamId: "TEAM#x" }, { ...request, operatorSub: 7 }, { ...request, teamId: undefined }]) {
      expect(reopenRequest(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("answers bad_request for anything else, without touching the table", async () => {
    const table = new MemoryTable();
    const handler = createReopenHandler({ dbFor: (_sub, teamId) => table.guarded(reopenPolicy(teamId ?? ".")), obs });
    expect(await handler({ ...request, extra: 1 })).toEqual({ ok: false, error: { kind: "bad_request", message: "Not a reopen request" } });
    expect(await handler({ ...request, reason: "" })).toEqual({ ok: false, error: { kind: "bad_request", message: expect.any(String) } });
    expect(table.calls).toEqual([]);
  });

  it("throws what isn't a refusal, so the ops route answers 500", async () => {
    const table = new MemoryTable();
    const handler = createReopenHandler({ dbFor: () => table.guarded(() => false), obs, now: () => Date.parse("2026-09-27T12:00:00Z") });
    await expect(handler(request)).rejects.toThrow();
  });

  it("logs IDs and the result, never the reason", async () => {
    logs.length = 0;
    const handler = createReopenHandler({ dbFor: (_sub, teamId) => new MemoryTable().guarded(reopenPolicy(teamId ?? ".")), obs });
    expect(await handler(request)).toMatchObject({ ok: false, error: { kind: "not_found" } });
    expect(JSON.stringify(logs)).toContain("team-1");
    expect(JSON.stringify(logs)).not.toContain("Disputed closure");
  });
});

describe("the operator-reopen role's read of the team (supply-checkout-3sv.24)", () => {
  // ReopenClosureFieldsRead requires dynamodb:Select SPECIFIC_ATTRIBUTES, so reopenPolicy refuses a GetItem without a
  // projection: the reopen tests in ops-api.test.ts, which check nothing was refused, then show the reopen projects
  it("refuses a GetItem of the team without a projection, or with Select other than SPECIFIC_ATTRIBUTES", () => {
    const refused: { command: string; input: Record<string, unknown> }[] = [];
    const allow = reopenPolicy("team-1", refused);
    const Key = { PK: "TEAM#team-1", SK: "META" };
    const projected = { ProjectionExpression: "closedAt, purging" };
    expect(allow("GetCommand", { Key })).toBe(false);
    expect(allow("GetCommand", { Key, ...projected, Select: "ALL_ATTRIBUTES" })).toBe(false);
    expect(allow("GetCommand", { Key: { PK: "TEAM#team-2", SK: "META" }, ...projected })).toBe(false);
    expect(allow("GetCommand", { Key, ...projected })).toBe(true);
    expect(refused).toHaveLength(3);
  });
});

describe("invoking the reopen function", () => {
  const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-example" };
  const answer = { ok: true, outcome: { eventId: "e-1", replayed: false, version: 3 } };

  function fakeFetch(status: number, body: string, headers: Record<string, string> = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(body, { status, headers });
    }) as unknown as typeof globalThis.fetch;
    return { fetch, calls };
  }

  it("sends a signed, synchronous Invoke of the named function and returns its answer", async () => {
    const { fetch, calls } = fakeFetch(200, JSON.stringify(answer));
    const reopen = lambdaReopener({ functionName: "supply-checkout-prod-ops-reopen", region: REGION, credentials, fetch });
    expect(await reopen(request)).toEqual(answer);
    const [call] = calls;
    expect(call?.url).toBe(`https://lambda.${REGION}.amazonaws.com/2015-03-31/functions/supply-checkout-prod-ops-reopen/invocations`);
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(call?.init.body as string)).toEqual(request);
    const headers = call?.init.headers as Record<string, string>;
    expect(headers["x-amz-invocation-type"]).toBe("RequestResponse");
    expect(headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/\\d{8}/${REGION}/lambda/aws4_request`));
  });

  it("throws, naming only the status, when Lambda refuses the call or the function throws", async () => {
    await expect(lambdaReopener({ functionName: "f", region: REGION, credentials, fetch: fakeFetch(403, '{"Message":"secret detail"}').fetch })(request)).rejects.toThrow(/^Reopen function failed: 403$/);
    await expect(lambdaReopener({ functionName: "f", region: REGION, credentials, fetch: fakeFetch(200, '{"errorMessage":"boom"}', { "x-amz-function-error": "Unhandled" }).fetch })(request)).rejects.toThrow(
      "Reopen function failed: 200 (function error)",
    );
    await expect(lambdaReopener({ functionName: "f", region: REGION, credentials, fetch: fakeFetch(200, "null").fetch })(request)).rejects.toThrow(/without a result/);
    await expect(lambdaReopener({ functionName: "f", region: REGION, credentials, fetch: fakeFetch(200, '{"ok":"yes"}').fetch })(request)).rejects.toThrow(/without a result/);
  });

  it("refuses a bad region or function name", () => {
    expect(() => lambdaReopener({ functionName: "f", region: "Bad Region", credentials })).toThrow(/region/);
    expect(() => lambdaReopener({ functionName: "arn:aws:lambda:x", region: REGION, credentials })).toThrow(/function name/);
  });
});
