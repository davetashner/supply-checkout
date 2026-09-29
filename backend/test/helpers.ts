import { randomUUID } from "node:crypto";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll } from "vitest";
import { authorizeTeam, createDb, type Db, type Role, type TeamContext } from "../src/data/index.js";
import { connection, dbFromConnection } from "../src/data/client.js";
import { createLocalTable, deleteLocalTable } from "../src/data/local-table.js";
import type { EmailCodes, TotpSetup } from "../src/api/cognito-user.js";
import { EmailNotSentError, type Mailer, type MessageTags } from "../src/email/mailer.js";
import type { EmailInput } from "../src/email/templates.js";
import { type DeletionLog, type DeletionRecord, validRecord } from "../src/deletions/records.js";

/** DynamoDB Local, e.g. http://localhost:8000. CI runs it as a service container. */
export const endpoint = process.env.DYNAMODB_ENDPOINT || undefined;

/** A made-up region: nothing here may depend on a real region name (ADR 0010). */
export const REGION = "test-local-1";

/** A fresh table in DynamoDB Local for one test file, deleted afterwards. */
export function useTable(): { readonly db: Db } {
  const holder = {} as { db: Db };
  beforeAll(async () => {
    holder.db = createDb({ endpoint, region: REGION, tableName: `test-${randomUUID()}`, env: {} });
    await createLocalTable(holder.db);
  });
  afterAll(async () => {
    if (holder.db) await deleteLocalTable(holder.db);
  });
  return holder;
}

/** The raw stored item, keys included, to check where data landed. */
export async function rawItem(db: Db, PK: string, SK: string) {
  const { Item } = await connection(db).doc.send(new GetCommand({ TableName: db.tableName, Key: { PK, SK }, ConsistentRead: true }));
  return Item;
}

export const newUser = () => `user-${randomUUID()}`;

/** A Db whose calls fail loudly, for tests that must never reach DynamoDB. */
export function offlineDb(region = REGION): Db {
  return fakeDb(() => Promise.reject(new Error("unexpected DynamoDB call")), region);
}

/** A Db whose document client answers with `send`. */
export function fakeDb(send: (command: { input: Record<string, unknown> }, ...rest: unknown[]) => Promise<unknown>, region = REGION): Db {
  const doc = { send } as unknown as ReturnType<typeof connection>["doc"];
  return dbFromConnection({ client: {} as ReturnType<typeof connection>["client"], doc, tableName: "fake", region });
}

/**
 * A real, issued context without a database: authorizeTeam against a fake
 * that returns a team homed in `homeRegion` and a membership with `role`.
 */
export function contextFor(role: Role, homeRegion = REGION, teamId = "t1", userId = "u1"): Promise<TeamContext> {
  const db = fakeDb(async () => ({ Responses: [{ Item: { homeRegion } }, { Item: { role } }] }));
  return authorizeTeam(db, userId, teamId);
}

/** Email verification codes for handlers whose tests don't use them (account-api.test.ts does). */
export const unusedEmailCodes: EmailCodes = {
  send: () => Promise.reject(new Error("not used")),
  verify: () => Promise.reject(new Error("not used")),
};

/** Two-step sign-in setup for handlers whose tests don't use it (account-api.test.ts does). */
export const unusedTotp: TotpSetup = {
  setPassword: () => Promise.reject(new Error("not used")),
  associate: () => Promise.reject(new Error("not used")),
  verify: () => Promise.reject(new Error("not used")),
  signOutEverywhere: () => Promise.reject(new Error("not used")),
};

/** A mailer that records what it would send, or fails like SES when `fail` names an error. */
export function fakeMailer() {
  const sent: { to: string; input: EmailInput; tags: MessageTags }[] = [];
  const state = { fail: undefined as string | undefined };
  const mailer: Mailer = {
    async send(to, input, tags = {}) {
      if (state.fail) throw new EmailNotSentError(state.fail);
      sent.push({ to, input, tags });
      return { messageId: `message-${sent.length}` };
    },
  };
  return { mailer, sent, state };
}

/**
 * The partitions an account-access session reaches, as its IAM policy allows
 * them (LeadingKeys): a handle on the in-memory table scoped the same way.
 */
export function accountPartitions(scope: { userId: string; teamId?: string; invitee?: string; member?: string; inviteLimit?: string }): string[] {
  return [
    `USER#${scope.userId}`,
    `TEAM#${scope.teamId ?? "."}`,
    `INVITEE#${scope.invitee ?? "."}`,
    `USER#${scope.member ?? "."}`,
    `INVITELIMIT#${scope.inviteLimit ?? "."}`,
  ];
}

/** The account handler's deleteUser, for tests that never delete an account. */
export const unusedDeleteUser = async (): Promise<void> => Promise.reject(new Error("deleteUser not used"));

/** A deletion log for handlers whose tests never delete anything. */
export const unusedDeletionLog: DeletionLog = { record: () => Promise.reject(new Error("deletion log not used")) };

/** A deletion log that keeps what it's given, or fails like S3 while `fail` is set. */
export function memoryDeletionLog() {
  const records: DeletionRecord[] = [];
  const state = { fail: false };
  const log: DeletionLog = {
    async record(record) {
      if (state.fail) throw Object.assign(new Error("Access Denied"), { name: "AccessDenied" });
      // Checked and written once, as s3DeletionLog does
      if (!records.some((r) => r.kind === record.kind && r.id === record.id)) records.push(validRecord(record));
    },
  };
  return { log, records, state };
}

/**
 * The top-level attribute names a request names anywhere (its key, update,
 * condition and projection), as IAM's dynamodb:Attributes sees them.
 */
export function namedAttributes(input: Record<string, unknown>): Set<string> {
  const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  const text = ["ProjectionExpression", "UpdateExpression", "ConditionExpression", "KeyConditionExpression", "FilterExpression"]
    .map((k) => (typeof input[k] === "string" ? (input[k] as string) : ""))
    .join(" ");
  const words = [...text.replace(/:[A-Za-z0-9_]+/g, " ").matchAll(/#?[A-Za-z_][A-Za-z0-9_]*/g)]
    .map((m) => m[0])
    .filter((w) => !["SET", "REMOVE", "ADD", "AND", "OR", "NOT", "attribute_exists", "attribute_not_exists", "begins_with", "if_not_exists"].includes(w))
    .map((w) => (w.startsWith("#") ? names[w] : w));
  const key = (input.Key ?? {}) as Record<string, unknown>;
  return new Set([...Object.keys(key), ...words].filter((w): w is string => typeof w === "string"));
}
