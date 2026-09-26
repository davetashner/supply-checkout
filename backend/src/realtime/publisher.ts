// Lambda entry point for the DynamoDB stream consumer (see publisher-handler.ts).

import { createObservability, withObservability } from "../observability/index.js";
import { REALTIME_ENV } from "./channels.js";
import { createEventsClient } from "./events-client.js";
import { createPublisherHandler } from "./publisher-handler.js";

const host = process.env[REALTIME_ENV.httpHost];
if (!host) throw new Error(`${REALTIME_ENV.httpHost} is not set`);

const obs = createObservability({ service: "live-updates" });
const publish = createEventsClient({ host, region: obs.region });
export const handler = withObservability(obs, createPublisherHandler({ publish, obs }));
