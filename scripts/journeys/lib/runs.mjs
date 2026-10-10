// Records of each run's throwaway accounts, under runs/<runId>/accounts/<role>.json in the mail
// bucket (30-day lifecycle), so the next run's cleanup can delete a crashed run's accounts.
//
// A record holds the address, the account's user ID, the teams it created (and, written before
// POST /teams, the name of the team it's about to create, `E2E <runId> …`), and where it got
// to: `planned` (address made, not yet signed up), `signup` (SignUp about to be sent: an
// unconfirmed account may exist), `started` (signed up and confirmed, or, for a run from before
// `signup`, sign-up begun), `deleted`. Only those fields: never a password, code, token or anything else, and a
// record with any other field is refused, writing or reading.
import { parseThrowaway, runOf } from "./addresses.mjs";

export const STATES = Object.freeze(["planned", "signup", "started", "deleted"]);
const FIELDS = new Set(["runId", "role", "address", "state", "userId", "teamIds", "teamName", "updatedAt"]);
const KEY = /^runs\/([A-Za-z0-9-]{1,40})\/accounts\/([a-z]{1,12})\.json$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export const recordKey = (runId, role) => `runs/${runId}/accounts/${role}.json`;

/** Checks a record; returns it with only its known fields, or throws. */
export function checkRecord(record) {
  const extra = Object.keys(record ?? {}).filter((k) => !FIELDS.has(k));
  if (extra.length) throw new Error(`A run record may not hold ${extra.join(", ")}`);
  const parsed = parseThrowaway(record.address);
  if (!parsed || parsed.runId !== record.runId || parsed.role !== record.role) throw new Error("A run record's address isn't its run's throwaway for its role");
  if (!STATES.includes(record.state)) throw new Error("A run record's state is planned, signup, started or deleted");
  if (record.userId !== undefined && !ID.test(record.userId)) throw new Error("A run record's userId isn't an ID");
  if (record.teamName !== undefined && !(typeof record.teamName === "string" && record.teamName.length <= 200 && /^[\x20-\x7e]+$/.test(record.teamName) && runOf({ name: record.teamName }) === record.runId)) throw new Error("A run record's teamName isn't a name of its run");
  if (record.teamIds !== undefined && !(Array.isArray(record.teamIds) && record.teamIds.every((t) => ID.test(t)))) throw new Error("A run record's teamIds aren't IDs");
  return Object.fromEntries(Object.entries(record).filter(([k]) => FIELDS.has(k)));
}

/** Writes (replaces) a record. */
export async function writeRecord(s3, record, now = () => new Date().toISOString()) {
  const clean = checkRecord({ ...record, updatedAt: now() });
  await s3.put(recordKey(clean.runId, clean.role), JSON.stringify(clean));
  return clean;
}

/**
 * Every run's records. A record that doesn't parse or check is reported in `problems` (by key
 * shape only) and skipped.
 */
export async function readRecords(s3) {
  const records = [];
  const problems = [];
  for (const { key } of await s3.list("runs/")) {
    const m = KEY.exec(key);
    if (!m) continue;
    try {
      const record = checkRecord(JSON.parse((await s3.get(key)).toString("utf8")));
      if (record.runId !== m[1] || record.role !== m[2]) throw new Error("key mismatch");
      records.push(record);
    } catch {
      problems.push(`A run record (${m[2]}) couldn't be read or isn't valid`);
    }
  }
  return { records, problems };
}
