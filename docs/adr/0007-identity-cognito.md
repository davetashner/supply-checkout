# 0007. Cognito for sign-in; teams and roles stored in our own data

- Status: Proposed
- Date: 2026-09-25

## Context

Users need to sign up, sign in on phones and desktops, belong to one or more teams, and hold a role in each team (owner, contributor, viewer). The app already supports view-only access. The iOS app has to follow App Store rules: if it offers Google sign-in it must also offer Sign in with Apple (guideline 4.8), and users must be able to delete their account from inside the app (guideline 5.1.1(v)).

## Decision

- **Amazon Cognito user pools** in the Essentials tier with **Managed Login**. Sign-in by email one-time code or password, **passkeys**, **Sign in with Apple** and **Google**. MFA is optional for users, and required for team owners before they can change billing.
- Tokens: short-lived access and ID tokens (60 minutes) and a 30-day refresh token with rotation. The web app keeps tokens in memory plus an HttpOnly cookie set by a small token-refresh endpoint, never in `localStorage`. The mobile apps use the Keychain/Keystore through Capacitor.
- **Roles live in DynamoDB** (the `MEMBER#` items in [ADR 0005](0005-multi-tenant-dynamodb.md)), not in Cognito groups. A user can hold a different role in each team, and a role change takes effect on the next request without a new token.
- Account deletion is self-serve from settings. It removes the Cognito user and personal data, and passes team ownership to another member or closes the team (which cancels its subscription).

## Alternatives considered

- **Auth0 / Clerk / WorkOS.** Better multi-region story and polished UI, but cost per active user (about $0.02–0.05+) is a noticeable share of $3 revenue, and they add another data processor to the privacy policy.
- **Roles as Cognito groups.** Groups are per pool, not per team, so they can't express "owner of team A, viewer of team B".

## Consequences

- Cognito user pools are **regional and don't replicate**. The pool lives in us-east-1. See [ADR 0010](0010-multi-region-active-active.md) for how the other region keeps working (tokens are checked locally in each region) and for the limit this puts on failover: new sign-ins and token refreshes wait for us-east-1. A spike bead evaluates options for closing that gap.
- Cognito's free tier (10,000 monthly active users on Essentials; verify current terms) covers the business well past launch.
