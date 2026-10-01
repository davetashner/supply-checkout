// Finds an app user by their `sub` for the security notices function
// (security-notices-handler.ts, supply-checkout-8jc.28): CloudTrail records the
// sub of the user whose token made a call, not their username. Signed with the
// function's role, which may call ListUsers and AdminGetUser on the app pool only.

import { emailVerifiedFrom } from "../api/cognito-user.js";
import { type CognitoAdminOptions, cognitoRequest, type ListedUser } from "./cognito-admin.js";

/** What the security notices function needs to know about one app user (cognitoAccounts). */
export interface PoolAccount {
  readonly username: string;
  readonly email?: string;
  /** As the account API decides it (emailVerifiedFrom): verified, no downgrade pending, and a linked user's recorded address. */
  readonly emailVerified: boolean;
  /**
   * Cognito's own `email_verified` is "true", whatever else holds: where
   * Cognito now sends codes and password resets. For telling the old address
   * of an email change, never a reason to send anything to this address.
   */
  readonly emailVerifiedInCognito: boolean;
  /** An authenticator app (TOTP) is one of the user's MFA methods, preferred or not. */
  readonly totpEnabled: boolean;
}

/** The user in the pool with this `sub`, or undefined if there's none. */
export type FindAccount = (sub: string) => Promise<PoolAccount | undefined>;

/** A Cognito `sub`: a UUID, which is also what keeps it safe inside ListUsers' filter string. */
export const SUB = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const attributesOf = (list: unknown): Record<string, string> =>
  Object.fromEntries(
    (Array.isArray(list) ? (list as { Name?: unknown; Value?: unknown }[]) : [])
      .filter((a) => typeof a?.Name === "string" && typeof a.Value === "string")
      .map((a) => [a.Name as string, a.Value as string]),
  );

/** ListUsers with a `sub` filter, then AdminGetUser for the user's address and MFA methods. */
export function cognitoAccounts(options: CognitoAdminOptions & { readonly userPoolId: string }): FindAccount {
  const call = cognitoRequest(options);
  return async (sub) => {
    if (!SUB.test(sub)) throw new Error("Not a Cognito sub");
    const listed = (await call("ListUsers", { UserPoolId: options.userPoolId, Filter: `sub = "${sub}"`, Limit: 1 })) as { Users?: unknown };
    const first = (Array.isArray(listed.Users) ? listed.Users[0] : undefined) as ListedUser | undefined;
    if (typeof first?.Username !== "string") return undefined;
    const user = (await call("AdminGetUser", { UserPoolId: options.userPoolId, Username: first.Username })) as {
      Username?: unknown;
      UserAttributes?: unknown;
      UserMFASettingList?: unknown;
    };
    const attributes = attributesOf(user.UserAttributes);
    // The user AdminGetUser found must be the one asked for
    if (attributes.sub !== sub) return undefined;
    return {
      username: first.Username,
      email: attributes.email,
      emailVerified: emailVerifiedFrom(user.Username, attributes),
      emailVerifiedInCognito: attributes.email_verified === "true",
      totpEnabled: Array.isArray(user.UserMFASettingList) && user.UserMFASettingList.includes("SOFTWARE_TOKEN_MFA"),
    };
  };
}
