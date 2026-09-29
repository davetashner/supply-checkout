// Lambda entry point for the nightly seat reconciliation (see seat-reconcile-handler.ts).

import { createDb } from "../data/index.js";
import { createObservability, withObservability } from "../observability/index.js";
import { OPS_ENV } from "./names.js";
import { createSeatReconcileHandler } from "./seat-reconcile-handler.js";

const queueUrl = process.env[OPS_ENV.seatQueueUrl];
if (!queueUrl) throw new Error(`${OPS_ENV.seatQueueUrl} is not set`);
const obs = createObservability({ service: "ops" });
const db = createDb({ tableName: process.env[OPS_ENV.tableName] });
export const handler = withObservability(obs, createSeatReconcileHandler({ db, queueUrl, obs }));
