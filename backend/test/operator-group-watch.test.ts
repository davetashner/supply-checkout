// The operator group watch (src/ops/operator-group-watch-handler.ts,
// supply-checkout-3sv.5): who joined, left, was disabled or enabled in the
// operators group since the last run, from ListUsersInGroup and one SSM
// parameter.

import { describe, expect, it } from "vitest";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { INITIAL_GROUP_SNAPSHOT } from "../src/ops/names.js";
import { listGroupMembers, MAX_PAGES } from "../src/ops/operator-group-members.js";
import { createOperatorGroupWatchHandler, diffGroup, type GroupMember, parseSnapshot, snapshotOf } from "../src/ops/operator-group-watch-handler.js";

type Logged = { level: string; message: string; data: Record<string, unknown> };

function fakeObservability() {
  const logs: Logged[] = [];
  const counts: { metric: string; value: number }[] = [];
  const gauges: { metric: string; value: number }[] = [];
  const log = (level: string) => (message: string, data: Record<string, unknown> = {}) => logs.push({ level, message, data });
  const obs: Observability = {
    region: "test-local-1",
    logger: { info: log("info"), warn: log("warn"), error: log("error") } as unknown as Observability["logger"],
    count: (metric, value = 1) => counts.push({ metric, value }),
    gauge: (metric, value) => gauges.push({ metric, value }),
    flush: () => {},
  };
  return { obs, logs, counts, gauges };
}

const sub = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const member = (n: number, enabled = true): GroupMember => ({ sub: sub(n), enabled });

function run(members: GroupMember[], saved: string) {
  const { obs, logs, counts, gauges } = fakeObservability();
  const writes: string[] = [];
  const handler = createOperatorGroupWatchHandler({
    obs,
    listMembers: async () => members,
    readSnapshot: async () => saved,
    writeSnapshot: async (s) => {
      writes.push(s);
    },
  });
  return { handler, logs, counts, gauges, writes };
}

describe("operator group watch", () => {
  it("records the group without counting on its first run", async () => {
    const { handler, counts, gauges, writes, logs } = run([member(1), member(2)], INITIAL_GROUP_SNAPSHOT);
    expect(await handler()).toEqual({ members: 2, changed: 0 });
    expect(counts).toEqual([]);
    expect(writes).toEqual([snapshotOf([member(1), member(2)])]);
    expect(gauges).toEqual([{ metric: BusinessMetric.OperatorGroupMembers, value: 2 }]);
    expect(logs.map((l) => l.level)).toEqual(["info"]);
  });

  it("counts nothing and writes nothing when the group is as it was", async () => {
    const { handler, counts, gauges, writes, logs } = run([member(2), member(1)], snapshotOf([member(1), member(2)]));
    expect(await handler()).toEqual({ members: 2, changed: 0 });
    expect(counts).toEqual([]);
    expect(writes).toEqual([]);
    expect(logs).toEqual([]);
    expect(gauges).toEqual([{ metric: BusinessMetric.OperatorGroupMembers, value: 2 }]);
  });

  it("counts each operator added, removed, disabled or enabled, logs them by sub, and saves the new group", async () => {
    const before = snapshotOf([member(1), member(2), member(3, false), member(4)]);
    const now = [member(1), member(2, false), member(3), member(5)];
    const { handler, counts, writes, logs } = run(now, before);
    expect(await handler()).toEqual({ members: 4, changed: 4 });
    expect(counts).toEqual([{ metric: BusinessMetric.OperatorGroupChanged, value: 4 }]);
    expect(writes).toEqual([snapshotOf(now)]);
    expect(logs).toEqual([{ level: "error", message: "Operator group changed", data: { added: [sub(5)], removed: [sub(4)], disabled: [sub(2)], enabled: [sub(3)], members: 4 } }]);
  });

  it("counts an add followed by the first run (the drill's add, then its removal)", async () => {
    const empty = snapshotOf([]);
    const added = run([member(7)], empty);
    expect(await added.handler()).toEqual({ members: 1, changed: 1 });
    const removed = run([], added.writes[0] as string);
    expect(await removed.handler()).toEqual({ members: 0, changed: 1 });
    expect(removed.logs[0]?.data).toMatchObject({ removed: [sub(7)] });
  });

  it("counts a snapshot it can't read once, and replaces it", async () => {
    for (const garbled of ["", "{", "null", "[]", '{"members":[]}', '{"members":{"x":true}}', `{"members":{"${sub(1)}":"yes"}}`]) {
      const { handler, counts, writes, logs } = run([member(1)], garbled);
      expect(await handler(), garbled).toEqual({ members: 1, changed: 1 });
      expect(counts).toEqual([{ metric: BusinessMetric.OperatorGroupChanged, value: 1 }]);
      expect(writes).toEqual([snapshotOf([member(1)])]);
      expect(logs[0]?.level).toBe("error");
      expect(JSON.stringify(logs)).not.toContain(sub(1));
    }
  });

  it("fails, counting nothing, when a member has no sub", async () => {
    const { handler, counts, writes, gauges } = run([{ sub: "", enabled: true }], INITIAL_GROUP_SNAPSHOT);
    await expect(handler()).rejects.toThrow("without a sub");
    expect(counts).toEqual([]);
    expect(writes).toEqual([]);
    expect(gauges).toEqual([]);
  });

  it("sends no gauge when saving the snapshot fails, so the next run counts again and silence shows", async () => {
    const { obs, counts, gauges } = fakeObservability();
    const handler = createOperatorGroupWatchHandler({
      obs,
      listMembers: async () => [member(1)],
      readSnapshot: async () => snapshotOf([]),
      writeSnapshot: async () => {
        throw new Error("AccessDenied");
      },
    });
    await expect(handler()).rejects.toThrow("AccessDenied");
    expect(counts).toEqual([{ metric: BusinessMetric.OperatorGroupChanged, value: 1 }]);
    expect(gauges).toEqual([]);
  });

  it("saves subs sorted, and reads back what it saves", () => {
    const snapshot = snapshotOf([member(2, false), member(1)]);
    expect(snapshot).toBe(`{"members":{"${sub(1)}":true,"${sub(2)}":false}}`);
    expect(parseSnapshot(snapshot)).toEqual(new Map([[sub(1), true], [sub(2), false]]));
    expect(snapshotOf([member(1), member(1)])).toBe(`{"members":{"${sub(1)}":true}}`);
    expect(diffGroup(new Map(), [])).toEqual({ added: [], removed: [], disabled: [], enabled: [] });
    expect(diffGroup(new Map([[sub(1), false]]), [member(1, false)])).toEqual({ added: [], removed: [], disabled: [], enabled: [] });
  });
});

describe("listing the operators group", () => {
  const user = (n: number, enabled: unknown = true, extra: { Name: string; Value: string }[] = []) => ({
    Username: `person-${n}`,
    Enabled: enabled,
    Attributes: [{ Name: "email", Value: `person-${n}@example.com` }, ...extra, { Name: "sub", Value: sub(n) }],
  });

  it("reads every page, keeping only each user's sub and whether they're enabled", async () => {
    const calls: { action: string; body: Record<string, unknown> }[] = [];
    const pages = [{ Users: [user(1), user(2, false)], NextToken: "next" }, { Users: [user(3, "true")] }];
    const members = await listGroupMembers(
      async (action, body) => {
        calls.push({ action, body: { ...body } });
        return pages.shift();
      },
      "pool-id",
      "operators",
    );
    expect(members).toEqual([member(1), member(2, false), member(3, false)]);
    expect(calls).toEqual([
      { action: "ListUsersInGroup", body: { UserPoolId: "pool-id", GroupName: "operators", Limit: 60 } },
      { action: "ListUsersInGroup", body: { UserPoolId: "pool-id", GroupName: "operators", Limit: 60, NextToken: "next" } },
    ]);
    expect(JSON.stringify(members)).not.toContain("example.com");
  });

  it("gives a user without a sub an empty one, and takes an odd answer as no users", async () => {
    const answers: unknown[] = [{ Users: [{ Enabled: true }, { Enabled: true, Attributes: "odd" }, null, { Attributes: [{ Name: "sub", Value: 5 }] }], NextToken: "" }];
    expect(await listGroupMembers(async () => answers.shift(), "p", "g")).toEqual([
      { sub: "", enabled: true },
      { sub: "", enabled: true },
      { sub: "", enabled: false },
      { sub: "", enabled: false },
    ]);
    expect(await listGroupMembers(async () => ({ Users: "odd" }), "p", "g")).toEqual([]);
  });

  it("stops after MAX_PAGES pages", async () => {
    let pages = 0;
    await expect(
      listGroupMembers(
        async () => {
          pages++;
          return { Users: [], NextToken: "more" };
        },
        "p",
        "g",
      ),
    ).rejects.toThrow("more than");
    expect(pages).toBe(MAX_PAGES);
  });
});
