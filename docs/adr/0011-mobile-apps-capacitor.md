# 0011. Native iOS and Android apps wrap the web app with Capacitor

- Status: Proposed
- Date: 2026-09-25

## Context

Crews use the app on phones in storage rooms and trucks. They want an icon on the home screen, a fast camera for barcodes and receipts, and sign-in that sticks. The web app already has iPhone-sized tests and accessibility checks. We want store listings on the App Store and Google Play without writing and maintaining a second app.

## Decision

- Build the iOS and Android apps with **Capacitor**, loading the same web bundle as the website ([ADR 0004](0004-runtime-adapter.md)).
- Native plugins: in-app browser for Stripe Checkout and the Customer Portal, camera, barcode scanning (ML Kit on Android, VisionKit on iOS) in place of the web barcode reader, secure token storage, share sheet for CSV export, and app/deep links for invites.
- Build and sign with **fastlane** in GitHub Actions on macOS runners. Upload to TestFlight and the Play internal track on every release; promote to production by hand at first.
- **Billing stays on the web.** Owners choose a plan in the app and pay through Stripe Checkout in the system browser, where store rules allow the link; no App Store or Google Play in-app purchase. See [ADR 0013](0013-web-billing-only.md).
- Includes in-app account deletion ([ADR 0007](0007-identity-cognito.md)) and privacy details (App Store privacy labels, Play data safety form).

## Alternatives considered

- **React Native / Flutter rewrite.** Better native feel, but a second codebase to build, test and keep in sync, for an app that is mostly forms and lists.
- **Progressive Web App only.** Free and already mostly there, but no store presence, and iOS limits PWA camera and storage behavior. We'll still ship the PWA manifest, since it's nearly free.

## Consequences

- The mobile-web journey tests cover most of the app code. The native wrappers need a smaller smoke suite on real devices (camera, scanning, sign-in, deep links).
- Apple Developer ($99/year) and Google Play ($25 once) accounts are needed, registered to the business (a D-U-N-S number is required for an organization account).
