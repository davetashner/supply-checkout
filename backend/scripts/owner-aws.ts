// What the owner's CLIs (backfill.ts, feedback.ts) share for reaching the table
// and the app user pool with the owner's own AWS credentials: the table-name
// check, the account the profile signs in to, and the app pool found from SSM
// and checked by name. Nothing here reads or writes data.
//
// Not imported by any Lambda.

import { GetParametersCommand, SSMClient } from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { cognitoRequest } from "../src/identity/cognito-admin.js";

/** An app table's name (tableName in src/data/schema.ts), so a typo can't point the backfill at another table. */
export const APP_TABLE = /^supply-checkout-([a-z0-9-]+)-app$/;

/** A user pool ID, `<region>_<id>`: the region is the first group. */
export const POOL_ID = /^([a-z]+(?:-[a-z]+)+-\d+)_[A-Za-z0-9]{1,64}$/;

export type Credentials = ReturnType<typeof defaultProvider>;

/** The account the credentials belong to (STS GetCallerIdentity). */
export async function callerAccount(region: string, credentials: Credentials): Promise<string> {
  const sts = new STSClient({ region, credentials });
  try {
    const { Account } = await sts.send(new GetCallerIdentityCommand({}));
    if (!Account) throw new Error("STS returned no account");
    return Account;
  } finally {
    sts.destroy();
  }
}

/** The app pool's SSM parameter (identityOutputParameters(envName).userPoolId in infra/lib/identity.ts). */
export const appPoolParameter = (envName: string) => `/supply-checkout/${envName}/identity/user-pool-id`;

/** The operator pool's SSM parameter (identityOutputParameters(envName).opsUserPoolId): the one pool the backfill must never list. */
export const opsPoolParameter = (envName: string) => `/supply-checkout/${envName}/identity/ops-user-pool-id`;

/** What appPool found: the app pool's ID, Cognito's name for it, and the operator pool's ID ("" if it has none). */
export interface FoundPool {
  readonly id: string;
  readonly name: string;
  readonly opsId: string;
}

/** The app pool of an environment: its ID (and the operator pool's) from SSM, then its name from Cognito, with the profile's credentials. */
export async function appPool(region: string, envName: string, credentials: Credentials | undefined): Promise<FoundPool> {
  const ssm = new SSMClient({ region, ...(credentials ? { credentials } : {}) });
  let id: string;
  let opsId: string;
  try {
    const { Parameters } = await ssm.send(new GetParametersCommand({ Names: [appPoolParameter(envName), opsPoolParameter(envName)] }));
    const value = (name: string) => Parameters?.find((p) => p.Name === name)?.Value ?? "";
    id = value(appPoolParameter(envName));
    opsId = value(opsPoolParameter(envName));
  } finally {
    ssm.destroy();
  }
  const match = POOL_ID.exec(id);
  if (!match) return { id, name: "", opsId };
  const described = (await cognitoRequest({ region: match[1] as string, timeoutMs: 10_000, ...(credentials ? { credentials } : {}) })("DescribeUserPool", { UserPoolId: id })) as {
    UserPool?: { Name?: unknown };
  };
  return { id, name: typeof described.UserPool?.Name === "string" ? described.UserPool.Name : "", opsId };
}

/**
 * Why `found` isn't the app pool of environment `envName` in `region`, or
 * undefined if it is: the operator pool is refused by ID and by its `-ops`
 * name, and the pool must be named supply-checkout-<env> and be in the region.
 */
export function appPoolProblem(found: FoundPool, envName: string, region: string): string | undefined {
  const parameter = appPoolParameter(envName);
  if (found.name.endsWith("-ops") || (found.opsId !== "" && found.id === found.opsId)) return `${parameter} names the operator pool (${found.id})`;
  const poolRegion = POOL_ID.exec(found.id)?.[1];
  const expected = `supply-checkout-${envName}`;
  if (!poolRegion || poolRegion !== region || found.name !== expected) {
    return `${parameter} must name the pool ${expected} in ${region}, not ${found.name || "an unnamed pool"} (${found.id || "no ID"})`;
  }
  return undefined;
}
