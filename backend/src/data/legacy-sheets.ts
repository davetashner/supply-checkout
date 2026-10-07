// The old "sheet" spellings, kept only for the sheets-to-projects rename's
// window (supply-checkout-005.6, docs/projects-rename-plan.md). Projects were
// called sheets: until the backfill has moved every item and old clients are
// gone, the server still reads and updates items stored under these names,
// and still accepts and sends them on the wire next to the new ones.
//
// Server release 2 (plan section 4, PR 6, "remove the sheets aliases")
// deletes this module and every use of it. Two files can't import it and
// repeat a literal under a LEGACY_ name, each checked against this one by a
// test: src/api/routes.ts and src/realtime/channels.ts (infra imports them).
// The backfill (projects-rename.ts) names both spellings itself, on purpose.

import { id } from "./keys.js";

export const legacy = {
  /** The sort-key prefix of a project the backfill hasn't moved yet: `SHEET#<projectId>`. */
  sheetPrefix: "SHEET#",
  /** The `type` of such an item. */
  sheetType: "sheet",
  /**
   * The collection's old name: the `/teams/{teamId}/sheets...` routes, the
   * data layer's collection name, and the copy of each realtime event.
   */
  sheetsCollection: "sheets",
  /** A project's key before the rename: read, and updated in place, until the backfill moves it; never used for a new item. */
  sheetKey: (teamId: string, projectId: string) => ({
    PK: `TEAM#${id(teamId, "team ID")}`,
    SK: `SHEET#${id(projectId, "project ID")}`,
  }),
  /** The date index partition of projects the backfill hasn't moved yet. */
  sheetsPartition: (teamId: string) => `TEAM#${id(teamId, "team ID")}#SHEETS`,
  /** A command request's old field names, each with its new name (the request fingerprint, commands.ts). */
  requestFields: { sheetId: "projectId", toSheetId: "toProjectId" },
  /** A command result's old field names, each with its new name: a response carries both. */
  resultFields: { sheetId: "projectId", toSheetId: "toProjectId", sheetCreated: "projectCreated" },
  /** A movement's old field names, each with its new name: stored on movements from before the rename, sent with both. */
  movementFields: { sheetId: "projectId", fromSheetId: "fromProjectId" },
} as const;
