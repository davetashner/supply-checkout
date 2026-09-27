// The stream consumer's view of who gets each team's changes (ADR 0016):
// the team's current members, or nobody once the team has ended. Read through
// liveUpdateRecipients and kept for AUDIENCE_TTL_MS, so a removed member or a
// canceled team stops getting notices within that time even if nothing else
// happens. The consumer also forgets a team as soon as the stream shows a
// change to its members or its META item, which usually makes it immediate.
// A read that takes longer than AUDIENCE_READ_TIMEOUT_MS fails (and is
// aborted), so a slow DynamoDB can't hold an invocation past its timeout.

import { type Db, liveUpdateRecipients } from "../data/index.js";
import { AUDIENCE_READ_TIMEOUT_MS, AUDIENCE_TTL_MS } from "./channels.js";

export interface Audience {
  /** The user IDs to publish the team's changes to. Throws if they can't be read. */
  recipients(teamId: string): Promise<readonly string[]>;
  /** Drops the team's cached recipients, so the next call reads them again. */
  forget(teamId: string): void;
}

export interface AudienceOptions {
  readonly db: Db;
  readonly ttlMs?: number;
  readonly now?: () => number;
  /** How many teams to keep. The oldest entry goes first. */
  readonly maxTeams?: number;
  /** How long one read may take before it fails, in milliseconds. */
  readonly readTimeoutMs?: number;
  /** For tests. */
  readonly read?: (db: Db, teamId: string, now: Date, signal: AbortSignal) => Promise<string[]>;
}

export class AudienceReadTimeout extends Error {
  override readonly name = "AudienceReadTimeout";
}

/** `read`, failing (and aborting it) if it takes longer than `ms`. */
function withDeadline<T>(ms: number, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new AudienceReadTimeout(`Reading the team's members took over ${ms} ms`);
      controller.abort(error);
      reject(error);
    }, ms);
  });
  return Promise.race([read(controller.signal), deadline]).finally(() => clearTimeout(timer));
}

interface Entry {
  readonly expires: number;
  readonly users: Promise<readonly string[]>;
}

export function createAudience(options: AudienceOptions): Audience {
  const ttl = options.ttlMs ?? AUDIENCE_TTL_MS;
  const now = options.now ?? Date.now;
  const max = options.maxTeams ?? 1000;
  const read = options.read ?? liveUpdateRecipients;
  const readTimeout = options.readTimeoutMs ?? AUDIENCE_READ_TIMEOUT_MS;
  const cache = new Map<string, Entry>();
  return {
    recipients(teamId) {
      const hit = cache.get(teamId);
      if (hit && hit.expires > now()) return hit.users;
      const users = withDeadline(readTimeout, (signal) => read(options.db, teamId, new Date(), signal));
      const entry = { expires: now() + ttl, users };
      cache.delete(teamId);
      cache.set(teamId, entry);
      if (cache.size > max) cache.delete(cache.keys().next().value as string);
      // A failed read isn't kept: the retry reads again
      users.catch(() => {
        if (cache.get(teamId) === entry) cache.delete(teamId);
      });
      return users;
    },
    forget(teamId) {
      cache.delete(teamId);
    },
  };
}
