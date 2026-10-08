// Team steps (J0.3). See tests/ui/app.js.

/** The team switcher in the header, shown to a member of more than one team. */
export const teamPicker = (page) => page.getByLabel("Team", { exact: true });

/** Switches to `team` (its ID or name), which loads the page again. */
export const switchTeam = (page, team) => teamPicker(page).selectOption(team);
