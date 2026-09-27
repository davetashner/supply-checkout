// The closed-team purge (supply-checkout-b1h), run on a schedule in the
// primary region.
//
// An owner closing a team (data/teams.ts, closeTeam) leaves it read-only for
// CLOSED_TEAM_RETENTION_DAYS, so it can be exported, and lists it in GSI1's
// closed-teams partition by when it's due. Each run reads the teams that are
// due, earliest first, and deletes each one (data/team-purge.ts): its whole
// partition, its members' team-switcher rows and its Stripe link, the META
// item last. It starts no new team after PURGE_BUDGET_MS, and a team it
// didn't finish (the timeout) is still listed, so the next run carries on.
// One team's failure is logged and counted, and the others still go.
//
// Logs have team IDs and counts, never names or emails. The function's role
// may delete whole items and name only TEAM_PURGE_ATTRIBUTES
// (infra/lib/observability/ops-checks.ts).

import { type Db, listTeamsToPurge, purgeTeam } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { PURGE_BUDGET_MS } from "./names.js";

export interface TeamPurgeDeps {
  readonly db: Db;
  readonly obs: Observability;
  readonly now?: () => number;
}

export function createTeamPurgeHandler(deps: TeamPurgeDeps) {
  const { db, obs } = deps;
  const now = deps.now ?? Date.now;
  return async (): Promise<{ purged: number; failed: number; due: number }> => {
    const started = now();
    const due = await listTeamsToPurge(db, new Date(started));
    let purged = 0;
    let failed = 0;
    for (const team of due) {
      if (now() - started > PURGE_BUDGET_MS) break;
      try {
        const result = await purgeTeam(db, team.teamId, new Date(now()));
        if (result.skipped) continue;
        purged++;
        obs.logger.info("Team purged", { teamId: team.teamId, purgeAfter: team.purgeAfter, items: result.deleted });
      } catch (error) {
        failed++;
        obs.logger.error("Team purge failed", { teamId: team.teamId, error: (error as { name?: string } | null)?.name ?? "Unknown" });
      }
    }
    if (purged) obs.count(BusinessMetric.TeamsPurged, purged);
    obs.logger.info("Purged closed teams", { due: due.length, purged, failed });
    // A run that failed anywhere fails, so the Lambda errors alarm sees it
    if (failed) throw new Error(`${failed} of ${due.length} closed teams weren't purged`);
    return { purged, failed, due: due.length };
  };
}
