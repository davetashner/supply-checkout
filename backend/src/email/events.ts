// Lambda entry point for SES bounce and complaint events (see events-handler.ts).

import { createDb } from "../data/index.js";
import { createObservability, withObservability } from "../observability/index.js";
import { createEmailEventsHandler } from "./events-handler.js";

const obs = createObservability({ service: "email-events" });
const db = createDb();
export const handler = withObservability(obs, createEmailEventsHandler({ db, obs }));
