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
// Every run that could read the index, even one where teams fail, sends the
// ClosedTeamsOverdue gauge: the closed teams still there
// PURGE_OVERDUE_AFTER_HOURS after their deletion date, so the privacy
// deadline has its own alarm. It's counted with a count query on the index
// (countTeamsDueBefore), not from the listing, so it isn't capped at the
// listing's limit. A run that can't read the index sends no gauge, and
// neither does a purge that doesn't run at all: "Deletion job not running"
// alarms when the gauge's samples stop.
//
// Logs have team IDs and counts, never names or emails. The function's role
// may delete whole items and name only TEAM_PURGE_ATTRIBUTES
// (infra/lib/observability/ops-checks.ts).

import { countTeamsDueBefore, type Db, listTeamsToPurge, purgeTeam } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { PURGE_BUDGET_MS, PURGE_OVERDUE_AFTER_HOURS } from "./names.js";

export interface TeamPurgeDeps {
  readonly db: Db;
  readonly obs: Observability;
  readonly now?: () => number;
}

export function createTeamPurgeHandler(deps: TeamPurgeDeps) {
  const { db, obs } = deps;
  const now = deps.now ?? Date.now;
  return async (): Promise<{ purged: number; failed: number; due: number; overdue: number }> => {
    const started = now();
    const overdueBefore = new Date(started - PURGE_OVERDUE_AFTER_HOURS * 3_600_000).toISOString();
    // Counted before the listing, from the same index: every overdue team is also due, and they list first
    const overdueAtStart = await countTeamsDueBefore(db, new Date(overdueBefore));
    const due = await listTeamsToPurge(db, new Date(started));
    let purged = 0;
    let failed = 0;
    // Teams this run deleted, or found weren't due after all
    const done = new Set<string>();
    for (const team of due) {
      if (now() - started > PURGE_BUDGET_MS) break;
      try {
        const result = await purgeTeam(db, team.teamId, new Date(now()));
        done.add(team.teamId);
        if (result.skipped) continue;
        purged++;
        obs.logger.info("Team purged", { teamId: team.teamId, purgeAfter: team.purgeAfter, items: result.deleted });
      } catch (error) {
        failed++;
        obs.logger.error("Team purge failed", { teamId: team.teamId, error: (error as { name?: string } | null)?.name ?? "Unknown" });
      }
    }
    if (purged) obs.count(BusinessMetric.TeamsPurged, purged);
    // The overdue teams at the start less those this run deleted (or found weren't due). Not a
    // count after the run: the index is eventually consistent, and a team just deleted could still
    // be counted. ISO timestamps compare as strings.
    const cleared = due.filter((t) => t.purgeAfter < overdueBefore && done.has(t.teamId)).length;
    const overdue = Math.max(0, overdueAtStart - cleared);
    obs.gauge(BusinessMetric.ClosedTeamsOverdue, overdue);
    obs.logger.info("Purged closed teams", { due: due.length, purged, failed, overdue });
    // A run that failed anywhere fails, so the Lambda errors alarm sees it
    if (failed) throw new Error(`${failed} of ${due.length} closed teams weren't purged`);
    return { purged, failed, due: due.length, overdue };
  };
}
