// The two Cognito checks the ops function makes on every request (ADR 0015),
// so removing, disabling or signing out an operator takes effect on their
// next request rather than when their token expires:
//
// - GetUser with the caller's own access token. Cognito refuses a token
//   revoked by sign-out or admin-user-global-sign-out, and a disabled user's
//   (AdminDisableUser revokes their tokens). It needs no IAM permission: the
//   token authorizes it, and the ops client grants the
//   aws.cognito.signin.user.admin scope for this. Its answer names the user.
// - AdminListGroupsForUser for that user, signed with the function's role,
//   which may call it on the operator pool only. The user must still be in
//   the `operators` group.

import { cognitoRequest, type CognitoAdminOptions } from "../identity/cognito-admin.js";
import { ApiError } from "../api/http.js";

/** The operator as Cognito sees them now. */
export interface OperatorUser {
  readonly username: string;
  readonly sub: string;
}

export interface OperatorDirectory {
  /** GetUser with the access token: 401 for a revoked token or a disabled user. */
  getUser(accessToken: string): Promise<OperatorUser>;
  /** The groups the user is in now. */
  groupsFor(username: string): Promise<string[]>;
}

const TIMEOUT_MS = 3000;
const ISSUER = /^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[A-Za-z0-9_-]+$/;

export interface OperatorDirectoryOptions extends Omit<CognitoAdminOptions, "region"> {
  /** The operator pool's issuer URL: GetUser goes to its endpoint, and it names the region. */
  readonly issuerUrl: string;
  /** The operator pool. */
  readonly userPoolId: string;
}

export function operatorDirectory(options: OperatorDirectoryOptions): OperatorDirectory {
  if (!ISSUER.test(options.issuerUrl)) throw new Error("OPS_ISSUER_URL is not a Cognito user pool issuer");
  const url = new URL(options.issuerUrl);
  const region = url.hostname.split(".")[1] as string;
  const doFetch = options.fetch ?? fetch;
  const admin = cognitoRequest({ ...options, region, timeoutMs: options.timeoutMs ?? TIMEOUT_MS });
  return {
    async getUser(accessToken) {
      const response = await doFetch(`${url.origin}/`, {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.GetUser" },
        body: JSON.stringify({ AccessToken: accessToken }),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => ({}))) as { __type?: string; Username?: unknown; UserAttributes?: { Name?: string; Value?: string }[] };
      if (!response.ok) {
        // A revoked token, a disabled or deleted user
        if (response.status === 400 && /NotAuthorized|UserNotFound/.test(body.__type ?? "")) throw new ApiError(401, "unauthenticated", "Sign in again");
        throw new Error(`GetUser failed: ${response.status} ${(body.__type ?? "").replace(/^.*#/, "")}`.trim());
      }
      const sub = (body.UserAttributes ?? []).find((a) => a.Name === "sub")?.Value;
      if (typeof body.Username !== "string" || typeof sub !== "string") throw new Error("GetUser answered without a user");
      return { username: body.Username, sub };
    },
    async groupsFor(username) {
      const groups: string[] = [];
      let NextToken: string | undefined;
      do {
        const answer = (await admin("AdminListGroupsForUser", { UserPoolId: options.userPoolId, Username: username, Limit: 60, ...(NextToken ? { NextToken } : {}) })) as {
          Groups?: { GroupName?: unknown }[];
          NextToken?: unknown;
        };
        for (const g of answer.Groups ?? []) if (typeof g?.GroupName === "string") groups.push(g.GroupName);
        NextToken = typeof answer.NextToken === "string" && answer.NextToken ? answer.NextToken : undefined;
      } while (NextToken);
      return groups;
    },
  };
}
