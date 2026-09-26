// Lambda entry point for the user pool's pre authentication trigger (see sign-in-guard-handler.ts).

import { createObservability, withObservability } from "../observability/index.js";
import { createSignInGuardHandler } from "./sign-in-guard-handler.js";

const obs = createObservability({ service: "sign-in" });
export const handler = withObservability(obs, createSignInGuardHandler({ obs }));
