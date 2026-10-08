// What the password reset function (email/password-reset-handler.ts,
// supply-checkout-6uw.26) asks the app pool about an address, and Cognito's
// ForgotPassword, which emails a reset code.
//
// - byAlias: AdminGetUser with the address as the username. In this pool the
//   email is the sign-in alias and usernames aren't case-sensitive, so this
//   finds the native user who signs in with the address however its case was
//   typed, as Managed Login's reset would.
// - byEmail: ListUsers with an `email = "…"` filter, for the users AdminGetUser
//   doesn't find by alias: a Google or Apple user (whose username is
//   `<provider>_<id>`), or a native user whose address isn't its sign-in alias.
// - forgotPassword: Cognito's own ForgotPassword with the web client's ID, for
//   one user by their username. It's a public call (no IAM, unsigned), as
//   Managed Login makes it; the pool emails the code from its own template.
//
// Signed with the function's role, which may call ListUsers and AdminGetUser
// on the app pool only. Errors name only the action, status and error type,
// never the address.

import { type CognitoAdminOptions, cognitoRequest, type ListedUser, type PoolUser } from "./cognito-admin.js";

export interface ResetLookup {
  /** The native user who signs in with this address (a sign-in alias), or undefined if there's none. */
  byAlias(email: string): Promise<PoolUser | undefined>;
  /** The users whose `email` is exactly one of `emails` (at most the first page of each). */
  byEmail(emails: readonly string[]): Promise<PoolUser[]>;
  /**
   * Asks Cognito to email the user a reset code: "sent" when it accepted,
   * "limited" when it refused for its own limits on codes, "refused" when it
   * won't send one to this user (no verified address, not confirmed, gone).
   */
  forgotPassword(username: string): Promise<"sent" | "limited" | "refused">;
}

const attributeMap = (list: unknown): Record<string, string> =>
  Object.fromEntries(
    (Array.isArray(list) ? (list as { Name?: unknown; Value?: unknown }[]) : [])
      .filter((a) => typeof a?.Name === "string" && typeof a.Value === "string")
      .map((a) => [a.Name as string, a.Value as string]),
  );

const poolUser = (username: string, u: { UserStatus?: unknown; Enabled?: unknown }, attributes: unknown): PoolUser => ({
  username,
  status: typeof u.UserStatus === "string" ? u.UserStatus : "",
  enabled: u.Enabled === true,
  attributes: attributeMap(attributes),
});

/** An address safe inside ListUsers' filter string: no quotation mark or backslash, at most 254 characters. */
const FILTERABLE = /^[^"\\\s]{3,254}$/;

const LIMITED = new Set(["LimitExceededException", "TooManyRequestsException"]);
const REFUSED = new Set(["UserNotFoundException", "InvalidParameterException", "NotAuthorizedException"]);
const TIMEOUT_MS = 5_000;

export function cognitoResetLookup(options: CognitoAdminOptions & { readonly userPoolId: string; readonly clientId: string }): ResetLookup {
  const call = cognitoRequest({ timeoutMs: TIMEOUT_MS, ...options });
  const doFetch = options.fetch ?? fetch;
  const endpoint = `https://cognito-idp.${options.region}.amazonaws.com/`;
  return {
    async byAlias(email) {
      let user: { Username?: unknown; UserStatus?: unknown; Enabled?: unknown; UserAttributes?: unknown };
      try {
        user = (await call("AdminGetUser", { UserPoolId: options.userPoolId, Username: email })) as typeof user;
      } catch (error) {
        if (/ UserNotFoundException$/.test((error as Error).message)) return undefined;
        throw error;
      }
      return typeof user.Username === "string" ? poolUser(user.Username, user, user.UserAttributes) : undefined;
    },
    async byEmail(emails) {
      const found = new Map<string, PoolUser>();
      for (const email of new Set(emails)) {
        if (!FILTERABLE.test(email)) continue;
        const answer = (await call("ListUsers", { UserPoolId: options.userPoolId, Filter: `email = "${email}"`, Limit: 60 })) as { Users?: unknown };
        for (const u of (Array.isArray(answer.Users) ? answer.Users : []) as ListedUser[]) {
          if (typeof u === "object" && u !== null && typeof u.Username === "string") found.set(u.Username, poolUser(u.Username, u, u.Attributes));
        }
      }
      return [...found.values()];
    },
    async forgotPassword(username) {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.ForgotPassword" },
        body: JSON.stringify({ ClientId: options.clientId, Username: username }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        return "sent";
      }
      const answer = (await response.json().catch(() => ({}))) as { __type?: unknown };
      const type = typeof answer.__type === "string" ? answer.__type.replace(/^.*#/, "") : "";
      if (LIMITED.has(type)) return "limited";
      if (response.status === 400 && REFUSED.has(type)) return "refused";
      // Only the status and error type: Cognito's messages can echo the username
      throw new Error(`ForgotPassword failed: ${response.status} ${type}`.trim());
    },
  };
}
