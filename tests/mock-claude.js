// In-memory stand-in for the claude.ai artifact runtime (window.claude).
// Injected with page.addInitScript, so it must be self-contained.
export function installMockClaude(opts) {
  const {
    seed = {}, canWrite = true, userId = "u_test", receipt = null,
    // Failure modes: a capability that isn't available, or calls that reject
    unavailable = [], writeError = null, sampleError = null,
    // More failure modes, all off by default:
    noRuntime = false, // no window.claude at all
    rejects = [], // capabilities whose use() call rejects
    writeErrorFor = null, // { prefix, code }: writes to matching paths fail
    limits = undefined, limitsError = false, // sample.limits() result, or it throws
    userErrors = [], // user methods that throw: "id", "can", "profiles"
    snapshotError = false, // collection listeners report an error instead of data
    downloadError = null, // downloads.save rejects with this code ("bare": rejects with no error object)
    sampleHang = false, // sample.json waits until its signal aborts
    instantUpdates = false, // listeners fire during a write, before it resolves (like a local-first database)
  } = opts || {};
  const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
  const docs = new Map(Object.entries(clone(seed)));
  const listeners = new Set();
  const mock = { docs, saves: [], sampleCalls: [] };
  window.__mock = mock;

  const denied = () => ({ code: "invalid_argument", message: "write not allowed" });
  const guard = (path) => {
    if (!canWrite) throw denied();
    if (writeError) throw { code: writeError, message: "simulated " + writeError };
    if (writeErrorFor && path.startsWith(writeErrorFor.prefix)) throw { code: writeErrorFor.code, message: "simulated " + writeErrorFor.code };
  };
  const fire = () => listeners.forEach((l) => l());
  const notify = () => (instantUpdates ? fire() : setTimeout(fire, 0));
  // Tests call this after changing mock.docs directly, to act as another user
  mock.notify = notify;
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
      set: async (data) => { guard(path); docs.set(path, clone(data)); notify(); },
      update: async (data) => {
        guard(path);
        if (!docs.has(path)) throw { code: "invalid_argument", message: "no such document" };
        merge(docs.get(path), data); notify();
      },
      delete: async () => { guard(path); docs.delete(path); notify(); },
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

  const db = { doc: docRef, collection: collRef };
  const profile = (id) => ({ id, name: id === userId ? "Test User" : "", avatarUrl: "data:,", color: "#336", email: null, isMe: id === userId, guest: false });
  const fails = (name) => { if (userErrors.includes(name)) throw { code: "unavailable", message: "simulated " + name + " failure" }; };
  const user = {
    id: async () => { fails("id"); return userId; },
    me: async () => ({ ...profile(userId), isOwner: true, canEdit: canWrite }),
    can: async () => { fails("can"); return canWrite; },
    isOwner: async () => true,
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
  sample.json = async (prompt, { signal } = {}) => {
    mock.sampleCalls.push(prompt);
    if (sampleHang) await new Promise((_, reject) => signal.addEventListener("abort", () => reject({ code: "cancelled", message: "cancelled" })));
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
