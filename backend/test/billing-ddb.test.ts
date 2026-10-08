// Billing's conditional writes against DynamoDB Local (ADR 0009): linking a
// customer, applying a subscription to its team (never to a closed, purging or
// purged team, and never another customer's), the event record and the
// once-per-owner notice claim. Skipped unless DYNAMODB_ENDPOINT is set (CI
// sets it).

import { randomUUID } from "node:crypto";
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { connection } from "../src/data/client.js";
import {
  applySubscription,
  authorizeTeam,
  claimBillingNotice,
  closeTeam,
  ConflictError,
  createTeam,
  finishReopenResync,
  getBillingTeam,
  isWebhookProcessed,
  linkStripeCustomer,
  listOwnerContacts,
  markWebhookProcessed,
  reopenTeam,
  stripeCustomerTeam,
  type SubscriptionState,
  teamContextForStripeCustomer,
} from "../src/data/index.js";
import { endpoint, newUser, rawItem, useTable } from "./helpers.js";

describe.skipIf(!endpoint)("billing on DynamoDB Local", () => {
  const table = useTable();
  const now = new Date();

  /** A new team with a linked customer, and the webhook's context for it. */
  async function linkedTeam() {
    const ownerId = newUser();
    const { team, context } = await createTeam(table.db, { userId: ownerId, email: "owner@example.com" }, { name: `Billing ${ownerId}` }, now);
    const customer = `cus_${randomUUID().replaceAll("-", "")}`;
    await linkStripeCustomer(table.db, context, customer);
    const ctx = await teamContextForStripeCustomer(table.db, customer);
    if (!ctx) throw new Error("no context");
    return { team, owner: context, ownerId, customer, ctx };
  }
  const state = (customer: string, fields: Partial<SubscriptionState> = {}): SubscriptionState => ({
    customerId: customer,
    subscriptionId: "sub_test_1",
    plan: "starter",
    interval: "month",
    seats: 3,
    status: "trialing",
    currentPeriodEnd: "2026-10-11T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...fields,
  });

  it("links a customer once, finds the team from it, and never moves it to another team", async () => {
    const { team, customer, ctx } = await linkedTeam();
    expect(await stripeCustomerTeam(table.db, customer)).toBe(team.teamId);
    expect(ctx).toMatchObject({ teamId: team.teamId, role: "system" });
    expect(await stripeCustomerTeam(table.db, "cus_nobody")).toBeUndefined();
    const other = await linkedTeam();
    await expect(linkStripeCustomer(table.db, other.owner, customer)).rejects.toBeInstanceOf(ConflictError);
  });

  it("won't link a customer to a closed team", async () => {
    const ownerId = newUser();
    const { team, context } = await createTeam(table.db, { userId: ownerId }, { name: `Closing ${ownerId}` }, now);
    await closeTeam(table.db, context, { confirmName: team.name }, now);
    // A context issued before the closure: the write's own condition refuses it
    await expect(linkStripeCustomer(table.db, context, "cus_after_close")).rejects.toBeInstanceOf(ConflictError);
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).not.toHaveProperty("stripeCustomerId");
    expect(await rawItem(table.db, "STRIPE#cus_after_close", "TEAM")).toBeUndefined();
  });

  it("applies a subscription, and applying it again changes only the sync time and version", async () => {
    const { team, customer, ctx } = await linkedTeam();
    expect(await applySubscription(table.db, ctx, state(customer), now)).toBe("applied");
    const first = await rawItem(table.db, `TEAM#${team.teamId}`, "META");
    expect(first).toMatchObject({ plan: "starter", seats: 3, status: "trialing", stripeSubscriptionId: "sub_test_1", billingInterval: "month", cancelAtPeriodEnd: false, version: 3 });
    expect(await applySubscription(table.db, ctx, state(customer), now)).toBe("applied");
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toEqual({ ...first, version: 4 });
    expect(await getBillingTeam(table.db, ctx, now)).toMatchObject({ status: "trialing", stripeSubscriptionId: "sub_test_1", closed: false, purging: false, readOnly: false });
  });

  it("with asRead (the nightly entitlement check), applies only at the version read (supply-checkout-8jc.9, 8jc.27)", async () => {
    const { team, customer, ctx } = await linkedTeam();
    // A new team: trialing on the trial plan, one seat, no subscription
    const read = await getBillingTeam(table.db, ctx, now);
    expect(read).toMatchObject({ status: "trialing", plan: "trial", seats: 1, version: 2 });
    const version = read?.version ?? -1;
    // An event applied meanwhile: the check's older state must not overwrite it
    expect(await applySubscription(table.db, ctx, state(customer, { status: "active" }), now)).toBe("applied");
    await expect(applySubscription(table.db, ctx, state(customer), now, { version })).rejects.toBeInstanceOf(ConflictError);
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ status: "active", version: version + 1 });
    // Read again, it applies, and moves the version
    const again = await getBillingTeam(table.db, ctx, now);
    expect(again).toMatchObject({ status: "active", version: version + 1 });
    expect(await applySubscription(table.db, ctx, state(customer, { status: "past_due" }), now, { version: again?.version ?? -1 })).toBe("applied");
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ status: "past_due", stripeSubscriptionId: "sub_test_1", version: version + 2 });
    // A version that isn't a whole number is refused before the write
    await expect(applySubscription(table.db, ctx, state(customer), now, { version: 1.5 })).rejects.toThrow("whole number");
    await expect(applySubscription(table.db, ctx, state(customer), now, { version: -1 })).rejects.toThrow("whole number");
  });

  it("with asRead, refuses a change and back (A to B to A) or a period end applied meanwhile, which compare equal by value", async () => {
    const { team, customer, ctx } = await linkedTeam();
    expect(await applySubscription(table.db, ctx, state(customer), now)).toBe("applied");
    const read = await getBillingTeam(table.db, ctx, now);
    const asRead = { version: read?.version ?? -1 };
    // Cancelled and renewed again between the check's read and its write: every field is as read
    expect(await applySubscription(table.db, ctx, state(customer, { cancelAtPeriodEnd: true }), now)).toBe("applied");
    expect(await applySubscription(table.db, ctx, state(customer), now)).toBe("applied");
    expect(await getBillingTeam(table.db, ctx, now)).toMatchObject({ status: read?.status, plan: read?.plan, seats: read?.seats, cancelAtPeriodEnd: read?.cancelAtPeriodEnd });
    await expect(applySubscription(table.db, ctx, state(customer, { status: "past_due" }), now, asRead)).rejects.toBeInstanceOf(ConflictError);
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ status: "trialing", cancelAtPeriodEnd: false });
    // Only the period end moved (a renewal): the version still refuses the older state
    const renewedRead = await getBillingTeam(table.db, ctx, now);
    expect(await applySubscription(table.db, ctx, state(customer, { currentPeriodEnd: "2026-12-01T00:00:00.000Z" }), now)).toBe("applied");
    await expect(applySubscription(table.db, ctx, state(customer), now, { version: renewedRead?.version ?? -1 })).rejects.toBeInstanceOf(ConflictError);
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ currentPeriodEnd: "2026-12-01T00:00:00.000Z" });
  });

  it("with asRead, two writers racing from one read: exactly one applies", async () => {
    const { team, customer, ctx } = await linkedTeam();
    const read = await getBillingTeam(table.db, ctx, now);
    const asRead = { version: read?.version ?? -1 };
    const results = await Promise.allSettled([
      applySubscription(table.db, ctx, state(customer, { status: "active" }), now, asRead),
      applySubscription(table.db, ctx, state(customer, { status: "past_due" }), now, asRead),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected");
    expect(lost?.status === "rejected" && lost.reason).toBeInstanceOf(ConflictError);
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ version: asRead.version + 1 });
  });

  it("records a reopen's pending resync, and finishes it only for that closure (supply-checkout-85qp)", async () => {
    const { team, owner, customer, ctx } = await linkedTeam();
    const closedAt = new Date(now.getTime() - 60_000);
    await closeTeam(table.db, owner, { confirmName: team.name }, closedAt);
    await reopenTeam(table.db, await authorizeTeam(table.db, owner.userId, team.teamId), { confirmName: team.name }, now);
    const read = await getBillingTeam(table.db, ctx, now);
    expect(read).toMatchObject({ closed: false, resyncFor: closedAt.toISOString(), reopenedAt: now.toISOString() });
    expect(read).not.toHaveProperty("cancelledFor");
    // Another closure's resync doesn't finish it
    expect(await finishReopenResync(table.db, ctx, "2026-01-01T00:00:00.000Z")).toBe(false);
    expect(await applySubscription(table.db, ctx, state(customer), now)).toBe("applied");
    expect(await finishReopenResync(table.db, ctx, closedAt.toISOString())).toBe(true);
    expect(await getBillingTeam(table.db, ctx, now)).not.toHaveProperty("resyncFor");
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).not.toHaveProperty("stripeResyncFor");
    // Done already: nothing to finish
    expect(await finishReopenResync(table.db, ctx, closedAt.toISOString())).toBe(false);
    await expect(finishReopenResync(table.db, owner, closedAt.toISOString())).rejects.toThrow("Only billing");
  });

  it("never touches a closed team", async () => {
    const { team, owner, customer, ctx } = await linkedTeam();
    await closeTeam(table.db, owner, { confirmName: team.name }, now);
    expect(await applySubscription(table.db, ctx, state(customer), now)).toBe("ignored");
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).not.toHaveProperty("stripeSubscriptionId");
  });

  it("never touches a team the purge has marked", async () => {
    const { team, customer, ctx } = await linkedTeam();
    await connection(table.db).doc.send(new UpdateCommand({ TableName: table.db.tableName, Key: { PK: `TEAM#${team.teamId}`, SK: "META" }, UpdateExpression: "SET purging = :at", ExpressionAttributeValues: { ":at": now.toISOString() } }));
    expect(await applySubscription(table.db, ctx, state(customer), now)).toBe("ignored");
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).not.toHaveProperty("stripeSubscriptionId");
  });

  it("never recreates a purged team's META item", async () => {
    const { team, customer, ctx } = await linkedTeam();
    await connection(table.db).doc.send(new DeleteCommand({ TableName: table.db.tableName, Key: { PK: `TEAM#${team.teamId}`, SK: "META" } }));
    expect(await applySubscription(table.db, ctx, state(customer), now)).toBe("ignored");
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toBeUndefined();
    expect(await getBillingTeam(table.db, ctx, now)).toBeUndefined();
    expect(await teamContextForStripeCustomer(table.db, customer)).toBeUndefined();
  });

  it("refuses another customer's subscription, and another subscription unless it replaces the team's", async () => {
    const { team, customer, ctx } = await linkedTeam();
    expect(await applySubscription(table.db, ctx, state("cus_someone_else"), now)).toBe("ignored");
    await applySubscription(table.db, ctx, state(customer), now);
    await expect(applySubscription(table.db, ctx, state(customer, { subscriptionId: "sub_test_2" }), now)).rejects.toBeInstanceOf(ConflictError);
    expect(await applySubscription(table.db, ctx, state(customer, { subscriptionId: "sub_test_2", replaces: "sub_test_1", status: "active" }), now)).toBe("applied");
    expect(await rawItem(table.db, `TEAM#${team.teamId}`, "META")).toMatchObject({ stripeSubscriptionId: "sub_test_2", status: "active" });
  });

  it("leaves the plan, interval and period end alone when the subscription doesn't say", async () => {
    const { team, customer, ctx } = await linkedTeam();
    await applySubscription(table.db, ctx, { customerId: customer, subscriptionId: "sub_test_1", seats: 2, status: "active", cancelAtPeriodEnd: true }, now);
    const meta = await rawItem(table.db, `TEAM#${team.teamId}`, "META");
    expect(meta).toMatchObject({ plan: "trial", seats: 2, status: "active", cancelAtPeriodEnd: true });
    expect(meta).not.toHaveProperty("billingInterval");
  });

  it("refuses an owner's context and a malformed state", async () => {
    const { owner, customer, ctx } = await linkedTeam();
    await expect(applySubscription(table.db, owner, state(customer), now)).rejects.toThrow("system role");
    await expect(applySubscription(table.db, ctx, state(customer, { seats: -1 }), now)).rejects.toBeInstanceOf(ConflictError);
    await expect(applySubscription(table.db, ctx, state(customer, { replaces: "sub/x" }), now)).rejects.toThrow("Invalid Stripe subscription ID");
  });

  it("makes a team whose subscription ended read-only for its members", async () => {
    const { team, ownerId, customer, ctx } = await linkedTeam();
    await applySubscription(table.db, ctx, state(customer, { status: "canceled" }), now);
    expect((await authorizeTeam(table.db, ownerId, team.teamId)).subscriptionEnded).toBe(true);
    expect(await getBillingTeam(table.db, ctx, now)).toMatchObject({ readOnly: true });
  });

  it("records an event once, and claims each owner's notice once", async () => {
    const { ctx, ownerId } = await linkedTeam();
    const eventId = `evt_${randomUUID().replaceAll("-", "")}`;
    expect(await isWebhookProcessed(table.db, eventId)).toBe(false);
    expect(await markWebhookProcessed(table.db, eventId, now)).toBe(true);
    expect(await markWebhookProcessed(table.db, eventId, now)).toBe(false);
    expect(await isWebhookProcessed(table.db, eventId)).toBe(true);
    expect(await claimBillingNotice(table.db, eventId, ownerId, now)).toBe(true);
    expect(await claimBillingNotice(table.db, eventId, ownerId, now)).toBe(false);
    expect(await listOwnerContacts(table.db, ctx)).toEqual([{ userId: ownerId, email: "owner@example.com" }]);
  });
});
