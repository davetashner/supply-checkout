# Live updates: the client contract

How the browser adapter (bead `supply-checkout-a2b`) turns AppSync Events into the app's `onSnapshot` callbacks ([ADR 0006](../adr/0006-api-and-realtime-sync.md)). The HTTP data API it fetches from is in [openapi.yaml](openapi.yaml).

**In short:** subscribe to `/teams/<teamId>` with the Cognito access token. Each event names a document that changed (collection, ID, operation, version) and carries **none of its data**. Fetch the document through the data API, which checks membership on every request. Re-list both collections after every (re)subscribe. If the WebSocket can't connect, poll the list routes instead.

## Why events carry no data

AppSync checks who may subscribe once, when the client subscribes. It has no way to end a subscription from the server later, and a WebSocket connection can stay open for up to 24 hours. If events carried documents, a crew member removed from the team while their phone was connected would keep receiving the team's sheets. Because they don't, everything a client sees comes from the data API, which reads the caller's `MEMBER` item on every request. So:

| When | Document contents | Change notices (collection, ID, operation, version) |
| --- | --- | --- |
| A member is removed | Stop at once: the next fetch gets `403 permission_denied` | Keep arriving on a subscription that was already open, until that connection closes (at most 24 hours, and in practice at the next reconnect, see below). A new subscription is refused at once. |
| A team is canceled | Whatever the data API allows for a canceled team, from the moment the status changes. Live updates add nothing. | As above |

A product's ID is its key, which the app makes from a barcode or the product's name, so a removed member with a connection still open could see which product keys change. Cutting those notices off within about a minute would need a server-side cut-off that AppSync Events doesn't offer (GraphQL subscriptions have one; Event APIs don't). The ways to get it are in [Cutting off notices faster](#cutting-off-notices-faster); neither is built.

## Endpoints

| | |
| --- | --- |
| WebSocket | `wss://realtime.<env domain>/event/realtime` (SSM `/supply-checkout/<env>/realtime/websocket-url`) |
| `host` for the authorization object | `realtime.<env domain>` (SSM `/supply-checkout/<env>/realtime/host`) |
| Channel | `/teams/<teamId>`, one per team. Nothing else is allowed: no wildcards, no deeper paths. |
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
  channel: `/teams/${teamId}`,
  authorization: { host: "realtime.<env domain>", Authorization: accessToken },
}));
```

`subscribe_success` means the caller is a member of the team (any role, viewers included). `subscribe_error` (an `UnauthorizedException`) means they aren't, the team doesn't exist, the channel isn't exactly `/teams/<teamId>`, or the token is invalid. The authorizer gives the same answer for all of these, so it doesn't reveal which teams exist. Treat it like a `403` from the API.

Clients can't publish. The `teams` namespace takes publishes only from the stream consumer's IAM role.

## Events

Each `data` message carries one event as a JSON string:

```json
{ "type": "data", "id": "<subscription id>", "event": "{\"v\":1,\"eventId\":\"…\",\"collection\":\"sheets\",\"id\":\"s-123\",\"op\":\"put\",\"version\":8,\"at\":1790000000000}" }
```

| Field | |
| --- | --- |
| `v` | Format version, `1`. Ignore events with a `v` you don't know. |
| `eventId` | The DynamoDB stream record's ID. A retried batch publishes the same event again with the same `eventId`. |
| `collection` | `products` or `sheets` |
| `id` | The product key or sheet ID (the last segment of the document's API path; percent-encode it in the URL) |
| `op` | `put` (created, replaced, updated, or a product's stock changed) or `delete` |
| `version` | The version after a `put`, or the deleted document's last version. Missing only for a malformed item: then just fetch. |
| `at` | When DynamoDB recorded the change, epoch milliseconds, to the second. For measuring, not ordering. |

There is nothing else in an event, and there never will be document data (a test checks every field).

### Applying an event

- **`put`**: `GET /teams/{teamId}/{collection}/{id}` and deliver the result to the listeners. Skip the fetch if the event's `version` is **lower** than the one you hold. Don't skip it when it's **equal**: a product's `stock` changes through an atomic add that keeps the version.
  - `404`: it was deleted since; treat as a `delete`.
  - `403 permission_denied`: the user is no longer a member. Unsubscribe, close the socket, stop polling, and show that they've been removed from the team.
- **`delete`**: drop the document locally. No fetch.
- **Coalesce**: keep at most one fetch in flight per document; if more events for it arrive meanwhile, fetch once more when it finishes. A busy sheet can change several times a second.
- **Order**: events for one team arrive in the order the writes happened, but a retry can repeat older events after newer ones. Because every `put` is answered by fetching the current document, a repeated or out-of-order event only costs a fetch; it can't leave stale data on screen.
- **Your own writes** come back as events too. The write's response already has the new version, so a `put` whose `version` equals the one you just wrote can be skipped for sheets. For products, fetch anyway (stock).

## Reconnecting

Events published while a client is disconnected are gone; AppSync doesn't replay them. So:

1. Reconnect with jittered exponential backoff (1 s, 2 s, 4 s … capped at 30 s), on socket close, a missed keep-alive, or the browser's `online` event.
2. After every `subscribe_success`, the first and each later one, **re-list both collections** (`GET /teams/{teamId}/products` and `/sheets`, following `cursor`) and deliver them as the new state. Events that arrive during the re-list are applied as above.
3. When the tab becomes visible again (`visibilitychange`), re-list too: mobile browsers freeze background tabs without closing their sockets.
4. While connected, also re-list every 10 minutes. It's cheap, and it covers the rare batch of events the consumer gave up on (see "Live updates dropped" in [docs/journeys.md](../journeys.md)).
5. When the access token is refreshed (hourly), reconnect with the new one. AppSync checks tokens only at connect and subscribe, so this isn't needed for the socket to keep working, but it means a removed member's open subscription ends within the hour on a well-behaved client.

After 5 minutes offline (acceptance: "reconnect after 5 minutes offline shows correct data"), step 2 is what makes the screen right.

## Polling fallback

Some networks block WebSockets. If no `connection_ack` arrives within 10 seconds, three connects in a row, or the socket closes before the ack three times:

- Re-list both collections every **15 seconds** while the page is visible, and every **60 seconds** while hidden (or stop, and re-list on `visibilitychange`), comparing versions to decide what to deliver.
- Keep trying the WebSocket every 2 minutes. Once a subscription succeeds, re-list once and stop polling.
- A `403` from polling means the same as above: removed from the team.

At 15 seconds, a crew of five polling both collections all day is well under the API's throttling, and each list call is one `Query`.

## Cutting off notices faster

Neither of these is built; both are options if a minute or less is required for change notices too (document contents are already cut off at once):

- **A channel per member**, `/users/<userId>`: the consumer publishes each change to every member's channel, reading the team's members with a cache of about 60 seconds. A removed member stops getting notices within that cache time, and a canceled team's changes can simply not be published. Costs one publish per member per change instead of one per change, and replaces the per-team channel in ADR 0006.
- **A rotating team channel**, `/teams/<teamId>/<epoch>`: removing a member or canceling the team writes a new epoch on the team's `META` item; the consumer publishes to the current epoch (cached about 60 seconds), the authorizer allows only the current one, and remaining members resubscribe when told the epoch changed. Keeps one publish per change, but the member-removal and billing code must rotate the epoch.

## Measuring after a deploy

Acceptance: a change on one device shows on another within 2 seconds at p95 in staging; a non-member can't subscribe (covered by `backend/test/realtime-authorizer.test.ts`); reconnect after 5 minutes offline shows correct data.

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

**Non-member.** Subscribe as a user who isn't in the team: expect `subscribe_error`. Then remove a member while their app is connected, and check that their next fetch gets `403` and the app shows they've been removed.
