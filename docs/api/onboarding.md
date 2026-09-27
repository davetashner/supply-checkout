# First sign-in and the team switcher

How the web app (the AWS adapter, `supply-checkout-a2b`) gets a signed-in user
into a team. The routes are in [openapi.yaml](openapi.yaml) under the `account`
tag; the handler is `backend/src/api/account-handler.ts`.

## Before calling

- Request the `aws.cognito.signin.user.admin` scope when signing in (as well as
  `openid email profile`). The server reads the caller's email with Cognito's
  `GetUser`, which needs it. Without it, `/me` and the invite route answer 401.
- Send the access token (`Authorization: Bearer <token>`) as on the data routes.
  Not the ID token.

## The flow

After sign-in (and after every page load with a session), call `GET /me`:

```json
{
  "user": { "id": "<sub>", "email": "pat@example.com", "emailVerified": true },
  "teams": [
    { "id": "…", "name": "Echo Cleaning", "role": "owner", "plan": "trial", "status": "trialing", "trialEndsAt": "2026-10-10T12:00:00.000Z", "homeRegion": "…", "comp": null }
  ],
  "invites": [
    { "id": "…", "teamName": "Bravo Co", "role": "contributor", "expiresAt": "2026-10-03T12:00:00.000Z" }
  ]
}
```

Then:

1. **No teams and no invites** (a new user): show "Name your team", one text
   field (1–200 characters). On submit, `POST /teams` with `{"name": "…"}` and an
   `Idempotency-Key` header. Make the key once when the form opens
   (`crypto.randomUUID()`), and send the same key if the user double-clicks or
   the request is retried; make a new one only for a different team. `201` is
   a new team and `200` is the one an earlier request with that key made: both
   return `{"team": {…}}`, with `role: "owner"`. Open it: its `id` is the
   `teamId` for the data routes. It's empty, so the app shows its empty
   inventory, ready to add products.
2. **Arrived from an invite link.** The invite email links to the app with the
   invite's ID and a one-time token:
   `https://app.<env domain>/?invite=<id>&token=<token>`. (It opens the web
   app; opening the mobile app from it, with universal links, comes with the
   phase 2 apps.) Keep
   both across sign-in (in `sessionStorage`, then remove them from the URL),
   and once `/me` has loaded offer that invite ("Bravo Co invited you as a
   contributor") with **Join**, and **Create my own team instead** if the user
   has no teams. **Join** is `POST /invites/{id}/accept` with
   `{"token": "<token from the link>"}`; it returns `{"team": {…}}` with the
   invited role. Open that team.
   - `404 not_found`: the invite expired, was used or revoked, the token is
     wrong, or it was sent to another address. Say so, and suggest asking for
     a new invite.
   - `429 quota_exceeded`: the user is already in 20 teams; they must leave one.
   - `403 permission_denied`: the email isn't verified. `/me` says so too
     (`emailVerified: false`, and `invites` is always empty then). Offer to
     verify it: `POST /me/email/code` emails a 6-digit code, and
     `POST /me/email/verify` with `{"code": "…"}` checks it. Then refresh the
     tokens (`POST /auth/refresh`) and load `/me` again.
   - `409 aborted`: they're already in the team. Open it.

   **Invites in `/me` without a link** (the user signed in some other way):
   show them ("Bravo Co invited you as a contributor"), with "Open the link in
   your invite email to join". They can't be accepted without the token.
3. **One team, no invites**: open it.
4. **Several teams**: open the last one used (keep its ID in `localStorage`;
   if it's no longer in `teams`, fall back to the first) and show a switcher
   listing `teams` by `name`. Switching is client-side only: use the other
   team's `id` in the data routes' path and resubscribe to its live updates.
   The server checks membership on every request, so a stale choice just gets
   `403 permission_denied`; call `/me` again and pick another team.

Use `role` to show or hide editing (viewers read only; the data routes also
answer a viewer's write with `403 permission_denied`, `reason: "view_only"`). Use `status` and
`trialEndsAt` for the trial banner.

## Inviting people

Owners invite from the members screen: `POST /teams/{teamId}/invites` with
`{"email", "role"}`. The server makes the invite and emails the link above; the
response is the invite as owners see it (never the token), with `inviteStatus`
`pending`, or `failed` with `failureReason: "not_sent"` if SES wouldn't send
it. `GET /teams/{teamId}/invites` lists them: `pending`, `failed` (`bounced`,
`complained` or `not_sent`, shown as "Couldn't deliver" with why) or
`expired`. `DELETE /teams/{teamId}/invites/{inviteId}` revokes one, and
`POST /teams/{teamId}/invites/{inviteId}/resend` replaces it with a new link
(a new `id`), pending again. To correct an address, revoke the invite and make
a new one. Each team can send 50 invites a day, 3 to any one address, and each
address can be sent 15 from all teams (429 `quota_exceeded`). The address must
be a bare `name@example.com` (400 otherwise); an address that's already a member's, or already has a
live invite to the team, is 409 `aborted` with a message to show. Removing a
member also revokes their other invites to the team.

A team can have 10 members while it's on its trial (or its subscription isn't
paying), and 100 once it's `active` or `past_due`. Members and live invites
together count: an invite past the cap is 429 `quota_exceeded` with
`reason: "team_full"`, and so is accepting an invite to a team that filled up
meanwhile (the invite stays, and works once an owner makes room). Show the
message and point owners at revoking an invite or removing a member. See
[openapi.yaml](openapi.yaml) under the `invites` tag.

## Leaving, closing a team and deleting an account

- **Leaving.** Anyone can leave a team with `DELETE /teams/{teamId}/members/{userId}`
  and their own user ID (`user.id` in `/me`). The web app offers it in the team
  bar to contributors and viewers (two taps), and to owners on the members
  screen. A team's last owner can't leave an open team (409 `last_owner`).
- **Closing a team.** Owners: `POST /teams/{teamId}/close` with `{"name": "…"}`,
  the team's name as the owner typed it (any case, spaces around ignored;
  otherwise 400 and nothing changes). The team turns read-only at once: every
  member can still read it (owners can export it) and leave, the last owner
  included, but any write is 403 `permission_denied` with
  `reason: "team_closed"`. Its invites go, nobody can join, and live updates
  stop. `/me` shows it with `closedAt` and `deletesAt`; show that it's
  closed, and when its data will be deleted, and open it read-only. 30 days
  after closing, all of it is deleted. Closing a closed team returns it as it
  is. It can't be reopened. Every owner is emailed that the team closed and
  the day it will be deleted, so an owner who didn't close it finds out. The
  email is best effort: the team is closed even if some owners weren't emailed.
- **Deleting an account.** `DELETE /me` with `{"confirm": "DELETE"}` (typed by
  the user). 409 `last_owner` while they're the only owner of an open team
  other people are in: show the message (it names the teams); they make
  someone else an owner, or close the team, first. Otherwise they leave every
  team (one they're alone in is closed first), invites to their verified
  email and everything the server keeps about them are deleted, and last
  their sign-in. 204 means it's done: forget the tokens and everything kept on
  the device; the refresh token no longer works, so a refresh answers 401 and
  clears the cookie. If it fails part-way, call it again: it carries on.

## Errors from `POST /teams`

- `400 bad_request`: no or malformed `Idempotency-Key` (8–128 letters, digits,
  `-` or `_`), a missing or blank name, a name over 200 characters, or any
  body field other than `name`.
- `409 aborted`: the same `Idempotency-Key` already made a team with another
  name. Make a new key when the user changes the name after a failed attempt.
- `429 quota_exceeded`: the user has created 5 teams today (UTC), or is already
  in 20 teams. Show the message.

## What the server guarantees

- The user is always the token's `sub`. `/me` has no parameters, so it can't
  be asked about anyone else.
- A new team gets the caller as its only owner, `homeRegion` = the region that
  served the request, `plan: "trial"`, `status: "trialing"` and a 14-day
  `trialEndsAt` (ADR 0009). Billing (`supply-checkout-x0l`) takes it from there.
- An invite is listed only for the email address Cognito has verified for the
  caller. It is accepted only with the token from its emailed link *and* by a
  caller with that verified address, only before it expires, and only once.
  Users can't mark their own email verified: the web client can't write
  `email_verified`. A Google or Apple user's email counts as verified only
  when the provider says it is (a user pool trigger copies the provider's
  claim at each sign-in; see "Sign-in" in docs/infrastructure.md).
- Every DynamoDB call runs on a role session scoped by IAM to the caller's own
  `USER#` partition, plus at most the one team and the one invitee partition
  the request is entitled to (see "Data API" in docs/infrastructure.md).
