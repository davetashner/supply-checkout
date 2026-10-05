import { describe, expect, it } from "vitest";
import { opsRouterCode, routerCode } from "../lib/stacks/web-stack.js";

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

  // A SyntaxError in the CloudFront runtime stops every request (503 on app.
  // and /demo/, supply-checkout-qk1.1), and Node, which runs these tests,
  // accepts syntax CloudFront doesn't. `for...of` broke prod; keep to the
  // constructs the router already ran live with.
  it("uses no syntax the CloudFront runtime rejects", () => {
    expect(source).not.toMatch(/\bfor\s*\([^)]*\bof\b/);
    expect(source).not.toMatch(/\.\.\./);
    expect(source).not.toMatch(/`/);
    expect(source).not.toMatch(/Object\.assign/);
  });

  it("copies values in literally, with no $ replacement patterns", () => {
    const code = routerCode({ kvsId: "id-$&-$'-$`-$$", apex: APEX, www: WWW, app: APP });
    expect(code).toContain('cf.kvs("id-$&-$\'-$`-$$")');
  });

  it("refuses hosts that aren't lowercase hostnames", () => {
    for (const bad of ["$&", "App.example.com", "a.example.com/x", 'a"b', "a b", ""]) {
      expect(() => routerCode({ kvsId: "k", apex: bad, www: WWW, app: APP }), bad).toThrow(/apex host/);
      expect(() => routerCode({ kvsId: "k", apex: APEX, www: bad, app: APP }), bad).toThrow(/www host/);
      expect(() => routerCode({ kvsId: "k", apex: APEX, www: WWW, app: bad }), bad).toThrow(/app host/);
    }
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

  describe("the marketing home page (channel site)", () => {
    const withSite = router({ app: "1.4.0", demo: "demo-20260926-abc1234", site: "site-20261005-120000-abc1234" });

    it("serves the apex's / and /assets/ from the site's live release, and nothing else", async () => {
      expect((await withSite(APEX, "/")).uri).toBe("/releases/site-20261005-120000-abc1234/index.html");
      expect((await withSite(APEX, "/assets/index-abc.css")).uri).toBe("/releases/site-20261005-120000-abc1234/assets/index-abc.css");
      expect((await withSite(APEX, "/assets/J4-checkout-abc.mp4")).uri).toBe("/releases/site-20261005-120000-abc1234/assets/J4-checkout-abc.mp4");
      // Its release marker, and every path that isn't the page's, never reach it
      for (const uri of ["/index.html", "/site-release.json", "/icon.svg", "/config.json", "/assets", "/Assets/x.js", "/releases/app-1/index.html", "/about/", "//evil.example/"]) {
        expectRedirect(await withSite(APEX, uri), 302, `https://${APP}/`);
      }
    });

    it("leaves the app, the demo and www. as they were", async () => {
      expect((await withSite(APP, "/")).uri).toBe("/releases/1.4.0/index.html");
      expect((await withSite(APEX, "/demo/")).uri).toBe("/releases/demo-20260926-abc1234/index.html");
      expectRedirect(await withSite(APEX, "/demo"), 301, "/demo/");
      expectRedirect(await withSite(WWW, "/"), 301, `https://${APEX}/`);
      expectRedirect(await withSite(WWW, "/assets/index-abc.css"), 301, `https://${APEX}/`);
    });

    it("serves it for any host that isn't app. or www. (the cloudfront.net name, a trailing dot), as with the apex", async () => {
      for (const host of ["d111111abcdef8.cloudfront.net", `${APEX}.`, `${APEX}:443`, `${APP}.`, undefined]) {
        expect((await withSite(host, "/")).uri, String(host)).toBe("/releases/site-20261005-120000-abc1234/index.html");
      }
    });

    it("sends / to the app, never a 503, while nothing is live on the site: not published, none, a bad version or a store error", async () => {
      for (const site of [undefined, "none", "", "../secret", "a b", new Error("KVS unavailable")]) {
        const r = router({ app: "1.4.0", ...(site === undefined ? {} : { site }) });
        for (const uri of ["/", "/assets/index-abc.css"]) {
          const res = await r(APEX, uri);
          expectRedirect(res, 302, `https://${APP}/`);
          expect(res.headers?.["cache-control"]?.value, String(site)).toBe("no-store");
        }
      }
    });
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

  it("treats app. or www. with a trailing dot or a port as the apex", async () => {
    for (const host of [`${APP}.`, `${APP}:443`, `${WWW}.`, `${WWW}:443`, `${APEX}.`, `${APEX}:443`]) {
      expectRedirect(await live(host, "/"), 302, `https://${APP}/`);
      expectRedirect(await live(host, "/assets/app.js"), 302, `https://${APP}/`);
      expect((await live(host, "/demo/")).uri, host).toBe("/releases/demo-20260926-abc1234/index.html");
    }
  });

  it("keeps encoded traversal inside the live release's prefix", async () => {
    // CloudFront passes the path still encoded, and S3 takes keys literally
    for (const [uri, rewritten] of [
      ["/demo/..%2f..%2freleases/x", "/releases/demo-20260926-abc1234/..%2f..%2freleases/x"],
      ["/demo/..%2F..%2Freleases/x", "/releases/demo-20260926-abc1234/..%2F..%2Freleases/x"],
      ["/demo/%2e%2e/%2e%2e/releases/x", "/releases/demo-20260926-abc1234/%2e%2e/%2e%2e/releases/x"],
    ]) {
      expect((await live(APEX, uri)).uri).toBe(rewritten);
    }
    expect((await live(APP, "/..%2f..%2freleases/x")).uri).toBe("/releases/1.4.0/..%2f..%2freleases/x");
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
      expect(res.headers?.["retry-after"]?.value).toBe("60");
      expect(res.headers?.["strict-transport-security"]?.value).toBe(HSTS);
      expect(res.headers?.["x-content-type-options"]?.value).toBe("nosniff");
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

// lib/web/ops-router.js, the operator page's router (supply-checkout-gxlt)
const OPS = `ops.${APEX}`;
const opsSource = opsRouterCode({ kvsId: "test-store", ops: OPS });

function opsRouter(store: Store) {
  const cf = {
    kvs: (id: string) => {
      expect(id).toBe("test-store");
      return {
        get: async (key: string) => {
          expect(key).toBe("ops");
          const value = store[key];
          if (value instanceof Error) throw value;
          if (value === undefined) throw new Error(`Key ${key} not found`);
          return value;
        },
      };
    },
  };
  const body = opsSource.replace(/^import cf from "cloudfront";$/m, "");
  expect(body).not.toBe(opsSource);
  const handler = new Function("cf", `${body}\nreturn handler;`)(cf) as (event: unknown) => Promise<Result>;
  return (host: string | undefined, uri: string) => handler({ request: { uri, querystring: { code: { value: "c" } }, headers: host === undefined ? {} : { host: { value: host } } } });
}

const opsLive = opsRouter({ ops: "ops-20261002-120000-abc1234", app: "1.4.0" });

const expectMade = (res: Result, status: number) => {
  expect(res.statusCode).toBe(status);
  expect(res.uri).toBeUndefined();
  expect(res.headers?.["strict-transport-security"]?.value).toBe(HSTS);
  expect(res.headers?.["x-content-type-options"]?.value).toBe("nosniff");
  expect(res.headers?.["cache-control"]?.value).toBe("no-store");
  expect(res.headers?.["content-security-policy"]?.value).toBe("default-src 'none'; frame-ancestors 'none'");
};

describe("ops router (CloudFront Function, supply-checkout-gxlt)", () => {
  it("fills in every placeholder and refuses a bad host", () => {
    expect(opsSource).not.toMatch(/__[A-Z_]+__/);
    expect(opsSource).toContain(`const OPS = "${OPS}";`);
    expect(opsSource).toContain(`const HSTS = "${HSTS}";`);
    for (const bad of ["$&", "Ops.example.com", 'a"b', ""]) expect(() => opsRouterCode({ kvsId: "k", ops: bad }), bad).toThrow(/ops host/);
  });

  it("uses no syntax the CloudFront runtime rejects", () => {
    expect(opsSource).not.toMatch(/\bfor\s*\([^)]*\bof\b/);
    expect(opsSource).not.toMatch(/\.\.\./);
    expect(opsSource).not.toMatch(/`/);
    expect(opsSource).not.toMatch(/Object\.assign/);
  });

  it("serves the page, its config and its hashed assets from the ops channel's release", async () => {
    expect((await opsLive(OPS, "/")).uri).toBe("/releases/ops-20261002-120000-abc1234/index.html");
    expect((await opsLive("OPS.SupplyCheckout.com", "/")).uri).toBe("/releases/ops-20261002-120000-abc1234/index.html");
    expect((await opsLive(OPS, "/ops-config.json")).uri).toBe("/releases/ops-20261002-120000-abc1234/ops-config.json");
    expect((await opsLive(OPS, "/assets/index-Do94nO-H.js")).uri).toBe("/releases/ops-20261002-120000-abc1234/assets/index-Do94nO-H.js");
    expect((await opsLive(OPS, "/assets/index-CMmWHuO0.css")).uri).toBe("/releases/ops-20261002-120000-abc1234/assets/index-CMmWHuO0.css");
    expect((await opsLive(OPS, "/assets/icon-Dth9jtnq.svg")).uri).toBe("/releases/ops-20261002-120000-abc1234/assets/icon-Dth9jtnq.svg");
  });

  it("answers 404 for any other host or path, so nothing else in the bucket can be named", async () => {
    for (const host of [APP, APEX, WWW, "d111111abcdef8.cloudfront.net", `${OPS}.`, `${OPS}:443`, undefined]) expectMade(await opsLive(host, "/"), 404);
    for (const uri of [
      "/index.html",
      "/config.json",
      "/favicon.ico",
      "/assets/index.js.map",
      "/assets/../config.json",
      "/assets/..%2f..%2f1.4.0/index.html",
      "/assets/a/b.js",
      "/assets/x.html",
      "/releases/1.4.0/index.html",
      "//evil.example/",
      "/team/t1",
      "",
    ]) {
      expectMade(await opsLive(OPS, uri), 404);
    }
  });

  it("serves only ops- releases: never the app's or the demo's, and 503 with nothing live", async () => {
    for (const bad of ["1.4.0", "demo-20260926-abc1234", "app-v1.9.0", "none", "ops-", "ops-../x", "ops-a b", ""]) {
      expectMade(await opsRouter({ ops: bad })(OPS, "/"), 503);
    }
    expectMade(await opsRouter({})(OPS, "/"), 503);
    expectMade(await opsRouter({ ops: new Error("KVS unavailable") })(OPS, "/"), 503);
  });
});
