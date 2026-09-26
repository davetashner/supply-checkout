// Checking items out to a sheet and returning them. Every checkout and return goes through here.
//
// The web build's db (src/aws/db.js) has `command`: one request that changes the sheet line and
// the storage count together, adding on the server, so two people checking out at once can't
// lose a count and a retry can't count twice (docs/api/commands.md). claude.ai's db doesn't, so
// the artifact build writes the sheet line, then the storage count (bumpStock in src/main.js, a
// read-then-write).
//
// `action` is one object per action the person confirms (one checkout or return form). The web
// build's db gives each action an operation ID, and sends the same one on every attempt at the
// same request, so a retry or a second tap is applied once.
//
// The request depends only on what the person entered, never on the latest copy of the sheet,
// so a retry after a live update is still the same request.
//
// Each resolves, once the sheet has saved, to { after, quantity, line }: what's left to do (the
// artifact's storage count write, or nothing, since the command moved stock already), and for
// a return, how many came back and the line as it is now. (Not `then`: an object with a
// `then` method is a thenable, and awaiting it would call it.)
import { WEB } from "./build.js";
import { int } from "./format.js";

const nothing = async () => true;

async function move(db, action, command, sheetId, body, local) {
  // WEB: the artifact build leaves this path out, since claude.ai's db has no commands (src/build.js)
  if (WEB && db.command) return { after: nothing, ...(await db.command(command, sheetId, body, action)) };
  await db.doc("sheets/" + sheetId).update({ items: { [body.productKey]: local.patch } });
  return local;
}

// item: the whole line as it should be now. oneOff: the name, price and code of an item that
// isn't in inventory, which the command needs to add its line ({} for an item in inventory).
export const checkOut = (db, action, sheetId, key, qty, item, oneOff, bumpStock) =>
  move(db, action, "checkout", sheetId, { productKey: key, quantity: qty, ...oneOff }, { patch: item, after: () => bumpStock(key, -qty) });
// r: how many the person is returning. The command adds it on the server, which refuses more
// than are left. The artifact writes the line's new returned count, added to the latest copy
// of the line (cur), in case someone else recorded a return meanwhile.
export function recordReturn(db, action, sheetId, key, r, cur, bumpStock) {
  const out = int(cur.out), before = Math.min(int(cur.returned), out), back = Math.min(out, before + r);
  return move(db, action, "return", sheetId, { productKey: key, quantity: r },
    { patch: { returned: back }, after: () => bumpStock(key, back - before), quantity: back - before, line: { out, returned: back } });
}
export const setStock = (db, key, stock) => db.doc("products/" + key).update({ stock });
