# 0016. A live-update channel per member, not per team

- Status: Accepted
- Date: 2026-09-28 (proposed 2026-09-26)
- Note: The owner accepted this on 2026-09-28. Built and deployed as described.
- Changes: the "one channel per team" part of [ADR 0006](0006-api-and-realtime-sync.md). The rest of 0006 stands.

## Context

[ADR 0006](0006-api-and-realtime-sync.md) sends live updates through AppSync Events on one channel per team, `/teams/<teamId>`, with a Lambda authorizer that checks membership when a client subscribes. Events carry no document data, so a removed member can't get contents: the data API checks membership on every request.

They did still get **change notices** (collection, ID, operation, version) on a subscription that was open before they were removed, until the connection closed: up to 24 hours, or within the hour on a client that reconnects when its token refreshes. A product's ID is its barcode or its name, so these notices say something. Bead `supply-checkout-4zn` requires that a removed member, and every member of a canceled team, get no more notices within about 60 seconds.

What AppSync Events offers (checked against the AWS docs, September 2026):

- **No server-side cut-off.** An Event API can't close a connection, end a subscription, or filter what one subscriber gets. GraphQL APIs have invalidation filters (`extensions.invalidateSubscriptions`) and enhanced subscription filters; Event APIs don't.
- **`onSubscribe` handlers** (APPSYNC_JS, or a direct Lambda integration) run once, when a client subscribes. They can refuse a subscription, not end one later. That's what our Lambda authorizer already does.
- **`onPublish` handlers** run once per publish, with the publisher's identity, not once per subscriber. They can drop or change an event for everybody on the channel, not for one person.
- **The authorizer's result cache (`ttlOverride`, `resultsCacheTtl`)** applies to new connect, subscribe and publish requests. A short TTL doesn't recheck an open subscription.

So a cut-off has to come from **what gets published where**: stop publishing anything a removed member's open subscription can receive.

## Decision

**Each signed-in user has one channel, `/users/<sub>`, and only that user may subscribe to it. The stream consumer publishes each change to the channel of every current member of the team, and to nobody once the team has ended.**

- **Subscribing.** The authorizer allows `EVENT_SUBSCRIBE` only to exactly `/users/<sub>` where `<sub>` is the verified access token's own user. No wildcard, no other path, no other user's channel. It reads no data at all, so it no longer has any table or KMS access. The namespace is `users`. As before, only IAM can publish to it, and only the consumer's role has `appsync:EventPublish`.
- **Publishing.** For each team in a stream batch, the consumer asks `liveUpdateRecipients(db, teamId)` (in `src/data`) for the team's members: one strongly consistent `GetItem` on `META` (the subscription status) and one `Query` of the `MEMBER#` items. A team that doesn't exist, or whose status has ended (`canceled`, `unpaid`, `incomplete_expired`: `ENDED_STATUSES` in `model.ts`), has nobody. It publishes the team's events, in order and 5 per request, to each member's channel. Each event now also carries `teamId`, because one user's channel carries every team they're in.
- **The cut-off.** The consumer caches each team's members for `AUDIENCE_TTL_MS`, 30 seconds. So a removed member, or a canceled team, stops getting notices **within 30 seconds plus the stream's delay** (usually under a second), whoever made the change and however. The event source mapping also passes the team's `META` and `MEMBER#` writes. When a batch has one, the consumer forgets that team's members before it publishes anything in the batch. A team's items share a partition key and so usually a stream shard, so the removal normally reaches the consumer before later writes and the cut-off is **immediate** in practice. DynamoDB Streams only promises order per item, though, and another consumer container may still hold the old list, so the 30-second cache is the guaranteed bound.
- **Canceling a team needs no extra call.** The billing webhook (not built yet) already sets the team's `status` through `updateTeam`. That write is in the stream and is what the consumer reads. A test cancels a team through `teamContextForStripeCustomer` and `updateTeam` and checks that notices stop.
- **Least privilege for the consumer.** Its new table permission is `GetItem` and `Query`, only on `TEAM#*` partition keys (`dynamodb:LeadingKeys`), and only for the attributes `PK`, `SK`, `userId`, `role` and `status` (`dynamodb:Attributes` with `dynamodb:Select = SPECIFIC_ATTRIBUTES`, from `LIVE_AUDIENCE_ATTRIBUTES` in `schema.ts`). It can't read documents or members' emails through the table. It could already read every item's images from the stream, which it needs for the change itself, so this adds nothing it could read before.

## Alternatives considered

- **A rotating team channel, `/teams/<teamId>/<epoch>`.** Removing a member or canceling the team writes a new epoch on `META`. The consumer publishes to the current epoch (cached), the authorizer allows only the current one, and the remaining members resubscribe when told the epoch changed. It keeps one publish per change. But:
  - Every path that ends access (removal, leaving, the billing webhook, a support tool, a hand fix in the console) has to remember to rotate. One that forgets leaves the removed member receiving notices with no time limit. With per-member channels the cut-off comes from the membership itself.
  - The remaining members must learn the new epoch and resubscribe. That needs a "rotated" notice on the old channel, which the removed member also gets, and a race to handle while clients move over.
  - The authorizer still has to read membership and the epoch on every subscribe.
- **An `onPublish` handler that filters by subscriber.** Not possible: it runs once per publish, not per subscriber.
- **An `onSubscribe` handler or a short authorizer TTL.** Both act only when a client subscribes, which already refuses non-members. Neither affects an open subscription.
- **Relying on clients to reconnect at token refresh.** That's up to an hour, and a modified client can simply not reconnect. It stays in the contract as good behavior, not as the control.
- **Moving live updates to AppSync GraphQL subscriptions, for invalidation filters.** ADR 0006 already turned GraphQL down (it only sees mutations through the same regional API). Switching back for this one feature would redo the live-update design.

## Consequences

- **Cost.** One publish request per member per chunk of up to 5 changes, instead of one per chunk. AppSync Events bills each inbound publish and each outbound delivery, and outbound deliveries were already one per subscriber, so the bill for a crew of five goes from about 6 to about 10 operations per change. At $1 per million operations that's far below a cent per user per month.
- **Large teams.** A batch for a big team is many requests. The consumer keeps at most `PUBLISH_CONCURRENCY` (20) requests in flight across the batch. At about 30 ms a request, a 100-member team takes about 150 ms per chunk of 5 changes, well inside the function's 10-second timeout and the 2-second p95 target for crews of typical size. If teams of several hundred become common, the rotating epoch is still an option for them.
- **Imports** (bead `supply-checkout-x28m`). A batch with more than 10 changes to one team's collection publishes one collection event ("re-list products") in their place, so a 200-row import costs each member about 8 publishes, not 40 requests of 5. It names no documents.
- **Bounding the fan-out** (bead `supply-checkout-o4z`). A team has at most 100 members (10 on a trial; `memberCap` in `backend/src/data/model.ts`, enforced when an invite is accepted). The event source mapping hands the consumer 25 records at a time, and one invocation makes at most 2,500 publish requests, started within 5 seconds (`channels.ts`), earliest records first. When the budget runs out it reports the earliest unfinished record and Lambda carries on from there. So one busy team holds its shard for one budget at most before the next invocation, and a slow AppSync ends an invocation with what it sent instead of timing out and sending the whole batch again.
- **Fewer subscriptions.** A client subscribes once for all its teams, and switching teams doesn't need a new subscription (the web app still makes one on each team switch, and ignores events for other teams).
- **New members** start getting notices at once when the consumer sees their `MEMBER#` write, and within the cache time otherwise. The client re-lists after every subscribe anyway.
- **A user with an invalid channel name** (a `sub` that isn't a channel segment) gets no notices. The consumer logs a warning. Cognito `sub`s are UUIDs, so this doesn't happen in practice.
- **Deploying** replaces the `teams` namespace with `users`. The web client and the backend have to ship together. They do, in one change, before launch.
