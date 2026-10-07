// The mailbox reader: waits for the app's mail to a test address in the mail bucket's inbox/,
// accepts it only when SES's verdicts say it's genuinely ours (mail.mjs verifyMessage), takes
// the code or link out, masks it, and deletes the message. It never logs a body, an address,
// a code or a link.
import { setTimeout as delay } from "node:timers/promises";
import { PROD } from "./config.mjs";
import { addresses, extractCode, extractLinks, messageText, parseMessage, verifyMessage } from "./mail.mjs";

/** How long to wait for a message, and how often to look (docs/journey-tests-plan.md, Flake policy). */
export const MAIL_TIMEOUT_MS = 60_000;
export const MAIL_POLL_MS = 3_000;
/** Clock skew allowed between the runner and S3's LastModified. */
const SKEW_MS = 10_000;

export class MailTimeout extends Error {}

/** Whether a raw message was addressed to `to` at all (before any verdict is checked). */
function addressedTo(raw, to) {
  const { headers } = parseMessage(raw);
  const want = to.toLowerCase();
  if (headers.filter((h) => h.name === "to").some((h) => addresses(h.value).includes(want))) return true;
  return headers.some((h) => h.name === "received" && (h.value.toLowerCase().includes(`for <${want}>`) || h.value.toLowerCase().includes(`for ${want}`)));
}

/**
 * Waits for the app's mail to `to`, received after `since` (ms). `want` is "code" (a 6- to
 * 8-digit code) or "link" (a link to the app; `linkMatch` narrows which). Returns `{ code }` or
 * `{ link }`; throws MailTimeout after `timeoutMs`. Messages to `to` that fail the checks are
 * counted and reported (by reason only) and never used.
 */
export async function waitForMail({ s3, to, since, want = "code", linkMatch = () => true, masker, log = () => {}, timeoutMs = MAIL_TIMEOUT_MS, pollMs = MAIL_POLL_MS, now = Date.now, sleep = delay, expect = PROD }) {
  const seen = new Set();
  const deadline = now() + timeoutMs;
  const rejected = [];
  for (;;) {
    const objects = (await s3.list("inbox/")).filter((o) => !seen.has(o.key) && !(o.lastModified < since - SKEW_MS)).sort((a, b) => a.lastModified - b.lastModified);
    for (const o of objects) {
      seen.add(o.key);
      const raw = await s3.get(o.key);
      if (!addressedTo(raw, to)) continue;
      const verdict = verifyMessage(raw, { to, sender: expect.sender, senderDomain: expect.senderDomain, region: expect.region });
      if (!verdict.ok) {
        rejected.push(verdict.reason);
        log(`Mailbox: refused a message to a run address (${verdict.reason})`);
        continue;
      }
      let found;
      if (want === "code") {
        const code = extractCode(messageText(verdict.parsed));
        if (code) found = { code: masker.add(code) };
      } else {
        const link = extractLinks(verdict.parsed, expect.app).find(linkMatch);
        if (link) {
          masker.add(link);
          for (const v of new URL(link).searchParams.values()) masker.add(v);
          found = { link };
        }
      }
      if (!found) {
        rejected.push(`no ${want} in the message`);
        log(`Mailbox: a genuine message to a run address had no ${want}`);
        continue;
      }
      try { await s3.remove(o.key); } catch { log("Mailbox: couldn't delete a read message (it expires in a day)"); }
      return found;
    }
    if (now() >= deadline) throw new MailTimeout(`No genuine ${want} arrived within ${Math.round(timeoutMs / 1000)} seconds${rejected.length ? ` (refused ${rejected.length}: ${[...new Set(rejected)].join("; ")})` : ""}`);
    await sleep(pollMs);
  }
}
