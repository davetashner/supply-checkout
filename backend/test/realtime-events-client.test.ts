// The IAM-signed AppSync Events publish client, against a fake fetch.

import { describe, expect, it } from "vitest";
import { createEventsClient, PublishError } from "../src/realtime/events-client.js";
import { REGION } from "./helpers.js";

const HOST = "example123.appsync-api.test.amazonaws.com";
const credentials = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", sessionToken: "session" };

function client(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const publish = createEventsClient({
    host: HOST,
    region: REGION,
    credentials,
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond(url, init);
    }) as typeof fetch,
  });
  return { publish, calls };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("createEventsClient", () => {
  it("POSTs the channel and events to /event, signed for appsync in the region", async () => {
    const { publish, calls } = client(() => ok({ successful: [{ identifier: "a", index: 0 }, { identifier: "b", index: 1 }], failed: [] }));
    const result = await publish("/teams/t1", ['{"n":1}', '{"n":2}']);
    expect(result).toEqual({ successful: [0, 1], failed: [] });
    const [call] = calls;
    expect(call?.url).toBe(`https://${HOST}/event`);
    expect(call?.init.method).toBe("POST");
    expect(JSON.parse(String(call?.init.body))).toEqual({ channel: "/teams/t1", events: ['{"n":1}', '{"n":2}'] });
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/\\d{8}/${REGION}/appsync/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$`));
    expect(headers["x-amz-security-token"]).toBe("session");
    expect(headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(headers["content-type"]).toBe("application/json");
  });

  it("returns the events AppSync refused", async () => {
    const { publish } = client(() =>
      ok({ successful: [{ index: 0 }], failed: [{ index: 1, code: "InvalidEvent", message: "bad" }, { index: "x", errorCode: "E", errorMessage: "m" }] }),
    );
    expect(await publish("/teams/t1", ["{}", "{}", "{}"])).toEqual({
      successful: [0],
      failed: [
        { index: 1, code: "InvalidEvent", message: "bad" },
        { index: -1, code: "E", message: "m" },
      ],
    });
    const empty = client(() => ok({}));
    expect(await empty.publish("/teams/t1", ["{}"])).toEqual({ successful: [], failed: [] });
  });

  it("sends nothing for no events, and refuses more than 5", async () => {
    const { publish, calls } = client(() => ok({}));
    expect(await publish("/teams/t1", [])).toEqual({ successful: [], failed: [] });
    await expect(publish("/teams/t1", Array(6).fill("{}"))).rejects.toThrow(PublishError);
    expect(calls).toHaveLength(0);
  });

  it("throws on an HTTP error, a network error, or an answer that isn't JSON", async () => {
    await expect(client(() => new Response("denied", { status: 403 })).publish("/teams/t1", ["{}"])).rejects.toMatchObject({
      name: "PublishError",
      status: 403,
      message: "Publish failed with HTTP 403: denied",
    });
    await expect(
      client(() => {
        throw new TypeError("fetch failed");
      }).publish("/teams/t1", ["{}"]),
    ).rejects.toThrow("Publish request failed: fetch failed");
    await expect(client(() => new Response("<html>", { status: 200 })).publish("/teams/t1", ["{}"])).rejects.toThrow("something other than JSON");
  });

  it("defaults to the Lambda's credentials and the global fetch", () => {
    expect(typeof createEventsClient({ host: HOST, region: REGION })).toBe("function");
  });
});
