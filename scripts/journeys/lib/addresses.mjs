// Run IDs, run-scoped names and throwaway addresses (docs/journey-tests-plan.md, "Data isolation
// and cleanup").
//
// Throwaway addresses are `run-<runId>-<role>-<32 hex>@<test mail domain>`: the run and role say
// what made them (so cleanup and the destructive-call guard can tell), and 128 random bits make
// them unguessable, so nobody outside the run can aim mail or sign-up attempts at one before it's
// used. They're masked in the log as soon as they're made.
import { randomBytes } from "node:crypto";
import { PROD } from "./config.mjs";

/** Roles a run makes throwaway accounts for. */
export const THROWAWAY_ROLES = Object.freeze(["owner", "crew"]);

const ROLE = /^[a-z]{1,12}$/;
const THROWAWAY = /^run-([A-Za-z0-9]{1,24}(?:-[A-Za-z0-9]{1,8})?)-([a-z]{1,12})-([0-9a-f]{32})$/;

/** A new throwaway address for `role` in run `runId`. */
export function throwawayAddress(runId, role, { random = randomBytes, domain = PROD.mailDomain } = {}) {
  if (!ROLE.test(role)) throw new Error("A throwaway role is lowercase letters");
  return `run-${runId}-${role}-${random(16).toString("hex")}@${domain}`;
}

/**
 * `{ runId, role }` for a throwaway address at exactly the test mail domain, else null. The
 * local part must match the generated shape in full: no other address counts, however it starts.
 */
export function parseThrowaway(address, { domain = PROD.mailDomain } = {}) {
  if (typeof address !== "string") return null;
  const at = address.lastIndexOf("@");
  if (at < 1 || address.indexOf("@") !== at || address.slice(at + 1).toLowerCase() !== domain) return null;
  const m = THROWAWAY.exec(address.slice(0, at));
  return m ? { runId: m[1], role: m[2] } : null;
}

/** What a run names everything it makes in a long-lived team: `E2E <runId> <label>`. */
export const runName = (runId, label) => `E2E ${runId} ${label}`;

/** A barcode for the run's item `n`: `e2e-<runId>-<n>`. */
export const runBarcode = (runId, n) => `e2e-${runId}-${n}`;

const NAMED = /^E2E ([A-Za-z0-9]{1,24}(?:-[A-Za-z0-9]{1,8})?) /;
const CODED = /^e2e-([A-Za-z0-9]{1,24}(?:-[A-Za-z0-9]{1,8})?)-\d+$/;

/** The run ID a run-made name or barcode carries, or null. */
export function runOf({ name, code } = {}) {
  const n = typeof name === "string" ? NAMED.exec(name) : null;
  if (n) return n[1];
  const c = typeof code === "string" ? CODED.exec(code) : null;
  return c ? c[1] : null;
}
