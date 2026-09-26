# Testing

How to run the tests is in the [README](../README.md#tests).

## Supported browsers

The current and previous major versions of Chrome, Edge, Firefox and Safari on desktop, and on phones and tablets: Safari on iPhone and iPad, Chrome on Android, Samsung Internet and Firefox for Android, at widths from 320 px up, in portrait and landscape. The desktop list is the `browserslist` field in `package.json`, and both builds compile their JavaScript and CSS for it (`build.target` in `vite.config.js`).

| Browser | Test project | Device and viewport | Builds tested |
| --- | --- | --- | --- |
| Chrome (desktop) | `desktop-chrome` | 1280 × 720 | artifact, web |
| Safari (iPhone) | `iphone-safari` | iPhone 13, 390 × 664 | artifact, web |
| Firefox (desktop) | `desktop-firefox` | 1280 × 720 | web |
| Safari (desktop) | `desktop-safari` | 1280 × 720 | web |
| Microsoft Edge (desktop) | `desktop-edge` | 1280 × 720 | web |
| Chrome (Android phone) | `android-chrome` | Pixel 7, 412 × 839 | web |
| Chrome (Android phone, landscape) | `android-chrome-landscape` | Pixel 7, 863 × 360 | web |
| Chrome (Samsung phone) | `galaxy-chrome` | Galaxy S24, 360 × 780 | web |
| Safari (iPad) | `ipad-safari` | iPad Mini, 768 × 1024 | web |
| Safari (iPad, landscape) | `ipad-safari-landscape` | iPad Mini, 1024 × 768 | web |

The artifact build only runs on claude.ai, so it's tested in desktop Chrome and iPhone Safari; the web build is tested in every browser above. The mobile projects emulate each device's screen size, pixel ratio, touch and user agent in Playwright's Chromium and WebKit, not the real phone browser.

`tests/layout.spec.js` checks that no screen scrolls sideways at 320, 360, 390, 430 and 768 px wide, and at each project's own viewport (which covers landscape).

Two mobile browsers can't be automated in Playwright:

- **Samsung Internet** is built on Chromium's Blink engine, so `android-chrome` and `galaxy-chrome` cover its rendering and JavaScript.
- **Firefox for Android** uses Gecko, which `desktop-firefox` covers, while the phone layout is covered by the mobile projects above.

No Playwright project exercises the camera, the phone's photo picker or real touch input, so each release gets a check on real phones: see [Real-device check](releases.md#real-device-check) under Releases.

## Running tests on a laptop

A full run starts a browser in every worker, and WebKit workers can each take over a gigabyte. Several at once, with other apps open, have used up a 16 GB laptop's memory and swap and frozen the screen. Two guards keep local runs in bounds:

- **Fewer workers.** Locally, Playwright uses one worker per 8 GB of RAM, and at most half the CPU cores (`localWorkers` in `playwright.config.js`). That's 2 on a 16 GB laptop. Pass `--workers=N` to change it for one run. CI uses Playwright's default.
- **One run at a time.** Each run takes a lock in the repo's shared `.git` directory (`tests/run-lock.js`), so a run started in another worktree waits and prints which run it's waiting for. A lock left by a run that was killed is taken over automatically. CI skips the lock.

While working on a change, run just the file and browser you're touching, e.g. `npx playwright test tests/sheets.spec.js --project=desktop-chrome`. Save `npm run check` for before you open a PR; CI runs every browser and build anyway (pull requests run desktop Chrome and iPhone Safari, and the merge queue runs the rest).

| Suite | What it checks |
| --- | --- |
| `app.spec.js` | Core flows: sheets, checkout and return, storage counts, items without barcodes, receipt review, CSV export, view-only access |
| `a11y.spec.js` | axe-core WCAG 2.1 A/AA scan of every screen, in light and dark mode |
| `theme.spec.js` | The System / Light / Dark control: each choice over a light and a dark OS, kept across a reload, applied before the page finishes loading, and falling back to System when storage throws |
| `layout.spec.js` | No sideways scrolling at 320px and 390px phone widths |
| `resilience.spec.js` | Missing capabilities, failed receipt reads, full storage, lost write permission, and resuming an unsaved receipt |
| `sheets.spec.js` | Editing, filtering, reopening and deleting sheets; editing and removing lines; picking and returning items without barcodes |
| `inventory.spec.js` | Adding, editing and deleting items; storage counts and totals; view-only and disconnected states |
| `barcode.spec.js` | Reading barcode photos with the browser's detector or ZXing, at several sizes, and when the photo can't be read |
| `receipts.spec.js` | Receipt review: clients, existing sheets, name and price choices, barcodes, splitting, every save check, and partial save failures |
| `startup.spec.js` | Starting without the runtime or with capabilities declined, lost connections, download failures, and saved-draft problems |
| `export.spec.js` | Exporting all data: sheets and inventory as CSV, everything as JSON, matching the screens; formula-like text guarded; owners only, including view-only owners; 1,000 sheets |
| `failures.spec.js` | Every kind of save that can fail leaves the screen as it was |
| `legacy-data.spec.js` | Sheets and items missing fields that older versions didn't save |
| `concurrent.spec.js` | Someone else changing or deleting data while a form is open |
| `demo.spec.js` | The demo build (web runs only): the banner, a checkout, a receipt and a download with no requests outside the page and Google Fonts; a reload starting over; the theme control; the banner's accessibility and 320px layout |
| `dev-server.spec.js` | `npm run dev` and its query-string options |
| `aws-account.spec.js` | The web build's runtime (web runs only): `config.json`, sign-in and the code exchange, token refresh (including 401, refresh, retry), first sign-in, invites, the team switcher, view-only, sign-out, and the screens' accessibility and 320px layout |
| `aws-data.spec.js` | The web build's runtime (web runs only): the app's writes on the data routes, cursors, error codes, downloads (including exporting 1,000 sheets listed page by page, and owners only), live events, re-lists, reconnecting, the polling fallback and removal from a team |

Every test also fails if the page throws an uncaught error or logs a console error.

## Coverage

`npm run test:coverage` runs the suites in desktop Chrome with code coverage on, once for each build. Coverage is mapped back to the files in `src/` through the builds' source maps. A run fails if lines, statements, functions or branches fall below **98%** (`THRESHOLD` in `tests/coverage.js`). CI runs this on every pull request.

When coverage is too low, `coverage/<build>/uncovered.txt` lists each gap by `src/` file and line: lines that never ran, lines that only partly ran, and branches that never ran. `coverage/<build>/index.html` is the full report; CI uploads each as the `coverage-report-artifact` and `coverage-report-web` artifacts. The web build is minified, so its statement count is smaller than the artifact's; lines, functions and branches come out close to the same.

The mock (`tests/mock-claude.js`) has opt-in failure modes, so tests can reach error paths: a missing runtime, declined capabilities, failed or path-specific writes, lost listeners, failed downloads, and a receipt read that waits to be cancelled. `window.__mock.notify()` fires live updates after a test changes `window.__mock.docs`, to act as another user.
