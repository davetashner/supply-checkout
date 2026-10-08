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
// Projects are listed by ID and sorted here, not with ?orderBy=date: that route reads an
// index that can lag a write, and a full re-list must not drop a project just created.
//
// Not every project, at first (supply-checkout-1dg.11): a team's finished projects pile up over
// the years, so the page lists `?since=<day>` (recentSince), the open projects and the finished
// ones from then on, and the snapshot says so (`since`). loadOlder() lists every project, and
// from then on every re-list does. A project this page fetched or wrote since it loaded (a live
// event, its own write, a command's answer) stays held across those re-lists even if it's from
// before the day, so one someone else edits or reopens, or one this page returned, doesn't vanish
// from under the person looking at it. A re-list of every project holds only what it lists. When
// the recent list is empty, one more request of a single project says whether the team has
// older ones (`older`), so the first-run checklist doesn't ask a team with years of projects
// to create its first.
import { createLive } from "./live.js";
import { COUNT_NOT_SAVED } from "../moves.js";

// A burst of events for one collection (a CSV import of hundreds of items, say) is answered
// by one re-list instead of a fetch per document: past BURST_FETCHES fetches within BURST_MS,
// events are held and the collection is re-listed once they stop for QUIET_MS, or MAX_WAIT_MS
// after the first was held if they don't. The re-list uses up the fetch budget, so a burst
// that goes on is re-listed every MAX_WAIT_MS rather than fetched again.
const BURST_FETCHES = 10, BURST_MS = 1000, QUIET_MS = 300, MAX_WAIT_MS = 2000;
// A re-list asked for while another one failed (it timed out, say) isn't dropped: it's tried
// again after RETRY_MS, twice as long after each failure, up to RETRY_MAX_MS
const RETRY_MS = 2000, RETRY_MAX_MS = 60e3;
const META = { fromCache: false, hasPendingWrites: false };

// The day the projects listed at start go back to: 1 January of the year it was six months ago,
// so the year groups the page shows are whole (this year's, and last year's until July)
function recentSince() {
  const now = new Date();
  return `${new Date(now.getFullYear(), now.getMonth() - 6, 1).getFullYear()}-01-01`;
}
const cmp = (a, b) => (a > b) - (a < b);
// A document's own fields, to compare two copies: not an item's stock (the stock commands own
// it) or when it was last saved. Keys are sorted at every level, since the server needn't keep
// their order.
const sorted = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().map((k) => [k, sorted(v[k])]) : v);
const fields = (data) => JSON.stringify(sorted(Object.fromEntries(Object.entries(data).filter(([k]) => k !== "stock" && k !== "updatedAt"))));
const snap = (id, doc) => ({ id, exists: !!doc, data: () => (doc ? structuredClone(doc.data) : undefined), metadata: META });

function querySnap(docs, order, since, older) {
  const list = [...docs.values()].sort((a, b) => cmp(a.id, b.id));
  if (order) {
    // Missing or non-text values sort as "", so undated projects come last when newest-first
    const val = (d) => (typeof d.data[order.field] === "string" ? d.data[order.field] : "");
    const dir = order.dir === "desc" ? -1 : 1;
    list.sort((a, b) => cmp(val(a), val(b)) * dir || cmp(a.id, b.id));
  }
  const out = list.map((d) => snap(d.id, d));
  return { docs: out, size: out.length, empty: !out.length, docChanges: () => [], metadata: META, ...(since ? { since } : {}), ...(older ? { older } : {}) };
}

// onClosed: a write was refused because an owner closed the team meanwhile; onEnded: because
// its subscription ended meanwhile (read-only until an owner subscribes). onResync: both
// collections are being re-listed (live.js), a moment to check anything else that may have
// changed unannounced (account.js: the team switcher); it's told "poll" when the re-list is
// the polling fallback's (live.js), which runs every 15 seconds.
export function createDb({ api, config, teamId, userId, token, onRemoved, onClosed, onEnded, onResync }) {
  const base = `/teams/${encodeURIComponent(teamId)}`;
  const colls = {};
  const inflight = new Map();
  // Each document's writes, one at a time (queued below)
  const queues = new Map();
  let removed = false;
  // all: list every project, not only the recent ones (loadOlder); since: the day the held list goes back to ("" for all)
  const coll = (name) => (colls[name] ||= { docs: new Map(), loaded: false, listeners: new Set(), touched: null, listing: null, again: false, due: false, fetched: [], held: null, retry: null, retries: 0, all: name !== "projects", since: "", kept: new Set(), older: false, gone: new Map() });
  const docPath = (name, id) => `${base}/${name}/${encodeURIComponent(id)}`;

  // Runs fn once every write to the same document sent before it has answered, so a write names
  // the version the one before it made: two quick edits from this page (finishing a project, then
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
    for (const c of Object.values(colls)) clearTimeout(c.retry);
    onRemoved();
  }

  // A write the API refused (403 permission_denied): a viewer's, or one to a team an owner
  // closed meanwhile (read-only), is rejected with the artifact runtime's view-only code,
  // which the app acts on (src/main.js); anything else means this user is no longer in the team.
  function denied(e) {
    if (e.code !== "permission_denied") return e;
    if (e.reason === "team_closed") onClosed();
    if (e.reason === "subscription_ended") onEnded();
    if (e.reason === "view_only" || e.reason === "team_closed" || e.reason === "subscription_ended") return { ...e, code: "invalid_argument" };
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
    if (doc) { c.docs.set(id, doc); c.kept.add(id); c.gone.delete(id); }
    else { c.docs.delete(id); c.kept.delete(id); }
    notify(name);
  }

  async function list(name, since = "") {
    const docs = new Map();
    let cursor = "";
    do {
      const query = [since && `since=${since}`, cursor && `cursor=${encodeURIComponent(cursor)}`].filter(Boolean).join("&");
      const page = await api("GET", `${base}/${name}` + (query && `?${query}`));
      for (const d of page.documents) docs.set(d.id, d);
      cursor = page.cursor;
    } while (cursor);
    return docs;
  }

  // Replaces the collection with a fresh list, keeping documents that changed while it
  // was being read. A re-list asked for meanwhile runs once more afterwards, or, if this one
  // fails, after a wait (RETRY_MS), until one gets through.
  function relist(name) {
    const c = coll(name);
    if (c.listing) { c.again = true; return c.listing; }
    // This one runs now, in place of a retry waiting
    clearTimeout(c.retry);
    c.retry = null;
    c.listing = (async () => {
      do {
        c.again = false;
        c.touched = new Set();
        const since = c.all ? "" : recentSince();
        const docs = await list(name, since);
        // Held from before the day: kept (above); with every project listed, no longer needed
        if (since) { for (const id of c.kept) if (!docs.has(id)) docs.set(id, c.docs.get(id)); }
        else c.kept.clear();
        // Nothing recent: whether there's anything older (one project, any)
        c.older = !!since && !docs.size && (await api("GET", `${base}/${name}?limit=1`)).documents.length > 0;
        for (const id of c.touched) {
          const doc = c.docs.get(id);
          if (doc) docs.set(id, doc);
          else docs.delete(id);
        }
        c.docs = docs;
        c.since = since;
        c.loaded = true;
        c.touched = null;
        c.retries = 0;
        // The list is the latest word on what's gone (a delete's own event may have been missed)
        c.gone.clear();
        notify(name);
      } while (c.again);
    })()
      .catch((e) => {
        c.touched = null;
        if (e.code === "permission_denied") lost();
        // Only the first load reports an error
        else if (!c.loaded) c.listeners.forEach((l) => l.error && l.error(e));
        // A re-list asked for meanwhile (or one being retried) is tried again, unless the page
        // has stopped meanwhile; any other is retried by the next one asked for
        else if (!removed && (c.again || c.retries)) {
          const wait = Math.min(RETRY_MAX_MS, RETRY_MS * 2 ** c.retries++);
          c.retry = setTimeout(() => relist(name), wait);
        }
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
    if (ev.op === "delete") {
      put(ev.collection, ev.id, null);
      // Changes seen before it (by the stream's clock) are for the document it deleted
      if (typeof ev.at === "number") c.gone.set(ev.id, { at: ev.at });
      else c.gone.delete(ev.id);
      return;
    }
    // A late event for a save from before the document was deleted: fetching it would only get
    // a 404 (which the browser logs). Deleted here, until the delete's own event arrives (a
    // document's events arrive in order): one for a version up to the one deleted. Deleted by
    // an event: one the stream saw in an earlier second. Anything else is fetched, such as the
    // document made again.
    const gone = c.gone.get(ev.id);
    if (gone && (gone.at === undefined ? ev.version <= gone.version : ev.at < gone.at)) return;
    const held = c.docs.get(ev.id);
    // Skip what's already here: an older version, or (for projects) the same one, such as
    // the echo of this user's own write. A product's is fetched again on the same version,
    // for data stored before every stock change gave the product a new version.
    if (held && (ev.version < held.version || (ev.version === held.version && ev.collection === "projects"))) return;
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
    // lost (a new project saved again after a timeout): it's saved, so it isn't made twice.
    const write = (method, body) => queued(name + "/" + id, async () => {
      const held = coll(name).docs.get(id), expectedVersion = held ? held.version : 0;
      try {
        const path = docPath(name, id);
        put(name, id, await (body ? api(method, path, { ...body, expectedVersion }) : api(method, `${path}?expectedVersion=${expectedVersion}`)));
        // Deleted here: late events for its earlier saves aren't fetched (onEvent), unless its
        // delete event came first and says which those are
        if (method === "DELETE" && !coll(name).gone.has(id)) coll(name).gone.set(id, { version: expectedVersion });
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

  // Checkout and return (docs/api/commands.md): one POST that changes the project line and the
  // stock together. The answer has the project and the product as they are now (null if gone),
  // so the screen updates before the live events arrive. Resolves to how many the command
  // moved and the line as it is now. A 409 (the line or item busy on the server, or the project
  // closed) is sent again once, as it is: the server adds the quantity to the line as it is then,
  // so someone else's change meanwhile doesn't make it a conflict. If that's refused too, it
  // fetches both, as a document write's 409 does, and passes the error on. So does a 400 or 404, which the command refuses for what the project
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
  // A command refused for what the project holds now: the server's message says why, with the
  // latest now showing. `refused` is a code only this adapter uses, for the app to show.
  const refused = (e) => ({ code: "refused", message: `${String(e.message).replace(/\.$/, "")}. The latest is showing.`, status: e.status });
  const command = (name, projectId, body, action) => queued("projects/" + projectId, async () => {
    const operation = operationId(action, [name, projectId, body]);
    const send = () => api("POST", `${docPath("projects", projectId)}/${name}`, { operationId: operation, ...body });
    try {
      // The same operation ID, so it's applied once whichever attempt the server saw
      const res = await send().catch((e) => { if (e.code !== "aborted") throw e; return send(); });
      put("projects", projectId, res.project);
      put("products", body.productKey, res.product);
      // The line as the project has it now; {} if the project or the line is gone (or has no items)
      const items = res.project?.data.items;
      return { quantity: res.result.quantity, line: (items && Object.hasOwn(items, body.productKey) && items[body.productKey]) || {} };
    } catch (e) {
      const bad = e.code === "bad_request" || e.code === "not_found";
      if (bad || e.code === "aborted") await Promise.all([fetchDoc("projects", projectId), fetchDoc("products", body.productKey)]);
      // Refused for what the project holds now (only so many left to return, the line or the project gone)
      if (bad) throw refused(e);
      throw denied(e);
    }
  });

  // Quick take (ADR 0017, docs/api/commands.md): a checkout onto the team's General Use project, which
  // the server picks (or starts) in the checkout's transaction. Answers, retries and refusals as
  // command() above; resolves to the checkout's answer and the project it went on (projectId).
  const quickTake = (body, action) => queued("adhoc", async () => {
    const operation = operationId(action, ["quickTake", body]);
    const send = () => api("POST", `${base}/adhoc/checkout`, { operationId: operation, ...body });
    try {
      const res = await send().catch((e) => { if (e.code !== "aborted") throw e; return send(); });
      const projectId = res.result.projectId;
      put("projects", projectId, res.project);
      put("products", body.productKey, res.product);
      return { quantity: res.result.quantity, projectId };
    } catch (e) {
      if (e.code === "bad_request") throw refused(e);
      throw denied(e);
    }
  });

  // Moving a whole ad hoc line to a client project (ADR 0017, docs/api/commands.md): one POST that
  // changes both projects together. Answers, retries and refusals as command() above, fetching both
  // projects when it's refused.
  const moveLine = (fromId, key, toId, action) => queued("projects/" + fromId, async () => {
    const operation = operationId(action, ["move", fromId, key, toId]);
    const send = () => api("POST", `${docPath("projects", fromId)}/move`, { operationId: operation, productKey: key, toProjectId: toId });
    try {
      const res = await send().catch((e) => { if (e.code !== "aborted") throw e; return send(); });
      put("projects", fromId, res.project);
      put("projects", toId, res.toProject);
    } catch (e) {
      const bad = e.code === "bad_request" || e.code === "not_found";
      if (bad || e.code === "aborted") await Promise.all([fetchDoc("projects", fromId), fetchDoc("projects", toId)]);
      if (bad) throw refused(e);
      throw denied(e);
    }
  });

  // A receipt's lines for a client, added to an existing project (docs/api/commands.md): one POST
  // that adds them all or none, without moving stock. lines: [{ productKey, quantity, code,
  // name, price, cost }], at most 40. Idempotent by operation ID, as command() is. A project
  // someone deleted rejects as not_found, for the app to say so; a 400 as `refused`.
  const addLines = (projectId, lines, action) => queued("projects/" + projectId, async () => {
    const operation = operationId(action, ["lines", projectId, lines]);
    try {
      put("projects", projectId, (await api("POST", `${docPath("projects", projectId)}/lines`, { operationId: operation, lines })).project);
    } catch (e) {
      const bad = e.code === "bad_request";
      if (bad || e.code === "not_found" || e.code === "aborted") await fetchDoc("projects", projectId);
      if (bad) throw refused(e);
      throw denied(e);
    }
  });

  // Stock outside a project (docs/api/commands.md): POST products/<key>/stock, one transaction
  // that changes the stock and records a movement saying why. A 409 fetches the item, as a
  // document write's does, and passes the error on.
  const adjustStock = (key, body, action) => queued("products/" + key, async () => {
    const operation = operationId(action, ["stock", key, body]);
    try {
      put("products", key, (await api("POST", `${docPath("products", key)}/stock`, { operationId: operation, ...body })).product);
    } catch (e) {
      if (e.code === "aborted") await fetchDoc("products", key);
      // The count changed while the form was open: the server's message says what it is now
      if (e.reason === "stock_changed") throw { code: "refused", message: e.message + COUNT_NOT_SAVED };
      throw denied(e);
    }
  });

  // An item saved from the inventory form or a receipt (src/moves.js saveItem). Stock moves only
  // through the stock command (the document routes keep the stored stock and refuse another), so
  // the PUT leaves it out and the new stock goes through the command, after the item exists. The
  // form sends a count only when the person changed it, with the count it opened with
  // (`expected`), and the server decides: it refuses one over stock that moved since
  // (stock_changed), and answers one that's already what's stored with no change. This page's
  // copy may be behind, so it isn't asked. A blank count stops counting the item
  // (`reason: "uncount"`, which removes its stock with a movement), as the artifact's write
  // without stock does, but only when the form showed a count when it opened (`counted`) and
  // the item still has one: a form opened on an item that wasn't counted leaves alone a count
  // someone made while it was open.
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
    const count = change.count === undefined ? (change.counted && typeof stored === "number" ? { reason: "uncount" } : null)
      : { reason: "count", count: change.count };
    const changes = change.reason === "receipt"
      ? change.lines.map((l) => [l.action, { reason: "receipt", quantity: l.quantity, unitCost: l.unitCost }])
      : count ? [[action, { ...count, expectedStock: change.expected }]] : [];
    for (const [a, b] of changes) await adjustStock(key, b, a);
  }

  function query(name, order) {
    return {
      orderBy: (field, dir = "asc") => query(name, { field, dir }),
      get: async () => querySnap(await list(name), order),
      onSnapshot: (next, error) => listen(name, (c) => next(querySnap(c.docs, order, c.since, c.older)), error),
    };
  }

  return {
    // Project IDs are made here, as the app expects; the first set() creates the document
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
    quickTake,
    moveLine,
    addLines,
    saveItem,
    // Every project from now on, not only the recent ones (above). Resolves once listeners
    // have them; rejects if they couldn't be listed (a later re-list tries again).
    loadOlder: async () => {
      const c = coll("projects");
      c.all = true;
      await relist("projects");
      await new Promise((r) => setTimeout(r, 0));
      if (c.since) throw { code: "unavailable", message: "Couldn't list the older projects" };
    },
    // A new access token: reconnect live updates with it
    reconnect: () => live.reconnect(),
    // The session ended (signed out, it expired, or another tab changed who's signed in) or
    // the account was deleted: no more live updates or re-lists, which need a token, not even
    // a burst's re-list or a failed one's retry still waiting, and the team isn't reported as lost
    stop: () => {
      removed = true;
      live.stop();
      for (const c of Object.values(colls)) {
        clearTimeout(c.retry);
        if (c.held) { clearTimeout(c.held.timer); c.held = null; }
      }
    },
  };
}
