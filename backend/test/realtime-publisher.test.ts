// The DynamoDB stream consumer: which records become change events, what the
// events look like, who they go to, and how failed publishes are retried.

import { readFileSync } from "node:fs";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audienceChangeFromStream, documentChangeFromStream } from "../src/data/index.js";
import { keys, prefixes } from "../src/data/keys.js";
import { createObservability, type Observability, withObservability } from "../src/observability/index.js";
import type { Audience } from "../src/realtime/audience.js";
import { MEMBERS_PER_TEAM } from "../src/data/index.js";
import {
  AUDIENCE_SK,
  AUDIENCE_READ_TIMEOUT_MS,
  CHANGE_EVENT_FIELDS,
  type ChangeEvent,
  COLLECTION_EVENT_AFTER,
  COLLECTION_EVENT_FIELDS,
  CONSUMER_TIMEOUT_SECONDS,
  DOCUMENT_SK_PREFIXES,
  EVENTS_PER_PUBLISH,
  PUBLISH_BUDGET_MS,
  PUBLISH_TIMEOUT_MS,
  PUBLISHES_PER_INVOCATION,
  STREAM_BATCH_SIZE,
  STREAM_RETRY_ATTEMPTS,
  userChannel,
  userFromChannel,
} from "../src/realtime/channels.js";
import type { Publish, PublishResult } from "../src/realtime/events-client.js";
import { changeEvent, createPublisherHandler } from "../src/realtime/publisher-handler.js";
import { REGION } from "./helpers.js";

const TEAM = "7d3b8a52-5a61-4c3e-9d1f-0b6f2f7c1a11";
const TEAM_B = "0f0e8a52-5a61-4c3e-9d1f-0b6f2f7c1a22";
const TEAM_C = "1c2e8a52-5a61-4c3e-9d1f-0b6f2f7c1a33";
// Members: A1 and A2 in TEAM, B1 in TEAM_B (Cognito user IDs are UUIDs)
const A1 = "a1a1a1a1-0000-4000-8000-000000000001";
const A2 = "a2a2a2a2-0000-4000-8000-000000000002";
const B1 = "b1b1b1b1-0000-4000-8000-000000000003";
const AT = 1_790_000_000;

let seq = 0;
type Item = Record<string, unknown>;

/** A stream record the way DynamoDB Streams hands it to Lambda (NEW_AND_OLD_IMAGES). */
function record(eventName: "INSERT" | "MODIFY" | "REMOVE", keys: { PK: string; SK: string }, images: { old?: Item; new?: Item } = {}): DynamoDBRecord {
  seq += 1;
  const image = (item?: Item) => (item ? (marshall({ ...keys, ...item }, { removeUndefinedValues: true }) as never) : undefined);
  return {
    eventID: `event-${seq}`,
    eventName,
    eventSource: "aws:dynamodb",
    awsRegion: REGION,
    dynamodb: {
      ApproximateCreationDateTime: AT,
      Keys: marshall(keys) as never,
      SequenceNumber: String(1000 + seq),
      SizeBytes: 100,
      StreamViewType: "NEW_AND_OLD_IMAGES",
      ...(eventName !== "INSERT" ? { OldImage: image(images.old) } : {}),
      ...(eventName !== "REMOVE" ? { NewImage: image(images.new) } : {}),
    },
  };
}

const product = (team: string, key: string) => ({ PK: `TEAM#${team}`, SK: `PRODUCT#${key}` });
/** A project's item key. */
const projectKey = (team: string, id: string) => ({ PK: `TEAM#${team}`, SK: `PROJECT#${id}` });
const productItem = (key: string, version: number, fields: Item = {}) => ({ type: "product", key, version, name: "Drop cloth", stock: 4, ...fields });
const projectItem = (id: string, version: number, fields: Item = {}) => ({
  type: "project",
  id,
  version,
  GSI1PK: `TEAM#${TEAM}#PROJECTS`,
  GSI1SK: `2026-09-26#${id}`,
  date: "2026-09-26",
  client: "Echo",
  items: { tape: { out: 2, returned: 0 } },
  ...fields,
});

describe("documentChangeFromStream", () => {
  it("maps a new product to a put with its version, and nothing from the document", () => {
    const change = documentChangeFromStream(record("INSERT", product(TEAM, "012345"), { new: productItem("012345", 1) }));
    expect(change).toEqual({ teamId: TEAM, collection: "products", id: "012345", op: "put", version: 1 });
  });

  it("maps a project update to the projects collection", () => {
    const change = documentChangeFromStream(record("MODIFY", projectKey(TEAM, "s1"), { old: projectItem("s1", 3), new: projectItem("s1", 4, { client: "Foxtrot" }) }));
    expect(change).toEqual({ teamId: TEAM, collection: "projects", id: "s1", op: "put", version: 4 });
  });

  it("ignores the rename backfill's SHEET# half (its REMOVE and any change to an old item), and maps the PROJECT# INSERT to a put", () => {
    expect(documentChangeFromStream(record("REMOVE", { PK: `TEAM#${TEAM}`, SK: "SHEET#s1" }, { old: projectItem("s1", 5) }))).toBeUndefined();
    expect(documentChangeFromStream(record("MODIFY", { PK: `TEAM#${TEAM}`, SK: "SHEET#s1" }, { old: projectItem("s1", 5), new: projectItem("s1", 6) }))).toBeUndefined();
    expect(documentChangeFromStream(record("INSERT", projectKey(TEAM, "s1"), { new: projectItem("s1", 5) }))).toEqual({ teamId: TEAM, collection: "projects", id: "s1", op: "put", version: 5 });
  });

  it("maps a stock ADD, which keeps the version, to a put with the same version", () => {
    const change = documentChangeFromStream(
      record("MODIFY", product(TEAM, "tape"), { old: productItem("tape", 7, { stock: 10 }), new: productItem("tape", 7, { stock: 8 }) }),
    );
    expect(change).toEqual({ teamId: TEAM, collection: "products", id: "tape", op: "put", version: 7 });
  });

  it("maps a delete to the deleted document's last version", () => {
    expect(documentChangeFromStream(record("REMOVE", projectKey(TEAM, "s1"), { old: projectItem("s1", 5) }))).toEqual({
      teamId: TEAM,
      collection: "projects",
      id: "s1",
      op: "delete",
      version: 5,
    });
    expect(documentChangeFromStream(record("REMOVE", projectKey(TEAM, "s1")))).toMatchObject({ op: "delete", version: undefined });
  });

  it("keeps product keys with characters a project ID can't have", () => {
    const key = "Tape, blue #2 (1\")";
    expect(documentChangeFromStream(record("INSERT", product(TEAM, key), { new: productItem(key, 1) }))?.id).toBe(key);
  });

  it.each([
    ["team metadata", { PK: `TEAM#${TEAM}`, SK: "META" }],
    ["a member", { PK: `TEAM#${TEAM}`, SK: "MEMBER#user-1" }],
    ["an invite", { PK: `TEAM#${TEAM}`, SK: "INVITE#i1" }],
    ["usage", { PK: `TEAM#${TEAM}`, SK: "USAGE#2026-09" }],
    ["an audit entry", { PK: `TEAM#${TEAM}`, SK: "AUDIT#2026-09-26T12:00:00Z#e1" }],
    ["a user's team link", { PK: "USER#user-1", SK: `TEAM#${TEAM}` }],
    ["a Stripe link", { PK: "STRIPE#cus_1", SK: "TEAM" }],
    ["a webhook marker", { PK: "WEBHOOK#evt_1", SK: "DONE" }],
    ["a product outside a team partition", { PK: "USER#user-1", SK: "PRODUCT#x" }],
    ["a product under a partition with extra parts", { PK: `TEAM#${TEAM}#PROJECTS`, SK: "PRODUCT#x" }],
    ["a bad team ID", { PK: "TEAM#bad id", SK: "PRODUCT#x" }],
    ["a project still under SHEET#", { PK: `TEAM#${TEAM}`, SK: "SHEET#a" }],
    ["a bad project ID", { PK: `TEAM#${TEAM}`, SK: "PROJECT#a#b" }],
    ["a project under another team's index partition", { PK: `TEAM#${TEAM}#PROJECTS`, SK: "PROJECT#x" }],
    ["an empty product key", { PK: `TEAM#${TEAM}`, SK: "PRODUCT#" }],
  ])("ignores %s", (_, keys) => {
    expect(documentChangeFromStream(record("INSERT", keys, { new: { version: 1 } }))).toBeUndefined();
  });

  it("ignores records without string keys or with an unknown event name", () => {
    const r = record("INSERT", product(TEAM, "x"), { new: productItem("x", 1) });
    expect(documentChangeFromStream({ ...r, dynamodb: { ...r.dynamodb, Keys: { PK: { N: "1" }, SK: { S: "PRODUCT#x" } } } })).toBeUndefined();
    expect(documentChangeFromStream({ ...r, dynamodb: undefined })).toBeUndefined();
    expect(documentChangeFromStream({ ...r, eventName: undefined })).toBeUndefined();
  });

  it("leaves out a version that is missing or isn't a whole number", () => {
    const unversioned = record("INSERT", product(TEAM, "y"), { new: { type: "product", key: "y", name: "No version" } });
    expect(documentChangeFromStream(unversioned)).toEqual({ teamId: TEAM, collection: "products", id: "y", op: "put", version: undefined });
    expect(documentChangeFromStream(record("MODIFY", product(TEAM, "z")))).toMatchObject({ op: "put", version: undefined });
    for (const bad of ["1.5", "0", "1e100"]) {
      const r = record("INSERT", product(TEAM, "x"), { new: productItem("x", 1) });
      (r.dynamodb?.NewImage as Record<string, unknown>).version = { N: bad };
      expect(documentChangeFromStream(r)?.version).toBeUndefined();
    }
  });
});

describe("audienceChangeFromStream", () => {
  it.each([
    ["team metadata", { PK: `TEAM#${TEAM}`, SK: "META" }, TEAM],
    ["a member", { PK: `TEAM#${TEAM}`, SK: "MEMBER#user-1" }, TEAM],
    ["a product", product(TEAM, "x"), undefined],
    ["an invite", { PK: `TEAM#${TEAM}`, SK: "INVITE#i1" }, undefined],
    ["a user's team link", { PK: "USER#user-1", SK: `TEAM#${TEAM}` }, undefined],
    ["the projects index partition", { PK: `TEAM#${TEAM}#PROJECTS`, SK: "META" }, undefined],
    ["a bad team ID", { PK: "TEAM#bad id", SK: "META" }, undefined],
  ])("for %s", (_, k, expected) => {
    expect(audienceChangeFromStream(record("REMOVE", k))).toBe(expected);
  });

  it("ignores records without string keys", () => {
    const r = record("INSERT", { PK: `TEAM#${TEAM}`, SK: "META" });
    expect(audienceChangeFromStream({ ...r, dynamodb: { ...r.dynamodb, Keys: { PK: { S: `TEAM#${TEAM}` }, SK: { N: "1" } } } })).toBeUndefined();
    expect(audienceChangeFromStream({ ...r, dynamodb: undefined })).toBeUndefined();
  });
});

describe("channels", () => {
  it("sends a collection event past the web app's own burst limit (BURST_FETCHES in src/aws/db.js)", () => {
    const db = readFileSync(new URL("../../src/aws/db.js", import.meta.url), "utf8");
    expect(db).toMatch(new RegExp(`\\bBURST_FETCHES = ${COLLECTION_EVENT_AFTER}\\b`));
  });

  it("filters the stream on the document and audience keys the data module uses", () => {
    expect([...DOCUMENT_SK_PREFIXES]).toEqual([prefixes.product, prefixes.project]);
    expect(AUDIENCE_SK).toEqual({ exact: keys.team(TEAM).SK, prefix: prefixes.member });
  });

  it("names a user's channel only for IDs AppSync accepts as a segment", () => {
    expect(userChannel(A1)).toBe(`/users/${A1}`);
    expect(userChannel("user_a")).toBeUndefined();
    expect(userChannel("a".repeat(51))).toBeUndefined();
    expect(userChannel("a".repeat(50))).toBe(`/users/${"a".repeat(50)}`);
    expect(userChannel("-abc")).toBeUndefined();
    expect(userChannel("abc-")).toBeUndefined();
    expect(userFromChannel(`/users/${A1}`)).toBe(A1);
    expect(userFromChannel(42)).toBeUndefined();
  });
});

describe("changeEvent", () => {
  const changeOf = (r: DynamoDBRecord) => {
    const change = documentChangeFromStream(r);
    if (!change) throw new Error("not a document change");
    return change;
  };
  const parse = (s: string) => JSON.parse(s) as ChangeEvent;

  it("names the document, the operation, the version and when it changed", () => {
    const r = record("INSERT", product(TEAM, "k"), { new: productItem("k", 1) });
    expect(parse(changeEvent(r, changeOf(r)))).toEqual({ v: 1, teamId: TEAM, eventId: r.eventID, collection: "products", id: "k", op: "put", version: 1, at: AT * 1000 });
  });

  it("carries no document data, however big or small the document", () => {
    const items = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`item-${i}`, { out: 1, returned: 0, note: "x".repeat(30) }]));
    const records = [
      record("INSERT", product(TEAM, "k"), { new: productItem("k", 1, { name: "Secret supplier", notes: "private" }) }),
      record("MODIFY", projectKey(TEAM, "big"), { old: projectItem("big", 1), new: projectItem("big", 2, { items, client: "Secret client" }) }),
      record("MODIFY", product(TEAM, "k"), { old: productItem("k", 1), new: productItem("k", 1, { stock: 99 }) }),
      record("REMOVE", projectKey(TEAM, "s1"), { old: projectItem("s1", 5, { client: "Secret client" }) }),
    ];
    for (const r of records) {
      const text = changeEvent(r, changeOf(r));
      expect(Object.keys(JSON.parse(text)).every((k) => (CHANGE_EVENT_FIELDS as readonly string[]).includes(k))).toBe(true);
      expect(text).not.toMatch(/Secret|private|Drop cloth|Echo|stock|items|99/);
      expect(Buffer.byteLength(text)).toBeLessThan(500);
    }
  });

  it("sends a delete with the last version", () => {
    const r = record("REMOVE", product(TEAM, "k"), { old: productItem("k", 3) });
    expect(parse(changeEvent(r, changeOf(r)))).toEqual({ v: 1, teamId: TEAM, eventId: r.eventID, collection: "products", id: "k", op: "delete", version: 3, at: AT * 1000 });
  });

  it("leaves out what it doesn't know, and falls back to the sequence number for the ID", () => {
    const r = record("MODIFY", product(TEAM, "z"));
    const { eventID: _, ...noId } = r;
    void _;
    const noTime = { ...noId, dynamodb: { ...noId.dynamodb, ApproximateCreationDateTime: undefined } };
    expect(parse(changeEvent(noTime, changeOf(noTime)))).toEqual({ v: 1, teamId: TEAM, eventId: r.dynamodb?.SequenceNumber, collection: "products", id: "z", op: "put" });
    const bare = { ...noTime, dynamodb: { Keys: noTime.dynamodb.Keys } };
    expect(parse(changeEvent(bare, changeOf(bare))).eventId).toBe("");
  });
});

describe("the stream handler", () => {
  let published: { channel: string; events: ChangeEvent[] }[];
  let counts: Record<string, number>;
  let logs: { level: string; message: string; fields: Record<string, unknown> }[];
  let answer: (channel: string, events: readonly string[]) => Promise<PublishResult>;
  let members: Record<string, readonly string[] | Error>;
  let forgotten: string[];

  function fakeObservability(): Observability {
    const at = (level: string) => (message: string, fields: Record<string, unknown> = {}) => logs.push({ level, message, fields });
    return {
      region: REGION,
      logger: { info: at("info"), warn: at("warn"), error: at("error"), addContext: () => {} } as unknown as Observability["logger"],
      count: (metric, value = 1) => {
        counts[metric] = (counts[metric] ?? 0) + value;
      },
      gauge: () => {},
      flush: () => {},
    };
  }

  const audience: Audience = {
    recipients: async (teamId) => {
      const m = members[teamId] ?? [];
      if (m instanceof Error) throw m;
      return m;
    },
    forget: (teamId) => {
      forgotten.push(teamId);
    },
  };
  const all = (events: readonly string[]): PublishResult => ({ successful: events.map((_, i) => i), failed: [] });
  const publish: Publish = async (channel, events) => {
    const result = await answer(channel, events);
    published.push({ channel, events: events.filter((_, i) => result.successful.includes(i)).map((e) => JSON.parse(e) as ChangeEvent) });
    return result;
  };
  // An event per document, however many: collection events have their own tests below
  const run = (records: DynamoDBRecord[], concurrency?: number) =>
    createPublisherHandler({ publish, audience, obs: fakeObservability(), concurrency, collectionEventAfter: Infinity })({ Records: records });
  const byChannel = () => {
    const out: Record<string, string[]> = {};
    for (const p of published) (out[p.channel] ??= []).push(...p.events.map((e) => `${e.op} ${e.id}`));
    return out;
  };

  beforeEach(() => {
    published = [];
    counts = {};
    logs = [];
    forgotten = [];
    members = { [TEAM]: [A1, A2], [TEAM_B]: [B1] };
    answer = async (_, events) => all(events);
  });

  it("publishes each team's changes to each of its members' channels, in order, and skips everything else", async () => {
    const records = [
      record("INSERT", product(TEAM, "a"), { new: productItem("a", 1) }),
      record("INSERT", { PK: `TEAM#${TEAM}`, SK: "INVITE#i1" }, { new: { teamId: TEAM } }),
      record("MODIFY", projectKey(TEAM_B, "s1"), { old: projectItem("s1", 1), new: projectItem("s1", 2) }),
      record("REMOVE", product(TEAM, "b"), { old: productItem("b", 4) }),
    ];
    expect(await run(records)).toEqual({ batchItemFailures: [] });
    expect(byChannel()).toEqual({ [`/users/${A1}`]: ["put a", "delete b"], [`/users/${A2}`]: ["put a", "delete b"], [`/users/${B1}`]: ["put s1"] });
    expect(published.find((p) => p.channel === `/users/${B1}`)?.events.map((e) => [e.collection, e.eventId])).toEqual([["projects", records[2]?.eventID]]);
    // Each event says which team it's for: a user's channel carries all their teams
    expect(published.find((p) => p.channel === `/users/${B1}`)?.events[0]?.teamId).toBe(TEAM_B);
    expect(published.find((p) => p.channel === `/users/${A1}`)?.events.every((e) => e.teamId === TEAM)).toBe(true);
    expect(counts).toEqual({ LiveUpdates: 3 });
    expect(logs.at(-1)).toMatchObject({ message: "Batch", fields: { records: 4, events: 3, teams: 2, publishes: 3, sent: 3, failed: 0 } });
    expect(logs.at(-1)?.fields.lagMs).toEqual(expect.any(Number));
    expect(forgotten).toEqual([]);
  });

  it("never publishes a team's change to someone who isn't in that team", async () => {
    await run([record("INSERT", product(TEAM_B, "secret"), { new: productItem("secret", 1) })]);
    expect(Object.keys(byChannel())).toEqual([`/users/${B1}`]);
  });

  it("forgets a team's members when the stream shows a membership or billing change, before publishing the batch", async () => {
    const records = [
      record("INSERT", product(TEAM, "a"), { new: productItem("a", 1) }),
      record("REMOVE", { PK: `TEAM#${TEAM}`, SK: `MEMBER#${A2}` }, { old: { role: "viewer" } }),
      record("MODIFY", { PK: `TEAM#${TEAM_B}`, SK: "META" }, { old: { status: "active" }, new: { status: "canceled" } }),
    ];
    const order: string[] = [];
    const tracking: Audience = {
      recipients: async (teamId) => {
        order.push(`read ${teamId}`);
        return audience.recipients(teamId);
      },
      forget: (teamId) => {
        order.push(`forget ${teamId}`);
      },
    };
    await createPublisherHandler({ publish, audience: tracking, obs: fakeObservability() })({ Records: records });
    expect(order).toEqual([`forget ${TEAM}`, `forget ${TEAM_B}`, `read ${TEAM}`]);
  });

  it("publishes nothing for a team with no audience (ended, or no members), and counts it as done", async () => {
    members[TEAM] = [];
    expect(await run([record("INSERT", product(TEAM, "a"), { new: productItem("a", 1) })])).toEqual({ batchItemFailures: [] });
    expect(published).toEqual([]);
    expect(logs.at(-1)).toMatchObject({ message: "Batch", fields: { events: 1, publishes: 0, sent: 1, failed: 0 } });
  });

  it("retries from the team's first event when its members can't be read", async () => {
    members[TEAM] = new Error("DynamoDB down");
    const records = [
      record("INSERT", product(TEAM_B, "b"), { new: productItem("b", 1) }),
      record("INSERT", product(TEAM, "a"), { new: productItem("a", 1) }),
    ];
    expect(await run(records)).toEqual({ batchItemFailures: [{ itemIdentifier: records[1]?.dynamodb?.SequenceNumber }] });
    expect(byChannel()).toEqual({ [`/users/${B1}`]: ["put b"] });
    expect(counts).toEqual({ LiveUpdates: 2, LiveUpdateFailures: 1 });
    expect(logs.find((l) => l.level === "error")).toMatchObject({ message: "Couldn't read the team's members", fields: { teamId: TEAM, error: "DynamoDB down" } });
  });

  it("does nothing, and reports success, for a batch with no documents", async () => {
    expect(await run([record("INSERT", { PK: `TEAM#${TEAM}`, SK: "META" }, { new: { name: "x" } })])).toEqual({ batchItemFailures: [] });
    expect(await run([])).toEqual({ batchItemFailures: [] });
    expect(published).toEqual([]);
    expect(counts).toEqual({});
    expect(logs.at(-1)?.fields.lagMs).toBeUndefined();
  });

  it("sends at most 5 events per request", async () => {
    members[TEAM] = [A1];
    const records = Array.from({ length: 12 }, (_, i) => record("INSERT", product(TEAM, `p${i}`), { new: productItem(`p${i}`, 1) }));
    await run(records);
    expect(published.map((p) => p.events.length)).toEqual([5, 5, 2]);
    expect(published.flatMap((p) => p.events.map((e) => e.id))).toEqual(records.map((_, i) => `p${i}`));
  });

  it("keeps at most `concurrency` publishes in flight across teams and members, besides the batch's first chunk", async () => {
    members = { [TEAM]: Array.from({ length: 7 }, (_, i) => `a${i}`), [TEAM_B]: Array.from({ length: 5 }, (_, i) => `b${i}`) };
    let active = 0;
    let peak = 0;
    let first = 0;
    let firstPeak = 0;
    answer = async (channel, events) => {
      // TEAM_B's record is first in the batch: its chunk goes to all 5 members at once, outside the limit
      const isFirst = channel.startsWith("/users/b");
      if (isFirst) firstPeak = Math.max(firstPeak, ++first);
      else peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (isFirst) first--;
      else active--;
      return all(events);
    };
    const records = [
      record("INSERT", product(TEAM_B, "q"), { new: productItem("q", 1) }),
      ...Array.from({ length: 7 }, (_, i) => record("INSERT", product(TEAM, `p${i}`), { new: productItem(`p${i}`, 1) })),
    ];
    expect(await run(records, 3)).toEqual({ batchItemFailures: [] });
    expect(peak).toBe(3);
    expect(firstPeak).toBe(5);
    // 7 members x 2 chunks, and 5 members x 1
    expect(published).toHaveLength(19);
  });

  it("skips a member whose ID can't be a channel name, with a warning", async () => {
    members[TEAM] = ["user_a", A1];
    await run([record("INSERT", product(TEAM, "x"), { new: productItem("x", 1) })]);
    expect(Object.keys(byChannel())).toEqual([`/users/${A1}`]);
    expect(logs.find((l) => l.level === "warn")?.fields).toEqual({ teamId: TEAM, userId: "user_a" });
  });

  it("publishes the same event again on a retry, so a client can apply it twice", async () => {
    const records = [record("INSERT", product(TEAM, "a"), { new: productItem("a", 1) })];
    await run(records);
    await run(records);
    expect(published[0]?.events).toEqual(published[2]?.events);
  });

  it("reports the earliest record that didn't reach every member, and stops that team there", async () => {
    const records = [
      record("INSERT", product(TEAM_B, "b1"), { new: productItem("b1", 1) }),
      ...Array.from({ length: 6 }, (_, i) => record("INSERT", product(TEAM, `a${i}`), { new: productItem(`a${i}`, 1) })),
    ];
    let calls = 0;
    answer = async (channel, events) => {
      // A2's second request fails; A1's goes through
      if (channel === `/users/${A2}` && ++calls === 2) throw new Error("HTTP 500");
      return all(events);
    };
    const result = await run(records);
    // TEAM's first 5 went out; the 6th (records[6]) didn't reach A2
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: records[6]?.dynamodb?.SequenceNumber }] });
    expect(counts).toEqual({ LiveUpdates: 7, LiveUpdateFailures: 1 });
    expect(logs.find((l) => l.level === "error")).toMatchObject({ message: "Publish failed", fields: { teamId: TEAM, error: "HTTP 500" } });
  });

  it("reports the earliest failure across teams", async () => {
    const records = [
      record("INSERT", product(TEAM, "a"), { new: productItem("a", 1) }),
      record("INSERT", product(TEAM_B, "b"), { new: productItem("b", 1) }),
      record("INSERT", product(TEAM, "c"), { new: productItem("c", 1) }),
    ];
    answer = async () => {
      throw new Error("down");
    };
    const result = await run(records);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: records[0]?.dynamodb?.SequenceNumber }]);
    expect(counts).toEqual({ LiveUpdates: 3, LiveUpdateFailures: 3 });
  });

  it("treats events AppSync refused, or didn't mention, as not sent, taking the earliest across members", async () => {
    const records = Array.from({ length: 3 }, (_, i) => record("INSERT", product(TEAM, `p${i}`), { new: productItem(`p${i}`, 1) }));
    answer = async (channel) =>
      channel === `/users/${A1}` ? { successful: [0], failed: [{ index: 1, code: "BadRequest" }, { index: 2, message: "too big" }] } : { successful: [0, 1], failed: [{ index: 2 }] };
    expect((await run(records)).batchItemFailures).toEqual([{ itemIdentifier: records[1]?.dynamodb?.SequenceNumber }]);
    expect(counts.LiveUpdateFailures).toBe(2);
    expect(logs.find((l) => l.level === "error")?.fields).toEqual({ teamId: TEAM, refused: 2, reasons: "BadRequest,too big" });
    expect(logs.filter((l) => l.level === "error")[1]?.fields.reasons).toBe("unknown");

    members[TEAM] = [A1];
    answer = async () => ({ successful: [1], failed: [] });
    expect((await run(records.slice(0, 2))).batchItemFailures).toEqual([{ itemIdentifier: records[0]?.dynamodb?.SequenceNumber }]);
  });

  it("uses an empty identifier for a record without a sequence number", async () => {
    const r = record("INSERT", product(TEAM, "a"), { new: productItem("a", 1) });
    const bare = { ...r, dynamodb: { ...r.dynamodb, SequenceNumber: undefined } };
    answer = async () => {
      throw new Error("down");
    };
    expect(await run([bare])).toEqual({ batchItemFailures: [{ itemIdentifier: "" }] });
    expect(await createPublisherHandler({ publish, audience, obs: fakeObservability() })({} as never)).toEqual({ batchItemFailures: [] });
  });

  describe("publish budget", () => {
    const products = (team: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => record("INSERT", product(team, `p${from + i}`), { new: productItem(`p${from + i}`, 1) }));
    const handler = (options: { maxPublishes?: number; budgetMs?: number; now?: () => number; concurrency?: number; audience?: Audience }) =>
      createPublisherHandler({ publish, audience: options.audience ?? audience, obs: fakeObservability(), collectionEventAfter: Infinity, ...options });

    it("stops after its most publishes, reports the earliest unfinished record, and doesn't count it as a failure", async () => {
      // 12 changes, 3 chunks, 2 members: 6 publishes; the budget allows 3
      const records = products(TEAM, 12);
      const result = await handler({ maxPublishes: 3, concurrency: 1 })({ Records: records });
      // The second chunk reached A1 but not A2, so it goes again from its first record
      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: records[5]?.dynamodb?.SequenceNumber }] });
      expect(published).toHaveLength(3);
      expect(counts).toEqual({ LiveUpdates: 12, LiveUpdatesDeferred: 7 });
      expect(logs.find((l) => l.level === "warn")).toMatchObject({ message: expect.stringContaining("budget"), fields: { publishes: 3, deferred: 7, teams: 1 } });
      expect(logs.at(-1)).toMatchObject({ message: "Batch", fields: { events: 12, publishes: 3, sent: 5, failed: 0, deferred: 7 } });
      expect(logs.some((l) => l.level === "error")).toBe(false);

      // Lambda's next invocation starts there, and finishes
      published = [];
      expect(await handler({ maxPublishes: 3 * 2 })({ Records: records.slice(5) })).toEqual({ batchItemFailures: [] });
      expect(byChannel()).toEqual({ [`/users/${A1}`]: records.slice(5).map((_, i) => `put p${5 + i}`), [`/users/${A2}`]: records.slice(5).map((_, i) => `put p${5 + i}`) });
    });

    it("stops starting requests once its time is up, when AppSync is slow", async () => {
      let clock = 0;
      answer = async (_, events) => {
        clock += 600;
        return all(events);
      };
      members[TEAM] = [A1];
      const records = products(TEAM, 15);
      // Each request takes 600 ms, and requests may start for 1 second: two of the three go out
      const result = await handler({ budgetMs: 1_000, now: () => clock, concurrency: 1 })({ Records: records });
      expect(published.map((p) => p.events.length)).toEqual([EVENTS_PER_PUBLISH, EVENTS_PER_PUBLISH]);
      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: records[2 * EVENTS_PER_PUBLISH]?.dynamodb?.SequenceNumber }] });
      expect(counts.LiveUpdateFailures).toBeUndefined();
    });

    it("counts a real failure as a failure even when the budget also ran out", async () => {
      const records = products(TEAM, 6);
      answer = async (channel, events) => {
        if (channel === `/users/${A1}`) throw new Error("HTTP 500");
        return all(events);
      };
      const result = await handler({ maxPublishes: 1, concurrency: 1 })({ Records: records });
      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: records[0]?.dynamodb?.SequenceNumber }] });
      expect(counts.LiveUpdateFailures).toBe(6);
    });

    it("spends the budget on the earliest records first, so every invocation moves the shard on", async () => {
      // TEAM_C's record is first in the batch, so it goes outside the budget and the limit.
      // TEAM_B's members are read first and queue first, but TEAM's record is earlier in the batch
      members[TEAM_C] = ["c0"];
      members[TEAM_B] = Array.from({ length: 5 }, (_, i) => `b${i}`);
      const slowTeam: Audience = {
        recipients: async (teamId) => {
          if (teamId === TEAM) await new Promise((resolve) => setTimeout(resolve, 5));
          return audience.recipients(teamId);
        },
        forget: () => {},
      };
      let release!: () => void;
      const first = new Promise<void>((resolve) => (release = resolve));
      answer = async (channel, events) => {
        // Hold the first request until TEAM has queued behind it
        if (channel === "/users/b0") await first;
        return all(events);
      };
      const records = [...products(TEAM_C, 1), ...products(TEAM, 1, 1), ...products(TEAM_B, 1, 2)];
      const running = handler({ maxPublishes: 4, concurrency: 1, audience: slowTeam })({ Records: records });
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      const result = await running;
      // c0 went at once; b0 had the slot; then both of TEAM's members, ahead of TEAM_B's other four; then the budget ran out
      expect(published.map((p) => p.channel)).toEqual(["/users/c0", "/users/b0", `/users/${A1}`, `/users/${A2}`]);
      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: records[2]?.dynamodb?.SequenceNumber }] });
    });

    it("always finishes the batch's first chunk, even for a team at the member cap when AppSync is slow", async () => {
      // PR #93's worry: each request near its timeout, so the budget runs out before a big team's chunk reaches everyone,
      // and every retry would stop at the same record until the retries ran out
      let clock = 0;
      answer = async (_, events) => {
        clock += 600;
        return all(events);
      };
      members[TEAM] = Array.from({ length: MEMBERS_PER_TEAM }, (_, i) => `m${i}`);
      const records = products(TEAM, 10);
      const result = await handler({ budgetMs: 1_000, now: () => clock, concurrency: 1 })({ Records: records });
      // The first 5 reached all 100 members; the next 5 wait for the next invocation
      expect(published).toHaveLength(MEMBERS_PER_TEAM);
      expect(published.every((p) => p.events.length === EVENTS_PER_PUBLISH)).toBe(true);
      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: records[EVENTS_PER_PUBLISH]?.dynamodb?.SequenceNumber }] });
      expect(counts).toEqual({ LiveUpdates: 10, LiveUpdatesDeferred: 5 });
      expect(logs.at(-1)).toMatchObject({ message: "Batch", fields: { publishes: MEMBERS_PER_TEAM, sent: 5, failed: 0, deferred: 5 } });
    });

    it("has enough retry attempts for budget stops alone to drain a full batch", () => {
      expect(STREAM_RETRY_ATTEMPTS).toBeGreaterThanOrEqual(STREAM_BATCH_SIZE);
    });

    it("fits a full batch of changes for teams at the member cap, inside the function's timeout", async () => {
      expect(PUBLISHES_PER_INVOCATION).toBeGreaterThanOrEqual(STREAM_BATCH_SIZE * MEMBERS_PER_TEAM);
      expect(PUBLISH_BUDGET_MS + PUBLISH_TIMEOUT_MS).toBeLessThanOrEqual(CONSUMER_TIMEOUT_SECONDS * 1000 - 1_000);
      // The worst case: every record from a different team at the cap
      const records = Array.from({ length: STREAM_BATCH_SIZE }, (_, i) => {
        const team = `0000${String(i).padStart(4, "0")}-5a61-4c3e-9d1f-0b6f2f7c1a11`;
        members[team] = Array.from({ length: MEMBERS_PER_TEAM }, (_, j) => `m${i}-${j}`);
        return record("INSERT", product(team, "x"), { new: productItem("x", 1) });
      });
      expect(await handler({})({ Records: records })).toEqual({ batchItemFailures: [] });
      expect(published).toHaveLength(STREAM_BATCH_SIZE * MEMBERS_PER_TEAM);
    });
  });

  describe("collection events", () => {
    const products = (team: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => record("INSERT", product(team, `p${from + i}`), { new: productItem(`p${from + i}`, 1, { name: "Secret supplier" }) }));
    const handler = (options: { collectionEventAfter?: number; maxPublishes?: number; concurrency?: number } = {}) =>
      createPublisherHandler({ publish, audience, obs: fakeObservability(), ...options });
    const events = (channel: string) => published.filter((p) => p.channel === channel).flatMap((p) => p.events as unknown as Record<string, unknown>[]);

    it("publishes one 'list' event for more than COLLECTION_EVENT_AFTER changes to one team's collection, naming no document", async () => {
      const imported = products(TEAM, COLLECTION_EVENT_AFTER + 2);
      const records = [
        ...imported.slice(0, 3),
        record("MODIFY", projectKey(TEAM, "s1"), { old: projectItem("s1", 1), new: projectItem("s1", 2) }),
        ...imported.slice(3),
        record("INSERT", product(TEAM_B, "b"), { new: productItem("b", 1) }),
      ];
      expect(await handler()({ Records: records })).toEqual({ batchItemFailures: [] });
      const list = events(`/users/${A1}`);
      // In the first import record's place, ahead of the project change that came after it
      expect(list).toEqual([
        { v: 2, teamId: TEAM, eventId: `${imported[0]?.eventID}~${imported.at(-1)?.eventID}`, collection: "products", op: "list", changes: imported.length, at: AT * 1000 },
        { v: 1, teamId: TEAM, eventId: records[3]?.eventID, collection: "projects", id: "s1", op: "put", version: 2, at: AT * 1000 },
      ]);
      expect(events(`/users/${A2}`)).toEqual(list);
      // Another team's single change is a document event as ever
      expect(events(`/users/${B1}`)).toMatchObject([{ v: 1, id: "b", op: "put" }]);
      // One request per member for the team, not three
      expect(published).toHaveLength(3);
      const text = JSON.stringify(list[0]);
      expect(Object.keys(list[0] as object).every((k) => (COLLECTION_EVENT_FIELDS as readonly string[]).includes(k))).toBe(true);
      expect(text).not.toMatch(/Secret|"p\d|id"/);
      expect(counts).toEqual({ LiveUpdates: records.length });
      expect(logs.at(-1)).toMatchObject({ message: "Batch", fields: { events: records.length, collectionEvents: 1, publishes: 3, sent: records.length, failed: 0, deferred: 0 } });
    });

    it("sends document events for COLLECTION_EVENT_AFTER changes or fewer, counting each collection on its own", async () => {
      members[TEAM] = [A1];
      const records = [
        ...products(TEAM, COLLECTION_EVENT_AFTER),
        ...Array.from({ length: COLLECTION_EVENT_AFTER }, (_, i) => record("INSERT", projectKey(TEAM, `s${i}`), { new: projectItem(`s${i}`, 1) })),
      ];
      await handler()({ Records: records });
      const list = events(`/users/${A1}`);
      // Each collection counted on its own
      expect(list).toHaveLength(2 * COLLECTION_EVENT_AFTER);
      expect(list.every((e) => e.v === 1)).toBe(true);
      expect(logs.at(-1)?.fields.collectionEvents).toBe(0);
    });

    it("is the same event on a retry of the same records, and a new one when the retry starts part way", async () => {
      members[TEAM] = [A1];
      const records = products(TEAM, 4);
      await handler({ collectionEventAfter: 2 })({ Records: records });
      await handler({ collectionEventAfter: 2 })({ Records: records });
      await handler({ collectionEventAfter: 2 })({ Records: records.slice(1) });
      const ids = events(`/users/${A1}`).map((e) => e.eventId);
      expect(ids[0]).toBe(ids[1]);
      expect(ids[2]).not.toBe(ids[0]);
      // Without stream times, it has none either
      published = [];
      const bare = records.map((r) => ({ ...r, dynamodb: { ...r.dynamodb, ApproximateCreationDateTime: undefined } }));
      await handler({ collectionEventAfter: 2 })({ Records: bare });
      expect(events(`/users/${A1}`)[0]).not.toHaveProperty("at");
    });

    it("retries from its first record when it doesn't reach every member, counting every change it stands for", async () => {
      const records = [record("INSERT", projectKey(TEAM, "s1"), { new: projectItem("s1", 1) }), ...products(TEAM, 5)];
      // Both events are in one chunk: the project reached A2, the collection event didn't
      answer = async (channel, evs) => (channel === `/users/${A2}` ? { successful: [0], failed: [{ index: 1, code: "BadRequest" }] } : all(evs));
      const result = await handler({ collectionEventAfter: 3 })({ Records: records });
      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: records[1]?.dynamodb?.SequenceNumber }] });
      expect(counts).toEqual({ LiveUpdates: 6, LiveUpdateFailures: 5 });
      expect(logs.at(-1)).toMatchObject({ message: "Batch", fields: { sent: 1, failed: 5 } });
    });

    it("goes as the batch's first chunk when it holds the batch's first record, so the shard moves on", async () => {
      let clock = 0;
      answer = async (_, evs) => {
        clock += 600;
        return all(evs);
      };
      members[TEAM] = Array.from({ length: MEMBERS_PER_TEAM }, (_, i) => `m${i}`);
      const records = [...products(TEAM, STREAM_BATCH_SIZE - 1), record("INSERT", projectKey(TEAM, "s1"), { new: projectItem("s1", 1) })];
      const result = await createPublisherHandler({ publish, audience, obs: fakeObservability(), budgetMs: 1_000, now: () => clock, concurrency: 1 })({ Records: records });
      // The collection event and the project were one chunk, which went to all 100 members outside the budget
      expect(result).toEqual({ batchItemFailures: [] });
      expect(published).toHaveLength(MEMBERS_PER_TEAM);
      expect(counts).toEqual({ LiveUpdates: STREAM_BATCH_SIZE });
    });

    it("defers the changes it stands for when the budget stops before it", async () => {
      members[TEAM_C] = ["c0"];
      const records = [record("INSERT", product(TEAM_C, "c"), { new: productItem("c", 1) }), ...products(TEAM, 4, 1)];
      const result = await handler({ collectionEventAfter: 2, maxPublishes: 1, concurrency: 1 })({ Records: records });
      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: records[1]?.dynamodb?.SequenceNumber }] });
      expect(counts).toEqual({ LiveUpdates: 5, LiveUpdatesDeferred: 4 });
    });
  });

  describe("members read before each chunk", () => {
    const products = (n: number) => Array.from({ length: n }, (_, i) => record("INSERT", product(TEAM, `p${i}`), { new: productItem(`p${i}`, 1) }));

    it("stops publishing to a member the Audience drops part way through a team's events", async () => {
      const reads: string[] = [];
      let calls = 0;
      const shrinking: Audience = {
        recipients: async (teamId) => {
          reads.push(teamId);
          // A2 is removed while the first chunk goes out, and the cache has moved on
          return ++calls === 1 ? [A1, A2, "bad_id"] : [A1, "bad_id"];
        },
        forget: () => {},
      };
      const records = products(12);
      const result = await createPublisherHandler({ publish, audience: shrinking, obs: fakeObservability(), collectionEventAfter: Infinity })({ Records: records });
      expect(result).toEqual({ batchItemFailures: [] });
      expect(reads).toEqual([TEAM, TEAM, TEAM]);
      expect(byChannel()).toEqual({ [`/users/${A1}`]: records.map((_, i) => `put p${i}`), [`/users/${A2}`]: records.slice(0, 5).map((_, i) => `put p${i}`) });
      // A bad user ID is warned about once per team, not per chunk
      expect(logs.filter((l) => l.level === "warn")).toHaveLength(1);
    });

    it("retries from the chunk whose members couldn't be read, keeping what went out before it", async () => {
      let calls = 0;
      const failing: Audience = {
        recipients: async () => {
          if (++calls === 2) throw new Error("DynamoDB down");
          return [A1];
        },
        forget: () => {},
      };
      const records = products(7);
      const result = await createPublisherHandler({ publish, audience: failing, obs: fakeObservability(), collectionEventAfter: Infinity })({ Records: records });
      expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: records[5]?.dynamodb?.SequenceNumber }] });
      expect(counts).toEqual({ LiveUpdates: 7, LiveUpdateFailures: 2 });
      expect(logs.at(-1)).toMatchObject({ message: "Batch", fields: { sent: 5, failed: 2 } });
    });

    it("doesn't read the members for a chunk once the budget is spent, except the batch's first", async () => {
      members[TEAM_C] = ["c0"];
      const reads: string[] = [];
      const counting: Audience = {
        recipients: async (teamId) => {
          reads.push(teamId);
          return audience.recipients(teamId);
        },
        forget: () => {},
      };
      members[TEAM] = [A1];
      // TEAM_C's record is first and goes outside the budget (counting 1 of 2); TEAM's first chunk takes the other
      const records = [record("INSERT", product(TEAM_C, "c"), { new: productItem("c", 1) }), ...products(12).slice(1)];
      const result = await createPublisherHandler({ publish, audience: counting, obs: fakeObservability(), collectionEventAfter: Infinity, maxPublishes: 2, concurrency: 1 })({
        Records: records,
      });
      expect(result.batchItemFailures).toHaveLength(1);
      expect(counts.LiveUpdatesDeferred).toBeGreaterThan(0);
      // One read per team for the chunks that went; none for TEAM's second chunk, after the budget ran out
      expect(byChannel()[`/users/${A1}`]).toHaveLength(EVENTS_PER_PUBLISH);
      expect(reads.filter((t) => t === TEAM_C)).toEqual([TEAM_C]);
      expect(reads.filter((t) => t === TEAM)).toEqual([TEAM]);
    });

    it("keeps a read and the first chunk's publish inside the function's timeout", () => {
      expect(AUDIENCE_READ_TIMEOUT_MS + PUBLISH_TIMEOUT_MS).toBeLessThanOrEqual(CONSUMER_TIMEOUT_SECONDS * 1000 - 1_000);
      // A read that starts just before the budget ends publishes nothing after it
      expect(PUBLISH_BUDGET_MS + Math.max(AUDIENCE_READ_TIMEOUT_MS, PUBLISH_TIMEOUT_MS)).toBeLessThanOrEqual(CONSUMER_TIMEOUT_SECONDS * 1000 - 1_000);
    });
  });
});

describe("the consumer's logs", () => {
  // Stream images carry whole items: a MEMBER item's email and name, a project's client and lines.
  // The consumer may read them to find the change, and must never write them out.
  const EMAIL = "crew.member@example.com";
  let out: string[];
  beforeEach(() => {
    out = [];
    const capture = (chunk: string | Uint8Array) => {
      out.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(capture);
    vi.spyOn(process.stderr, "write").mockImplementation(capture);
    vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "info").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...a) => void out.push(a.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
  });
  afterEach(() => vi.restoreAllMocks());

  const records = () => [
    record("INSERT", { PK: `TEAM#${TEAM}`, SK: `MEMBER#${A2}` }, { new: { userId: A2, role: "viewer", email: EMAIL, name: "Pat Secretname" } }),
    record("MODIFY", projectKey(TEAM, "s1"), { old: projectItem("s1", 1, { client: "Secret client" }), new: projectItem("s1", 2, { client: "Secret client" }) }),
    ...Array.from({ length: COLLECTION_EVENT_AFTER + 1 }, (_, i) => record("INSERT", product(TEAM, `k${i}`), { new: productItem(`k${i}`, 1, { name: "Secret supplier" }) })),
    record("REMOVE", product(TEAM_B, "gone"), { old: productItem("gone", 3, { name: "Secret supplier" }) }),
  ];
  const context = { awsRequestId: "req-1", functionName: "supply-checkout-prod-live-updates" } as never;

  it("never writes a stream record, an image or an event, whatever happens", async () => {
    const obs = createObservability({ service: "live-updates", env: { AWS_REGION: REGION, SUPPLY_CHECKOUT_ENV: "prod" } });
    const cases: { publish: Publish; audience: Audience; maxPublishes?: number }[] = [
      // Everything goes out
      { publish: async (_, e) => ({ successful: e.map((_, i) => i), failed: [] }), audience: { recipients: async () => [A1, A2, "bad_id"], forget: () => {} } },
      // AppSync refuses, or the request fails
      { publish: async () => ({ successful: [], failed: [{ index: 0, code: "BadRequest", message: "no" }] }), audience: { recipients: async () => [A1], forget: () => {} } },
      { publish: async () => Promise.reject(new Error("HTTP 500")), audience: { recipients: async () => [A1], forget: () => {} } },
      // The members can't be read, or the budget runs out
      { publish: async (_, e) => ({ successful: e.map((_, i) => i), failed: [] }), audience: { recipients: async () => Promise.reject(new Error("timed out")), forget: () => {} } },
      { publish: async (_, e) => ({ successful: e.map((_, i) => i), failed: [] }), audience: { recipients: async () => [A1], forget: () => {} }, maxPublishes: 0 },
      // Something throws out of the handler
      { publish: async (_, e) => ({ successful: e.map((_, i) => i), failed: [] }), audience: { recipients: async () => [A1], forget: () => { throw new Error("cache broke"); } } },
    ];
    for (const c of cases) {
      const handler = withObservability(obs, createPublisherHandler({ ...c, obs }));
      await handler({ Records: records() }, context).catch(() => undefined);
    }
    const text = out.join("\n");
    // It did log (so the test would see a leak)
    expect(text).toContain('"Batch"');
    expect(text).toContain("Unhandled error");
    for (const leak of [EMAIL, "Secretname", "Secret client", "Secret supplier", "NewImage", "OldImage", "SequenceNumber", '"eventID"', '"op":', "event-"]) {
      expect(text).not.toContain(leak);
    }
  });
});
