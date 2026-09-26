// The DynamoDB stream consumer: which records become change events, what the
// events look like, and how failed publishes are retried.

import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import { documentChangeFromStream } from "../src/data/index.js";
import { prefixes } from "../src/data/keys.js";
import type { Observability } from "../src/observability/index.js";
import { CHANGE_EVENT_FIELDS, type ChangeEvent, DOCUMENT_SK_PREFIXES, teamChannel, teamFromChannel } from "../src/realtime/channels.js";
import type { Publish, PublishResult } from "../src/realtime/events-client.js";
import { changeEvent, createPublisherHandler } from "../src/realtime/publisher-handler.js";
import { REGION } from "./helpers.js";

const TEAM = "7d3b8a52-5a61-4c3e-9d1f-0b6f2f7c1a11";
const TEAM_B = "0f0e8a52-5a61-4c3e-9d1f-0b6f2f7c1a22";
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
const sheet = (team: string, id: string) => ({ PK: `TEAM#${team}`, SK: `SHEET#${id}` });
const productItem = (key: string, version: number, fields: Item = {}) => ({ type: "product", key, version, name: "Drop cloth", stock: 4, ...fields });
const sheetItem = (id: string, version: number, fields: Item = {}) => ({
  type: "sheet",
  id,
  version,
  GSI1PK: `TEAM#${TEAM}#SHEETS`,
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

  it("maps a sheet update", () => {
    const change = documentChangeFromStream(record("MODIFY", sheet(TEAM, "s1"), { old: sheetItem("s1", 3), new: sheetItem("s1", 4, { client: "Foxtrot" }) }));
    expect(change).toEqual({ teamId: TEAM, collection: "sheets", id: "s1", op: "put", version: 4 });
  });

  it("maps a stock ADD, which keeps the version, to a put with the same version", () => {
    const change = documentChangeFromStream(
      record("MODIFY", product(TEAM, "tape"), { old: productItem("tape", 7, { stock: 10 }), new: productItem("tape", 7, { stock: 8 }) }),
    );
    expect(change).toEqual({ teamId: TEAM, collection: "products", id: "tape", op: "put", version: 7 });
  });

  it("maps a delete to the deleted document's last version", () => {
    expect(documentChangeFromStream(record("REMOVE", sheet(TEAM, "s1"), { old: sheetItem("s1", 5) }))).toEqual({
      teamId: TEAM,
      collection: "sheets",
      id: "s1",
      op: "delete",
      version: 5,
    });
    expect(documentChangeFromStream(record("REMOVE", sheet(TEAM, "s1")))).toMatchObject({ op: "delete", version: undefined });
  });

  it("keeps product keys with characters a sheet ID can't have", () => {
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
    ["a product under a partition with extra parts", { PK: `TEAM#${TEAM}#SHEETS`, SK: "PRODUCT#x" }],
    ["a bad team ID", { PK: "TEAM#bad id", SK: "PRODUCT#x" }],
    ["a bad sheet ID", { PK: `TEAM#${TEAM}`, SK: "SHEET#a#b" }],
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

describe("channels", () => {
  it("filters the stream on the document prefixes the data module uses", () => {
    expect([...DOCUMENT_SK_PREFIXES]).toEqual([prefixes.product, prefixes.sheet]);
  });

  it("names a team's channel only for IDs AppSync accepts as a segment", () => {
    expect(teamChannel(TEAM)).toBe(`/teams/${TEAM}`);
    expect(teamChannel("team_a")).toBeUndefined();
    expect(teamChannel("a".repeat(51))).toBeUndefined();
    expect(teamChannel("a".repeat(50))).toBe(`/teams/${"a".repeat(50)}`);
    expect(teamChannel("-abc")).toBeUndefined();
    expect(teamChannel("abc-")).toBeUndefined();
    expect(teamFromChannel(`/teams/${TEAM}`)).toBe(TEAM);
    expect(teamFromChannel(42)).toBeUndefined();
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
    expect(parse(changeEvent(r, changeOf(r)))).toEqual({ v: 1, eventId: r.eventID, collection: "products", id: "k", op: "put", version: 1, at: AT * 1000 });
  });

  it("carries no document data, however big or small the document", () => {
    const items = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [`item-${i}`, { out: 1, returned: 0, note: "x".repeat(30) }]));
    const records = [
      record("INSERT", product(TEAM, "k"), { new: productItem("k", 1, { name: "Secret supplier", notes: "private" }) }),
      record("MODIFY", sheet(TEAM, "big"), { old: sheetItem("big", 1), new: sheetItem("big", 2, { items, client: "Secret client" }) }),
      record("MODIFY", product(TEAM, "k"), { old: productItem("k", 1), new: productItem("k", 1, { stock: 99 }) }),
      record("REMOVE", sheet(TEAM, "s1"), { old: sheetItem("s1", 5, { client: "Secret client" }) }),
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
    expect(parse(changeEvent(r, changeOf(r)))).toEqual({ v: 1, eventId: r.eventID, collection: "products", id: "k", op: "delete", version: 3, at: AT * 1000 });
  });

  it("leaves out what it doesn't know, and falls back to the sequence number for the ID", () => {
    const r = record("MODIFY", product(TEAM, "z"));
    const { eventID: _, ...noId } = r;
    void _;
    const noTime = { ...noId, dynamodb: { ...noId.dynamodb, ApproximateCreationDateTime: undefined } };
    expect(parse(changeEvent(noTime, changeOf(noTime)))).toEqual({ v: 1, eventId: r.dynamodb?.SequenceNumber, collection: "products", id: "z", op: "put" });
    const bare = { ...noTime, dynamodb: { Keys: noTime.dynamodb.Keys } };
    expect(parse(changeEvent(bare, changeOf(bare))).eventId).toBe("");
  });
});

describe("the stream handler", () => {
  let published: { channel: string; events: ChangeEvent[] }[];
  let counts: Record<string, number>;
  let logs: { level: string; message: string; fields: Record<string, unknown> }[];
  let answer: (channel: string, events: readonly string[]) => Promise<PublishResult>;

  function fakeObservability(): Observability {
    const at = (level: string) => (message: string, fields: Record<string, unknown> = {}) => logs.push({ level, message, fields });
    return {
      region: REGION,
      logger: { info: at("info"), warn: at("warn"), error: at("error"), addContext: () => {} } as unknown as Observability["logger"],
      count: (metric, value = 1) => {
        counts[metric] = (counts[metric] ?? 0) + value;
      },
      flush: () => {},
    };
  }

  const all = (events: readonly string[]): PublishResult => ({ successful: events.map((_, i) => i), failed: [] });
  const publish: Publish = async (channel, events) => {
    const result = await answer(channel, events);
    published.push({ channel, events: events.filter((_, i) => result.successful.includes(i)).map((e) => JSON.parse(e) as ChangeEvent) });
    return result;
  };
  const run = (records: DynamoDBRecord[]) => createPublisherHandler({ publish, obs: fakeObservability() })({ Records: records });

  beforeEach(() => {
    published = [];
    counts = {};
    logs = [];
    answer = async (_, events) => all(events);
  });

  it("publishes each team's changes to its own channel, in order, and skips everything else", async () => {
    const records = [
      record("INSERT", product(TEAM, "a"), { new: productItem("a", 1) }),
      record("INSERT", { PK: `TEAM#${TEAM}`, SK: "MEMBER#user-2" }, { new: { role: "viewer" } }),
      record("MODIFY", sheet(TEAM_B, "s1"), { old: sheetItem("s1", 1), new: sheetItem("s1", 2) }),
      record("REMOVE", product(TEAM, "b"), { old: productItem("b", 4) }),
      record("INSERT", { PK: `TEAM#${TEAM}`, SK: "INVITE#i1" }, { new: { teamId: TEAM } }),
    ];
    expect(await run(records)).toEqual({ batchItemFailures: [] });
    const byChannel = Object.fromEntries(published.map((p) => [p.channel, p.events.map((e) => `${e.op} ${e.id}`)]));
    expect(byChannel).toEqual({ [`/teams/${TEAM}`]: ["put a", "delete b"], [`/teams/${TEAM_B}`]: ["put s1"] });
    expect(counts).toEqual({ LiveUpdates: 3 });
    expect(logs.at(-1)).toMatchObject({ message: "Batch", fields: { records: 5, events: 3, teams: 2, sent: 3, failed: 0 } });
    expect(logs.at(-1)?.fields.lagMs).toEqual(expect.any(Number));
  });

  it("does nothing, and reports success, for a batch with no documents", async () => {
    expect(await run([record("INSERT", { PK: `TEAM#${TEAM}`, SK: "META" }, { new: { name: "x" } })])).toEqual({ batchItemFailures: [] });
    expect(await run([])).toEqual({ batchItemFailures: [] });
    expect(published).toEqual([]);
    expect(counts).toEqual({});
    expect(logs.at(-1)?.fields.lagMs).toBeUndefined();
  });

  it("sends at most 5 events per request", async () => {
    const records = Array.from({ length: 12 }, (_, i) => record("INSERT", product(TEAM, `p${i}`), { new: productItem(`p${i}`, 1) }));
    await run(records);
    expect(published.map((p) => p.events.length)).toEqual([5, 5, 2]);
    expect(published.flatMap((p) => p.events.map((e) => e.id))).toEqual(records.map((_, i) => `p${i}`));
  });

  it("skips a team whose ID can't be a channel name, with a warning", async () => {
    await run([record("INSERT", product("team_a", "x"), { new: productItem("x", 1) })]);
    expect(published).toEqual([]);
    expect(logs.find((l) => l.level === "warn")?.fields).toEqual({ teamId: "team_a" });
  });

  it("publishes the same event again on a retry, so a client can apply it twice", async () => {
    const records = [record("INSERT", product(TEAM, "a"), { new: productItem("a", 1) })];
    await run(records);
    await run(records);
    expect(published[0]?.events).toEqual(published[1]?.events);
  });

  it("reports the earliest record that didn't go out when a request fails, and stops that team there", async () => {
    const records = [
      record("INSERT", product(TEAM_B, "b1"), { new: productItem("b1", 1) }),
      ...Array.from({ length: 6 }, (_, i) => record("INSERT", product(TEAM, `a${i}`), { new: productItem(`a${i}`, 1) })),
    ];
    let calls = 0;
    answer = async (channel, events) => {
      if (channel === `/teams/${TEAM}` && ++calls === 2) throw new Error("HTTP 500");
      return all(events);
    };
    const result = await run(records);
    // TEAM's first 5 went out; the 6th (records[6]) failed
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

  it("treats events AppSync refused, or didn't mention, as not sent", async () => {
    const records = Array.from({ length: 3 }, (_, i) => record("INSERT", product(TEAM, `p${i}`), { new: productItem(`p${i}`, 1) }));
    answer = async () => ({ successful: [0], failed: [{ index: 1, code: "BadRequest" }, { index: 2, message: "too big" }] });
    expect((await run(records)).batchItemFailures).toEqual([{ itemIdentifier: records[1]?.dynamodb?.SequenceNumber }]);
    expect(counts.LiveUpdateFailures).toBe(2);
    expect(logs.find((l) => l.level === "error")?.fields).toEqual({ teamId: TEAM, refused: 2, reasons: "BadRequest,too big" });

    counts = {};
    answer = async () => ({ successful: [], failed: [{ index: 0 }] });
    expect((await run(records.slice(0, 1))).batchItemFailures).toHaveLength(1);
    expect(logs.at(-2)?.fields.reasons).toBe("unknown");

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
    expect(await createPublisherHandler({ publish, obs: fakeObservability() })({} as never)).toEqual({ batchItemFailures: [] });
  });
});
