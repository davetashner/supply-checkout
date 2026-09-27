// The stuck-import check (supply-checkout-can), run on a schedule in the
// primary region.
//
// An inventory import commits in batches (data/imports.ts). If the commit
// stops part-way (the Lambda timed out, or items kept changing) and nobody
// retries it, the import stays half applied. The job is listed in GSI1's
// committing-imports partition until its last batch commits, so this check
// reads that one index partition, counts the jobs that started more than
// STUCK_IMPORT_AFTER_MINUTES ago, and sends the count as the StuckImports
// gauge, zero included, so the "Imports stuck" alarm (docs/journeys.md, J2)
// fires and recovers on its own. Each stuck job is logged with its team and
// import IDs and progress (IDs, never names or emails), for the runbook.
//
// Cost: one Query of a partition that is normally empty, every
// CHECK_EVERY_MINUTES. The function's role can read only that partition's
// keys and progress (infra/lib/observability/ops-checks.ts).

import { type Db, listStuckImports } from "../data/index.js";
import { BusinessMetric, type Observability } from "../observability/index.js";
import { MAX_LOGGED_STUCK_IMPORTS, STUCK_IMPORT_AFTER_MINUTES } from "./names.js";

export interface StuckImportsDeps {
  readonly db: Db;
  readonly obs: Observability;
  readonly now?: () => number;
}

export function createStuckImportsHandler(deps: StuckImportsDeps) {
  const { db, obs } = deps;
  const now = deps.now ?? Date.now;
  return async (): Promise<{ stuck: number }> => {
    const stuck = await listStuckImports(db, new Date(now() - STUCK_IMPORT_AFTER_MINUTES * 60_000));
    obs.gauge(BusinessMetric.StuckImports, stuck.length);
    for (const job of stuck.slice(0, MAX_LOGGED_STUCK_IMPORTS)) {
      obs.logger.warn("Import stuck", { teamId: job.teamId, importId: job.importId, startedAt: job.startedAt, committed: job.committed, total: job.total });
    }
    obs.logger.info("Checked imports", { stuck: stuck.length });
    return { stuck: stuck.length };
  };
}
