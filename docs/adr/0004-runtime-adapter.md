# 0004. Keep one web app behind a runtime adapter

- Status: Proposed
- Date: 2026-09-25

## Context

All of the app's data, identity and AI calls go through `window.claude.use(name)` (the `use()` helper in `src/runtime.js`, called by the startup code at the end of `src/main.js`), which asks for four capabilities:

| Capability | What the app calls |
| --- | --- |
| `db` | `collection(name).doc(id)` with `set`, `update` (deep merge), `delete`, `onSnapshot`, and `collection("sheets").orderBy("date", "desc")` |
| `user` | `can("data.write")` to decide between view-only and contributor; `isOwner()` to offer exporting all data |
| `downloads` | Saving a sheet's CSV, and exporting all data as CSV or JSON |
| `sample` | `json(prompt, { images, signal })` and `limits()` for receipt reading |

`tests/mock-claude.js` already implements this same interface in memory for the Playwright suites. The original artifact keeps running for the family business on claude.ai.

## Decision

- Keep **one** copy of the app's UI and logic. Grow `src/runtime.js` into a small runtime layer that provides the `window.claude` interface in two builds:
  - `claude` – the current behavior, unchanged. Published to the claude.ai artifact.
  - `aws` – implements the same calls against our API ([ADR 0006](0006-api-and-realtime-sync.md)), Cognito ([ADR 0007](0007-identity-cognito.md)) and the receipt endpoint ([ADR 0008](0008-receipt-reading-bedrock.md)). `downloads` becomes a plain browser download.
- Move the app from a single `index.html` into a small Vite project (still no UI framework). Done: the page source is `src/index.html`, and the build outputs `dist/artifact/index.html` for the artifact and a hashed static bundle in `dist/web/` for CloudFront.
- The SaaS build adds the screens the artifact doesn't need: sign-in, team switcher, invites, members and roles, billing, and account settings. The adapter tells the app which of these to show.
- Replace the read-then-write stock update (`bumpStock`) with an `increment` operation in the adapter, so two people checking out at once can't lose a count. The claude.ai build keeps its current behavior.

## Alternatives considered

- **Fork into a separate SaaS repo.** Faster at first, but every fix would then have to be made twice, and the existing tests would drift apart.
- **Rewrite in React/Next.js.** Gives more UI tooling, but throws away working, tested, accessible code. We can revisit if the UI outgrows plain JS.

## Consequences

- Every existing Playwright suite keeps running against the mock and guards both builds.
- The adapter's real-time behavior (reconnects, conflicts, offline) is the riskiest new code. It gets its own contract tests, run against a real staging API.
