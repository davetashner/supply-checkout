// use("db") for the web build: the app's Firestore-like calls (src/main.js) on the data
// API, as mapped at the top of docs/api/openapi.yaml, with onSnapshot kept current by live
// updates (docs/api/realtime.md).
//
// Each collection someone listens to is held in memory. Listeners get the whole collection
// after the first list, after each of the adapter's own writes, after each live event
// (fetched through the API, which checks membership on every request; a burst of them is
// one re-list) and after every re-list. Documents are sent through as the app wrote them,
// whatever their fields.
//
// Sheets are listed by ID and sorted here, not with ?orderBy=date: that route reads an
// index that can lag a write, and a full re-list must not drop a sheet just created.
import { createLive } from "./live.js";

// A burst of events for one collection (a CSV import of hundreds of items, say) is answered
// by one re-list instead of a fetch per document: past BURST_FETCHES fetches within BURST_MS,
// events are held and the collection is re-listed once they stop for QUIET_MS, or MAX_WAIT_MS
// after the first was held if they don't. The re-list uses up the fetch budget, so a burst
// that goes on is re-listed every MAX_WAIT_MS rather than fetched again.
const BURST_FETCHES = 10, BURST_MS = 1000, QUIET_MS = 300, MAX_WAIT_MS = 2000;
const META = { fromCache: false, hasPendingWrites: false };
const cmp = (a, b) => (a > b) - (a < b);
// A document's own fields, to compare two copies: not an item's stock (the stock commands own
// it) or when it was last saved. Keys are sorted at every level, since the server needn't keep
// their order.
const sorted = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().map((k) => [k, sorted(v[k])]) : v);
const fields = (data) => JSON.stringify(sorted(Object.fromEntries(Object.entries(data).filter(([k]) => k !== "stock" && k !== "updatedAt"))));
const snap = (id, doc) => ({ id, exists: !!doc, data: () => (doc ? structuredClone(doc.data) : undefined), metadata: META });

function querySnap(docs, order) {
  const list = [...docs.values()].sort((a, b) => cmp(a.id, b.id));
  if (order) {
    // Missing or non-text values sort as "", so undated sheets come last when newest-first
    const val = (d) => (typeof d.data[order.field] === "string" ? d.data[order.field] : "");
    const dir = order.dir === "desc" ? -1 : 1;
    list.sort((a, b) => cmp(val(a), val(b)) * dir || cmp(a.id, b.id));
  }
  const out = list.map((d) => snap(d.id, d));
  return { docs: out, size: out.length, empty: !out.length, docChanges: () => [], metadata: META };
}

// onClosed: a write was refused because an owner closed the team meanwhile. onResync: both
// collections are being re-listed (live.js), a moment to check anything else that may have
// changed unannounced (account.js: the team switcher); it's told "poll" when the re-list is
// the polling fallback's (live.js), which runs every 15 seconds.
export function createDb({ api, config, teamId, userId, token, onRemoved, onClosed, onResync }) {
  const base = `/teams/${encodeURIComponent(teamId)}`;
  const colls = {};
  const inflight = new Map();
  // Each document's writes, one at a time (queued below)
  const queues = new Map();
  let removed = false;
  const coll = (name) => (colls[name] ||= { docs: new Map(), loaded: false, listeners: new Set(), touched: null, listing: null, again: false, due: false, fetched: [], held: null });
  const docPath = (name, id) => `${base}/${name}/${encodeURIComponent(id)}`;

  // Runs fn once every write to the same document sent before it has answered, so a write names
  // the version the one before it made: two quick edits from this page (finishing a sheet, then
  // saving its details) don't conflict with each other. Someone else's change still does.
  function queued(key, fn) {
    const next = (queues.get(key) || Promise.resolve()).then(fn, fn);
    queues.set(key, next);
    const done = () => { if (queues.get(key) === next) queues.delete(key); };
    next.then(done, done);
    return next;
  }

  // Removed from the team (or it's gone): stop everything once, and say so
  function lost() {
    if (removed) return;
    removed = true;
    live.stop();
    onRemoved();
  }

  // A write the API refused (403 permission_denied): a viewer's, or one to a team an owner
  // closed meanwhile (read-only), is rejected with the artifact runtime's view-only code,
  // which the app acts on (src/main.js); anything else means this user is no longer in the team.
  function denied(e) {
    if (e.code !== "permission_denied") return e;
    if (e.reason === "team_closed") onClosed();
    if (e.reason === "view_only" || e.reason === "team_closed") return { ...e, code: "invalid_argument" };
    lost();
    return e;
  }

  // Delivers the collection to its listeners, at most once per tick
  function notify(name) {
    const c = coll(name);
    if (c.due) return;
    c.due = true;
    setTimeout(() => {
      c.due = false;
      if (c.loaded) c.listeners.forEach((l) => l.fn(c));
    }, 0);
  }

  // Stores a document from the API (null: it's gone), unless an older copy
  function put(name, id, doc) {
    const c = coll(name), held = c.docs.get(id);
    if (doc && held && doc.version < held.version) return;
    if (c.touched) c.touched.add(id);
    if (doc) c.docs.set(id, doc);
    else c.docs.delete(id);
    notify(name);
  }

  async function list(name) {
    const docs = new Map();
    let cursor = "";
    do {
      const page = await api("GET", `${base}/${name}` + (cursor && `?cursor=${encodeURIComponent(cursor)}`));
      for (const d of page.documents) docs.set(d.id, d);
      cursor = page.cursor;
    } while (cursor);
    return docs;
  }

  // Replaces the collection with a fresh list, keeping documents that changed while it
  // was being read. A re-list asked for meanwhile runs once more afterwards.
  function relist(name) {
    const c = coll(name);
    if (c.listing) { c.again = true; return c.listing; }
    c.listing = (async () => {
      do {
        c.again = false;
        c.touched = new Set();
        const docs = await list(name);
        for (const id of c.touched) {
          const doc = c.docs.get(id);
          if (doc) docs.set(id, doc);
          else docs.delete(id);
        }
        c.docs = docs;
        c.loaded = true;
        c.touched = null;
        notify(name);
      } while (c.again);
    })()
      .catch((e) => {
        c.touched = null;
        if (e.code === "permission_denied") lost();
        // Only the first load reports an error; later re-lists are retried by the next one
        else if (!c.loaded) c.listeners.forEach((l) => l.error && l.error(e));
      })
      .finally(() => { c.listing = null; });
    return c.listing;
  }
  const resync = (why) => {
    if (removed) return;
    Object.keys(colls).forEach((n) => colls[n].listeners.size && relist(n));
    onResync?.(why);
  };

  // A live event: fetch what changed (at most one fetch per document at a time)
  async function fetchDoc(name, id) {
    const key = name + "/" + id;
    const busy = inflight.get(key);
    if (busy) { busy.again = true; return; }
    const state = { again: true };
    inflight.set(key, state);
    while (state.again) {
      state.again = false;
      try { put(name, id, await api("GET", docPath(name, id))); }
      catch (e) {
        if (e.code === "not_found") put(name, id, null);
        else if (e.code === "permission_denied") lost();
      }
    }
    inflight.delete(key);
  }

  // Fetches a changed document, or during a burst holds it for one re-list (BURST_FETCHES)
  function changed(name, id) {
    const c = colls[name], now = Date.now();
    c.fetched = c.fetched.filter((t) => now - t < BURST_MS);
    if (!c.held && c.fetched.length < BURST_FETCHES) {
      c.fetched.push(now);
      fetchDoc(name, id);
      return;
    }
    c.held ||= { since: now };
    clearTimeout(c.held.timer);
    c.held.timer = setTimeout(() => {
      c.held = null;
      c.fetched = Array(BURST_FETCHES).fill(Date.now());
      relist(name);
    }, Math.min(QUIET_MS, c.held.since + MAX_WAIT_MS - now));
  }

  function onEvent(ev) {
    // The user's channel carries every team they're in; this page shows one
    if (ev.teamId !== teamId) return;
    // Only the collections this page reads (not "__proto__", "constructor" and the like)
    if (!Object.hasOwn(colls, ev.collection)) return;
    const c = colls[ev.collection];
    // Many changes at once (an import): re-list now, in place of any burst being held
    if (ev.op === "list") {
      if (c.held) { clearTimeout(c.held.timer); c.held = null; }
      c.fetched = Array(BURST_FETCHES).fill(Date.now());
      relist(ev.collection);
      return;
    }
    if (ev.op === "delete") { put(ev.collection, ev.id, null); return; }
    const held = c.docs.get(ev.id);
    // Skip what's already here: an older version, or (for sheets) the same one, such as
    // the echo of this user's own write. A product's is fetched again on the same version,
    // for data stored before every stock change gave the product a new version.
    if (held && (ev.version < held.version || (ev.version === held.version && ev.collection === "sheets"))) return;
    changed(ev.collection, ev.id);
  }

  const live = createLive({ url: config.realtimeUrl, host: config.realtimeHost, channel: `/users/${userId}`, token, onEvent, onResync: resync });
  live.start();

  // Calls render with the collection whenever it changes, once it has loaded
  function listen(name, render, error) {
    const c = coll(name);
    const l = { fn: render, error };
    c.listeners.add(l);
    if (c.loaded) notify(name);
    else relist(name);
    return () => c.listeners.delete(l);
  }

  function docRef(path) {
    const [name, id] = [path.slice(0, path.indexOf("/")), path.slice(path.indexOf("/") + 1)];
    // Every write names the version it was made against (ADR 0006): the one held, or 0 for
    // a document this page doesn't have. If someone else changed it first (409 aborted),
    // fetch the latest so the app redraws with it, and pass the error on for the app to say so.
    // If what changed is that someone deleted it, that's the error: not_found. A set that finds
    // the document already as it was sent is this page's own earlier attempt, whose answer was
    // lost (a new sheet saved again after a timeout): it's saved, so it isn't made twice.
    const write = (method, body) => queued(name + "/" + id, async () => {
      const held = coll(name).docs.get(id), expectedVersion = held ? held.version : 0;
      try {
        const path = docPath(name, id);
        put(name, id, await (body ? api(method, path, { ...body, expectedVersion }) : api(method, `${path}?expectedVersion=${expectedVersion}`)));
      } catch (e) {
        if (e.code !== "aborted") throw denied(e);
        await fetchDoc(name, id);
        const now = coll(name).docs.get(id);
        if (now && method === "PUT" && fields(now.data) === fields(body.data)) return;
        throw now ? e : { code: "not_found", message: "Not found", status: 404 };
      }
    });
    return {
      id,
      path,
      get: async () => {
        try { return snap(id, await api("GET", docPath(name, id))); }
        catch (e) { if (e.code === "not_found") return snap(id, null); throw e; }
      },
      set: (data) => write("PUT", { data }),
      update: (patch) => write("PATCH", { data: patch }),
      delete: () => write("DELETE"),
      onSnapshot: (next, error) => listen(name, (c) => next(snap(id, c.docs.get(id))), error),
    };
  }

  // Checkout and return (docs/api/commands.md): one POST that changes the sheet line and the
  // stock together. The answer has the sheet and the product as they are now (null if gone),
  // so the screen updates before the live events arrive. Resolves to how many the command
  // moved and the line as it is now. A 409 (the line or item busy on the server, or the sheet
  // closed) is sent again once, as it is: the server adds the quantity to the line as it is then,
  // so someone else's change meanwhile doesn't make it a conflict. If that's refused too, it
  // fetches both, as a document write's 409 does, and passes the error on. So does a 400 or 404, which the command refuses for what the sheet
  // holds now; it rejects as `refused` (a code only this adapter uses) with the server's message, for the app to show.
  //
  // `action` stands for one action the person confirmed. It keeps one operation ID for as long
  // as the request stays the same, so every attempt at it (a retry, or a second tap while the
  // first is still on its way) is applied once, and a changed request is a new operation. The ID
  // is kept on the action itself (`operation`), so an action saved with a receipt draft keeps
  // it after a reload.
  function operationId(action, request) {
    const key = JSON.stringify(request), held = action.operation;
    if (held && held.key === key) return held.id;
    action.operation = { key, id: crypto.randomUUID() };
    return action.operation.id;
  }
  // A command refused for what the sheet holds now: the server's message says why, with the
  // latest now showing. `refused` is a code only this adapter uses, for the app to show.
  const refused = (e) => ({ code: "refused", message: `${String(e.message).replace(/\.$/, "")}. The latest is showing.`, status: e.status });
  const command = (name, sheetId, body, action) => queued("sheets/" + sheetId, async () => {
    const operation = operationId(action, [name, sheetId, body]);
    const send = () => api("POST", `${docPath("sheets", sheetId)}/${name}`, { operationId: operation, ...body });
    try {
      // The same operation ID, so it's applied once whichever attempt the server saw
      const res = await send().catch((e) => { if (e.code !== "aborted") throw e; return send(); });
      put("sheets", sheetId, res.sheet);
      put("products", body.productKey, res.product);
      // The line as the sheet has it now; {} if the sheet or the line is gone (or has no items)
      const items = res.sheet?.data.items;
      return { quantity: res.result.quantity, line: (items && Object.hasOwn(items, body.productKey) && items[body.productKey]) || {} };
    } catch (e) {
      const bad = e.code === "bad_request" || e.code === "not_found";
      if (bad || e.code === "aborted") await Promise.all([fetchDoc("sheets", sheetId), fetchDoc("products", body.productKey)]);
      // Refused for what the sheet holds now (only so many left to return, the line or the sheet gone)
      if (bad) throw refused(e);
      throw denied(e);
    }
  });

  // A receipt's lines for a client, added to an existing sheet (docs/api/commands.md): one POST
  // that adds them all or none, without moving stock. lines: [{ productKey, quantity, code,
  // name, price, cost }], at most 40. Idempotent by operation ID, as command() is. A sheet
  // someone deleted rejects as not_found, for the app to say so; a 400 as `refused`.
  const addLines = (sheetId, lines, action) => queued("sheets/" + sheetId, async () => {
    const operation = operationId(action, ["lines", sheetId, lines]);
    try {
      put("sheets", sheetId, (await api("POST", `${docPath("sheets", sheetId)}/lines`, { operationId: operation, lines })).sheet);
    } catch (e) {
      const bad = e.code === "bad_request";
      if (bad || e.code === "not_found" || e.code === "aborted") await fetchDoc("sheets", sheetId);
      if (bad) throw refused(e);
      throw denied(e);
    }
  });

  // Stock outside a sheet (docs/api/commands.md): POST products/<key>/stock, one transaction
  // that changes the stock and records a movement saying why. A 409 fetches the item, as a
  // document write's does, and passes the error on.
  const adjustStock = (key, body, action) => queued("products/" + key, async () => {
    const operation = operationId(action, ["stock", key, body]);
    try {
      put("products", key, (await api("POST", `${docPath("products", key)}/stock`, { operationId: operation, ...body })).product);
    } catch (e) {
      if (e.code === "aborted") await fetchDoc("products", key);
      throw denied(e);
    }
  });

  // An item saved from the inventory form or a receipt (src/moves.js saveItem). Stock moves only
  // through the stock command (the document routes keep the stored stock and refuse another), so
  // the PUT leaves it out and the new stock goes through the command, after the item exists. A
  // count that matches what's stored changes nothing. The web build doesn't stop counting an
  // item: a blank count leaves its stock as it is.
  //
  // The PUT is skipped when the item's own fields are what's held already (the time it was
  // saved aside): a count on its own, or saving again after the stock command's answer was lost.
  // The held copy is then older than the server's, since the command gave the item a new
  // version, so a PUT would conflict; the command is sent again with the same ID instead, and
  // the server replays it.
  async function saveItem(key, body, change, action) {
    const data = { ...body }, held = coll("products").docs.get(key);
    delete data.stock;
    if (!held || fields(held.data) !== fields(data)) await docRef("products/" + key).set(data);
    const stored = coll("products").docs.get(key).data.stock;
    const changes = change.reason === "receipt"
      ? change.lines.map((l) => [l.action, { reason: "receipt", quantity: l.quantity, unitCost: l.unitCost }])
      : change.count === undefined || change.count === stored ? [] : [[action, { reason: "count", count: change.count }]];
    for (const [a, b] of changes) await adjustStock(key, b, a);
  }

  function query(name, order) {
    return {
      orderBy: (field, dir = "asc") => query(name, { field, dir }),
      get: async () => querySnap(await list(name), order),
      onSnapshot: (next, error) => listen(name, (c) => next(querySnap(c.docs, order)), error),
    };
  }

  return {
    // Sheet IDs are made here, as the app expects; the first set() creates the document
    collection: (name) => {
      const ref = {
        ...query(name, null),
        path: name,
        doc: (id) => docRef(name + "/" + (id || crypto.randomUUID())),
        add: async (data) => { const r = ref.doc(); await r.set(data); return r; },
      };
      return ref;
    },
    doc: docRef,
    command,
    addLines,
    saveItem,
    // A new access token: reconnect live updates with it
    reconnect: () => live.reconnect(),
    // The session ended (signed out, it expired, or another tab changed who's signed in) or
    // the account was deleted: no more live updates or re-lists, which need a token, not even
    // a burst's re-list still waiting, and the team isn't reported as lost
    stop: () => {
      removed = true;
      live.stop();
      for (const c of Object.values(colls)) if (c.held) { clearTimeout(c.held.timer); c.held = null; }
    },
  };
}
