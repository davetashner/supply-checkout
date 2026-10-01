// The queue of Stripe customer deletions the team purge still owes
// (supply-checkout-8jc.42), and the purge deleting a team's data on schedule
// while Stripe is down, against DynamoDB Local (skipped without
// DYNAMODB_ENDPOINT; `npm run test:ddb` runs it locally). Its own file, so its
// own table: the purge runs here over every closed team in it.
// account-deletion-api.test.ts covers the handler against the in-memory table.

import { QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import type { PurgeStripe } from "../src/billing/closing.js";
import { connection } from "../src/data/client.js";
import { CLOSED_TEAM_RETENTION_DAYS, closeTeam, createTeam, isTeamPurgedOrPurging, linkStripeCustomer, listStripeCustomerDeletions, queueStripeCustomerDeletion, removeStripeCustomerDeletion } from "../src/data/index.js";
import { STRIPE_DELETIONS_PARTITION } from "../src/data/schema.js";
import { BusinessMetric, type Observability } from "../src/observability/index.js";
import { createTeamPurgeHandler } from "../src/ops/team-purge-handler.js";
import { endpoint, memoryDeletionLog, newUser, REGION, useTable } from "./helpers.js";

const DAY = 86400_000;

describe.skipIf(!endpoint)("queued Stripe customer deletions (DynamoDB Local)", () => {
  const table = useTable();

  async function partition(pk: string) {
    const { Items } = await connection(table.db).doc.send(
      new QueryCommand({ TableName: table.db.tableName, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": pk }, ConsistentRead: true }),
    );
    return Items ?? [];
  }

  it("queues a deletion once, keeping its first time, lists them oldest first, and removes one", async () => {
    await queueStripeCustomerDeletion(table.db, { teamId: "team-q2", stripeCustomerId: "cus_q2", queuedAt: "2026-09-02T00:00:00.000Z" });
    await queueStripeCustomerDeletion(table.db, { teamId: "team-q1", stripeCustomerId: "cus_q1", queuedAt: "2026-09-01T00:00:00.000Z" });
    // Queued again (a run that stopped after queuing it): the first entry stays
    await queueStripeCustomerDeletion(table.db, { teamId: "team-q1", stripeCustomerId: "cus_q1", queuedAt: "2026-09-03T00:00:00.000Z" });
    expect(await listStripeCustomerDeletions(table.db)).toEqual({
      deletions: [
        { teamId: "team-q1", stripeCustomerId: "cus_q1", queuedAt: "2026-09-01T00:00:00.000Z" },
        { teamId: "team-q2", stripeCustomerId: "cus_q2", queuedAt: "2026-09-02T00:00:00.000Z" },
      ],
      invalid: 0,
    });
    // IDs and a time only
    expect(await partition(STRIPE_DELETIONS_PARTITION)).toContainEqual({ PK: STRIPE_DELETIONS_PARTITION, SK: "team-q1", teamId: "team-q1", stripeCustomerId: "cus_q1", queuedAt: "2026-09-01T00:00:00.000Z" });
    await removeStripeCustomerDeletion(table.db, "team-q1");
    await removeStripeCustomerDeletion(table.db, "team-q1");
    await removeStripeCustomerDeletion(table.db, "team-q2");
    expect(await listStripeCustomerDeletions(table.db)).toEqual({ deletions: [], invalid: 0 });
    // Refuses what isn't an ID or a time
    await expect(queueStripeCustomerDeletion(table.db, { teamId: "team q", stripeCustomerId: "cus_q", queuedAt: "2026-09-01T00:00:00.000Z" })).rejects.toThrow("Invalid team ID");
    await expect(queueStripeCustomerDeletion(table.db, { teamId: "team-q", stripeCustomerId: "cus q", queuedAt: "2026-09-01T00:00:00.000Z" })).rejects.toThrow("Invalid Stripe customer ID");
    await expect(queueStripeCustomerDeletion(table.db, { teamId: "team-q", stripeCustomerId: "cus_q", queuedAt: "soon" })).rejects.toThrow("Invalid queuedAt");
    await expect(queueStripeCustomerDeletion(table.db, { teamId: "team-q", stripeCustomerId: "acct_q", queuedAt: "2026-09-01T00:00:00.000Z" })).rejects.toThrow("Invalid Stripe customer ID");
    await expect(queueStripeCustomerDeletion(table.db, { teamId: "team-q", stripeCustomerId: "cus_q-1", queuedAt: "2026-09-01T00:00:00.000Z" })).rejects.toThrow("Invalid Stripe customer ID");
    // Written by something else: counted, not listed
    await connection(table.db).doc.send(new UpdateCommand({ TableName: table.db.tableName, Key: { PK: STRIPE_DELETIONS_PARTITION, SK: "team-r" }, UpdateExpression: "SET teamId = :t, stripeCustomerId = :c, queuedAt = :q", ExpressionAttributeValues: { ":t": "team-r", ":c": "cus_", ":q": "2026-09-01T00:00:00.000Z" } }));
    expect(await listStripeCustomerDeletions(table.db)).toEqual({ deletions: [], invalid: 1 });
    await removeStripeCustomerDeletion(table.db, "team-r");
  });

  it("purges a closed team on schedule while Stripe is down, and deletes its Stripe customer from the queue once Stripe is back", async () => {
    const closedAt = new Date("2026-09-10T00:00:00.000Z");
    const ownerId = newUser();
    const { team, context: owner } = await createTeam(table.db, { userId: ownerId, email: `owner.${ownerId}@example.com` }, { name: "Echo Cleaning" }, closedAt);
    const customerId = `cus_${team.teamId.slice(0, 8)}`;
    await linkStripeCustomer(table.db, owner, customerId);
    // Its subscription already set to end for this closure, so the purge only has the customer to delete
    await closeTeam(table.db, owner, { confirmName: "Echo Cleaning" }, closedAt);
    await connection(table.db).doc.send(
      new UpdateCommand({ TableName: table.db.tableName, Key: { PK: `TEAM#${team.teamId}`, SK: "META" }, UpdateExpression: "SET stripeSubscriptionId = :sub, stripeCancelledFor = closedAt", ExpressionAttributeValues: { ":sub": "sub_ddb_q" } }),
    );

    const customers = new Set([customerId]);
    const stripe = { down: true, attempts: 0 };
    const client = {
      customers: {
        async del(id: string) {
          stripe.attempts++;
          if (stripe.down) throw Object.assign(new Error("Stripe is down"), { name: "StripeConnectionError" });
          if (!customers.delete(id)) throw Object.assign(new Error("No such customer"), { code: "resource_missing", statusCode: 404 });
        },
      },
    } as unknown as PurgeStripe;
    const counts: Record<string, number> = {};
    const gauges: Record<string, number> = {};
    const obs: Observability = {
      region: REGION,
      logger: { info: () => {}, warn: () => {}, error: () => {}, addContext: () => {} } as unknown as Observability["logger"],
      count: (metric, value = 1) => void (counts[metric] = (counts[metric] ?? 0) + value),
      gauge: (metric, value) => void (gauges[metric] = value),
      flush: () => {},
    };
    const deletions = memoryDeletionLog();
    const purge = (at: number) => createTeamPurgeHandler({ db: table.db, obs, deletions: deletions.log, stripe: async () => client, now: () => at })();

    const due = closedAt.getTime() + CLOSED_TEAM_RETENTION_DAYS * DAY + 1000;
    // Still there: a queue entry naming it would be refused
    expect(await isTeamPurgedOrPurging(table.db, team.teamId)).toBe(false);
    expect(await purge(due)).toMatchObject({ purged: 1, failed: 0 });
    expect(await isTeamPurgedOrPurging(table.db, team.teamId)).toBe(true);
    // The data's gone on schedule, the Stripe customer isn't, and its deletion is queued with the IDs its deletion record keeps
    expect(await partition(`TEAM#${team.teamId}`)).toEqual([]);
    expect(await partition(`STRIPE#${customerId}`)).toEqual([]);
    expect(await partition(`USER#${ownerId}`)).not.toContainEqual(expect.objectContaining({ SK: `TEAM#${team.teamId}` }));
    expect(customers.has(customerId)).toBe(true);
    expect(deletions.records).toEqual([{ kind: "team", id: team.teamId, deletedAt: new Date(due).toISOString(), stripeCustomerId: customerId, stripeSubscriptionId: "sub_ddb_q" }]);
    expect((await listStripeCustomerDeletions(table.db)).deletions).toEqual([{ teamId: team.teamId, stripeCustomerId: customerId, queuedAt: new Date(due).toISOString() }]);
    expect(counts[BusinessMetric.StripeCustomerDeletionsQueued]).toBe(1);
    expect(gauges[BusinessMetric.StripeCustomerDeletionsPending]).toBe(1);

    // Two days later, still down: the gauge has its age
    await purge(due + 2 * DAY);
    expect(gauges[BusinessMetric.StripeCustomerDeletionOldestHours]).toBe(48);

    // Back: deleted, and the queue's empty
    stripe.down = false;
    await purge(due + 2 * DAY + 3_600_000);
    expect(customers.has(customerId)).toBe(false);
    expect(counts[BusinessMetric.StripeCustomersDeleted]).toBe(1);
    expect(await partition(STRIPE_DELETIONS_PARTITION)).toEqual([]);
    expect(gauges[BusinessMetric.StripeCustomerDeletionsPending]).toBe(0);
    expect(gauges[BusinessMetric.StripeCustomerDeletionOldestHours]).toBe(0);
  });
});
