// Shared fakes for the prod journey harness's unit tests (node --test scripts/journeys/test/).
// Nothing here talks to AWS, Cognito or the app.
import { EventEmitter } from "node:events";
import { PROD } from "../lib/config.mjs";

/** A test-domain address (built, so no literal address sits in the repository). */
export const at = (local) => `${local}@${PROD.mailDomain}`;

/** A full set of the production-journeys secrets, all fake. */
export function fakeEnv(extra = {}) {
  return {
    JOURNEYS_OWNER_EMAIL: at("owner-lived"),
    JOURNEYS_OWNER_PASSWORD: "Owner-password-1234567890-abcdef!",
    JOURNEYS_OWNER_TOTP: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
    JOURNEYS_CREW_EMAIL: at("crew-lived"),
    JOURNEYS_CREW_PASSWORD: "Crew-password-1234567890-abcdefg!",
    JOURNEYS_VIEWER_EMAIL: at("viewer-lived"),
    JOURNEYS_VIEWER_PASSWORD: "Viewer-password-1234567890-abcde!",
    JOURNEYS_DESKTOP_TEAM_ID: "team-desktop-1",
    JOURNEYS_PHONE_TEAM_ID: "team-phone-2",
    JOURNEYS_MAIL_BUCKET: "journey-mail-bucket-fake",
    JOURNEYS_RESULTS_BUCKET: "journey-results-bucket-fake",
    ...extra,
  };
}

/** An in-memory bucket with the S3 client's interface, recording every call. */
export function fakeS3(objects = {}) {
  const store = new Map(Object.entries(objects).map(([k, v]) => [k, { body: Buffer.from(typeof v === "string" ? v : v.body), lastModified: v.lastModified ?? 0 }]));
  const calls = [];
  return {
    store,
    calls,
    async list(prefix) { calls.push(["list", prefix]); return [...store].filter(([k]) => k.startsWith(prefix)).map(([key, o]) => ({ key, lastModified: o.lastModified })); },
    async get(key) { calls.push(["get", key]); if (!store.has(key)) throw new Error("NoSuchKey"); return store.get(key).body; },
    async put(key, body) { calls.push(["put", key]); store.set(key, { body: Buffer.from(body), lastModified: Date.now() }); },
    async remove(key) { calls.push(["remove", key]); store.delete(key); },
    async upload(dir, prefix) { calls.push(["upload", dir, prefix]); },
  };
}

/**
 * A raw message as SES inbound stores it. `trace` overrides SES's headers; `extraTop` goes above
 * them (which SES never lets a sender do), `senderHeaders` below them (where a sender's own
 * headers are).
 */
export function sesMessage({
  to,
  from = `"Supply Checkout" <${PROD.sender}>`,
  body = "Your Supply Checkout verification code is 123456. It expires in 24 hours.",
  spf = "pass",
  dkim = [`pass header.i=@${PROD.senderDomain}`, "pass header.i=@amazonses.com"],
  dmarc = `pass header.from=${PROD.senderDomain}`,
  spam = "PASS",
  virus = "PASS",
  by = `inbound-smtp.${PROD.region}.amazonaws.com`,
  rcpt = to,
  senderHeaders = [],
  extraTop = [],
  headers: extra = [],
  date = "Wed, 07 Oct 2026 12:00:05 +0000",
  tos = [to],
  contentType = "text/plain; charset=UTF-8",
  encoding = "7bit",
} = {}) {
  const auth = [`Authentication-Results: amazonses.com;`, ` spf=${spf} (spfCheck: domain of amazonses.com designates 192.0.2.10 as permitted sender) client-ip=192.0.2.10;`, ...dkim.map((d) => ` dkim=${d};`), ...(dmarc ? [` dmarc=${dmarc};`] : [])];
  return [
    ...extraTop,
    "Return-Path: <bounce@example.com>",
    `Received: from a1-2.smtp-out.amazonses.com (a1-2.smtp-out.amazonses.com [192.0.2.10])`,
    ` by ${by} with SMTP id abc123`,
    ` for ${rcpt};`,
    " Wed, 07 Oct 2026 12:00:00 +0000 (UTC)",
    `X-SES-Spam-Verdict: ${spam}`,
    `X-SES-Virus-Verdict: ${virus}`,
    `Received-SPF: ${spf} (spfCheck: domain of amazonses.com designates 192.0.2.10 as permitted sender) client-ip=192.0.2.10;`,
    ...auth,
    "X-SES-RECEIPT: AEFBQUFBQUFBQUFF",
    ...senderHeaders,
    `From: ${from}`,
    ...tos.map((t) => `To: ${t}`),
    ...(date ? [`Date: ${date}`] : []),
    "Subject: Your Supply Checkout verification code",
    "MIME-Version: 1.0",
    `Content-Type: ${contentType}`,
    `Content-Transfer-Encoding: ${encoding}`,
    ...extra,
    "",
    body,
  ].join("\r\n");
}

/** A fetch that answers from `routes` (`"METHOD url"` → [status, json] or a function of the body). */
export function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const target = init.headers?.["X-Amz-Target"];
    const key = target ? `${target.split(".").pop()}` : `${method} ${url}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ key, url, init, body });
    let answer = routes[key];
    if (typeof answer === "function") answer = answer(body, calls.filter((c) => c.key === key).length);
    if (!answer) throw new Error(`unexpected ${key}`);
    const [status, json] = answer;
    return { ok: status >= 200 && status < 300, status, json: async () => { if (json === undefined) throw new Error("no body"); return json; } };
  };
  return { fetch, calls };
}

/** A request as a browser context's "request" event gives it. */
export const fakeRequest = (href) => ({ url: () => href });

/**
 * A Playwright browser context, as far as stopApp and the session helpers use it: an event
 * emitter (a test fires "request", "requestfinished" and "requestfailed"), its pages, which
 * record each goto in `log` (and call `onGoto`), and a cookie jar as Playwright filters it.
 */
export function fakeBrowserContext({ pages = 1, log = [], jar = [] } = {}) {
  const ctx = new EventEmitter();
  ctx.log = log;
  ctx.jar = jar;
  ctx.list = Array.from({ length: pages }, (_, i) => ({
    at: `${PROD.app}/`,
    url() { return this.at; },
    context: () => ctx,
    async goto(url) { log.push(`page${i} goto ${url}`); ctx.onGoto?.(url, i); this.at = url; },
  }));
  ctx.pages = () => ctx.list;
  // cookies(urls) as playwright-core's filterCookies: domain matches the host, path a prefix of
  // the URL's path, Secure ones only for https
  ctx.cookies = async (urls) => {
    log.push("cookies");
    const list = urls === undefined ? [] : [urls].flat().map((u) => new URL(u));
    return ctx.jar.filter((c) => !list.length || list.some((u) => {
      const domain = c.domain.startsWith(".") ? c.domain : `.${c.domain}`;
      return `.${u.hostname}`.endsWith(domain) && u.pathname.startsWith(c.path) && (u.protocol === "https:" || !c.secure);
    }));
  };
  ctx.addCookies = async (cookies) => { log.push(`addCookies ${cookies.map((c) => c.name).join(",")}`); ctx.jar.push(...cookies); };
  ctx.clearCookies = async ({ name } = {}) => { log.push(`clearCookies ${name ?? "*"}`); ctx.jar = ctx.jar.filter((c) => name !== undefined && c.name !== name); };
  return ctx;
}
