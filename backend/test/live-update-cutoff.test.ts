// The live-update cut-off (supply-checkout-4zn, ADR 0016), end to end against
// DynamoDB Local: a member removed from a team, or every member of a team
// whose subscription is canceled, gets no more change notices within about a
// minute. The real stream consumer, audience cache and data module run
// against the real table; only AppSync (the publish call), the stream and the
// clock are stand-ins.
//
// Two cases for each: the consumer sees the membership or billing write in the
// stream (it forgets the team's members and the cut-off is immediate), and the
// worst case, where it doesn't (the cache expires within AUDIENCE_TTL_MS).
// CI runs DynamoDB Local; without DYNAMODB_ENDPOINT these are skipped locally.

import { marshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBRecord } from "aws-lambda";
import { beforeEach, describe, expect, it } from "vitest";
import {
  acceptInvite,
  authorizeTeam,
  createInvite,
  createTeam,
  ForbiddenError,
  getTeam,
  linkStripeCustomer,
  removeMember,
  teamContextForStripeCustomer,
  type TeamContext,
  updateTeam,
} from "../src/data/index.js";
import type { Observability } from "../src/observability/index.js";
import { createAudience } from "../src/realtime/audience.js";
import { AUDIENCE_TTL_MS, type ChangeEvent } from "../src/realtime/channels.js";
import type { Publish } from "../src/realtime/events-client.js";
import { createPublisherHandler } from "../src/realtime/publisher-handler.js";
import { endpoint, newUser, REGION, useTable } from "./helpers.js";

/** About a minute: the acceptance criterion. */
const CUT_OFF_MS = 60_000;

describe.skipIf(!endpoint)("cutting off live updates", () => {
  const table = useTable();
  let clock: number;
  let delivered: { channel: string; event: ChangeEvent }[];
  let seq: number;
  let consumer: ReturnType<typeof createPublisherHandler>;
  let teamId: string;
  let owner: TeamContext;
  let ownerId: string;
  let crewId: string;

  const quiet = {
    region: REGION,
    logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} } as unknown as Observability["logger"],
    count: () => {},
    gauge: () => {},
    flush: () => {},
  } as Observability;
  const publish: Publish = async (channel, events) => {
    for (const e of events) delivered.push({ channel, event: JSON.parse(e) as ChangeEvent });
    return { successful: events.map((_, i) => i), failed: [] };
  };

  /** A stream record for a write to `SK` in the team's partition. */
  function record(sk: string, eventName: "INSERT" | "MODIFY" | "REMOVE" = "MODIFY"): DynamoDBRecord {
    seq++;
    const keys = { PK: `TEAM#${teamId}`, SK: sk };
    return {
      eventID: `e${seq}`,
      eventName,
      dynamodb: {
        Keys: marshall(keys) as never,
        SequenceNumber: String(seq),
        ApproximateCreationDateTime: Math.floor(clock / 1000),
        ...(eventName === "REMOVE" ? {} : { NewImage: marshall({ ...keys, version: seq }) as never }),
      },
    };
  }
  const productWrite = () => record(`PRODUCT#p${seq + 1}`);
  /** Who got notices from the batch. */
  async function deliver(records: DynamoDBRecord[]): Promise<string[]> {
    delivered = [];
    expect(await consumer({ Records: records })).toEqual({ batchItemFailures: [] });
    return [...new Set(delivered.map((d) => d.channel))].sort();
  }
  const channel = (userId: string) => `/users/${userId}`;

  beforeEach(async () => {
    const db = table.db;
    clock = Date.parse("2026-09-26T12:00:00Z");
    seq = 0;
    consumer = createPublisherHandler({ publish, audience: createAudience({ db, now: () => clock }), obs: quiet });
    ownerId = newUser();
    crewId = newUser();
    const created = await createTeam(db, { userId: ownerId, email: "owner@example.com" }, { name: "Echo Cleaning" });
    teamId = created.team.teamId;
    owner = created.context;
    const { invite, token } = await createInvite(db, owner, { email: "crew@example.com", role: "contributor" });
    await acceptInvite(db, { userId: crewId, verifiedEmail: "crew@example.com" }, invite, token);
  });

  it("reaches every member while they're in the team, and each event names the team", async () => {
    expect(await deliver([productWrite()])).toEqual([channel(crewId), channel(ownerId)].sort());
    expect(delivered.every((d) => d.event.teamId === teamId)).toBe(true);
  });

  describe("a removed member", () => {
    it("gets nothing after the removal once the consumer sees it in the stream", async () => {
      await deliver([productWrite()]);
      await removeMember(table.db, owner, crewId);
      // The MEMBER item's REMOVE comes through the stream before later writes
      expect(await deliver([record(`MEMBER#${crewId}`, "REMOVE"), productWrite()])).toEqual([channel(ownerId)]);
      clock += 1000;
      expect(await deliver([productWrite()])).toEqual([channel(ownerId)]);
      // And the data API refuses them, so a notice already on its way can't be turned into contents
      await expect(authorizeTeam(table.db, crewId, teamId)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("gets nothing within about a minute even if the consumer never sees the removal", async () => {
      await deliver([productWrite()]);
      await removeMember(table.db, owner, crewId);
      // Worst case: another container, or a stream record it missed, so its cache is stale
      clock += AUDIENCE_TTL_MS - 1;
      expect(await deliver([productWrite()])).toContain(channel(crewId));
      clock += 1;
      expect(await deliver([productWrite()])).toEqual([channel(ownerId)]);
      expect(AUDIENCE_TTL_MS).toBeLessThan(CUT_OFF_MS);
    });

    it("who leaves on their own is cut off the same way", async () => {
      const crew = await authorizeTeam(table.db, crewId, teamId);
      await deliver([productWrite()]);
      await removeMember(table.db, crew, crewId);
      expect(await deliver([record(`MEMBER#${crewId}`, "REMOVE"), productWrite()])).toEqual([channel(ownerId)]);
    });
  });

  describe("a canceled team", () => {
    /** The billing webhook's path: the Stripe customer's team, as the system role. */
    async function cancel(): Promise<void> {
      const customer = `cus_${teamId.replaceAll("-", "").slice(0, 12)}`;
      await linkStripeCustomer(table.db, owner, customer);
      const system = await teamContextForStripeCustomer(table.db, customer);
      if (!system) throw new Error("no team for the customer");
      const team = await getTeam(table.db, owner);
      await updateTeam(table.db, system, { status: "canceled" }, team.version);
    }

    it("stops reaching any member once the consumer sees the status change", async () => {
      await deliver([productWrite()]);
      await cancel();
      expect(await deliver([record("META"), productWrite()])).toEqual([]);
    });

    it("stops reaching any member within about a minute even if the consumer never sees it", async () => {
      await deliver([productWrite()]);
      await cancel();
      clock += AUDIENCE_TTL_MS;
      expect(await deliver([productWrite()])).toEqual([]);
    });

    it("reaches its members again if the subscription is reactivated", async () => {
      await cancel();
      const system = await teamContextForStripeCustomer(table.db, `cus_${teamId.replaceAll("-", "").slice(0, 12)}`);
      await updateTeam(table.db, system as TeamContext, { status: "active" }, (await getTeam(table.db, owner)).version);
      expect(await deliver([record("META"), productWrite()])).toEqual([channel(crewId), channel(ownerId)].sort());
    });
  });
});
