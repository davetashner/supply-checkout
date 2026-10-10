// The cost guard on profile photos (supply-checkout-6uw.30). Presigned photo
// URLs are bearer links for an hour, so a leaked one could be fetched over and
// over, and S3 charges for every byte out. The photos bucket has one S3
// request metrics configuration, filtered to photos/ (PHOTOS_METRICS_ID, data
// stack), and this P2 alarm watches its BytesDownloaded: a 256×256 photo is
// under 64 KB, so PHOTOS_DOWNLOAD_ALARM_BYTES in an hour is tens of thousands
// of views, far past what the app's teams make.

import { Aws, Duration } from "aws-cdk-lib";
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import type { Construct } from "constructs";
import { PHOTOS_METRICS_ID, photosBucketName } from "../../../backend/src/photos/names.js";
import type { AlarmTopics } from "./alarm-topics.js";

/** Bytes downloaded from photos/ in an hour above which the alarm goes off: 5 GiB. */
export const PHOTOS_DOWNLOAD_ALARM_BYTES = 5 * 1024 ** 3;

/** P2 "Profile photo downloads high": BytesDownloaded under photos/ above PHOTOS_DOWNLOAD_ALARM_BYTES in an hour. Primary region only. */
export function photosDownloadAlarm(scope: Construct, props: { readonly envName: string; readonly region: string; readonly topics: AlarmTopics }): Alarm {
  const alarm = new Alarm(scope, "PhotosDownloadsHigh", {
    alarmName: `supply-checkout-${props.envName}-p2-photo-downloads-high`,
    alarmDescription:
      "P2. Profile photo downloads high: more than 5 GiB of profile photos was downloaded from the photos bucket in an hour, likely a leaked presigned URL fetched in a loop. " +
      "Each URL lasts an hour. Runbook: docs/observability.md, Profile photo downloads high.",
    metric: new Metric({
      namespace: "AWS/S3",
      metricName: "BytesDownloaded",
      dimensionsMap: { BucketName: photosBucketName(props.envName, props.region, Aws.ACCOUNT_ID), FilterId: PHOTOS_METRICS_ID },
      statistic: "Sum",
      period: Duration.hours(1),
      region: props.region,
    }),
    threshold: PHOTOS_DOWNLOAD_ALARM_BYTES,
    evaluationPeriods: 1,
    comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
    treatMissingData: TreatMissingData.NOT_BREACHING,
  });
  props.topics.notify(alarm, "P2");
  return alarm;
}
