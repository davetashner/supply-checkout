// node --test scripts/journeys/test/ (part of npm run test:scripts): the mailbox reader's
// verdict checks, parsing and extraction, and its refusal of forged mail raced to a run address.
import assert from "node:assert/strict";
import { test } from "node:test";
import { throwawayAddress } from "../lib/addresses.mjs";
import { PROD } from "../lib/config.mjs";
import { addresses, authResults, extractCode, extractLinks, messageText, parseMessage, verifyMessage } from "../lib/mail.mjs";
import { MailTimeout, waitForMail } from "../lib/mailbox.mjs";
import { createMasker } from "../lib/mask.mjs";
import { fakeS3, sesMessage } from "./helpers.mjs";

const to = throwawayAddress("9-1", "owner");
const expect = { to, sender: PROD.sender, senderDomain: PROD.senderDomain, region: PROD.region };

test("a genuine message from the app passes", () => {
  const v = verifyMessage(sesMessage({ to }), expect);
  assert.equal(v.ok, true);
  assert.equal(extractCode(messageText(v.parsed)), "123456");
  // Letter case in addresses and verdicts doesn't matter
  assert.equal(verifyMessage(sesMessage({ to: to.toUpperCase(), rcpt: to.toUpperCase(), spam: "pass" }), expect).ok, true);
  // DKIM by header.d works as well as header.i
  assert.equal(verifyMessage(sesMessage({ to, dkim: [`pass header.d=${PROD.senderDomain}`] }), expect).ok, true);
});

test("each failed verdict refuses the message, with a reason that names nothing", () => {
  const cases = [
    [{ spf: "fail" }, /SPF/],
    [{ spf: "softfail" }, /SPF/],
    [{ dkim: ["fail header.i=@" + PROD.senderDomain] }, /DKIM/],
    [{ dkim: ["pass header.i=@amazonses.com"] }, /DKIM/],
    [{ dkim: ["pass header.i=@evil.example"] }, /DKIM/],
    [{ dkim: [`pass header.i=@${PROD.senderDomain}.evil.example`] }, /DKIM/],
    [{ dmarc: `fail header.from=${PROD.senderDomain}` }, /DMARC/],
    [{ dmarc: null }, /DMARC/],
    [{ dmarc: "pass header.from=evil.example" }, /DMARC/],
    [{ dmarc: "pass" }, /DMARC/],
    [{ tos: [] }, /exactly one To/],
    [{ tos: [to, to] }, /exactly one To/],
    [{ tos: [`${to}, other@example.com`] }, /not addressed to/],
    [{ spam: "FAIL" }, /spam/],
    [{ virus: "GRAY" }, /virus/],
    [{ by: "mx.evil.example" }, /SES inbound/],
    [{ by: `inbound-smtp.us-west-2.amazonaws.com` }, /SES inbound/],
    [{ from: '"Supply Checkout" <noreply@example.org>' }, /no-reply/],
    [{ from: `<${PROD.sender}>, <other@example.org>` }, /no-reply/],
    [{ headers: [`From: <${PROD.sender}>`] }, /exactly one From/],
    [{ rcpt: throwawayAddress("9-1", "crew") }, /delivered to/],
  ];
  for (const [opts, re] of cases) {
    const v = verifyMessage(sesMessage({ to, ...opts }), expect);
    assert.equal(v.ok, false, JSON.stringify(opts));
    assert.match(v.reason, re, JSON.stringify(opts));
    assert.ok(!v.reason.includes("@"), "a reason names no address");
  }
});

test("a sender's own Authentication-Results can't stand in for SES's", () => {
  // A forger who passes nothing but adds a passing Authentication-Results among their headers
  const forged = sesMessage({ to, spf: "fail", dkim: ["none"], dmarc: "fail", senderHeaders: [`Authentication-Results: amazonses.com; spf=pass; dkim=pass header.i=@${PROD.senderDomain}; dmarc=pass`] });
  assert.equal(verifyMessage(forged, expect).ok, false);
  // Headers above SES's (which SES never stores) aren't trusted either
  const above = sesMessage({ to, spf: "fail", extraTop: [`Authentication-Results: amazonses.com; spf=pass; dkim=pass header.i=@${PROD.senderDomain}`] });
  assert.equal(verifyMessage(above, expect).ok, false);
  // No SES block at all
  assert.equal(verifyMessage(`From: <${PROD.sender}>\r\nTo: ${to}\r\n\r\ncode 123456`, expect).reason, "not received through SES inbound");
  const noAuth = sesMessage({ to }).replace(/Authentication-Results:[^\r]*(\r\n [^\r]*)*/, "X-Other: 1");
  assert.equal(verifyMessage(noAuth, expect).reason, "no SES authentication results");
  const otherServ = sesMessage({ to }).replace("Authentication-Results: amazonses.com;", "Authentication-Results: evil.example;");
  assert.equal(verifyMessage(otherServ, expect).reason, "authentication results aren't SES's");
  const noReceivedSpf = sesMessage({ to }).replace(/Received-SPF: pass/, "Received-SPF: neutral");
  assert.equal(verifyMessage(noReceivedSpf, expect).reason, "Received-SPF isn't pass");
});

test("a genuine message replayed to another test address, or replayed late, is refused", () => {
  // An attacker resends a genuine, DKIM-signed invite (To: the throwaway it was sent to) to a
  // long-lived account's address: SES's envelope says the long-lived address, the signed To doesn't
  const longLived = `owner-lived@${PROD.mailDomain}`;
  const replayed = sesMessage({ to, rcpt: longLived, body: "Join: https://app.supplycheckout.com/?invite=i1&token=t1" });
  const v = verifyMessage(replayed, { ...expect, to: longLived });
  assert.equal(v.ok, false);
  assert.equal(v.reason, "not addressed to the address waited on");
  // The same genuine message replayed later to its own address is older than the wait
  const since = Date.parse("2026-10-07T13:00:00Z");
  assert.equal(verifyMessage(sesMessage({ to }), { ...expect, notBefore: since }).reason, "sent before this wait began, or undated");
  assert.equal(verifyMessage(sesMessage({ to, date: null }), { ...expect, notBefore: since }).reason, "sent before this wait began, or undated");
  assert.equal(verifyMessage(sesMessage({ to, date: "Wed, 07 Oct 2026 13:00:01 +0000" }), { ...expect, notBefore: since }).ok, true);
});

test("without a Received recipient, the To header decides", () => {
  const raw = sesMessage({ to }).replace(/\r\n for [^;]+;/, "");
  assert.equal(verifyMessage(raw, expect).ok, true);
  const other = sesMessage({ to: "else@example.com" }).replace(/\r\n for [^;]+;/, "");
  assert.equal(verifyMessage(other, expect).ok, false);
});

test("MIME parsing: folded headers, multipart, base64 and quoted-printable, HTML", () => {
  const html = '<html><style>p{}</style><p>Your code is <b>87654321</b>. <a href="https://app.supplycheckout.com/?invite=i1&amp;token=t1">Join</a> <a href="https://evil.example/?x=1">x</a></p></html>';
  const raw = sesMessage({
    to,
    contentType: 'multipart/alternative; boundary="b1"',
    body: [
      "--b1",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Join here: https://app.supplycheckout.com/?invite=3Di2 caf=C3=A9 long=",
      " line",
      "--b1",
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from(html).toString("base64"),
      "--b1",
      "Content-Type: image/png",
      "",
      "xx",
      "--b1--",
      "",
    ].join("\r\n"),
  });
  const v = verifyMessage(raw, expect);
  assert.equal(v.ok, true);
  const text = messageText(v.parsed);
  assert.match(text, /café long line/);
  assert.equal(extractCode(text), "87654321");
  const links = extractLinks(v.parsed, PROD.app);
  assert.ok(links.includes("https://app.supplycheckout.com/?invite=i1&token=t1"));
  assert.ok(!links.some((l) => l.includes("evil")));
  assert.deepEqual(addresses(`"A, B" <A@example.com>, c@example.org`), ["a@example.com", "c@example.org"]);
  assert.deepEqual(addresses(undefined), []);
  assert.deepEqual(authResults("amazonses.com; spf=pass x; junk; dkim=pass header.d=Example.com").results.map((r) => r.method), ["spf", "dkim"]);
  assert.deepEqual(parseMessage(Buffer.from("Subject: x")).headers, [{ name: "subject", value: "x" }]);
  assert.equal(extractCode("no digits here"), null);
  assert.equal(extractCode("order 12345678 shipped"), null);
});

const T0 = Date.parse("2026-10-07T12:00:00Z");
function clock() {
  let t = T0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

test("the reader skips a forged code raced to a run address and takes the genuine one", async () => {
  const s3 = fakeS3({
    "inbox/forged": { body: sesMessage({ to, spf: "pass", dkim: ["pass header.i=@evil.example"], dmarc: null, from: `<${PROD.sender}>`, body: "Your code is 999999" }), lastModified: T0 + 1000 },
    "inbox/other-run": { body: sesMessage({ to: throwawayAddress("9-1", "crew"), body: "Your code is 111111" }), lastModified: T0 + 1500 },
    "inbox/old": { body: sesMessage({ to, body: "Your code is 222222" }), lastModified: T0 - 60_000 },
    "inbox/genuine": { body: sesMessage({ to, body: "Your verification code is 123456" }), lastModified: T0 + 2000 },
  });
  const logs = [];
  const masker = createMasker({ github: false });
  const { now, sleep } = clock();
  const got = await waitForMail({ s3, to, since: T0, masker, log: (l) => logs.push(l), now, sleep });
  assert.deepEqual(got, { code: "123456" });
  assert.ok(masker.has("123456"), "the code is masked");
  assert.ok(!masker.has("999999"));
  assert.ok(!s3.store.has("inbox/genuine"), "the message is deleted once read");
  assert.ok(s3.store.has("inbox/forged"), "a refused message is left alone");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /refused a message to a run address \(no passing DKIM/);
  assert.ok(!logs.join("").includes("@") && !logs.join("").includes("999999"));
  assert.ok(!s3.calls.some(([op, k]) => op === "get" && k === "inbox/old"), "messages from before the run aren't read");
});

test("the reader refuses a genuine message replayed to the address it waits on", async () => {
  const longLived = `owner-lived@${PROD.mailDomain}`;
  const s3 = fakeS3({
    "inbox/replay": { body: sesMessage({ to, rcpt: longLived, body: "Your code is 999999" }), lastModified: T0 + 1000 },
    "inbox/old-replay": { body: sesMessage({ to: longLived, date: "Wed, 07 Oct 2026 08:00:00 +0000", body: "Your code is 888888" }), lastModified: T0 + 1500 },
  });
  const logs = [];
  const c = clock();
  await assert.rejects(waitForMail({ s3, to: longLived, since: T0, masker: createMasker({ github: false }), now: c.now, sleep: c.sleep, timeoutMs: 3000, log: (l) => logs.push(l) }), MailTimeout);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /not addressed to/);
  assert.match(logs[1], /sent before this wait began/);
});

test("the reader waits for the genuine message, and times out with only refusals", async () => {
  const s3 = fakeS3({});
  const { now, sleep } = clock();
  const slowSleep = async (ms) => {
    await sleep(ms);
    if (now() - T0 === 6000) await s3.put("inbox/late", sesMessage({ to, body: "Your code is 314159" }));
    s3.store.get("inbox/late") && (s3.store.get("inbox/late").lastModified = T0 + 6000);
  };
  const masker = createMasker({ github: false });
  assert.deepEqual(await waitForMail({ s3, to, since: T0, masker, now, sleep: slowSleep }), { code: "314159" });

  const forgedOnly = fakeS3({ "inbox/f": { body: sesMessage({ to, spf: "fail" }), lastModified: T0 } });
  const c2 = clock();
  await assert.rejects(waitForMail({ s3: forgedOnly, to, since: T0, masker, now: c2.now, sleep: c2.sleep, timeoutMs: 9000 }), (e) => e instanceof MailTimeout && /refused 1: SPF didn't pass/.test(e.message) && !e.message.includes("@"));
});

test("links: only the app's, matched and masked with their parameters", async () => {
  const body = `Join: https://app.supplycheckout.com/?invite=inv123&token=tok456 or https://app.supplycheckout.com/help`;
  const s3 = fakeS3({ "inbox/a": { body: sesMessage({ to, body }), lastModified: T0 }, "inbox/b": { body: sesMessage({ to, body: "Welcome, nothing to click" }), lastModified: T0 + 1 } });
  const masker = createMasker({ github: false });
  const { now, sleep } = clock();
  const got = await waitForMail({ s3, to, since: T0, want: "link", linkMatch: (l) => l.includes("invite="), masker, now, sleep });
  assert.equal(got.link, "https://app.supplycheckout.com/?invite=inv123&token=tok456");
  assert.ok(masker.has("tok456") && masker.has("inv123"));
  // A genuine message without what's wanted is skipped, then the wait times out
  const s3b = fakeS3({ "inbox/b": { body: sesMessage({ to, body: "Welcome, nothing to click" }), lastModified: T0 } });
  const c = clock();
  const logs = [];
  await assert.rejects(waitForMail({ s3: s3b, to, since: T0, want: "link", masker, now: c.now, sleep: c.sleep, timeoutMs: 3000, log: (l) => logs.push(l) }), /no link in the message/);
  assert.match(logs[0], /had no link/);
});

test("a message that can't be deleted after reading is still used", async () => {
  const s3 = fakeS3({ "inbox/a": { body: sesMessage({ to }), lastModified: T0 } });
  s3.remove = async () => { throw new Error("AccessDenied"); };
  const logs = [];
  const { now, sleep } = clock();
  assert.deepEqual(await waitForMail({ s3, to, since: T0, masker: createMasker({ github: false }), now, sleep, log: (l) => logs.push(l) }), { code: "123456" });
  assert.match(logs[0], /couldn't delete/);
});
