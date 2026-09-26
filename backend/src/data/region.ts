// Where data lives and where writes go (ADR 0010). No region names appear in
// code: the running region comes from AWS_REGION, which Lambda sets.

/** The region this code runs in. */
export function localRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  if (!region) throw new Error("AWS_REGION is not set");
  return region;
}

/** What routing needs to know about a team. */
export interface HomedTeam {
  readonly teamId: string;
  /** The region the team was created in; its writes belong there once there are two. */
  readonly homeRegion: string;
}

/**
 * The one place that decides which region takes a team's writes.
 *
 * MVP: always the local region, because there is only one. Phase 2 returns
 * `team.homeRegion` (so each team's counters and sheets have one writer and
 * global-table last-writer-wins can't lose updates), or the local region when
 * the home region is unhealthy.
 */
export function writeRegionFor(team: HomedTeam, local: string): string {
  void team;
  return local;
}
