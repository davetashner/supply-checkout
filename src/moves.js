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
// Each resolves, once the sheet has saved, to what's left to do: the artifact's storage count
// write, or nothing (the command moved stock already).
const nothing = async () => true;

async function move(db, action, command, sheetId, body, line, stock) {
  if (db.command) { await db.command(command, sheetId, body, action); return nothing; }
  await db.doc("sheets/" + sheetId).update({ items: { [body.productKey]: line } });
  return stock;
}

// item: the whole line as it should be now. oneOff: the name, price and code of an item that
// isn't in inventory, which the command needs to add its line ({} for an item in inventory).
export const checkOut = (db, action, sheetId, key, qty, item, oneOff, bumpStock) =>
  move(db, action, "checkout", sheetId, { productKey: key, quantity: qty, ...oneOff }, item, () => bumpStock(key, -qty));
// before and back: how many of the line were returned before this return, and after it
export const recordReturn = (db, action, sheetId, key, before, back, bumpStock) =>
  move(db, action, "return", sheetId, { productKey: key, quantity: back - before }, { returned: back }, () => bumpStock(key, back - before));
export const setStock = (db, key, stock) => db.doc("products/" + key).update({ stock });
