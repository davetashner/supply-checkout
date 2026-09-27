// Checking items out to a sheet and returning them. Every checkout and return goes through here.
//
// The web build's db (src/aws/db.js) has `command`: one request that changes the sheet line and
// the storage count together, adding on the server, so two people checking out at once can't
// lose a count and a retry can't count twice (docs/api/commands.md). claude.ai's db doesn't, so
// the artifact build writes the sheet line, then the storage count (addStock below, a
// read-then-write), as one attempt: if the storage count fails, trying again finds the line
// saved and writes only the storage count.
//
// `action` is one object per action the person confirms (one checkout or return form). The web
// build's db gives each action an operation ID, and sends the same one on every attempt at the
// same request, so a retry or a second tap is applied once.
//
// The request depends only on what the person entered, never on the latest copy of the sheet,
// so a retry after a live update is still the same request.
//
// Each resolves, once the sheet and the storage count have saved, to { quantity, line }: for a
// return, how many came back and the line as it is now.
import { WEB } from "./build.js";
import { int, own, uid, hasStock } from "./format.js";

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

// plan(cur): what the artifact writes, from the line as it's saved now (cur, undefined if there's
// none), so the quantity is added to the latest line even if this page hasn't heard of someone
// else's change yet: { patch, delta } (the line's change and the storage count's), and for a
// return what it resolves to. partial: a return, which changes part of the line.
async function move(db, action, command, sheetId, body, partial, plan) {
  // WEB: the artifact build leaves this path out, since claude.ai's db has no commands (src/build.js)
  if (WEB && db.command) return db.command(command, sheetId, body, action);
  // As with the web build's operation IDs, a changed request (another quantity) is a new action
  const key = body.productKey, request = JSON.stringify([command, sheetId, body]), ref = db.doc("sheets/" + sheetId);
  if (action.request !== request) Object.assign(action, { request, mark: uid() });
  const mark = action.mark;
  return attempt(action, async () => {
    const got = await ref.get();
    if (!got.exists) throw { code: "not_found" };
    const cur = own(got.data().items || {}, key);
    // Saved already: what's left is what that attempt left to do, its storage count
    if (!marked(cur, mark)) {
      // A return changes part of the line, so it doesn't make a line someone else removed again
      if (!cur && partial) throw { code: "refused", message: "Someone else removed this item from the sheet, so the return wasn't saved." };
      const local = plan(cur);
      saved.set(action, local);
      await ref.update({ items: { [key]: { ...local.patch, ops: remember(cur, mark) } } });
      // Until the storage count saves too, the form can't change the request (src/main.js)
      action.due = true;
    }
    const done = saved.get(action);
    await addStock(db, key, done.delta, mark);
    action.due = false;
    return done;
  });
}

// The artifact's storage count: adds delta (or takes it away) to the stock saved now, with the
// action's mark on the item, so trying again after a lost answer adds nothing. An item nobody
// has counted stays uncounted when taking away, and one someone deleted isn't made again.
async function addStock(db, key, delta, mark) {
  const ref = db.doc("products/" + key), got = await ref.get(), cur = got.exists ? got.data() : undefined;
  if (!delta || !cur || marked(cur, mark) || (!hasStock(cur) && delta < 0)) return;
  await ref.update({ stock: Math.max(0, (hasStock(cur) ? cur.stock : 0) + delta), ops: remember(cur, mark) });
}

// item: the line as this page has it with the checkout added (its name, price and cost; the
// artifact adds qty to the saved line's out). oneOff: the name, price and code of an item that
// isn't in inventory, which the command needs to add its line ({} for an item in inventory).
export const checkOut = (db, action, sheetId, key, qty, item, oneOff) =>
  move(db, action, "checkout", sheetId, { productKey: key, quantity: qty, ...oneOff }, false,
    cur => ({ patch: { ...item, out: int(cur && cur.out) + qty, returned: int(cur && cur.returned) }, delta: -qty }));
// r: how many the person is returning. The command adds it on the server, which refuses more
// than are left. The artifact writes the line's new returned count, added to the line as it's
// saved now, in case someone else recorded a return meanwhile.
export const recordReturn = (db, action, sheetId, key, r) =>
  move(db, action, "return", sheetId, { productKey: key, quantity: r }, true, cur => {
    const out = int(cur.out), before = Math.min(int(cur.returned), out), back = Math.min(out, before + r);
    return { patch: { returned: back }, delta: back - before, quantity: back - before, line: { out, returned: back } };
  });
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
