// Checking items out to a project and returning them, and the other changes that move counts.
// Every checkout and return goes through here, to the runtime's commands (src/aws/db.js): one
// request that changes the project line and the storage count together, adding on the server, so
// two people checking out at once can't lose a count and a retry can't count twice
// (docs/api/commands.md).
//
// `action` is one object per action the person confirms (one checkout or return form). The db
// gives each action an operation ID, and sends the same one on every attempt at the same
// request, so a retry or a second tap is applied once.
//
// The request depends only on what the person entered, never on the latest copy of the project,
// so a retry after a live update is still the same request.
//
// Each resolves, once the project and the storage count have saved, to { quantity, line }: for a
// return, how many came back and the line as it is now.

// oneOff: the name, price and code of an item that isn't in inventory, which the command needs
// to add its line ({} for an item in inventory).
export const checkOut = (db, action, projectId, key, qty, oneOff) =>
  db.command("checkout", projectId, { productKey: key, quantity: qty, ...oneOff }, action);
// r: how many the person is returning. The command adds it on the server, which refuses more
// than are left.
export const recordReturn = (db, action, projectId, key, r) =>
  db.command("return", projectId, { productKey: key, quantity: r }, action);
// Company equipment lost or broken on the job (ADR 0017, section 3): q of the line's pieces
// still out, and what the client is charged for them (charge, dollars for the lot; undefined:
// nothing). Stock doesn't move: it went down when they were taken.
export const markLost = (db, action, projectId, key, q, charge) =>
  db.command("lost", projectId, { productKey: key, quantity: q, ...(charge === undefined ? {} : { charge }) }, action);

// Quick take (ADR 0017, section 4): a checkout onto the team's open General Use project, without
// choosing a project. The quick-take command picks the project on the server, in the checkout's
// transaction, so two first takes at once end on one project (docs/api/commands.md). date: the
// person's date, for a General Use project it starts. Resolves to the checkout's answer and the
// project it went on (projectId).
export const quickTake = (db, action, key, qty, oneOff, date) =>
  db.quickTake({ productKey: key, quantity: qty, ...oneOff, date }, action);

// Moving a whole line from the open General Use project to an open client project (ADR 0017,
// section 5): its counts go onto the client project's line for the item, which keeps its own
// price, or the line goes as it is, with the price it was taken at. Stock doesn't move: it left
// storage at the quick take. The move command changes both projects in one transaction.
export const moveLine = (db, action, fromId, key, toId) => db.moveLine(fromId, key, toId, action);

// A receipt's lines for a client, added to a project that already exists (saveReceipt in
// src/main.js). items: { [key]: line }, each as a new line would be ({ code, name, price, cost
// each from the receipt, out: how many were bought, returned: 0 }). A line already on the project
// keeps its name, price and cost, and adds to its out. No stock moves: these were bought for the
// client and never were in storage. `action` is the receipt's destination, kept with the draft,
// so every attempt at saving it (Try again, or after a reload) adds each line once: the addLines
// command adds all the lines or none, 40 to a request, each request its own operation
// (docs/api/commands.md).
export const MAX_LINES = 40;
//
// bought: company equipment bought for the client (ADR 0017, section 2a), { [productKey]: { code,
// name, cost: the receipt price each, out, typed?: a price the reviewer typed } }. Each goes on a
// line of its own, `<productKey>:bought`, marked purchased, apart from the same item on loan. It
// sends the receipt price, and a price only with priceSet "manual": the server works out the
// team's markup itself.
export async function addLines(db, action, projectId, items, bought = {}) {
  const lines = [
    ...Object.entries(items).map(([productKey, l]) => ({ productKey, quantity: l.out, code: l.code, name: l.name, price: l.price, cost: l.cost })),
    ...Object.entries(bought).map(([productKey, b]) => ({ productKey, quantity: b.out, code: b.code, name: b.name, cost: b.cost, ...(b.typed === undefined ? {} : { price: b.typed, priceSet: "manual" }) })),
  ];
  const parts = (action.parts ||= []);
  for (let i = 0; i < lines.length; i += MAX_LINES) await db.addLines(projectId, lines.slice(i, i + MAX_LINES), (parts[i / MAX_LINES] ||= {}));
}

// Saving an item whose stock changes outside a project: the inventory form (someone counted
// storage) and a receipt's general-inventory lines (stock bought in). body is the whole item,
// with its new stock. The db saves the item without stock (the server keeps what's stored) and
// sends the change as the stock command, which records why stock changed
// (docs/api/commands.md). change: { reason: "count", keep: true } (the person didn't change the
// count field, so the stock stays as stored), { reason: "count", count, counted, expected }
// (count undefined: not counted; counted: the form showed a count when it opened, so a blank one
// stops counting; expected: the count it opened with, null if none), or { reason: "receipt",
// lines: [{ action, quantity, unitCost }] }, one per receipt line, each line its own action.
export const saveItem = (db, action, key, body, change) => db.saveItem(key, body, change, action);
// What the inventory form says when the stock moved while it was open and the person changed
// the count. The server says the first part (docs/api/commands.md, `stock_changed`), and
// src/aws/db.js adds this.
export const COUNT_NOT_SAVED = ", so your count wasn't saved. The latest is showing.";
