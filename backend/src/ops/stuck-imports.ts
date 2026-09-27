// Lambda entry point for the scheduled stuck-import check (see stuck-imports-handler.ts).

import { createDb } from "../data/index.js";
import { createObservability, withObservability } from "../observability/index.js";
import { OPS_ENV } from "./names.js";
import { createStuckImportsHandler } from "./stuck-imports-handler.js";

const obs = createObservability({ service: "ops" });
const db = createDb({ tableName: process.env[OPS_ENV.tableName] });
export const handler = withObservability(obs, createStuckImportsHandler({ db, obs }));
