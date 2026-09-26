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
import { TEAM_SESSION_TAG } from "./routes.js";

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
  readonly sts?: { send(command: AssumeRoleCommand): Promise<Pick<AssumeRoleCommandOutput, "Credentials">> };
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

export function teamScopedDbs(options: TeamDbOptions): DbForTeam {
  const env = options.env ?? process.env;
  const sts = options.sts ?? new STSClient({ region: env.AWS_REGION });
  const now = options.now ?? Date.now;
  const maxTeams = options.maxTeams ?? 50;
  const cache = new Map<string, Db>();

  const credentialsFor = (teamId: string) => {
    let current: Credentials | undefined;
    let pending: Promise<Credentials> | undefined;
    return async (): Promise<Credentials> => {
      if (current && current.expiration.getTime() - now() > REFRESH_BEFORE_MS) return current;
      pending ??= sts
        .send(
          new AssumeRoleCommand({
            RoleArn: options.roleArn,
            // Shows the team in CloudTrail; the tag is what the policy checks
            RoleSessionName: `team-${teamId}`.slice(0, 64),
            DurationSeconds: SESSION_SECONDS,
            Tags: [{ Key: TEAM_SESSION_TAG, Value: teamId }],
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
  };

  return (teamId: string) => {
    if (typeof teamId !== "string" || !TEAM_ID.test(teamId)) throw new InvalidInputError("Invalid team ID");
    const hit = cache.get(teamId);
    if (hit) {
      // Most recently used goes last
      cache.delete(teamId);
      cache.set(teamId, hit);
      return hit;
    }
    const db = createDb({ tableName: options.tableName, env, credentials: credentialsFor(teamId) });
    cache.set(teamId, db);
    if (cache.size > maxTeams) {
      const [oldest, evicted] = cache.entries().next().value as [string, Db];
      cache.delete(oldest);
      closeDb(evicted);
    }
    return db;
  };
}
