// The verified email of a report's sender, for an operator reading a report
// whose sender agreed to be contacted (supply-checkout-3sv.26). The same rule
// as `npm run feedback -- show` (scripts/feedback.ts): the address the account
// API would trust (noticeAddressOf: Cognito's email_verified, no downgrade
// pending, a linked user's recorded address), normalized, or none.
//
// The CLI finds the user with ListUsers (a `sub` filter), signed with the
// owner's credentials. The ops function's role may call AdminGetUser on the
// app pool only, never ListUsers, which would let it list every user's
// address: AdminGetUser takes a native user's `sub` as their username, so it
// finds one user and nothing else. A Google or Apple user who signed up
// through the provider (a federated-only user) isn't found by their `sub`;
// the page then says to look them up with `npm run feedback -- show`.
//
// Nothing here logs. Errors name only Cognito's action, status and error
// type (cognitoRequest), never the user or their address.

import { type CognitoAdminOptions, cognitoRequest } from "../identity/cognito-admin.js";
import { SUB } from "../identity/cognito-accounts.js";
import { noticeAddressOf } from "../identity/notice-address.js";

/** The sender's address, or why there's none: no such user by that `sub`, or no address the API trusts. */
export type ReporterContact = { readonly email: string } | { readonly email: null; readonly why: "not_found" | "unverified" };

/** Looks up a report's sender by their `sub` (the report's `userId`). Throws if Cognito can't be asked. */
export type ReporterEmail = (userId: string) => Promise<ReporterContact>;

const attributesOf = (list: unknown): Record<string, string> =>
  Object.fromEntries(
    (Array.isArray(list) ? (list as { Name?: unknown; Value?: unknown }[]) : [])
      .filter((a) => typeof a?.Name === "string" && typeof a.Value === "string")
      .map((a) => [a.Name as string, a.Value as string]),
  );

export function reporterEmailLookup(options: CognitoAdminOptions & { readonly userPoolId: string }): ReporterEmail {
  const call = cognitoRequest(options);
  return async (userId) => {
    if (!SUB.test(userId)) return { email: null, why: "not_found" };
    let user: { Username?: unknown; UserAttributes?: unknown };
    try {
      user = (await call("AdminGetUser", { UserPoolId: options.userPoolId, Username: userId })) as typeof user;
    } catch (error) {
      if (/\bUserNotFoundException$/.test((error as Error).message)) return { email: null, why: "not_found" };
      throw error;
    }
    const attributes = attributesOf(user.UserAttributes);
    // The user AdminGetUser found must be the one asked for
    if (attributes.sub !== userId) return { email: null, why: "not_found" };
    const address = noticeAddressOf(user.Username, attributes)?.address;
    return address ? { email: address } : { email: null, why: "unverified" };
  };
}
