// Lambda entry point for the scheduled daily returns digest (see returns-digest-handler.ts).

import { createDb } from "../data/index.js";
import { mailerFromEnv } from "../email/mailer.js";
import { createObservability, withObservability } from "../observability/index.js";
import { OPS_ENV } from "./names.js";
import { createReturnsDigestHandler } from "./returns-digest-handler.js";

const obs = createObservability({ service: "ops" });
export const handler = withObservability(obs, createReturnsDigestHandler({ db: createDb({ tableName: process.env[OPS_ENV.tableName] }), obs, mailer: mailerFromEnv() }));
