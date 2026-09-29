// ListUsersInGroup for the operator group watch: every member's `sub` and
// whether they're enabled, and nothing else it answers (usernames, emails).

import type { GroupMember } from "./operator-group-watch-handler.js";

/** One signed Cognito call (cognitoRequest in identity/cognito-admin.ts). */
export type CognitoCall = (action: string, body: Readonly<Record<string, unknown>>) => Promise<unknown>;

/** The most pages one run reads: 60 users each, far more operators than there will be. */
export const MAX_PAGES = 20;

export async function listGroupMembers(call: CognitoCall, userPoolId: string, groupName: string): Promise<GroupMember[]> {
  const members: GroupMember[] = [];
  let NextToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = (await call("ListUsersInGroup", { UserPoolId: userPoolId, GroupName: groupName, Limit: 60, ...(NextToken ? { NextToken } : {}) })) as { Users?: unknown; NextToken?: unknown };
    for (const user of Array.isArray(answer.Users) ? (answer.Users as { Enabled?: unknown; Attributes?: unknown }[]) : []) {
      const attributes = Array.isArray(user?.Attributes) ? (user.Attributes as { Name?: unknown; Value?: unknown }[]) : [];
      const sub = attributes.find((a) => a?.Name === "sub")?.Value;
      members.push({ sub: typeof sub === "string" ? sub : "", enabled: user?.Enabled === true });
    }
    NextToken = typeof answer.NextToken === "string" && answer.NextToken ? answer.NextToken : undefined;
    if (!NextToken) return members;
  }
  throw new Error(`ListUsersInGroup had more than ${MAX_PAGES} pages`);
}
