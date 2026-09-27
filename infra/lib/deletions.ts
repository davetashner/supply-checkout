// Writing deletion records (backend/src/deletions, supply-checkout-0ic7). The
// bucket is in the primary region's data stack (stacks/data-stack.ts); the
// writers are the account function (a deleted account, in every region) and
// the team purge (a purged team, primary region only).

import { Aws, Validations } from "aws-cdk-lib";
import { PolicyStatement, type Role } from "aws-cdk-lib/aws-iam";
import type { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { DELETION_PREFIXES, DELETIONS_ENV, deletionsBucketName } from "../../backend/src/deletions/names.js";
import type { DeploymentConfig } from "./config.js";

/**
 * Lets `fn` write one kind of deletion record: s3:PutObject under that kind's
 * prefix only. No reads, lists, deletes, retention or legal-hold changes, and
 * no other prefix, so the account function can't write a team's record or the
 * purge a user's. Only with If-None-Match, so no record can be overwritten. The object key names the ID, which only the function's own
 * checks choose (the caller's token `sub`, or a team the closed-teams index
 * lists), so IAM can't narrow it further than the prefix.
 */
export function grantPutDeletionRecords(fn: LambdaFunction, config: Pick<DeploymentConfig, "envName" | "primaryRegion">, kind: keyof typeof DELETION_PREFIXES): void {
  const bucket = deletionsBucketName(config.envName, config.primaryRegion, Aws.ACCOUNT_ID);
  fn.addToRolePolicy(
    new PolicyStatement({
      sid: kind === "user" ? "PutAccountDeletionRecords" : "PutTeamDeletionRecords",
      actions: ["s3:PutObject"],
      resources: [`arn:${Aws.PARTITION}:s3:::${bucket}/${DELETION_PREFIXES[kind]}*`],
      // Only a conditional write (If-None-Match: *, as records.ts sends it): a record,
      // once written, can't get a newer version on top of it
      conditions: { Null: { "s3:if-none-match": "false" } },
    }),
  );
  Validations.of(fn.role as Role).acknowledge({
    id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${deletionsBucketName(config.envName, config.primaryRegion, "<AWS::AccountId>")}/${DELETION_PREFIXES[kind]}*]`,
    reason: `Each deleted ${kind === "user" ? "account" : "team"} gets its own object, named by its ID, which the function chooses at run time; the grant is PutObject under ${DELETION_PREFIXES[kind]} only`,
  });
  fn.addEnvironment(DELETIONS_ENV.bucket, bucket);
  fn.addEnvironment(DELETIONS_ENV.region, config.primaryRegion);
}
