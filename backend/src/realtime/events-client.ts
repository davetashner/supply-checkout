// Publishes to AppSync Events over HTTP, signed with the Lambda's role (IAM).
// Only the stream consumer publishes: the `users` namespace allows publishing
// with IAM alone, and only the consumer's role has appsync:EventPublish.
//
// POST https://<http host>/event with {"channel": "/users/<id>", "events": [<JSON string>, ...]}
// answers 200 with {"successful": [{identifier, index}], "failed": [{identifier, index, code, message}]}.

import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@smithy/types";
import { EVENTS_PER_PUBLISH } from "./channels.js";

export interface PublishResult {
  /** Indexes (into the events passed in) that AppSync accepted. */
  readonly successful: readonly number[];
  /** Indexes AppSync refused, with its reason. */
  readonly failed: readonly { readonly index: number; readonly code?: string; readonly message?: string }[];
}

/** Publishes up to EVENTS_PER_PUBLISH events to one channel. Throws if the request fails as a whole. */
export type Publish = (channel: string, events: readonly string[]) => Promise<PublishResult>;

export interface EventsClientOptions {
  /** The Event API's HTTP host, e.g. `<id>.appsync-api.<region>.amazonaws.com`. */
  readonly host: string;
  readonly region: string;
  /** Defaults to the Lambda's role. */
  readonly credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  /** For tests. */
  readonly fetch?: typeof fetch;
  /** Per request. */
  readonly timeoutMs?: number;
}

export class PublishError extends Error {
  override readonly name = "PublishError";
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const Sha256 = Hash.bind(null, "sha256");

interface Answer {
  readonly successful?: { readonly index?: unknown }[];
  readonly failed?: { readonly index?: unknown; readonly code?: unknown; readonly errorCode?: unknown; readonly message?: unknown; readonly errorMessage?: unknown }[];
}

const str = (...values: unknown[]) => values.find((v): v is string => typeof v === "string");

export function createEventsClient(options: EventsClientOptions): Publish {
  const signer = new SignatureV4({
    service: "appsync",
    region: options.region,
    credentials: options.credentials ?? defaultProvider(),
    sha256: Sha256,
  });
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;

  return async (channel, events) => {
    if (events.length === 0) return { successful: [], failed: [] };
    if (events.length > EVENTS_PER_PUBLISH) throw new PublishError(`At most ${EVENTS_PER_PUBLISH} events per publish`);
    const body = JSON.stringify({ channel, events });
    const signed = await signer.sign({
      method: "POST",
      protocol: "https:",
      hostname: options.host,
      path: "/event",
      headers: { host: options.host, "content-type": "application/json" },
      body,
      query: {},
    });
    let response: Response;
    try {
      response = await doFetch(`https://${options.host}/event`, {
        method: "POST",
        headers: signed.headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PublishError(`Publish request failed: ${(error as Error).message}`);
    }
    const text = await response.text();
    if (!response.ok) throw new PublishError(`Publish failed with HTTP ${response.status}: ${text.slice(0, 200)}`, response.status);
    let answer: Answer;
    try {
      answer = JSON.parse(text) as Answer;
    } catch {
      throw new PublishError("Publish answered with something other than JSON", response.status);
    }
    const index = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : -1);
    return {
      successful: (answer.successful ?? []).map((s) => index(s.index)),
      failed: (answer.failed ?? []).map((f) => ({ index: index(f.index), code: str(f.code, f.errorCode), message: str(f.message, f.errorMessage) })),
    };
  };
}
