import { describe, expect, it } from "vitest";
import { routerCode } from "../lib/stacks/web-stack.js";

// Runs lib/web/router.js (the CloudFront Function), as WebStack fills it in,
// with a stand-in for the `cloudfront` module's KeyValueStore.
type Store = Record<string, string | Error>;
interface Result {
  uri?: string;
  statusCode?: number;
  headers?: Record<string, { value: string }>;
}

const APEX = "supplycheckout.com";
const APP = `app.${APEX}`;
const WWW = `www.${APEX}`;
const HSTS = "max-age=63072000; includeSubDomains";
const source = routerCode({ kvsId: "test-store", apex: APEX, www: WWW, app: APP });

function router(store: Store) {
  const cf = {
    kvs: (id: string) => {
      expect(id).toBe("test-store");
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
    handler({
      request: {
        uri,
        querystring: { next: { value: "https://evil.example/" } },
        headers: host === undefined ? {} : { host: { value: host } },
      },
    });
}

const live = router({ app: "1.4.0", demo: "demo-20260926-abc1234" });

const expectRedirect = (res: Result, status: number, location: string) => {
  expect(res.statusCode).toBe(status);
  expect(res.uri).toBeUndefined();
  expect(res.headers?.location?.value).toBe(location);
  expect(res.headers?.["strict-transport-security"]?.value).toBe(HSTS);
  expect(res.headers?.["x-content-type-options"]?.value).toBe("nosniff");
};

describe("router (CloudFront Function)", () => {
  it("fills in every placeholder", () => {
    expect(source).not.toMatch(/__[A-Z_]+__/);
    expect(() => routerCode({ kvsId: "__X__", apex: APEX, www: WWW, app: APP })).toThrow(/__X__/);
  });

  it("serves the app channel on app., with index.html for directories only (no client-side routing)", async () => {
    expect((await live(APP, "/")).uri).toBe("/releases/1.4.0/index.html");
    expect((await live("APP.SupplyCheckout.com", "/")).uri).toBe("/releases/1.4.0/index.html");
    expect((await live(APP, "/assets/app.js")).uri).toBe("/releases/1.4.0/assets/app.js");
    expect((await live(APP, "/docs/")).uri).toBe("/releases/1.4.0/docs/index.html");
    expect((await live(APP, "/sheets/42")).uri).toBe("/releases/1.4.0/sheets/42");
    expect((await live(APP, "/favicon.ico")).uri).toBe("/releases/1.4.0/favicon.ico");
    // app. has no /demo: it's an ordinary path in the app's release
    expect((await live(APP, "/demo/")).uri).toBe("/releases/1.4.0/demo/index.html");
  });

  it("sends the apex home page to the app with a 302 that isn't stored", async () => {
    const res = await live(APEX, "/");
    expectRedirect(res, 302, `https://${APP}/`);
    expect(res.headers?.["cache-control"]?.value).toBe("no-store");
  });

  it("redirects /demo to /demo/ permanently", async () => {
    const res = await live(APEX, "/demo");
    expectRedirect(res, 301, "/demo/");
    expect(res.headers?.["cache-control"]?.value).toBe("max-age=86400");
  });

  it("serves the demo channel under /demo/, with the prefix stripped", async () => {
    expect((await live(APEX, "/demo/")).uri).toBe("/releases/demo-20260926-abc1234/index.html");
    expect((await live(APEX, "/demo/index.html")).uri).toBe("/releases/demo-20260926-abc1234/index.html");
    expect((await live(APEX, "/demo/assets/index-abc.js")).uri).toBe("/releases/demo-20260926-abc1234/assets/index-abc.js");
    expect((await live(APEX, "/demo/icons/favicon.svg")).uri).toBe("/releases/demo-20260926-abc1234/icons/favicon.svg");
  });

  it("sends every other apex path to the app root", async () => {
    for (const uri of ["/assets/app.js", "/favicon.ico", "/demos", "/demo.html", "/Demo/", "/about/", "//evil.example/", "/x?next=https://evil.example"]) {
      const res = await live(APEX, uri);
      expectRedirect(res, 302, `https://${APP}/`);
      expect(res.headers?.["cache-control"]?.value, uri).toBe("no-store");
    }
  });

  it("treats any other host (the cloudfront.net name, or a missing Host) as the apex", async () => {
    for (const host of ["d111111abcdef8.cloudfront.net", "evil.example", "app.evil.example", "www.evil.example", undefined]) {
      expectRedirect(await live(host, "/"), 302, `https://${APP}/`);
      expect((await live(host, "/demo/")).uri).toBe("/releases/demo-20260926-abc1234/index.html");
    }
  });

  it("redirects www. to the apex, keeping only whether it was the demo", async () => {
    for (const [uri, location] of [
      ["/", `https://${APEX}/`],
      ["/about", `https://${APEX}/`],
      ["//evil.example/x", `https://${APEX}/`],
      ["/demo", `https://${APEX}/demo/`],
      ["/demo/assets/x.js", `https://${APEX}/demo/`],
    ]) {
      const res = await live(WWW, uri);
      expectRedirect(res, 301, location);
      expect(res.headers?.["cache-control"]?.value).toBe("max-age=86400");
    }
    expectRedirect(await live("WWW.SupplyCheckout.com", "/"), 301, `https://${APEX}/`);
  });

  it("never copies the request into a Location", async () => {
    const hosts = [APEX, WWW, APP, "evil.example", undefined];
    const uris = ["/", "/demo", "/evil.example", "//evil.example", "/demo/../evil", "/%2F%2Fevil.example", "/\\evil.example"];
    const allowed = ["/demo/", `https://${APP}/`, `https://${APEX}/`, `https://${APEX}/demo/`];
    for (const host of hosts) {
      for (const uri of uris) {
        const location = (await live(host, uri)).headers?.location?.value;
        if (location !== undefined) expect(allowed, `${host} ${uri}`).toContain(location);
      }
    }
  });

  it("answers 503 when a channel has nothing live, or the store fails", async () => {
    const r = router({ app: "none", demo: new Error("KVS unavailable") });
    for (const host of [APP, APEX]) {
      const res = await r(host, host === APP ? "/" : "/demo/");
      expect(res.statusCode).toBe(503);
      expect(res.headers?.["cache-control"]?.value).toBe("no-store");
    }
    expect((await router({ app: "1.0.0" })(APEX, "/demo/")).statusCode).toBe(503);
    // The home page redirect doesn't need the store
    expect((await r(APEX, "/")).statusCode).toBe(302);
  });

  it("rejects a live version that could escape the releases prefix", async () => {
    for (const bad of ["../secret", "1.0/../../x", "", ".hidden", "a b"]) {
      expect((await router({ app: bad })(APP, "/")).statusCode, bad).toBe(503);
      expect((await router({ demo: bad })(APEX, "/demo/")).statusCode, bad).toBe(503);
    }
  });
});
