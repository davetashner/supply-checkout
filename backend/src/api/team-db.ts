// Per-team database handles for the data API: the second layer of team
// isolation (ADR 0005).
//
// The data Lambda's own role can't touch the table. For each team it assumes
// the data-access role with a session tag `teamId=<team>`, and that role's
// policy allows DynamoDB only on items whose partition key is `TEAM#<tag>` (or
// the team's date index partition, `TEAM#<tag>#SHEETS`), through the
// dynamodb:LeadingKeys condition. So even if a bug built another team's key,
// IAM would refuse the call. The membership check (authorizeTeam) runs on the
// same scoped handle: it reads only the team's own partition.
//
// Sessions last an hour (the limit for role chaining) and are reused until
// five minutes before they expire, so a warm Lambda pays for AssumeRole about
// once an hour per team. The handles are kept in a small LRU cache.

import { AssumeRoleCommand, type AssumeRoleCommandOutput, STSClient } from "@aws-sdk/client-sts";
import { closeDb, createDb, type Db, InvalidInputError } from "../data/index.js";
import { RECEIPT_SESSION_TAGS, TEAM_SESSION_TAG } from "./routes.js";

export type DbForTeam = (teamId: string) => Db;

export interface TeamDbOptions {
  /** The data-access role (DATA_ROLE_ARN). */
  readonly roleArn: string;
  /** Defaults to TABLE_NAME. */
  readonly tableName?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** How many teams' handles to keep. */
  readonly maxTeams?: number;
  /** For tests. */
  readonly sts?: Sts;
  readonly now?: () => number;
}

const TEAM_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SESSION_SECONDS = 3600;
const REFRESH_BEFORE_MS = 5 * 60_000;

interface Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}

/** An STS client, or a stand-in for tests. */
export type Sts = { send(command: AssumeRoleCommand): Promise<Pick<AssumeRoleCommandOutput, "Credentials">> };

/**
 * Credentials for one tagged session of `roleArn`, assumed on first use and
 * again five minutes before they expire. Concurrent callers share one call.
 */
export function roleSession(sts: Sts, now: () => number, input: { roleArn: string; sessionName: string; tags: Record<string, string> }) {
  let current: Credentials | undefined;
  let pending: Promise<Credentials> | undefined;
  return async (): Promise<Credentials> => {
    if (current && current.expiration.getTime() - now() > REFRESH_BEFORE_MS) return current;
    pending ??= sts
      .send(
        new AssumeRoleCommand({
          RoleArn: input.roleArn,
          // Shows the caller in CloudTrail; the tags are what the policy checks
          RoleSessionName: input.sessionName.slice(0, 64),
          DurationSeconds: SESSION_SECONDS,
          Tags: Object.entries(input.tags).map(([Key, Value]) => ({ Key, Value })),
        }),
      )
      .then(({ Credentials: c }) => {
        if (!c?.AccessKeyId || !c.SecretAccessKey || !c.SessionToken || !c.Expiration) throw new Error("AssumeRole returned no credentials");
        current = { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.SessionToken, expiration: c.Expiration };
        return current;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

/**
 * How long an evicted handle stays open. A request that took the handle before
 * it was evicted may still be using it, and a Lambda request lasts at most the
 * function's timeout (10 seconds), so it's closed well after that.
 */
export const CLOSE_EVICTED_AFTER_MS = 60_000;

/**
 * A small LRU cache of Db handles. An evicted handle is closed only after
 * CLOSE_EVICTED_AFTER_MS, never under a request that is still using it.
 */
export function dbCache(maxSize: number) {
  const cache = new Map<string, Db>();
  return (key: string, create: () => Db): Db => {
    const hit = cache.get(key);
    if (hit) {
      // Most recently used goes last
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const db = create();
    cache.set(key, db);
    if (cache.size > maxSize) {
      const [oldest, evicted] = cache.entries().next().value as [string, Db];
      cache.delete(oldest);
      // unref: a pending close never keeps the process alive
      setTimeout(() => closeDb(evicted), CLOSE_EVICTED_AFTER_MS).unref();
    }
    return db;
  };
}

export function teamScopedDbs(options: TeamDbOptions): DbForTeam {
  const env = options.env ?? process.env;
  const sts = options.sts ?? new STSClient({ region: env.AWS_REGION });
  const now = options.now ?? Date.now;
  const cached = dbCache(options.maxTeams ?? 50);

  return (teamId: string) => {
    if (typeof teamId !== "string" || !TEAM_ID.test(teamId)) throw new InvalidInputError("Invalid team ID");
    return cached(teamId, () =>
      createDb({
        tableName: options.tableName,
        env,
        credentials: roleSession(sts, now, { roleArn: options.roleArn, sessionName: `team-${teamId}`, tags: { [TEAM_SESSION_TAG]: teamId } }),
      }),
    );
  };
}

/** A Db for one team, acting for one user: the receipts function's handles (receiptScopedDbs). */
export type DbForTeamUser = (teamId: string, userId: string) => Db;

/**
 * Like teamScopedDbs, for the receipts function (ADR 0008, supply-checkout-wxx):
 * its role session is tagged with the team and with the caller, so it reaches
 * the team's partition and the caller's own per-user receipt rate counters
 * (`RECEIPTRATE#<userId>`), and no one else's. `userId` must be the verified
 * token's `sub`. One session per team and user, kept like the team ones.
 */
export function receiptScopedDbs(options: TeamDbOptions): DbForTeamUser {
  const env = options.env ?? process.env;
  const sts = options.sts ?? new STSClient({ region: env.AWS_REGION });
  const now = options.now ?? Date.now;
  const cached = dbCache(options.maxTeams ?? 50);

  return (teamId: string, userId: string) => {
    if (typeof teamId !== "string" || !TEAM_ID.test(teamId)) throw new InvalidInputError("Invalid team ID");
    if (typeof userId !== "string" || !TEAM_ID.test(userId)) throw new InvalidInputError("Invalid user ID");
    return cached(`${teamId}/${userId}`, () =>
      createDb({
        tableName: options.tableName,
        env,
        credentials: roleSession(sts, now, {
          roleArn: options.roleArn,
          sessionName: `receipts-${teamId}`,
          tags: { [RECEIPT_SESSION_TAGS.teamId]: teamId, [RECEIPT_SESSION_TAGS.userId]: userId },
        }),
      }),
    );
  };
}
