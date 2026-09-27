// Lambda entry point for the operator reopen function (see reopen-handler.ts).
// Its own role can't reach the table: per request it assumes the
// operator-reopen role, tagged with the team, which may read and update only
// that team's REOPEN_ATTRIBUTES and append to that team's operator audit.

import { API_ENV } from "../api/routes.js";
import { createObservability, withObservability } from "../observability/index.js";
import { opsScopedDbs } from "./ops-db.js";
import { createReopenHandler } from "./reopen-handler.js";

const roleArn = process.env[API_ENV.opsReopenRoleArn];
// Fail closed: without it there's no scoped role
if (!roleArn) throw new Error(`${API_ENV.opsReopenRoleArn} is not set`);
const obs = createObservability({ service: "ops-reopen" });
export const handler = withObservability(obs, createReopenHandler({ dbFor: opsScopedDbs({ roleArn }), obs }));
