// Reading one message from the test mailbox (docs/journey-tests-plan.md, "The test mailbox").
//
// SES inbound writes each raw message to the mail bucket, after adding its own trace headers at
// the top: Return-Path, a Received line "by inbound-smtp.<region>.amazonaws.com … for <rcpt>",
// X-SES-Spam-Verdict, X-SES-Virus-Verdict, Received-SPF, Authentication-Results (authserv-id
// amazonses.com) and X-SES-RECEIPT. Anyone on the internet can send mail to the test subdomain,
// including a forged sign-in code or invite link raced to a run's address, so a message counts
// only when SES's own verdicts say it's ours:
//
// - SES's headers are the leading block; the topmost Received is SES inbound's, and the topmost
//   Authentication-Results (SES prepends, so a sender's own copies sit below it) is SES's;
// - SPF passed, a DKIM signature for the app's domain passed, DMARC passed for the app's domain,
//   and the spam and virus verdicts are PASS;
// - there's exactly one From, and it's the app's no-reply address;
// - its one To header (DKIM-signed) is the address the harness is waiting on, SES delivered it
//   there, and its Date is from this wait (a replayed genuine message fails one of these).
//
// Anything else is refused with a reason that names no address or content.

const SES_TRACE = new Set(["return-path", "received", "x-ses-spam-verdict", "x-ses-virus-verdict", "received-spf", "authentication-results", "x-ses-receipt", "x-ses-dkim-signature"]);

/** Splits a raw message into its headers (in order, unfolded) and body. */
export function parseMessage(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString("latin1") : String(raw);
  const m = /\r?\n\r?\n/.exec(text);
  const head = m ? text.slice(0, m.index) : text;
  const body = m ? text.slice(m.index + m[0].length) : "";
  const headers = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) headers[headers.length - 1].value += " " + line.trim();
    else {
      const colon = line.indexOf(":");
      if (colon > 0) headers.push({ name: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() });
    }
  }
  return { headers, body };
}

const all = (headers, name) => headers.filter((h) => h.name === name).map((h) => h.value);
const first = (headers, name) => headers.find((h) => h.name === name)?.value;

/** The addresses in an address-list header (`"Name" <a@b>, c@d`), lowercased. */
export function addresses(value) {
  if (!value) return [];
  const out = [];
  const re = /<([^<>\s]+@[^<>\s]+)>|([^\s<>,;:"]+@[^\s<>,;:"]+)/g;
  let m;
  while ((m = re.exec(value))) out.push((m[1] ?? m[2]).toLowerCase());
  return out;
}

/** The `key=value` results in an Authentication-Results value, by method. */
export function authResults(value) {
  const [authserv, ...rest] = String(value).split(";").map((s) => s.trim());
  const results = rest.filter(Boolean).map((r) => {
    const m = /^([a-z]+)=([a-z]+)\b(.*)$/i.exec(r);
    if (!m) return null;
    const props = {};
    for (const p of m[3].matchAll(/\b([a-z]+\.[a-z]+)=([^\s;]+)/gi)) props[p[1].toLowerCase()] = p[2].toLowerCase();
    return { method: m[1].toLowerCase(), result: m[2].toLowerCase(), props };
  }).filter(Boolean);
  return { authserv: authserv.split(/\s/)[0].toLowerCase(), results };
}

/**
 * Whether a raw message is genuinely the app's mail to `to`, sent no earlier than `notBefore`
 * (ms, when given). Returns `{ ok: true, parsed }`, or `{ ok: false, reason }`.
 *
 * The recipient is checked on the message's own To header (exactly one, which the app's DKIM
 * signature covers), not only SES's envelope recipient, which the sending server chooses: a
 * genuine message replayed to another test address keeps its original To and is refused. Its
 * Date (also signed) must be from this wait, so an old genuine message replayed to the same
 * address is refused too.
 */
export function verifyMessage(raw, { to, sender, senderDomain, region, notBefore }) {
  const parsed = parseMessage(raw);
  const { headers } = parsed;
  // SES's trace block: the leading run of trace headers
  let end = 0;
  while (end < headers.length && SES_TRACE.has(headers[end].name)) end++;
  const block = headers.slice(0, end);
  const fail = (reason) => ({ ok: false, reason });

  const received = first(block, "received");
  const by = /\bby\s+([^\s;]+)/i.exec(received ?? "")?.[1]?.toLowerCase();
  if (by !== `inbound-smtp.${region}.amazonaws.com`) return fail("not received through SES inbound");
  const auth = first(block, "authentication-results");
  if (!auth) return fail("no SES authentication results");
  if (first(headers, "authentication-results") !== auth) return fail("SES authentication results aren't the topmost");
  const ar = authResults(auth);
  if (ar.authserv !== "amazonses.com") return fail("authentication results aren't SES's");
  const results = (method) => ar.results.filter((r) => r.method === method);
  if (!results("spf").some((r) => r.result === "pass")) return fail("SPF didn't pass");
  const domain = senderDomain.toLowerCase();
  const signedByUs = (r) => r.result === "pass" && (r.props["header.d"] === domain || r.props["header.i"] === `@${domain}`);
  if (!results("dkim").some(signedByUs)) return fail("no passing DKIM signature from the app's domain");
  const dmarc = results("dmarc");
  if (!dmarc.length || dmarc.some((r) => r.result !== "pass" || r.props["header.from"] !== domain)) return fail("DMARC didn't pass for the app's domain");
  if (first(block, "x-ses-spam-verdict")?.toUpperCase() !== "PASS") return fail("SES spam verdict isn't PASS");
  if (first(block, "x-ses-virus-verdict")?.toUpperCase() !== "PASS") return fail("SES virus verdict isn't PASS");
  if (!/^pass\b/i.test(first(block, "received-spf") ?? "")) return fail("Received-SPF isn't pass");

  const froms = all(headers, "from");
  if (froms.length !== 1) return fail("not exactly one From header");
  const fromAddresses = addresses(froms[0]);
  if (fromAddresses.length !== 1 || fromAddresses[0] !== sender.toLowerCase()) return fail("not from the app's no-reply address");

  const want = String(to).toLowerCase();
  const tos = all(headers, "to");
  if (tos.length !== 1) return fail("not exactly one To header");
  const toList = addresses(tos[0]);
  if (toList.length !== 1 || toList[0] !== want) return fail("not addressed to the address waited on");
  const rcpt = /\bfor <?([^\s<>;]+@[^\s<>;]+?)>?;/i.exec(received)?.[1]?.toLowerCase();
  if (rcpt !== undefined && rcpt !== want) return fail("not delivered to the address waited on");
  if (notBefore !== undefined) {
    const date = Date.parse(first(headers, "date") ?? "");
    if (!Number.isFinite(date) || date < notBefore) return fail("sent before this wait began, or undated");
  }
  return { ok: true, parsed };
}

function decodeTransfer(body, encoding) {
  const enc = String(encoding ?? "").toLowerCase();
  if (enc === "base64") return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (enc === "quoted-printable") {
    const bytes = Buffer.from(body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return bytes.toString("utf8");
  }
  return Buffer.from(body, "latin1").toString("utf8");
}

/** The text and HTML parts of a parsed message, decoded. */
export function bodyParts({ headers, body }) {
  const type = first(headers, "content-type") ?? "text/plain";
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary) {
    const out = [];
    const sections = body.split(`--${boundary}`).slice(1);
    for (const s of sections) {
      if (s.startsWith("--")) break;
      out.push(...bodyParts(parseMessage(s.replace(/^\r?\n/, ""))));
    }
    return out;
  }
  if (!/^text\/(plain|html)/i.test(type)) return [];
  return [{ type: /^text\/html/i.test(type) ? "html" : "text", content: decodeTransfer(body, first(headers, "content-transfer-encoding")) }];
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const unescapeHtml = (s) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e]);

/** The message's readable text: plain parts, and HTML parts without their tags. */
export function messageText(parsed) {
  return bodyParts(parsed)
    .map((p) => (p.type === "html" ? unescapeHtml(p.content.replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")) : p.content))
    .join("\n")
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

/** A 6- to 8-digit code that follows the word "code" (Cognito's sign-up and sign-in codes). */
export function extractCode(text) {
  return /\bcode\b[^0-9]{0,40}?\b(\d{6,8})\b/i.exec(text)?.[1] ?? null;
}

/** Every link in the message (href attributes and bare URLs) whose origin is exactly `origin`. */
export function extractLinks(parsed, origin) {
  const found = new Set();
  for (const p of bodyParts(parsed)) {
    const text = p.type === "html" ? unescapeHtml(p.content) : p.content;
    for (const m of text.matchAll(/https:\/\/[^\s"'<>]+/g)) {
      try {
        const url = new URL(m[0].replace(/[).,]+$/, ""));
        if (url.origin === origin) found.add(url.href);
      } catch {}
    }
  }
  return [...found];
}
