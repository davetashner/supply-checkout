// Lambda entry point for the deletion records watch (see watch-handler.ts).

import { S3Client } from "@aws-sdk/client-s3";
import { createObservability, withObservability } from "../observability/index.js";
import { DELETIONS_ENV } from "./names.js";
import { createDeletionRecordsWatchHandler } from "./watch-handler.js";

const obs = createObservability({ service: "ops" });
const bucket = process.env[DELETIONS_ENV.bucket];
const region = process.env[DELETIONS_ENV.region];
if (!bucket || !region) throw new Error(`${DELETIONS_ENV.bucket} and ${DELETIONS_ENV.region} must be set`);
export const handler = withObservability(obs, createDeletionRecordsWatchHandler({ obs, s3: new S3Client({ region }), bucket }));
