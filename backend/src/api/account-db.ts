// Per-user database handles for the account API (/me, POST /teams, invite
// acceptance): the IAM layer of isolation for requests that aren't inside one
// team yet.
//
// Creating a team writes the new TEAM# items and the owner's USER# row;
// accepting an invite writes the invited team's MEMBER item and the user's
// USER# row. Neither fits the data-access role, which reaches one existing
// team's partition. So the account function assumes its own role, the
// account-access role, tagged with:
//
//   userId   the caller's `sub`, from the verified token         USER#<userId>
//   teamId   a team the request is entitled to touch             TEAM#<teamId>
//   invitee  the SHA-256 of the caller's verified email          INVITEE#<invitee> (GSI2)
//   member   another member of `teamId`, whose team-switcher     USER#<member>, update
//            row an owner changes or deletes                       and delete only
//   inviteLimit  the SHA-256 of an address an owner of `teamId`  INVITELIMIT#<hash>,
//            is inviting, for its daily invite counter             update only
//
// and that role's policy allows DynamoDB only on those partitions
// (dynamodb:LeadingKeys). The handler chooses the team only from sources the
// caller is entitled to: the ID derived from their own idempotency key (a new
// team), an invite found under their verified email (the invited team), or
// their own USER# rows (/me), or the path's team once the caller's membership
// is checked. It sets `member` only for a member of that team, and
// `inviteLimit` only for the address being invited to that team, after the
// caller's role check. Unused tags are ACCOUNT_TAG_UNUSED.

import { STSClient } from "@aws-sdk/client-sts";
import { createDb, type Db, InvalidInputError } from "../data/index.js";
import { ACCOUNT_SESSION_TAGS, ACCOUNT_TAG_UNUSED } from "./routes.js";
import { dbCache, roleSession, type Sts } from "./team-db.js";

export interface AccountScope {
  /** The caller's `sub`. */
  readonly userId: string;
  /** A team the request may touch. */
  readonly teamId?: string;
  /** hashEmail() of the caller's verified email, to read their invites. */
  readonly invitee?: string;
  /** Another member of `teamId`, whose team-switcher row may be updated or deleted. Needs `teamId`. */
  readonly member?: string;
  /** hashEmail() of an address an owner of `teamId` is inviting, whose daily invite counter may be updated. Needs `teamId`. */
  readonly inviteLimit?: string;
}

export type DbForAccount = (scope: AccountScope) => Db;

export interface AccountDbOptions {
  /** The account-access role (ACCOUNT_ROLE_ARN). */
  readonly roleArn: string;
  /** Defaults to TABLE_NAME. */
  readonly tableName?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** How many scopes' handles to keep. */
  readonly maxScopes?: number;
  /** For tests. */
  readonly sts?: Sts;
  readonly now?: () => number;
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;

export function accountScopedDbs(options: AccountDbOptions): DbForAccount {
  const env = options.env ?? process.env;
  const sts = options.sts ?? new STSClient({ region: env.AWS_REGION });
  const now = options.now ?? Date.now;
  const cached = dbCache(options.maxScopes ?? 50);

  return (scope: AccountScope) => {
    if (typeof scope.userId !== "string" || !ID.test(scope.userId)) throw new InvalidInputError("Invalid user ID");
    if (scope.teamId !== undefined && (typeof scope.teamId !== "string" || !ID.test(scope.teamId))) throw new InvalidInputError("Invalid team ID");
    if (scope.invitee !== undefined && (typeof scope.invitee !== "string" || !HASH.test(scope.invitee))) throw new InvalidInputError("Invalid invitee");
    if (scope.member !== undefined && (typeof scope.member !== "string" || !ID.test(scope.member) || scope.teamId === undefined)) throw new InvalidInputError("Invalid member");
    if (scope.inviteLimit !== undefined && (typeof scope.inviteLimit !== "string" || !HASH.test(scope.inviteLimit) || scope.teamId === undefined)) throw new InvalidInputError("Invalid invite limit");
    const tags = {
      [ACCOUNT_SESSION_TAGS.userId]: scope.userId,
      [ACCOUNT_SESSION_TAGS.teamId]: scope.teamId ?? ACCOUNT_TAG_UNUSED,
      [ACCOUNT_SESSION_TAGS.invitee]: scope.invitee ?? ACCOUNT_TAG_UNUSED,
      [ACCOUNT_SESSION_TAGS.member]: scope.member ?? ACCOUNT_TAG_UNUSED,
      [ACCOUNT_SESSION_TAGS.inviteLimit]: scope.inviteLimit ?? ACCOUNT_TAG_UNUSED,
    };
    const key = `${tags.userId} ${tags.teamId} ${tags.invitee} ${tags.member} ${tags.inviteLimit}`;
    return cached(key, () =>
      createDb({ tableName: options.tableName, env, credentials: roleSession(sts, now, { roleArn: options.roleArn, sessionName: `user-${scope.userId}`, tags }) }),
    );
  };
}
