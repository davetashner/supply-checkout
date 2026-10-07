// The long-lived journey teams' settings (supply-checkout-o60.7). J2.5's prod test sets the
// equipment markup to MARKUP_SENTINEL, a value only that test uses, and puts the team's own value
// back when it's done. If the run dies before it can, the team is left on the sentinel, and
// cleanup (and the next J2.5 test) puts it back to the journey teams' markup, BASELINE_MARKUP.
// Nothing here touches a markup that isn't the sentinel.

/** The equipment markup (percent) J2.5's prod test sets: never a journey team's own value. */
export const MARKUP_SENTINEL = 12.34;

/** The long-lived journey teams' equipment markup: the app's default, 0% (docs/journeys.md, J2.5). */
export const BASELINE_MARKUP = 0;

/**
 * Puts a long-lived team's equipment markup back to the baseline if J2.5's test left it on the
 * sentinel. `api` is the long-lived owner's (lib/api.mjs). Returns true if it changed anything.
 */
export async function resetMarkup(api, teamId) {
  const res = await api.getSettings(teamId);
  if (res?.settings?.equipmentMarkup !== MARKUP_SENTINEL) return false;
  await api.putSettings(teamId, BASELINE_MARKUP, res.version);
  return true;
}
