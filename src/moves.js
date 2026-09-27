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
import { int, own, uid, hasStock } from "./format.js";

const nothing = async () => true;

// claude.ai's db has no transactions or conditional writes, so the artifact build makes each
// action's write detectable instead: it saves a mark for the action (a random ID) in the same
// update as the change, on the line or item it changes (`ops`, the last MAX_MARKS marks, newest
// last). An attempt that finds its action's mark there was already saved by an earlier one whose
// answer was lost, and writes nothing. A write that timed out may still land, so each attempt
// waits for the one before it to answer first (in this page: `pending`). Marks are kept out of
// exports (src/export.js).
export const MAX_MARKS = 10;
const ops = doc => (doc && Array.isArray(doc.ops) ? doc.ops : []);
const marked = (doc, mark) => ops(doc).includes(mark);
const remember = (doc, ...marks) => [...ops(doc), ...marks].slice(-MAX_MARKS);
// An action's mark, made once. saveReceipt makes them before it writes, so a draft saved
// meanwhile keeps them after a reload.
export const markOf = action => (action.mark ||= uid());
const pending = new WeakMap(), saved = new WeakMap();
function attempt(action, fn) {
  const next = (pending.get(action) || Promise.resolve()).catch(() => {}).then(fn);
  pending.set(action, next);
  return next;
}

async function move(db, action, command, sheetId, body, local) {
  // WEB: the artifact build leaves this path out, since claude.ai's db has no commands (src/build.js)
  if (WEB && db.command) return { after: nothing, ...(await db.command(command, sheetId, body, action)) };
  // As with the web build's operation IDs, a changed request (another quantity) is a new action
  const key = body.productKey, request = JSON.stringify([command, sheetId, body]), ref = db.doc("sheets/" + sheetId);
  if (action.request !== request) Object.assign(action, { request, mark: uid() });
  const mark = action.mark;
  return attempt(action, async () => {
    const got = await ref.get();
    if (!got.exists) throw { code: "not_found" };
    const cur = own(got.data().items || {}, key);
    // Saved already: what's left is what that attempt left to do (its storage count)
    if (marked(cur, mark)) return saved.get(action);
    saved.set(action, local);
    await ref.update({ items: { [key]: { ...local.patch, ops: remember(cur, mark) } } });
    return local;
  });
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
//   the lines to the latest copy, and saves them in one update with the destination's mark on
//   each line (see move above). An attempt that finds its mark on any of them was already saved
//   by an earlier one whose answer was lost, and writes nothing.
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
  const ref = db.doc("sheets/" + sheetId), mark = markOf(action);
  return attempt(action, async () => {
    const got = await ref.get();
    if (!got.exists) throw { code: "not_found" };
    const had = got.data().items || {};
    if (entries.some(([key]) => marked(own(had, key), mark))) return;
    const patch = {};
    for (const [key, it] of entries) {
      const cur = own(had, key);
      patch[key] = { ...(cur ? { ...cur, code: cur.code || it.code, out: int(cur.out) + it.out, returned: int(cur.returned) } : it), ops: remember(cur, mark) };
    }
    await ref.update({ items: patch });
  });
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
  ((WEB && db.saveItem) || ((key, body) => setItem(db, key, body, change)))(key, body, change, action);
// The artifact build's save. Stock bought in on a receipt is added to what's stored, with the
// lines' marks (see move above): a retry after a lost answer finds them and adds nothing. The
// lines are saved together, so finding any one's mark means they all were.
function setItem(db, key, body, change) {
  const ref = db.doc("products/" + key), acts = change.reason === "receipt" ? change.lines.map(l => l.action) : [];
  if (!acts.length) return ref.set(body);
  const marks = acts.map(markOf);
  return attempt(acts[0], async () => {
    const got = await ref.get(), cur = got.exists ? got.data() : undefined;
    if (marks.some(m => marked(cur, m))) return;
    // Added to the stock saved now, in case it changed since the app's copy
    const stock = (hasStock(cur) ? cur.stock : 0) + change.lines.reduce((a, l) => a + l.quantity, 0);
    await ref.set({ ...body, stock, ops: remember(cur, ...marks) });
  });
}
