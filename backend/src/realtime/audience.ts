// The stream consumer's view of who gets each team's changes (ADR 0016):
// the team's current members, or nobody once the team has ended. Read through
// liveUpdateRecipients and kept for AUDIENCE_TTL_MS, so a removed member or a
// canceled team stops getting notices within that time even if nothing else
// happens. The consumer also forgets a team as soon as the stream shows a
// change to its members or its META item, which usually makes it immediate.

import { type Db, liveUpdateRecipients } from "../data/index.js";
import { AUDIENCE_TTL_MS } from "./channels.js";

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
  /** For tests. */
  readonly read?: (db: Db, teamId: string) => Promise<string[]>;
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
  const cache = new Map<string, Entry>();
  return {
    recipients(teamId) {
      const hit = cache.get(teamId);
      if (hit && hit.expires > now()) return hit.users;
      const users = read(options.db, teamId);
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
