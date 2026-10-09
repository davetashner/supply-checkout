// In-memory stand-in for the app's runtime (window.claude, ADR 0004), with the web build's
// commands (src/aws/db.js) run in the page. The tests, the demo and `npm run dev` use it.
// Injected with page.addInitScript, so it must be self-contained.
export function installMockClaude(opts) {
  const {
    seed = {}, canWrite = true, owner = true, userId = "u_test", userName = "Test User", names = {}, avatarUrl = "data:,", receipt = null,
    sampleDelay = 0, // milliseconds sample.json takes to answer, like a real model call
    // Failure modes: a capability that isn't available, or calls that reject
    unavailable = [], writeError = null, sampleError = null,
    // More failure modes, all off by default:
    noRuntime = false, // no window.claude at all
    rejects = [], // capabilities whose use() call rejects
    writeErrorFor = null, // { prefix, code }: writes to matching paths fail
    limits = undefined, limitsError = false, // sample.limits() result, or it throws
    userErrors = [], // user methods that throw: "id", "can", "profiles", "isOwner"
    snapshotError = false, // collection listeners report an error instead of data
    downloadError = null, // downloads.save rejects with this code ("bare": rejects with no error object)
    sampleHang = false, // sample.json waits until its signal aborts
    instantUpdates = false, // listeners fire during a write, before it resolves (like a local-first database)
    viewOnlyNotice = undefined, // user.viewOnlyNotice() answers this (the web build's closed team); undefined: claude.ai has no such method
  } = opts || {};
  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const docs = new Map(Object.entries(clone(seed)));
  const listeners = new Set();
  const mock = { docs, saves: [], sampleCalls: [], sampleImages: [], failWrites: null, loseWrites: null };
  window.__mock = mock;

  const denied = () => ({ code: "invalid_argument", message: "write not allowed" });
  // A path prefix matches whole segments: "projects/s1" is that project (and anything under it),
  // never "projects/s1x9..." (a new project's random ID can start with "s1"). "projects/" or ""
  // matches everything under it.
  const under = (path, prefix) => path.startsWith(prefix) && (!prefix || prefix.endsWith("/") || path.length === prefix.length || path[prefix.length] === "/");
  const guard = (path) => {
    if (!canWrite) throw denied();
    if (writeError) throw { code: writeError, message: "simulated " + writeError };
    // Set by a test while the page is open: writes fail with this code until it's cleared. Or
    // { prefix, code }: only writes to paths starting with prefix ("products/") fail.
    const fail = mock.failWrites && (typeof mock.failWrites === "string" ? { prefix: "", code: mock.failWrites } : mock.failWrites);
    if (fail && under(path, fail.prefix)) throw { code: fail.code, message: "simulated " + fail.code };
    if (writeErrorFor && under(path, writeErrorFor.prefix)) throw { code: writeErrorFor.code, message: "simulated " + writeErrorFor.code };
  };
  const fire = () => listeners.forEach((l) => l());
  const notify = () => (instantUpdates ? fire() : setTimeout(fire, 0));
  // Tests call this after changing mock.docs directly, to act as another user
  mock.notify = notify;
  // A slow connection: after hold(), writes wait until release(), then go through (or fail) as usual.
  // mock.writes counts every write call, held or not.
  let held = null;
  mock.writes = 0;
  // hold(prefix): only writes to paths starting with prefix ("products/") wait.
  mock.hold = (prefix = "") => { let release; held = { wait: new Promise((r) => { release = r; }), release, prefix }; };
  mock.release = () => { const h = held; held = null; if (h) h.release(); };
  const arrive = async (path) => { mock.writes++; if (held && under(path, held.prefix)) await held.wait; };
  // Set by a test to a path prefix ("projects/"): writes there are saved, but then reject as if
  // the answer was lost on the way back
  const lost = (path) => { if (mock.loseWrites !== null && under(path, mock.loseWrites)) throw { code: "unavailable", message: "simulated lost answer" }; };
  const merge = (target, src) => {
    for (const [k, v] of Object.entries(src)) {
      const both = v && typeof v === "object" && !Array.isArray(v) && target[k] && typeof target[k] === "object" && !Array.isArray(target[k]);
      if (both) merge(target[k], v);
      else target[k] = clone(v);
    }
  };
  const snap = (path) => {
    const d = docs.get(path);
    return { id: path.split("/").pop(), exists: !!d, data: () => clone(d), metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const listen = (run, next, error) => {
    if (snapshotError && error) { setTimeout(() => error({ code: "unavailable", message: "simulated listener error" }), 0); return () => {}; }
    const l = () => next(run());
    listeners.add(l);
    setTimeout(l, 0);
    return () => listeners.delete(l);
  };

  function docRef(path) {
    return {
      id: path.split("/").pop(),
      path,
      get: async () => snap(path),
      set: async (data) => { await arrive(path); guard(path); docs.set(path, clone(data)); notify(); lost(path); },
      update: async (data) => {
        await arrive(path); guard(path);
        if (!docs.has(path)) throw { code: "invalid_argument", message: "no such document" };
        merge(docs.get(path), data); notify(); lost(path);
      },
      delete: async () => { await arrive(path); guard(path); docs.delete(path); notify(); },
      onSnapshot: (next) => listen(() => snap(path), next),
      collection: (sub) => collRef(path + "/" + sub),
    };
  }
  function query(path, order) {
    const depth = path.split("/").length + 1;
    const run = () => {
      let list = [...docs.keys()].filter((p) => p.startsWith(path + "/") && p.split("/").length === depth).sort().map(snap);
      if (order) {
        const dir = order.dir === "desc" ? -1 : 1;
        list = list.sort((a, b) => (String(a.data()[order.field]) < String(b.data()[order.field]) ? -dir : dir));
      }
      return { docs: list, size: list.length, empty: !list.length, docChanges: () => [], metadata: { fromCache: false, hasPendingWrites: false } };
    };
    return {
      where() { return this; },
      limit() { return this; },
      orderBy: (field, dir = "asc") => query(path, { field, dir }),
      get: async () => run(),
      onSnapshot: (next, error) => listen(run, next, error),
    };
  }
  function collRef(path) {
    const ref = {
      ...query(path),
      path,
      doc: (id) => docRef(path + "/" + (id || Math.random().toString(36).slice(2, 12))),
      add: async (data) => { const r = ref.doc(); await r.set(data); return r; },
    };
    return ref;
  }

  // The web build's commands (src/aws/db.js), as the API runs them (docs/api/commands.md, and
  // tests/fake-aws.js, which fakes them on the API's side): each changes its documents together,
  // in one write, and an action's operation is applied once, so an attempt after a lost answer
  // (loseWrites) or a second tap finds it applied and answers as it did. A changed request is a new
  // operation. Refusals reject as src/aws/db.js does: `refused`, with the API's message.
  const operations = new Map();
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const refused = (message) => ({ code: "refused", message: `${message}. The latest is showing.` });
  const MARKS = ["ackedAtStock", "orderedQty", "orderedOn"];
  const dropMarks = (data) => MARKS.forEach((f) => delete data[f]);
  // A stock change that raises a marked item above its reorder level ends the team's marks on its
  // low-stock alert (src/reorder.js, backend/src/data/reorder.ts)
  const endAck = (data, delta) => {
    if (delta > 0 && MARKS.some((f) => has(data, f)) && !(typeof data.reorderAt === "number" && data.stock <= data.reorderAt)) dropMarks(data);
  };
  // Runs one operation: waits and fails as a write to each of `paths` would, applies `apply` once,
  // and answers as it first did. A refused one changes nothing and isn't kept.
  async function operate(action, request, paths, apply) {
    const key = JSON.stringify(request);
    if (!action.operation || action.operation.key !== key) action.operation = { key, id: Math.random().toString(36).slice(2) };
    for (const p of paths) await arrive(p);
    for (const p of paths) guard(p);
    const id = action.operation.id;
    if (!operations.has(id)) { operations.set(id, apply()); notify(); }
    for (const p of paths) lost(p);
    return clone(operations.get(id));
  }
  const openAdhoc = () => {
    const hit = [...docs].find(([p, d]) => p.startsWith("projects/") && d.kind === "adhoc" && d.status !== "closed");
    return hit && hit[0].slice("projects/".length);
  };
  // Checkout, return and lost (src/aws/db.js command): the line and the storage count change together
  function apply(name, projectId, body, quick) {
    const { productKey: key, quantity: qty, charge, ...oneOff } = body;
    const project = docs.get("projects/" + projectId), product = docs.get("products/" + key);
    if (!project) throw refused("No such project");
    if (project.status === "closed") throw { code: "aborted", message: "This project is closed" };
    const items = (project.items ||= {}), line = has(items, key) ? items[key] : undefined;
    const taken = { takenBy: userId, takenAt: new Date().toISOString() };
    let delta;
    if (name === "checkout") {
      if (project.kind === "adhoc" && !quick) throw refused("Take items for no job with Quick take, not onto the General Use project");
      if (line) { line.out = (line.out || 0) + qty; if (line.kind === "equipment") Object.assign(line, taken); }
      else {
        const from = product || oneOff, equipment = from.kind === "equipment";
        items[key] = { code: from.code ?? "", name: from.name ?? "", ...(equipment ? { kind: "equipment" } : { price: from.price ?? 0 }), ...(from.cost === undefined ? {} : { cost: from.cost }), out: qty, returned: 0, ...(equipment ? taken : {}) };
      }
      delta = -qty;
    } else {
      if (!line) throw refused("This item isn't on this project");
      const left = (line.out || 0) - (line.returned || 0) - (line.lost || 0);
      if (name === "lost") {
        if (line.kind !== "equipment") throw refused("Only company equipment is recorded as lost or broken");
        if (qty > left) throw refused(`Only ${left} of this item ${left === 1 ? "is" : "are"} still out`);
        line.lost = (line.lost || 0) + qty;
        if (charge !== undefined) line.lostCharge = Math.round(((line.lostCharge || 0) + charge) * 100) / 100;
        delta = 0;
      } else {
        if (line.purchased) throw refused("This was bought for the client, so it doesn't come back");
        if (qty > left) throw refused(`Only ${left} of this item ${left === 1 ? "is" : "are"} left to return`);
        line.returned = (line.returned || 0) + qty;
        delta = qty;
      }
    }
    if (product && typeof product.stock === "number" && delta) { product.stock = Math.max(0, product.stock + delta); endAck(product, delta); }
    return { quantity: qty, line: clone(items[key]) };
  }
  const command = async (name, projectId, body, action) =>
    operate(action, [name, projectId, body], ["projects/" + projectId, "products/" + body.productKey], () => apply(name, projectId, body, false));
  // Quick take: a checkout onto the open General Use project, or onto the next adhoc-<n>, which it starts
  const quickTake = async ({ date, ...body }, action) => operate(action, ["quickTake", body, date], ["projects/", "products/" + body.productKey], () => {
    let projectId = openAdhoc();
    if (!projectId) {
      const n = Math.max(0, ...[...docs.keys()].filter((p) => p.startsWith("projects/adhoc-")).map((p) => Number(p.slice("projects/adhoc-".length)) || 0)) + 1;
      projectId = `adhoc-${n}`;
      docs.set("projects/" + projectId, { kind: "adhoc", client: "", date, status: "open", createdBy: userId, createdAt: new Date().toISOString(), items: {} });
    }
    return { quantity: apply("checkout", projectId, body, true).quantity, projectId };
  });
  // A whole line from the open General Use project onto a client project's line for the item, or as it is
  const moveLine = async (fromId, key, toId, action) => operate(action, ["move", fromId, key, toId], ["projects/" + fromId, "projects/" + toId], () => {
    const from = docs.get("projects/" + fromId), to = docs.get("projects/" + toId);
    if (!from || from.kind !== "adhoc" || openAdhoc() !== fromId) throw refused("Only a line on the open General Use project moves to another project");
    if (!to) throw refused("No such project");
    if (to.status === "closed") throw { code: "aborted", message: "This project is closed. Reopen it to move a line to it." };
    const line = has(from.items, key) ? from.items[key] : undefined;
    if (!line) throw refused("This item isn't on this project");
    const items = (to.items ||= {}), cur = has(items, key) ? items[key] : undefined;
    if (cur && cur.kind !== line.kind) throw refused(cur.kind === "equipment" ? "The project has this item as company equipment; correct the lines by hand" : "The project has this item as a supply; correct the lines by hand");
    if (cur) Object.assign(cur, { out: (cur.out || 0) + line.out, returned: (cur.returned || 0) + (line.returned || 0), ...(line.lost ? { lost: (cur.lost || 0) + line.lost } : {}) });
    else items[key] = clone(line);
    delete from.items[key];
  });
  // A receipt's lines for a client, all or none: a new line, or adding to an existing one's out.
  // Company equipment goes on a line of its own, priced at the receipt price (the mock has no markup).
  const addLines = async (projectId, lines, action) => operate(action, ["lines", projectId, lines], ["projects/" + projectId], () => {
    const project = docs.get("projects/" + projectId);
    if (!project) throw { code: "not_found", message: "No such project" };
    if (project.status === "closed") throw { code: "aborted", message: "This project is closed. Reopen it to add to it." };
    const items = (project.items ||= {});
    for (const { productKey, quantity, code = "", name, price, cost, priceSet } of lines) {
      const equipment = docs.get("products/" + productKey)?.kind === "equipment", manual = priceSet === "manual";
      const key = equipment ? `${productKey}:bought` : productKey;
      if (has(items, key)) { items[key].out += quantity; continue; }
      items[key] = {
        code, name: name.trim(), price: equipment && !manual ? cost : price, ...(cost === undefined ? {} : { cost }),
        ...(equipment ? { purchased: true, priceSet: manual ? "manual" : "markup", ...(manual ? { priceSetBy: userId, priceSetAt: new Date().toISOString() } : {}) } : {}), out: quantity, returned: 0,
      };
    }
  });
  // An item from the inventory form or a receipt (src/aws/db.js saveItem): the item is saved with
  // the stock that's stored, then the stock changes through its own operation (a count, an
  // uncount or what a receipt bought), which refuses a count over stock that moved since the form opened
  async function saveItem(key, body, change, action) {
    const path = "products/" + key, data = clone(body);
    delete data.stock;
    // Its answer is never lost here: loseWrites loses the stock command's answer instead
    await arrive(path); guard(path);
    const stored = docs.get(path);
    if (stored && typeof stored.stock === "number") data.stock = stored.stock;
    docs.set(path, data); notify();
    const stock = (p) => (typeof p.stock === "number" ? p.stock : null);
    const adjust = (a, req, fn) => operate(a, ["stock", key, req], [path], () => fn(docs.get(path)));
    if (change.reason === "receipt") {
      for (const l of change.lines) await adjust(l.action, [l.quantity, l.unitCost], (p) => { p.stock = (stock(p) || 0) + l.quantity; endAck(p, l.quantity); });
      return;
    }
    const now = stock(docs.get(path));
    if (change.count === undefined && !(change.counted && now !== null)) return;
    await adjust(action, [change.count, change.expected], (p) => {
      const before = stock(p);
      if (change.expected !== undefined && before !== change.expected && before !== (change.count === undefined ? null : change.count)) {
        throw refused(`The count changed while you were editing: ${before === null ? "it's no longer counted" : `it's now ${before}`}, so your count wasn't saved`);
      }
      if (change.count === undefined) { delete p.stock; dropMarks(p); }
      else { p.stock = change.count; endAck(p, 1); }
    });
  }

  const db = { doc: docRef, collection: collRef, command, quickTake, moveLine, addLines, saveItem };
  const profile = (id) => ({ id, name: id === userId ? userName : names[id] || "", avatarUrl, color: "#336", email: null, isMe: id === userId, guest: false });
  const fails = (name) => { if (userErrors.includes(name)) throw { code: "unavailable", message: "simulated " + name + " failure" }; };
  const user = {
    id: async () => { fails("id"); return userId; },
    me: async () => ({ ...profile(userId), isOwner: owner, canEdit: canWrite }),
    can: async () => { fails("can"); return canWrite; },
    isOwner: async () => { fails("isOwner"); return owner; },
    ...(viewOnlyNotice === undefined ? {} : { viewOnlyNotice: async () => viewOnlyNotice }),
    canEdit: async () => canWrite,
    profiles: async (ids) => { fails("profiles"); return Object.fromEntries([].concat(ids).map((id) => [id, profile(id)])); },
  };
  const downloads = {
    save: async (req) => {
      if (downloadError === "bare") throw undefined;
      if (downloadError) throw { code: downloadError, message: "simulated " + downloadError };
      mock.saves.push(req); return { status: "saved" };
    },
  };
  const sample = async () => ({ text: "", truncated: false, modelTierApplied: "default" });
  sample.json = async (prompt, { images, signal } = {}) => {
    mock.sampleCalls.push(prompt);
    mock.sampleImages.push(images);
    if (sampleHang) await new Promise((_, reject) => signal.addEventListener("abort", () => reject({ code: "cancelled", message: "cancelled" })));
    if (sampleDelay) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, sampleDelay);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject({ code: "cancelled", message: "cancelled" }); });
      });
    }
    if (sampleError) throw { code: sampleError, message: "simulated " + sampleError };
    return clone(receipt);
  };
  sample.limits = async () => {
    if (limitsError) throw { code: "unavailable", message: "simulated limits failure" };
    if (limits !== undefined) return limits;
    return { maxPromptBytes: 65536, images: { maxCount: 5, maxInputBytes: 20e6, mediaTypes: ["image/jpeg", "image/png"] } };
  };

  const namespaces = { db, user, downloads, sample };
  if (noRuntime) return;
  window.claude = {
    use: async (name) => {
      if (rejects.includes(name)) throw { code: "not_granted", message: "simulated rejection" };
      return unavailable.includes(name) ? null : namespaces[name] || null;
    },
  };
}
