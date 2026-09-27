// The Stripe client for the functions that call Stripe, and the catalog script
// (ADR 0009). The secret key lives in AWS Secrets Manager only
// (supply-checkout/<env>/stripe/<mode>-secret-key, docs/infrastructure.md
// "Billing"): a function reads it once, when it first needs it, and keeps the
// client for an hour so a rotated key is picked up without a deploy.
//
// The key is never logged, printed, put in an error or a metric. Every error
// this file throws about it names the secret and the problem, never the value.

import { GetSecretValueCommand, SecretsManagerClient, type SecretsManagerClientConfig } from "@aws-sdk/client-secrets-manager";
import Stripe from "stripe";
import { STRIPE_ENV, STRIPE_MODES, type StripeMode } from "./names.js";

export { STRIPE_ENV, STRIPE_MODES, type StripeMode, stripeSecretName } from "./names.js";

// A Stripe secret key (sk_) or restricted key (rk_), test or live
const KEY = /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/;

/** The mode of a Stripe secret or restricted key, or undefined if it isn't one. */
export function keyMode(key: string): StripeMode | undefined {
  const match = KEY.exec(key);
  return match ? (match[2] as StripeMode) : undefined;
}

/**
 * The key in a secret's value: the value itself, or, for a JSON object, the
 * one field that holds a Stripe key. Throws, without the value, if there's
 * no key in it.
 */
export function keyFromSecret(value: string | undefined): string {
  const text = (value ?? "").trim();
  if (keyMode(text)) return text;
  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const keys = Object.values(typeof parsed === "object" && parsed !== null ? parsed : {}).filter((v): v is string => typeof v === "string" && keyMode(v.trim()) !== undefined);
    if (keys.length === 1) return (keys[0] as string).trim();
  }
  throw new Error("The Stripe secret doesn't hold a Stripe secret or restricted key");
}

/** The key, if it's of `mode`. A live key where test is expected (or the reverse) is refused. */
export function requireMode(key: string, mode: StripeMode): string {
  const actual = keyMode(key);
  if (actual !== mode) throw new Error(`The Stripe secret holds a ${actual ?? "non-Stripe"} key, not a ${mode}-mode key`);
  return key;
}

/** Reads a secret's string value by name or ARN. */
export type SecretReader = (secretId: string) => Promise<string | undefined>;

/** A reader on Secrets Manager in `region`, with the function's own credentials (or the script's). */
export function secretsManagerReader(region: string | undefined, credentials?: SecretsManagerClientConfig["credentials"]): SecretReader {
  const client = new SecretsManagerClient({ region, ...(credentials ? { credentials } : {}) });
  return async (secretId) => (await client.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString;
}

/** The Stripe client every caller uses: the SDK's pinned API version, a short timeout and one retry. */
export function createStripe(key: string): Stripe {
  return new Stripe(key, {
    apiVersion: Stripe.API_VERSION,
    maxNetworkRetries: 1,
    timeout: 5_000,
    telemetry: false,
    appInfo: { name: "supply-checkout" },
  });
}

/** How long a function keeps its client before reading the secret again. */
export const STRIPE_CLIENT_TTL_MS = 60 * 60_000;

export interface CachedStripeOptions<S> {
  readonly secretId: string;
  readonly mode: StripeMode;
  readonly read: SecretReader;
  /** Builds the client from the key (createStripe; tests pass a fake). */
  readonly create: (key: string) => S;
  readonly now?: () => number;
}

/**
 * The client, read from the secret on first use and again after
 * STRIPE_CLIENT_TTL_MS. Concurrent callers share one read, and a failed read
 * isn't kept, so the next request tries again.
 */
export function cachedStripe<S>(options: CachedStripeOptions<S>): () => Promise<S> {
  const now = options.now ?? Date.now;
  let current: { client: S; at: number } | undefined;
  let pending: Promise<S> | undefined;
  return () => {
    if (current && now() - current.at < STRIPE_CLIENT_TTL_MS) return Promise.resolve(current.client);
    pending ??= options
      .read(options.secretId)
      .then((value) => {
        const client = options.create(requireMode(keyFromSecret(value), options.mode));
        current = { client, at: now() };
        return client;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

/** The mode from the environment: `test` or `live`, and nothing else. */
export function stripeModeFrom(value: string | undefined): StripeMode {
  if (!STRIPE_MODES.includes(value as StripeMode)) throw new Error(`${STRIPE_ENV.mode} must be test or live`);
  return value as StripeMode;
}

/**
 * The fields of a Stripe error that are safe to log: its type, code, HTTP
 * status and request ID. Never its message or raw body, which can echo
 * request parameters.
 */
export function stripeErrorFields(error: unknown): Record<string, string | number> {
  if (!(error instanceof Stripe.errors.StripeError)) return { code: (error as { name?: string } | null)?.name ?? "Unknown" };
  const fields: Record<string, string | number> = { type: error.type };
  if (error.code) fields.code = error.code;
  if (typeof error.statusCode === "number") fields.status = error.statusCode;
  if (error.requestId) fields.requestId = error.requestId;
  return fields;
}
