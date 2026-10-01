// Cognito's admin API, signed with the Lambda's role (IAM): AdminUpdateUserAttributes
// for the email_verified trigger, ListUsers and AdminLinkProviderForUser for the
// account-linking trigger (and cognito-accounts.ts builds the security notices
// function's lookup on cognitoRequest). Each role may call only its own actions, and only on the
// environment's user pool (identity stack). The endpoint is the regional Cognito
// endpoint for the Lambda's own region, which is the pool's region: the triggers run
// beside the pool.

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";

/** Sets `attributes` on one user. Throws if Cognito doesn't answer 200. */
export type UpdateUserAttributes = (userPoolId: string, username: string, attributes: Readonly<Record<string, string>>) => Promise<void>;

/** One user, as ListUsers describes it. */
export interface PoolUser {
  readonly username: string;
  /** UNCONFIRMED, CONFIRMED, EXTERNAL_PROVIDER, RESET_REQUIRED, FORCE_CHANGE_PASSWORD, … */
  readonly status: string;
  readonly enabled: boolean;
  readonly attributes: Readonly<Record<string, string>>;
}

/**
 * The users whose `email` equals `email`, with `more` set when Cognito had more
 * than one page. The caller must pass an email with no quotation mark or
 * backslash: it goes into ListUsers' filter string.
 */
export type ListUsersByEmail = (userPoolId: string, email: string) => Promise<{ users: PoolUser[]; more: boolean }>;

/** Links a Google or Apple identity (the provider's user ID) to an existing native user. */
export type LinkProviderForUser = (userPoolId: string, nativeUsername: string, providerName: string, providerUserId: string) => Promise<void>;

export interface CognitoAdminOptions {
  readonly region: string;
  /** Defaults to the Lambda's role. */
  readonly credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** For tests. */
  readonly fetch?: typeof fetch;
  /** Per request. Cognito gives a trigger 5 seconds in all. */
  readonly timeoutMs?: number;
}

const Sha256 = Hash.bind(null, "sha256");
const REGION = /^[a-z0-9-]+$/;

/** One signed call to Cognito's JSON API: the answer's body, or an error naming only the action, status and error type. */
export function cognitoRequest(options: CognitoAdminOptions): (action: string, body: Readonly<Record<string, unknown>>) => Promise<unknown> {
  if (!REGION.test(options.region)) throw new Error("Not an AWS region name");
  const host = `cognito-idp.${options.region}.amazonaws.com`;
  const signer = new SignatureV4({ service: "cognito-idp", region: options.region, credentials: options.credentials ?? defaultProvider(), sha256: Sha256 });
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 3_000;

  return async (action, payload) => {
    const body = JSON.stringify(payload);
    const signed = await signer.sign({
      method: "POST",
      protocol: "https:",
      hostname: host,
      path: "/",
      headers: {
        host,
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": `AWSCognitoIdentityProviderService.${action}`,
      },
      body,
      query: {},
    });
    const response = await doFetch(`https://${host}/`, { method: "POST", headers: signed.headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const answer = (await response.json().catch(() => ({}))) as { __type?: unknown };
    if (!response.ok) {
      // Only the error type: Cognito's messages can echo the username or email
      const type = typeof answer.__type === "string" ? answer.__type.replace(/^.*#/, "") : "";
      throw new Error(`${action} failed: ${response.status} ${type}`.trim());
    }
    return answer;
  };
}

export function cognitoAdmin(options: CognitoAdminOptions): UpdateUserAttributes {
  return updateWith(cognitoRequest(options));
}

function updateWith(call: ReturnType<typeof cognitoRequest>): UpdateUserAttributes {
  return async (userPoolId, username, attributes) => {
    await call("AdminUpdateUserAttributes", {
      UserPoolId: userPoolId,
      Username: username,
      UserAttributes: Object.entries(attributes).map(([Name, Value]) => ({ Name, Value })),
    });
  };
}

export interface ListedUser {
  readonly Username?: unknown;
  readonly UserStatus?: unknown;
  readonly Enabled?: unknown;
  readonly Attributes?: unknown;
}

/** ListUsers, AdminUpdateUserAttributes (to record the linked email) and AdminLinkProviderForUser, for the account-linking trigger. */
export function cognitoLinking(options: CognitoAdminOptions): {
  listUsersByEmail: ListUsersByEmail;
  updateUserAttributes: UpdateUserAttributes;
  linkProviderForUser: LinkProviderForUser;
} {
  const call = cognitoRequest(options);
  return {
    updateUserAttributes: updateWith(call),
    async listUsersByEmail(userPoolId, email) {
      if (/["\\]/.test(email)) throw new Error("An email for a ListUsers filter can't contain a quotation mark or backslash");
      // 60 is ListUsers' largest page: more than that sharing one email is refused anyway
      const answer = (await call("ListUsers", { UserPoolId: userPoolId, Filter: `email = "${email}"`, Limit: 60 })) as { Users?: unknown; PaginationToken?: unknown };
      const listed = Array.isArray(answer.Users) ? (answer.Users as ListedUser[]) : [];
      const users = listed
        .filter((u): u is ListedUser => typeof u === "object" && u !== null && typeof u.Username === "string")
        .map((u) => ({
          username: u.Username as string,
          status: typeof u.UserStatus === "string" ? u.UserStatus : "",
          enabled: u.Enabled === true,
          attributes: Object.fromEntries(
            (Array.isArray(u.Attributes) ? (u.Attributes as { Name?: unknown; Value?: unknown }[]) : [])
              .filter((a) => typeof a?.Name === "string" && typeof a.Value === "string")
              .map((a) => [a.Name as string, a.Value as string]),
          ),
        }));
      return { users, more: typeof answer.PaginationToken === "string" && answer.PaginationToken !== "" };
    },
    async linkProviderForUser(userPoolId, nativeUsername, providerName, providerUserId) {
      await call("AdminLinkProviderForUser", {
        UserPoolId: userPoolId,
        DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: nativeUsername },
        SourceUser: { ProviderName: providerName, ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: providerUserId },
      });
    },
  };
}
