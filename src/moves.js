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
import { int, own, uid } from "./format.js";

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
// A receipt's lines for a client, added to a sheet that already exists (saveReceipt in
// src/main.js). items: { [key]: line }, each as a new line would be ({ code, name, price, cost
// each from the receipt, out: how many were bought, returned: 0 }). A line already on the sheet keeps its name, price
// and cost, and adds to its out. No stock moves: these were bought for the client and never were
// in storage. `action` is the receipt's destination, kept with the draft, so every attempt at
// saving it (Try again, or after a reload) adds each line once:
//
// - The web build's db sends the addLines command, all the lines or none, 40 to a request, each
//   request its own operation (docs/api/commands.md).
// - claude.ai's db has no commands or transactions, so the artifact build reads the sheet, adds
//   the lines to the latest copy, and saves them in one update with a mark saying this receipt
//   was saved (the sheet's `savedReceipts`). An attempt that finds its mark there already was
//   saved by an earlier one whose answer was lost, and writes nothing.
export const MAX_LINES = 40;
export async function addLines(db, action, sheetId, items) {
  const entries = Object.entries(items);
  // WEB: the artifact build leaves this path out, since claude.ai's db has no commands (src/build.js)
  if (WEB && db.addLines) {
    const parts = (action.parts ||= []);
    for (let i = 0; i < entries.length; i += MAX_LINES) {
      const lines = entries.slice(i, i + MAX_LINES).map(([productKey, l]) => ({ productKey, quantity: l.out, code: l.code, name: l.name, price: l.price, cost: l.cost }));
      await db.addLines(sheetId, lines, (parts[i / MAX_LINES] ||= {}));
    }
    return;
  }
  const ref = db.doc("sheets/" + sheetId), got = await ref.get();
  if (!got.exists) throw { code: "not_found" };
  const s = got.data(), mark = (action.mark ||= uid());
  if (own(s.savedReceipts || {}, mark)) return;
  const patch = {};
  for (const [key, it] of entries) {
    const cur = own(s.items || {}, key);
    patch[key] = cur ? { ...cur, code: cur.code || it.code, out: int(cur.out) + it.out, returned: int(cur.returned) } : it;
  }
  await ref.update({ items: patch, savedReceipts: { [mark]: true } });
}
export const setStock = (db, key, stock) => db.doc("products/" + key).update({ stock });

// Saving an item whose stock changes outside a sheet: the inventory form (someone counted
// storage) and a receipt's general-inventory lines (stock bought in). body is the whole item,
// with its new stock, which the artifact saves as it is. The web build's db saves the item
// without stock (the server keeps what's stored) and sends the change as the stock command,
// which records why stock changed (docs/api/commands.md). change: { reason: "count", count } (count undefined: not
// counted), or { reason: "receipt", lines: [{ action, quantity, unitCost }] }, one per receipt
// line, each line its own action. (`||`, not a condition: the artifact runs the right side.)
// WEB: the artifact build keeps only the right side, since claude.ai's db has no saveItem.
export const saveItem = (db, action, key, body, change) =>
  ((WEB && db.saveItem) || ((key, body) => db.doc("products/" + key).set(body)))(key, body, change, action);
