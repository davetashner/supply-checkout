// Lambda entry point for the data API (see data-handler.ts). Everything that
// can be reused across invocations is built once per container, outside the
// handler: the STS client, the per-team DynamoDB clients and the logger.

import { createObservability, withObservability } from "../observability/index.js";
import { createDataHandler } from "./data-handler.js";
import { API_ENV } from "./routes.js";
import { sessionCheckFromEnv } from "./session-reset.js";
import { teamScopedDbs } from "./team-db.js";

const roleArn = process.env[API_ENV.dataRoleArn];
// Fail closed: without the scoped role there is no second layer of isolation
if (!roleArn) throw new Error(`${API_ENV.dataRoleArn} is not set`);

const obs = createObservability({ service: "data-api" });
export const handler = withObservability(obs, createDataHandler({ dbForTeam: teamScopedDbs({ roleArn }), obs, sessionCheck: sessionCheckFromEnv() }));
