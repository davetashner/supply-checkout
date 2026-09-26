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
    { "id": "…", "name": "Echo Cleaning", "role": "owner", "plan": "trial", "status": "trialing", "trialEndsAt": "2026-10-10T12:00:00.000Z", "homeRegion": "…" }
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
   invite's ID and a one-time token (the link format is
   `supply-checkout-5tp`'s; for example `?invite=<id>&token=<token>`). Keep
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
     (`emailVerified: false`, and `invites` is always empty then). Ask the
     user to verify their email in Managed Login.
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
answer a viewer's write with `403 invalid_argument`). Use `status` and
`trialEndsAt` for the trial banner.

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
