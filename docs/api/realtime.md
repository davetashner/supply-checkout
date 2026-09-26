# Live updates: the client contract

How the browser adapter (bead `supply-checkout-a2b`) turns AppSync Events into the app's `onSnapshot` callbacks ([ADR 0006](../adr/0006-api-and-realtime-sync.md), with the per-member channels of [ADR 0016](../adr/0016-per-member-live-update-channels.md)). The HTTP data API it fetches from is in [openapi.yaml](openapi.yaml).

**In short:** subscribe to your own channel, `/users/<sub>`, with the Cognito access token. Each event names a document that changed (team, collection, ID, operation, version) and carries **none of its data**. Ignore events for teams other than the one on screen. Fetch the document through the data API, which checks membership on every request. Re-list both collections after every (re)subscribe. If the WebSocket can't connect, poll the list routes instead.

## Why events carry no data, and who gets them

AppSync checks who may subscribe once, when the client subscribes. It has no way to end or filter a subscription from the server later, and a WebSocket connection can stay open for up to 24 hours. So two things keep a removed member out:

- **Events carry no documents.** Everything a client sees comes from the data API, which reads the caller's `MEMBER` item on every request.
- **Events go only to current members.** Each user has their own channel, and only they can subscribe to it. The stream consumer publishes a team's changes to the channel of each current member of the team, and to nobody once the team has ended. It rereads a team's members at least every 30 seconds, and at once when it sees a change to them.

| When | Document contents | Change notices (team, collection, ID, operation, version) |
| --- | --- | --- |
| A member is removed, or leaves | Stop at once: the next fetch gets `403 permission_denied` | Stop within about 30 seconds, and normally at once: the consumer stops publishing the team's changes to their channel. Their subscription stays open and still gets their other teams' changes. |
| A team's subscription ends (`canceled`, `unpaid`, `incomplete_expired`) | Whatever the data API allows for a canceled team, from the moment the status changes. Live updates add nothing. | Stop for every member within about 30 seconds, and normally at once. They start again if the subscription is reactivated. |

The decision and the alternatives (a rotating team channel, AppSync handlers, authorizer TTLs) are in [ADR 0016](../adr/0016-per-member-live-update-channels.md).

## Endpoints

| | |
| --- | --- |
| WebSocket | `wss://realtime.<env domain>/event/realtime` (SSM `/supply-checkout/<env>/realtime/websocket-url`) |
| `host` for the authorization object | `realtime.<env domain>` (SSM `/supply-checkout/<env>/realtime/host`) |
| Channel | `/users/<sub>`, one per user, where `<sub>` is the `sub` of your access token (the `user.id` from `GET /me`). Nothing else is allowed: no wildcards, no deeper paths, no other user's channel. |
| Data API | `https://api.<env domain>` ([openapi.yaml](openapi.yaml)) |

The web app's Content-Security-Policy already allows `https://` and `wss://` to `realtime.<env domain>`.

## Connecting

Authorization is the Cognito **access token** (not the ID token), the same one the data API takes. It goes in a WebSocket subprotocol:

```js
const auth = { host: "realtime.<env domain>", Authorization: accessToken };
const header = btoa(JSON.stringify(auth)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const ws = new WebSocket("wss://realtime.<env domain>/event/realtime", ["aws-appsync-event-ws", `header-${header}`]);
ws.onopen = () => ws.send(JSON.stringify({ type: "connection_init" }));
```

AppSync answers `{"type":"connection_ack","connectionTimeoutMs":300000}` and then sends `{"type":"ka"}` about every 60 seconds. If no `ka` (or other message) arrives within `connectionTimeoutMs`, close the socket and reconnect. An invalid or expired token closes the connection or answers with an error instead of the ack.

## Subscribing

```js
ws.send(JSON.stringify({
  type: "subscribe",
  id: crypto.randomUUID(),            // unique per connection; [A-Za-z0-9_+-]{1,128}
  channel: `/users/${userId}`,          // your own sub
  authorization: { host: "realtime.<env domain>", Authorization: accessToken },
}));
```

`subscribe_success` means the channel is the caller's own. It says nothing about teams: the channel gets the changes of every team the user is currently in (any role, viewers included). `subscribe_error` (an `UnauthorizedException`) means the channel isn't exactly `/users/<sub>` for the token's user, or the token is invalid. Re-list as after a subscribe; the data API says whether the user is still in the team.

Clients can't publish. The `users` namespace takes publishes only from the stream consumer's IAM role.

## Events

Each `data` message carries one event as a JSON string:

```json
{ "type": "data", "id": "<subscription id>", "event": "{\"v\":1,\"teamId\":\"7d3b8a52-…\",\"eventId\":\"…\",\"collection\":\"sheets\",\"id\":\"s-123\",\"op\":\"put\",\"version\":8,\"at\":1790000000000}" }
```

| Field | |
| --- | --- |
| `v` | Format version, `1`. Ignore events with a `v` you don't know. |
| `teamId` | The team whose document changed. Your channel carries every team you're in: ignore events for a team you aren't showing. |
| `eventId` | The DynamoDB stream record's ID. A retried batch publishes the same event again with the same `eventId`. |
| `collection` | `products` or `sheets` |
| `id` | The product key or sheet ID (the last segment of the document's API path; percent-encode it in the URL) |
| `op` | `put` (created, replaced, updated, or a product's stock changed) or `delete` |
| `version` | The version after a `put`, or the deleted document's last version. Missing only for a malformed item: then just fetch. |
| `at` | When DynamoDB recorded the change, epoch milliseconds, to the second. For measuring, not ordering. |

There is nothing else in an event, and there never will be document data (a test checks every field).

Events for a team you've just been added to start within about 30 seconds of joining (normally at once); the re-list after subscribing covers the gap.

### Applying an event

- **`put`**: `GET /teams/{teamId}/{collection}/{id}` and deliver the result to the listeners. Skip the fetch if the event's `version` is **lower** than the one you hold. Don't skip it when it's **equal**: a product's `stock` changes through an atomic add that keeps the version.
  - `404`: it was deleted since; treat as a `delete`.
  - `403 permission_denied`: the user is no longer a member. Unsubscribe, close the socket, stop polling, and show that they've been removed from the team.
- **`delete`**: drop the document locally. No fetch.
- **Coalesce**: keep at most one fetch in flight per document; if more events for it arrive meanwhile, fetch once more when it finishes. A busy sheet can change several times a second.
- **Bursts**: a bulk write (a CSV import of hundreds of items) sends an event per document. Don't fetch them all: past a few fetches a second for one collection, hold the events and re-list the collection once they stop. The web app fetches up to 10 documents per collection a second; past that it holds events and re-lists after 300 ms without one, or 2 seconds after the first was held if they keep coming, and it counts the re-list as a full second's fetches (`BURST_FETCHES` and the rest in `src/aws/db.js`). A 200-row import costs each client at most 10 fetches and a re-list or two, not 200 fetches.
- **Other teams**: drop events whose `teamId` isn't the team on screen, before anything else.
- **Order**: events for one team arrive in the order the writes happened, but a retry can repeat older events after newer ones. Because every `put` is answered by fetching the current document, a repeated or out-of-order event only costs a fetch; it can't leave stale data on screen.
- **Your own writes** come back as events too. The write's response already has the new version, so a `put` whose `version` equals the one you just wrote can be skipped for sheets. For products, fetch anyway (stock).

## Reconnecting

Events published while a client is disconnected are gone; AppSync doesn't replay them. So:

1. Reconnect with jittered exponential backoff (1 s, 2 s, 4 s … capped at 30 s), on socket close, a missed keep-alive, or the browser's `online` event.
2. After every `subscribe_success`, the first and each later one, **re-list both collections** (`GET /teams/{teamId}/products` and `/sheets`, following `cursor`) and deliver them as the new state. Events that arrive during the re-list are applied as above.
3. When the tab becomes visible again (`visibilitychange`), re-list too: mobile browsers freeze background tabs without closing their sockets.
4. While connected, also re-list every 10 minutes. It's cheap, and it covers the rare batch of events the consumer gave up on (see "Live updates dropped" in [docs/journeys.md](../journeys.md)).
5. When the access token is refreshed (hourly), reconnect with the new one. AppSync checks tokens only at connect and subscribe, so this isn't needed for the socket to keep working, but it means a signed-out user's open subscription ends within the hour on a well-behaved client. (Removal from a team doesn't depend on it: the consumer stops publishing to a removed member.)

After 5 minutes offline (acceptance: "reconnect after 5 minutes offline shows correct data"), step 2 is what makes the screen right.

## Polling fallback

Some networks block WebSockets. If no `connection_ack` arrives within 10 seconds, three connects in a row, or the socket closes before the ack three times:

- Re-list both collections every **15 seconds** while the page is visible, and every **60 seconds** while hidden (or stop, and re-list on `visibilitychange`), comparing versions to decide what to deliver.
- Keep trying the WebSocket every 2 minutes. Once a subscription succeeds, re-list once and stop polling.
- A `403` from polling means the same as above: removed from the team.

At 15 seconds, a crew of five polling both collections all day is well under the API's throttling, and each list call is one `Query`.

## How the cut-off works

Built in `supply-checkout-4zn` ([ADR 0016](../adr/0016-per-member-live-update-channels.md)):

- The consumer reads a team's audience with `liveUpdateRecipients` (`backend/src/data/live-audience.ts`): the `META` item's `status` and the `MEMBER#` items' `userId` and `role`, strongly consistent. An ended team, or one that doesn't exist, has nobody.
- It keeps each team's audience for `AUDIENCE_TTL_MS` (30 seconds, `backend/src/realtime/channels.ts`), and forgets it as soon as a batch contains a write to that team's `META` or `MEMBER#` items. The event source mapping passes those items to the consumer for this reason; they're never published.
- Nothing else has to call anything: removing a member (`removeMember`) deletes the `MEMBER#` item, and the billing webhook sets `status` with `updateTeam`.
- Tests: `backend/test/live-update-cutoff.test.ts` removes a member, has a member leave, and cancels a team through the Stripe webhook's context, against DynamoDB Local, and checks that notices stop at once when the consumer sees the change and within the cache time when it doesn't. `backend/test/realtime-authorizer.test.ts` checks that nobody can subscribe to another user's channel.

## Measuring after a deploy

Acceptance: a change on one device shows on another within 2 seconds at p95 in staging; nobody can subscribe to another user's channel (covered by `backend/test/realtime-authorizer.test.ts`); a removed member gets no more notices within about a minute (`backend/test/live-update-cutoff.test.ts`); reconnect after 5 minutes offline shows correct data.

**End to end (p95 under 2 s).** With two test users in one staging team, run a subscriber and a writer from a laptop:

1. Subscriber: connect and subscribe as user A (a Node script with the `ws` package, or [wscat](https://github.com/websockets/wscat): `wscat -p 13 -s "header-$HEADER" -s aws-appsync-event-ws -c wss://realtime.staging.supplycheckout.com/event/realtime`, then send the `connection_init` and `subscribe` messages above). Record the local time each `data` message arrives, with its `id` and `version`.
2. Writer: as user B, `PUT /teams/{teamId}/sheets/latency-<n>` 200 times, one every 2 seconds, recording the local time each request was **sent**.
3. Latency for each write = event arrival − request sent, matched on the sheet ID and version. Take the 95th percentile. It includes the API write, the stream, the consumer and AppSync's fan-out: everything a crew member waits for. Running both on one machine keeps the clocks the same.

**Server side, all the time.** The consumer logs one `Batch` line per invocation with `lagMs` (now minus the oldest record's stream time, which is to the second), and the `Live updates delayed` alarm watches its `IteratorAge`. In Logs Insights, on `/aws/lambda/supply-checkout-<env>-live-updates`:

```
filter message = "Batch" | stats pct(lagMs, 95) as p95, count() by bin(1h)
```

Subtract about 500 ms for the second-precision timestamp. The dashboard's "J4: live updates" graph shows `LiveUpdates` and `LiveUpdateFailures`.

**Reconnect after 5 minutes offline.** In staging, open the app on a phone, turn on airplane mode, have another device check out and return items and create a sheet for 5 minutes, turn airplane mode off, and check that within a few seconds the phone shows the same sheets and counts as the other device, without a manual reload. The adapter's contract tests (a2b) cover the same with a mocked socket.

**Another user's channel, and removal.** Subscribe as user A to user B's channel: expect `subscribe_error`. Then, with user B subscribed to their own channel in a raw WebSocket client (not the app, which stops at the first `403`), remove B from the team and keep writing as A: B's socket should get no event for that team from about a second after the removal, and at the latest 30 seconds. Check that B's next fetch gets `403` too.
