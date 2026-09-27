// Database handles for the ops function (ADR 0015). Its own role can't reach
// the table. For each request it assumes the operator-access role, tagged
// with the team a comp changes (or OPS_TAG_UNUSED for reads), and that role
// may only:
//
// - query GSI3's OPS#TEAMS, OPS#OWNERS#* and OPS#AUDIT#* partitions, for the
//   projected attributes only (the team list, owners and the audit by month);
// - update the comp attributes (COMP_ATTRIBUTES) of items in TEAM#<tag>;
// - put and query items in OPAUDIT#* partitions (never update or delete).
//
// So an operator can't read a team's sheets or inventory through the ops
// function, even with a bug in it. Sessions are cached like the data
// function's (team-db.ts).

import { STSClient } from "@aws-sdk/client-sts";
import { dbCache, roleSession, type Sts } from "../api/team-db.js";
import { OPS_SESSION_TAG, OPS_TAG_UNUSED } from "../api/routes.js";
import { createDb, type Db, InvalidInputError } from "../data/index.js";

/**
 * A handle for one operator's request: `teamId` only when it changes that
 * team's comp. The session is named after the operator, so CloudTrail shows
 * who made each call.
 */
export type DbForOps = (operatorSub: string, teamId?: string) => Db;

export interface OpsDbOptions {
  /** The operator-access role (OPS_ROLE_ARN). */
  readonly roleArn: string;
  readonly tableName?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sts?: Sts;
  readonly now?: () => number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function opsScopedDbs(options: OpsDbOptions): DbForOps {
  const env = options.env ?? process.env;
  const sts = options.sts ?? new STSClient({ region: env.AWS_REGION });
  const now = options.now ?? Date.now;
  const cached = dbCache(20);
  return (operatorSub: string, teamId?: string) => {
    if (typeof operatorSub !== "string" || !ID.test(operatorSub)) throw new InvalidInputError("Invalid operator");
    if (teamId !== undefined && (typeof teamId !== "string" || !ID.test(teamId))) throw new InvalidInputError("Invalid team ID");
    const tag = teamId ?? OPS_TAG_UNUSED;
    return cached(`${operatorSub} ${tag}`, () =>
      createDb({ tableName: options.tableName, env, credentials: roleSession(sts, now, { roleArn: options.roleArn, sessionName: `ops-${operatorSub}`, tags: { [OPS_SESSION_TAG]: tag } }) }),
    );
  };
}
