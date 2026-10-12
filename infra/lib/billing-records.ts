// Writing billing records (backend/src/billing-records, supply-checkout-ijt7). The bucket is in
// the primary region's data stack (stacks/data-stack.ts), under compliance-mode Object Lock for
// 7 years; the only writer is the team purge (observability/ops-checks.ts), which keeps a purged
// team's invoices there before it deletes the team's Stripe customer.

import { Aws, Validations } from "aws-cdk-lib";
import { PolicyStatement, type Role } from "aws-cdk-lib/aws-iam";
import type { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { BILLING_RECORD_PREFIX, BILLING_RECORDS_ENV, billingRecordsBucketName } from "../../backend/src/billing-records/names.js";
import type { DeploymentConfig } from "./config.js";

/**
 * Lets `fn` write billing records (`teams/<teamId>/<customerId>.json`): s3:PutObject under teams/ only. No reads, lists, deletes,
 * retention or legal-hold changes, so a stolen purge role can't read, shorten or remove a record
 * (and compliance mode stops everyone else), and only with If-None-Match, so no record can get a
 * newer version on top of it. The object key names a team ID, which only the function's own checks
 * choose (a team the closed-teams index lists), so IAM can't narrow it further than the prefix.
 */
export function grantPutBillingRecords(fn: LambdaFunction, config: Pick<DeploymentConfig, "envName" | "primaryRegion">): void {
  const bucket = billingRecordsBucketName(config.envName, config.primaryRegion, Aws.ACCOUNT_ID);
  fn.addToRolePolicy(
    new PolicyStatement({
      sid: "PutBillingRecords",
      actions: ["s3:PutObject"],
      resources: [`arn:${Aws.PARTITION}:s3:::${bucket}/${BILLING_RECORD_PREFIX}*`],
      // Only a conditional write, and only If-None-Match: * (as records.ts sends it)
      conditions: { Null: { "s3:if-none-match": "false" }, StringEquals: { "s3:if-none-match": "*" } },
    }),
  );
  Validations.of(fn.role as Role).acknowledge({
    id: `AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::${billingRecordsBucketName(config.envName, config.primaryRegion, "<AWS::AccountId>")}/${BILLING_RECORD_PREFIX}*]`,
    reason: `Each purged team gets its own object, named by its ID, which the function chooses at run time; the grant is PutObject under ${BILLING_RECORD_PREFIX} only`,
  });
  fn.addEnvironment(BILLING_RECORDS_ENV.bucket, bucket);
  fn.addEnvironment(BILLING_RECORDS_ENV.region, config.primaryRegion);
}
