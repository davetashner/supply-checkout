// Lambda entry point for the scheduled closed-team purge (see team-purge-handler.ts).

import { createDb } from "../data/index.js";
import { deletionLogFromEnv } from "../deletions/records.js";
import { createObservability, withObservability } from "../observability/index.js";
import { OPS_ENV } from "./names.js";
import { createTeamPurgeHandler } from "./team-purge-handler.js";

const obs = createObservability({ service: "ops" });
const db = createDb({ tableName: process.env[OPS_ENV.tableName] });
export const handler = withObservability(obs, createTeamPurgeHandler({ db, obs, deletions: deletionLogFromEnv() }));
