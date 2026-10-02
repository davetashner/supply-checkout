# The operator page: using it, and when it doesn't work

For operators: people in the operator pool's `operators` group ([Operators](../infrastructure.md#operators), [ADR 0015](../adr/0015-platform-operator-role.md)). The page is at `https://ops.supplycheckout.com/` (`https://ops.<env>.supplycheckout.com/` elsewhere). It does what `npm run ops` does for teams and comps; reopening a team, stuck imports and the receipt ranking are in the CLI. Bead `supply-checkout-gxlt`.

## Signing in

**Sign in** goes to `ops-auth.supplycheckout.com`: your operator username and password, then the 6-digit code from your authenticator app. That's the operator account, never your customer account (a customer token is refused). The page keeps your session only in the tab's memory for 15 minutes: then, or after a reload, it asks you to sign in again, which within an hour of your last password usually comes straight back without asking. Nothing is saved in the browser.

**Sign out** forgets the session in the tab and ends the sign-in page's session. It doesn't revoke the 15-minute token itself. If you think a token was taken (a lost or shared laptop), revoke every token at once with `npm run ops -- sign-out`, or ask an administrator for `npm run operators -- disable <username>` and `admin-user-global-sign-out` ([Operators](../infrastructure.md#operators)).

## Comping a team

1. **Teams**: search by name or team ID. A search reads teams in batches; if it says it isn't finished, press **More**.
2. Open the team. Check its plan, status, comp (with months left), and, for a team paying through Stripe, its subscription and whether a comp discount is on (`Comp discount: invoices $0 until about …`).
3. **Comp this team** (or **Change or extend the comp**):
   - **For a number of months** (1 to 12): the team keeps its plan unless you change it, and a team paying monthly through Stripe also gets $0 invoices for those months, then billing resumes by itself. The discount is applied by the billing worker a moment later: open the team again in a minute to see it, and the team's audit has the `ops.comp.discount` outcome.
   - **Until a date** (UTC, at most 12 months ahead): changes access in the app only, with no Stripe discount (it removes one an earlier months comp gave).
   - **Seats** only when the comp should allow a different number of members than the plan.
   - **Reason**, always: it's in the audit, and the team's owners see the action as "Supply Checkout support".
4. **End the comp** ends it now, and takes off any Stripe discount it gave. It needs a reason too.

## When a change isn't saved

| The page says | What it means | What to do |
| --- | --- | --- |
| **Not saved.** The team changed since you read it … **Read the team again** | Someone or something changed the team after you opened it (another operator, an owner, billing). Nothing was changed. | Press **Read the team again** (what you typed is kept), check the team now, then send the change again if it still makes sense. |
| **Not saved.** This team is closed … | A closed team can't be comped. | Reopen it first with `npm run ops -- reopen <teamId> --reason …` if that's right, then comp it. |
| **Not saved.** This team has no comp | There's nothing to end. | Read the team again. |
| No answer from the API … applied at most once | The request may or may not have arrived. | Press the same button again without changing anything: it sends the same request with the same key, which the API applies only once. |
| Your session ended … Sign in again | The 15 minutes ran out, or your token was revoked or you were removed from the group. | Sign in again. If it keeps happening at once, ask an administrator whether your account is still in `operators`. |
| This account isn't an operator | The API refused the account (403). | Ask an administrator (`npm run operators -- list`). |
| ops-config.json … must be … | The published page's config points at the wrong hosts. | An administrator republishes it (`npm run publish:ops`). |

## When the page itself doesn't load

- **503 from `ops.`**: nothing is published on the `ops` channel, or its live version isn't an `ops-*` release. `npm run publish:web -- live --channel ops` shows it; `npm run publish:ops` publishes, `npm run publish:web -- activate --channel ops --version <ops-…>` rolls back.
- **404**: only `/`, `/ops-config.json` and the page's own `/assets/` files exist there. Go to the root.
- **Sign-in says the redirect isn't allowed** (`redirect_mismatch`): the ops client doesn't list `https://ops.<env domain>/`. The identity stack adds it; redeploy it, and check CloudTrail for an `UpdateUserPoolClient` that removed it (that would also have paged `OperatorPoolChanges`).
- **Requests to the API fail in the browser's console with a CORS error**: the api stack's CORS doesn't list the page's origin yet; deploy the api stack.
- The CLI always works as a fallback: `npm run ops -- team <teamId>`, `comp`, `uncomp`, `audit`.
