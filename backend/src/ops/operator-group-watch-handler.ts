// The operator group watch (supply-checkout-3sv.5, ADR 0015), a scheduled
// check in the primary region.
//
// The OperatorPoolChanges rule is meant to alert P1 on every change to the
// operator pool's users and group, from CloudTrail through EventBridge. In
// the 2026-09-27 drill AdminCreateUser reached it, but AdminAddUserToGroup
// and AdminRemoveUserFromGroup never did, though the trail recorded them as
// write management events and the pattern matches them
// (docs/infrastructure.md, "Operators"). So this watch doesn't depend on
// CloudTrail or EventBridge at all: every GROUP_WATCH_EVERY_MINUTES it asks
// Cognito who is in the `operators` group (ListUsersInGroup) and compares
// that with the list it saw last, kept in one SSM parameter. Each operator
// added, removed (from the group, or deleted), disabled or enabled since
// counts once in OperatorGroupChanged, which alarms P1 ("Operator group
// changed"); the log line lists them by `sub`.
//
// Every run that finishes sends the group's size as the OperatorGroupMembers
// gauge, and "Operator group watch silent" (P2) fires when none arrives for
// a while: a disabled schedule, a failing function, a missing permission.
//
// The first run after the parameter is created (it holds INITIAL_GROUP_SNAPSHOT)
// records the group without counting anything. Anything else it can't read
// counts once and is replaced, so a garbled parameter is seen, not trusted.
// The parameter is written only when something changed, after the count.
//
// It logs `sub`s (Cognito's opaque user IDs, which CloudTrail records for
// these calls too), never usernames, emails or other attributes.

import { BusinessMetric, type Observability } from "../observability/index.js";
import { INITIAL_GROUP_SNAPSHOT } from "./names.js";

/** One member of the operators group. */
export interface GroupMember {
  readonly sub: string;
  readonly enabled: boolean;
}

export interface OperatorGroupWatchDeps {
  readonly obs: Observability;
  /** Every user in the operators group now. */
  readonly listMembers: () => Promise<GroupMember[]>;
  /** The snapshot the last run saved. */
  readonly readSnapshot: () => Promise<string>;
  readonly writeSnapshot: (snapshot: string) => Promise<void>;
}

const SUB = /^[0-9a-f-]{36}$/;

/** The group as saved: `sub` to enabled, sorted, as JSON. */
export function snapshotOf(members: readonly GroupMember[]): string {
  const sorted = [...members].sort((a, b) => (a.sub < b.sub ? -1 : a.sub > b.sub ? 1 : 0));
  return JSON.stringify({ members: Object.fromEntries(sorted.map((m) => [m.sub, m.enabled])) });
}

/** A saved snapshot, or undefined when it isn't one this watch wrote. */
export function parseSnapshot(raw: string): Map<string, boolean> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const members = (parsed as { members?: unknown } | null)?.members;
  if (typeof members !== "object" || members === null || Array.isArray(members)) return undefined;
  const entries = Object.entries(members as Record<string, unknown>);
  if (!entries.every(([sub, enabled]) => SUB.test(sub) && typeof enabled === "boolean")) return undefined;
  return new Map(entries as [string, boolean][]);
}

export interface GroupChanges {
  readonly added: string[];
  readonly removed: string[];
  readonly disabled: string[];
  readonly enabled: string[];
}

/** Who joined, left, was disabled or was enabled between two looks at the group. */
export function diffGroup(before: ReadonlyMap<string, boolean>, now: readonly GroupMember[]): GroupChanges {
  const changes: GroupChanges = { added: [], removed: [], disabled: [], enabled: [] };
  const current = new Map(now.map((m) => [m.sub, m.enabled]));
  for (const [sub, enabled] of current) {
    const was = before.get(sub);
    if (was === undefined) changes.added.push(sub);
    else if (was && !enabled) changes.disabled.push(sub);
    else if (!was && enabled) changes.enabled.push(sub);
  }
  for (const sub of before.keys()) if (!current.has(sub)) changes.removed.push(sub);
  for (const list of Object.values(changes)) list.sort();
  return changes;
}

export function createOperatorGroupWatchHandler(deps: OperatorGroupWatchDeps) {
  const { obs } = deps;
  return async (): Promise<{ members: number; changed: number }> => {
    const members = await deps.listMembers();
    for (const m of members) if (!SUB.test(m.sub)) throw new Error("ListUsersInGroup answered with a user without a sub");
    const raw = await deps.readSnapshot();
    const snapshot = snapshotOf(members);
    let changed = 0;
    if (raw === INITIAL_GROUP_SNAPSHOT) {
      obs.logger.info("Recorded the operators group for the first time", { members: members.length });
    } else {
      const before = parseSnapshot(raw);
      if (!before) {
        changed = 1;
        obs.logger.error("Operator group watch couldn't read its last snapshot; replacing it", { members: members.length });
      } else {
        const changes = diffGroup(before, members);
        changed = changes.added.length + changes.removed.length + changes.disabled.length + changes.enabled.length;
        if (changed > 0) obs.logger.error("Operator group changed", { ...changes, members: members.length });
      }
    }
    if (changed > 0) obs.count(BusinessMetric.OperatorGroupChanged, changed);
    if (raw !== snapshot) await deps.writeSnapshot(snapshot);
    obs.gauge(BusinessMetric.OperatorGroupMembers, members.length);
    return { members: members.length, changed };
  };
}
