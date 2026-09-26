import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Runs lib/web/router.js (the CloudFront Function) with a stand-in for the
// `cloudfront` module's KeyValueStore.
type Store = Record<string, string | Error>;
interface Result {
  uri?: string;
  statusCode?: number;
  headers?: Record<string, { value: string }>;
}

const source = readFileSync(new URL("../lib/web/router.js", import.meta.url), "utf8");

function router(store: Store) {
  const cf = {
    kvs: (id: string) => {
      expect(id).toBe("__KVS_ID__");
      return {
        get: async (key: string) => {
          const value = store[key];
          if (value instanceof Error) throw value;
          if (value === undefined) throw new Error(`Key ${key} not found`);
          return value;
        },
      };
    },
  };
  const body = source.replace(/^import cf from "cloudfront";$/m, "");
  expect(body).not.toBe(source);
  const handler = new Function("cf", `${body}\nreturn handler;`)(cf) as (event: unknown) => Promise<Result>;
  return (host: string | undefined, uri: string) =>
    handler({ request: { uri, headers: host === undefined ? {} : { host: { value: host } } } });
}

const live = router({ app: "1.4.0", demo: "demo-20260926-abc1234" });

describe("router (CloudFront Function)", () => {
  it("serves the app channel on app. and the demo everywhere else", async () => {
    expect((await live("app.supplycheckout.com", "/assets/app.js")).uri).toBe("/releases/1.4.0/assets/app.js");
    expect((await live("supplycheckout.com", "/assets/app.js")).uri).toBe("/releases/demo-20260926-abc1234/assets/app.js");
    expect((await live("APP.staging.supplycheckout.com", "/")).uri).toBe("/releases/1.4.0/index.html");
    expect((await live(undefined, "/")).uri).toBe("/releases/demo-20260926-abc1234/index.html");
  });

  it("serves index.html for directories and nothing else in its place (no client-side routing)", async () => {
    expect((await live("app.x.com", "/")).uri).toBe("/releases/1.4.0/index.html");
    expect((await live("app.x.com", "/docs/")).uri).toBe("/releases/1.4.0/docs/index.html");
    expect((await live("app.x.com", "/sheets/42")).uri).toBe("/releases/1.4.0/sheets/42");
    expect((await live("app.x.com", "/favicon.ico")).uri).toBe("/releases/1.4.0/favicon.ico");
  });

  it("redirects www. to the apex", async () => {
    const res = await live("www.supplycheckout.com", "/about");
    expect(res.statusCode).toBe(301);
    expect(res.headers?.location?.value).toBe("https://supplycheckout.com/about");
  });

  it("answers 503 when a channel has nothing live, or the store fails", async () => {
    const r = router({ app: "none", demo: new Error("KVS unavailable") });
    for (const host of ["app.x.com", "x.com"]) {
      const res = await r(host, "/");
      expect(res.statusCode).toBe(503);
      expect(res.headers?.["cache-control"]?.value).toBe("no-store");
    }
    expect((await router({ app: "1.0.0" })("x.com", "/")).statusCode).toBe(503);
  });

  it("rejects a live version that could escape the releases prefix", async () => {
    for (const bad of ["../secret", "1.0/../../x", "", ".hidden", "a b"]) {
      expect((await router({ app: bad })("app.x.com", "/")).statusCode, bad).toBe(503);
    }
  });
});
