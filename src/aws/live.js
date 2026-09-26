// Live updates for the web build, over AppSync Events (docs/api/realtime.md). One
// subscription to the team's channel; each event names a changed document and carries
// none of its data, so the db module fetches it. After every (re)subscribe, when the tab
// is shown again and every 10 minutes, it asks for a full re-list (onResync), because
// events sent while disconnected are gone. If the socket can't get going three times in
// a row, it polls by re-listing instead, and keeps trying the socket every 2 minutes.
const PROTOCOL = "aws-appsync-event-ws";
const ACK_WAIT = 10e3, RESYNC = 600e3, RETRY_WHILE_POLLING = 120e3, POLL = 15e3, POLL_HIDDEN = 60e3;
const b64url = (s) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function createLive({ url, host, channel, token, onEvent, onResync }) {
  let ws = null, stopped = false, failures = 0, step = 0, polling = false;
  let retryTimer, pollTimer, resyncTimer;

  function connect() {
    clearTimeout(retryTimer);
    const auth = { host, Authorization: token() };
    const sock = ws = new WebSocket(url, [PROTOCOL, "header-" + b64url(JSON.stringify(auth))]);
    const subId = crypto.randomUUID();
    let subscribed = false, kaMs = 300e3, kaTimer = setTimeout(() => sock.close(), ACK_WAIT);
    const alive = () => { clearTimeout(kaTimer); kaTimer = setTimeout(() => sock.close(), kaMs); };
    sock.onopen = () => sock.send(JSON.stringify({ type: "connection_init" }));
    sock.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.type === "connection_ack") {
        kaMs = msg.connectionTimeoutMs || kaMs;
        alive();
        sock.send(JSON.stringify({ type: "subscribe", id: subId, channel, authorization: auth }));
      } else if (msg.type === "ka") alive();
      else if (msg.type === "subscribe_success") {
        subscribed = true; failures = 0; step = 0;
        stopPolling();
        onResync();
        clearInterval(resyncTimer); resyncTimer = setInterval(onResync, RESYNC);
      } else if (msg.type === "subscribe_error") {
        // Like a 403: the re-list finds out whether the user is still in the team
        onResync();
        sock.close();
      } else if (msg.type === "data" && msg.id === subId) {
        let ev = null;
        try { ev = JSON.parse(msg.event); } catch {}
        if (ev && ev.v === 1) onEvent(ev);
      }
    };
    sock.onclose = () => {
      clearTimeout(kaTimer);
      if (sock !== ws || stopped) return;
      ws = null;
      clearInterval(resyncTimer);
      if (!subscribed && ++failures >= 3) startPolling();
      // Jittered exponential backoff: 1 s, 2 s, 4 s … 30 s; every 2 minutes while polling
      const wait = polling ? RETRY_WHILE_POLLING : Math.min(30e3, 1e3 * 2 ** step++) * (0.5 + Math.random() / 2);
      retryTimer = setTimeout(connect, wait);
    };
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    const poll = () => { onResync(); pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN : POLL); };
    poll();
  }
  function stopPolling() { polling = false; clearTimeout(pollTimer); }

  // A new socket right away (a new token, or the network is back)
  function reconnect() {
    if (stopped) return;
    const old = ws;
    ws = null;
    if (old) old.close();
    connect();
  }

  return {
    start() {
      connect();
      document.addEventListener("visibilitychange", () => { if (!document.hidden && !stopped) onResync(); });
      window.addEventListener("online", () => { if (!ws) reconnect(); });
    },
    // AppSync checks the token only when connecting, so reconnect with each new one
    reconnect,
    stop() {
      stopped = true;
      stopPolling();
      clearTimeout(retryTimer); clearInterval(resyncTimer);
      const old = ws;
      ws = null;
      if (old) old.close();
    },
  };
}
