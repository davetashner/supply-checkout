// Lambda entry point for the sign-in session endpoints (see auth-handler.ts).

import { createObservability, withObservability } from "../observability/index.js";
import { createAuthHandler } from "./auth-handler.js";
import { API_ENV } from "./routes.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const obs = createObservability({ service: "auth-api" });
const config = {
  authUrl: required(API_ENV.authUrl),
  clientId: required(API_ENV.clientId),
  allowedOrigins: required(API_ENV.allowedOrigins).split(",").map((s) => s.trim()).filter(Boolean),
};
export const handler = withObservability(obs, createAuthHandler({ config, obs }));
