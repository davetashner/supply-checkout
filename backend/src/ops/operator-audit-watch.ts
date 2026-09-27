// Lambda entry point for the operator audit watch (see operator-audit-watch-handler.ts).

import { createObservability, withObservability } from "../observability/index.js";
import { createOperatorAuditWatchHandler } from "./operator-audit-watch-handler.js";

const obs = createObservability({ service: "ops" });
export const handler = withObservability(obs, createOperatorAuditWatchHandler({ obs }));
