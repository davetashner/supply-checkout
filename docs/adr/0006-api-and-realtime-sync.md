# 0006. HTTP API for reads and writes, AppSync Events for live updates

- Status: Proposed
- Date: 2026-09-25

## Context

The app depends on live updates: `onSnapshot` on `products` and `sheets` means one person's checkout shows up on another person's phone without a refresh. The API also has to run in two regions at once ([ADR 0010](0010-multi-region-active-active.md)) and has to check team membership and subscription status on every write.

## Decision

- **Commands and queries**: an API Gateway **HTTP API** with a Cognito JWT authorizer, backed by a small number of Lambda functions grouped by area (`data`, `teams`, `billing`, `receipts`). REST-style JSON routes such as `GET /teams/{id}/sheets`, `PATCH /teams/{id}/sheets/{sheetId}`, and `POST /teams/{id}/products/{key}/stock:increment`.
- **Live updates**: **AppSync Events** (managed WebSocket pub/sub), one channel per team (`/teams/{teamId}`). Clients subscribe with their Cognito token; an AppSync Lambda authorizer checks that the caller belongs to that team.
- **Fan-out**: a DynamoDB Streams consumer in **each** region publishes a small change event (`{collection, id, op, version}`) to that region's AppSync Events API. Because global tables replicate into both regions, clients connected to either region see every change, whichever region wrote it.
- Events carry no document data. AppSync checks membership only when a client subscribes and can't end a subscription later, so the adapter turns each event into an `onSnapshot` callback by fetching the changed document through the HTTP API, which checks membership on every request. A member removed while connected gets no more document contents. On reconnect the adapter refetches the whole collection, so an event missed while offline can't leave the screen stale. The client contract is [docs/api/realtime.md](../api/realtime.md).
- **Inventory commands** (`supply-checkout-1dg.1`): checkout, return and stock adjustment are commands next to the document routes (`POST /teams/{teamId}/sheets/{sheetId}/checkout`, `.../return`, `POST /teams/{teamId}/products/{key}/stock`). Each is one DynamoDB transaction that changes the sheet line, the stock and a movement record together, and each carries a client-generated operation ID, so a retry returns the first result instead of applying it again. The client contract is [docs/api/commands.md](../api/commands.md).
- Every write carries a `version` number. The server applies it with a conditional update, so two people editing the same sheet line can't silently overwrite each other; the loser gets a 409 and the UI refreshes that line.

## Alternatives considered

- **AppSync GraphQL with subscriptions.** Subscriptions only fire for mutations that go through the same regional API, so writes arriving in the other region, or from Stripe webhooks, would be missed without extra work. GraphQL also adds a schema layer the app doesn't need.
- **API Gateway WebSocket APIs.** Would mean running connection tracking in DynamoDB ourselves.
- **Polling every few seconds.** Simple, but slower to feel "live" and costs more in requests at scale. Kept as the fallback when a WebSocket can't connect (some corporate networks block it).

## Consequences

- Reads, writes and live updates each scale independently, and each is paid per request or message.
- The adapter has to handle reconnects and resyncs. Contract tests cover this.
