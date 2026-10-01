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
import { int, own, uid, hasStock, round2 } from "./format.js";

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
// return what it resolves to. partial: what a change to part of the line is called (a return),
// which doesn't make a line someone else removed again; false for a checkout.
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
      if (!cur && partial) throw { code: "refused", message: `Someone else removed this item from the sheet, so the ${partial} wasn't saved.` };
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
    cur => {
      // A line moved off the ad hoc sheet left a marker (moveLine below): taking it again starts afresh
      const live = cur && !cur.moved ? cur : undefined;
      return { patch: { ...item, out: int(live && live.out) + qty, returned: int(live && live.returned), ...(cur && cur.moved ? { moved: false, lost: 0 } : {}) }, delta: -qty };
    });
// r: how many the person is returning. The command adds it on the server, which refuses more
// than are left. The artifact writes the line's new returned count, added to the line as it's
// saved now, in case someone else recorded a return meanwhile.
export const recordReturn = (db, action, sheetId, key, r) =>
  move(db, action, "return", sheetId, { productKey: key, quantity: r }, "return", cur => {
    // Never past what's neither back nor lost (company equipment lost or broken, ADR 0017)
    const out = int(cur.out), before = Math.min(int(cur.returned), out), back = Math.max(before, Math.min(out - int(cur.lost), before + r));
    return { patch: { returned: back }, delta: back - before, quantity: back - before, line: { out, returned: back } };
  });
// Company equipment lost or broken on the job (ADR 0017, section 3): q of the line's pieces
// still out, and what the client is charged for them (charge, dollars for the lot; undefined:
// nothing). Stock doesn't move: it went down when they were taken. The web build's db sends
// the lost command; the artifact writes the line's lost and lostCharge, added to the line as
// it's saved now, never past what's still out, with the action's mark (see move above).
export const markLost = (db, action, sheetId, key, q, charge) =>
  move(db, action, "lost", sheetId, { productKey: key, quantity: q, ...(charge === undefined ? {} : { charge }) }, "change", cur => {
    const out = int(cur.out), back = Math.min(int(cur.returned), out), before = Math.min(int(cur.lost), out - back);
    const lost = Math.min(out - back, before + q);
    return { patch: { lost, ...(charge === undefined ? {} : { lostCharge: round2((Number(cur.lostCharge) || 0) + charge) }) }, delta: 0, quantity: lost - before };
  });

// Quick take (ADR 0017, section 4): a checkout onto the team's open ad hoc sheet, without choosing
// a sheet. start: { id, body, date }, the sheet it aims at (the open ad hoc sheet this page holds,
// or the next `adhoc-<n>`), the sheet to make if it isn't there, and the person's date. Resolves
// to the checkout's answer and the sheet it went on (sheetId).
//
// - The web build's db sends the quick-take command, which picks the sheet on the server, in the
//   checkout's transaction, so two first takes at once end on one sheet (docs/api/commands.md).
// - claude.ai's db has no transactions, so the artifact build reads the sheet it aims at, makes it
//   if it isn't there (a `set` with no lines), or moves on to the next number if someone finished
//   it meanwhile, then adds the line as a checkout does, with the action's mark. A `set` can't be
//   conditional, so one from another page that read before this line landed can wipe it: the
//   take reads the sheet again and, if its mark isn't there, writes the line again. Stock is
//   right either way: its mark is on the item (addStock).
export async function quickTake(db, action, key, qty, item, oneOff, start) {
  // WEB: the artifact build leaves this path out, since claude.ai's db has no commands (src/build.js)
  if (WEB && db.quickTake) return db.quickTake({ productKey: key, quantity: qty, ...oneOff, date: start.date }, action);
  let id = action.sheetId || start.id;
  for (;;) {
    const got = await db.doc("sheets/" + id).get();
    if (!got.exists) await db.doc("sheets/" + id).set(start.body);
    // Finished by someone else meanwhile: the next one
    else if (got.data().status === "closed") { id = "adhoc-" + (Number(id.slice(6)) + 1); continue; }
    break;
  }
  action.sheetId = id;
  const take = () => checkOut(db, action, id, key, qty, item, oneOff);
  let done = await take();
  const after = await db.doc("sheets/" + id).get();
  if (!marked(own(Object(after.data().items), key), action.mark)) done = await take();
  return { ...done, sheetId: id };
}

// Moving a whole line from the open ad hoc sheet to an open job sheet (ADR 0017, section 5): its
// counts go onto the job sheet's line for the item, which keeps its own price, or the line goes
// as it is, with the price it was taken at. Stock doesn't move: it left storage at the quick take.
//
// - The web build's db sends the move command: both sheets change in one transaction.
// - The artifact build makes two writes with the move's mark: the counts onto the job sheet, then
//   the ad hoc line replaced by a hidden "moved" marker (shown nowhere, left out of exports, as a
//   removed line is). A retry that finds the mark on the job sheet skips the first write, and one
//   that finds it on the ad hoc line writes nothing.
export async function moveLine(db, action, fromId, key, toId) {
  // WEB: the artifact build leaves this path out, since claude.ai's db has no commands (src/build.js)
  if (WEB && db.moveLine) return db.moveLine(fromId, key, toId, action);
  const mark = markOf(action), from = db.doc("sheets/" + fromId), to = db.doc("sheets/" + toId);
  return attempt(action, async () => {
    // A sheet that's gone has no lines (data() is undefined)
    const line = own(Object(Object((await from.get()).data()).items), key);
    if (!line || (line.moved && !marked(line, mark))) throw { code: "refused", message: "Someone else moved or removed this line, so it wasn't moved." };
    if (marked(line, mark)) return;
    const there = await to.get();
    if (!there.exists) throw { code: "not_found" };
    const cur = own(Object(there.data().items), key);
    if (!marked(cur, mark)) {
      if (cur && cur.kind !== line.kind) throw { code: "refused", message: "That sheet has this item as the other kind (a supply, or company equipment), so it wasn't moved. Correct the lines by hand." };
      const moved = { ...line, ops: [mark] };
      const added = cur && { out: int(cur.out) + int(line.out), returned: int(cur.returned) + int(line.returned), ...(line.lost ? { lost: int(cur.lost) + int(line.lost) } : {}), ops: remember(cur, mark) };
      await to.update({ items: { [key]: added || moved } });
    }
    await from.update({ items: { [key]: { moved: toId, out: 0, returned: 0, lost: 0, ops: remember(line, mark) } } });
  });
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
//
// bought: company equipment bought for the client (ADR 0017, section 2a), { [productKey]: { code,
// name, cost: the receipt price each, out, typed?: a price the reviewer typed, by?: who typed it } }.
// Each goes on a line of its own, `<productKey>:bought`, marked purchased, apart from the same
// item on loan. The web build sends the receipt price, and a price only with priceSet "manual":
// the server works out the team's markup itself. The artifact build has no markup: the line
// is charged the receipt price, or the typed price, which says who typed it and when.
export async function addLines(db, action, sheetId, items, bought = {}) {
  // WEB: the artifact build leaves this path out, since claude.ai's db has no commands (src/build.js)
  if (WEB && db.addLines) {
    const lines = [
      ...Object.entries(items).map(([productKey, l]) => ({ productKey, quantity: l.out, code: l.code, name: l.name, price: l.price, cost: l.cost })),
      ...Object.entries(bought).map(([productKey, b]) => ({ productKey, quantity: b.out, code: b.code, name: b.name, cost: b.cost, ...(b.typed === undefined ? {} : { price: b.typed, priceSet: "manual" }) })),
    ];
    const parts = (action.parts ||= []);
    for (let i = 0; i < lines.length; i += MAX_LINES) await db.addLines(sheetId, lines.slice(i, i + MAX_LINES), (parts[i / MAX_LINES] ||= {}));
    return;
  }
  const at = new Date().toISOString();
  const entries = [
    ...Object.entries(items),
    ...Object.entries(bought).map(([key, b]) => [`${key}:bought`, {
      code: b.code, name: b.name, cost: b.cost, price: b.typed ?? b.cost, purchased: true,
      ...(b.typed === undefined ? {} : { priceSet: "manual", priceSetBy: b.by, priceSetAt: at }), out: b.out, returned: 0,
    }]),
  ];
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
// which records why stock changed (docs/api/commands.md). change: { reason: "count", keep: true }
// (the person didn't change the count field, so the stock stays as stored), { reason: "count",
// count, counted, expected } (count undefined: not counted; counted: the form showed a count when
// it opened, so a blank one stops counting; expected: the count it opened with, null if none), or
// { reason: "receipt", lines: [{ action, quantity, unitCost }] }, one per receipt
// line, each line its own action. (`||`, not a condition: the artifact runs the right side.)
// WEB: the artifact build keeps only the right side, since claude.ai's db has no saveItem.
export const saveItem = (db, action, key, body, change) =>
  ((WEB && db.saveItem) || ((key, body) => setItem(db, key, body, change)))(key, body, change, action);
// What the inventory form says when the stock moved while it was open and the person changed
// the count: what the stock is now (null: not counted). The web build's server says the first
// part (docs/api/commands.md, `stock_changed`), and src/aws/db.js adds the rest.
export const COUNT_NOT_SAVED = ", so your count wasn't saved. The latest is showing.";
const countChanged = now => ({ code: "refused", message: `The count changed while you were editing: ${now === null ? "it's no longer counted" : `it's now ${now}`}${COUNT_NOT_SAVED}` });
// The inventory form's save, in the artifact build. The form's copy of the item may be older
// than what's stored, so the stock is the one stored now, unless the person changed the count
// and the stock is still what the form opened with (or already what they counted). A count over
// stock that moved isn't saved: the rest of the item is, with the stock as it is, and the save
// is refused saying what it is now.
async function setCount(ref, body, change) {
  const got = await ref.get(), cur = got.exists ? got.data() : undefined;
  const now = hasStock(cur) ? cur.stock : null, moved = !change.keep && now !== change.expected && now !== (hasStock(body) ? body.stock : null);
  const next = { ...body };
  if (change.keep || moved) { delete next.stock; if (now !== null) next.stock = now; }
  // The marks are the stored ones too: one a checkout or return elsewhere added while the form
  // was open keeps that action's retry from moving the stock again (see move above)
  delete next.ops;
  if (cur && Array.isArray(cur.ops)) next.ops = cur.ops;
  await ref.set(next);
  if (moved) throw countChanged(now);
}
// The artifact build's save. Stock bought in on a receipt is added to what's stored, with the
// lines' marks (see move above): a retry after a lost answer finds them and adds nothing. The
// lines are saved together, so finding any one's mark means they all were.
function setItem(db, key, body, change) {
  const ref = db.doc("products/" + key);
  if (change.reason === "count") return setCount(ref, body, change);
  const acts = change.lines.map(l => l.action);
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
