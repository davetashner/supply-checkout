// Lambda entry point for the DynamoDB stream consumer (see publisher-handler.ts).
// The audience cache lives as long as the container.

import { createDb } from "../data/index.js";
import { createObservability, withObservability } from "../observability/index.js";
import { createAudience } from "./audience.js";
import { CONSUMER_DB_REQUEST_TIMEOUT_MS, PUBLISH_TIMEOUT_MS, REALTIME_ENV } from "./channels.js";
import { createEventsClient } from "./events-client.js";
import { createPublisherHandler } from "./publisher-handler.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const host = required(REALTIME_ENV.httpHost);
const obs = createObservability({ service: "live-updates" });
const publish = createEventsClient({ host, region: obs.region, timeoutMs: PUBLISH_TIMEOUT_MS });
// A request timeout, so a hung read is retried inside AUDIENCE_READ_TIMEOUT_MS
const audience = createAudience({ db: createDb({ tableName: required(REALTIME_ENV.tableName), requestTimeoutMs: CONSUMER_DB_REQUEST_TIMEOUT_MS }) });
export const handler = withObservability(obs, createPublisherHandler({ publish, audience, obs }));
