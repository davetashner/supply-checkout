# Testing

How to run the tests is in the [README](../README.md#tests).

## Supported browsers

The current and previous major versions of Chrome, Edge, Firefox and Safari on desktop, and on phones and tablets: Safari on iPhone and iPad, Chrome on Android, Samsung Internet and Firefox for Android, at widths from 320 px up, in portrait and landscape. The desktop list is the `browserslist` field in `package.json`, and the builds compile their JavaScript and CSS for it (`build.target` in `vite.config.js`).

| Browser | Test project | Device and viewport | Builds tested |
| --- | --- | --- | --- |
| Chrome (desktop) | `desktop-chrome` | 1280 × 720 | web |
| Safari (iPhone) | `iphone-safari` | iPhone 13, 390 × 664 | web |
| Firefox (desktop) | `desktop-firefox` | 1280 × 720 | web |
| Safari (desktop) | `desktop-safari` | 1280 × 720 | web |
| Microsoft Edge (desktop) | `desktop-edge` | 1280 × 720 | web |
| Chrome (Android phone) | `android-chrome` | Pixel 7, 412 × 839 | web |
| Chrome (Android phone, landscape) | `android-chrome-landscape` | Pixel 7, 863 × 360 | web |
| Chrome (Samsung phone) | `galaxy-chrome` | Galaxy S24, 360 × 780 | web |
| Safari (iPad) | `ipad-safari` | iPad Mini, 768 × 1024 | web |
| Safari (iPad, landscape) | `ipad-safari-landscape` | iPad Mini, 1024 × 768 | web |

The web build is tested in every browser above. The mobile projects emulate each device's screen size, pixel ratio, touch and user agent in Playwright's Chromium and WebKit, not the real phone browser.

`tests/layout.spec.js` checks that no screen scrolls sideways at 320, 360, 390, 430 and 768 px wide, and at each project's own viewport (which covers landscape).

Two mobile browsers can't be automated in Playwright:

- **Samsung Internet** is built on Chromium's Blink engine, so `android-chrome` and `galaxy-chrome` cover its rendering and JavaScript.
- **Firefox for Android** uses Gecko, which `desktop-firefox` covers, while the phone layout is covered by the mobile projects above.

No Playwright project exercises the camera, the phone's photo picker or real touch input, so each release gets a check on real phones: see [Real-device check](releases.md#real-device-check) under Releases.

## Running tests on a laptop

A full run starts a browser in every worker, and WebKit workers can each take over a gigabyte. Several at once, with other apps open, have used up a 16 GB laptop's memory and swap and frozen the screen. Two guards keep local runs in bounds:

- **Fewer workers.** Locally, Playwright uses one worker per 8 GB of RAM, and at most half the CPU cores (`localWorkers` in `playwright.config.js`). That's 2 on a 16 GB laptop. Pass `--workers=N` to change it for one run. CI uses Playwright's default.
- **One run at a time.** Each run takes a lock in the repo's shared `.git` directory (`tests/run-lock.js`), so a run started in another worktree waits and prints which run it's waiting for. A lock left by a run that was killed is taken over automatically. CI skips the lock.

While working on a change, run just the file and browser you're touching, e.g. `npx playwright test tests/projects.spec.js --project=desktop-chrome`. Save `npm run check` for before you open a PR; CI runs every browser and build anyway (pull requests run desktop Chrome and iPhone Safari, and the merge queue runs the rest).

| Suite | What it checks |
| --- | --- |
| `app.spec.js` | Core flows: projects, checkout and return, storage counts, items without barcodes, receipt review, CSV export, view-only access |
| `a11y.spec.js` | axe-core WCAG 2.1 A/AA scan of every screen, in light and dark mode |
| `theme.spec.js` | The System / Light / Dark control: each choice over a light and a dark OS, kept across a reload, applied before the page finishes loading, and falling back to System when storage throws |
| `layout.spec.js` | No sideways scrolling at 320px and 390px phone widths |
| `resilience.spec.js` | Missing capabilities, failed receipt reads, full storage, lost write permission, and resuming an unsaved receipt |
| `projects.spec.js` | Editing, filtering, reopening and deleting projects; editing and removing lines; picking and returning items without barcodes |
| `inventory.spec.js` | Adding, editing and deleting items; storage counts and totals; view-only and disconnected states |
| `live-scan.spec.js` | The live scanner with a stand-in camera (`tests/camera.js`): codes taken only when separate frames agree, misreads ignored, ZXing in the aiming box and on spots, a blocked or missing camera, the photo fallback, closing while the camera starts, the time limit, the page hidden, the flashlight, Escape and Tab, every Scan button, and the layout at 375 px in light and dark |
| `barcode.spec.js` | Reading barcode photos with the browser's detector or ZXing: at several sizes, codes turned, upside down, at a slant or small in a busy photo (synthetic photos drawn in the test, like the pilot's bin label), the time budget, check digits and codes that need a second read, correcting a misread number before it's saved, and when the photo can't be read |
| `receipts.spec.js` | Receipt review: clients, existing projects, name and price choices, barcodes, splitting, every save check, partial save failures, a save whose answer was lost or timed out adding each line and each stock line once, and the review locked from the first attempt until it's saved |
| `startup.spec.js` | Starting without the runtime or with capabilities declined, lost connections, download failures, and saved-draft problems |
| `export.spec.js` | Exporting all data: projects and inventory as CSV, everything as JSON, matching the screens; formula-like text guarded; the marks of recent saves left out of the JSON; owners only, including view-only owners; 1,000 projects |
| `failures.spec.js` | Every kind of save that can fail leaves the screen as it was |
| `save-states.spec.js` | Saving on a slow or flaky connection: a form says Saving… and can't be sent twice or closed meanwhile, nothing shows as saved before it is, a save that didn't go through keeps what was entered and offers Try again, a checkout or return whose answer was lost counted once on Try again, a checkout or return whose storage count failed after its line saved finished once by Try again, and going offline and back says so |
| `legacy-data.spec.js` | Projects and items missing fields that older versions didn't save |
| `concurrent.spec.js` | Someone else changing or deleting data while a form is open, such as removing a line while its return form is open |
| `demo.spec.js` | The demo build (web runs only): the banner, a checkout, a receipt and a download with no requests outside the page and Google Fonts; a reload starting over; the theme control; the banner's accessibility and 320px layout |
| `site.spec.js` | The marketing home page (web runs only, `site/`) as CloudFront serves it, under the app's CSP: the headline, trial and demo links and price, each recorded clip with its poster and every file loading, the hero clip playing muted and one off screen paused, reduced motion (stills with a play button), no axe violations in light and dark, a phone width with no sideways scroll, and no scripts but its own. |
| `ops.spec.js` | The operator page (web runs only, `ops/`): sign-in through a stand-in for the operator pool with PKCE and state, the token in memory only, a customer token refused, team search and detail, comps by months and by date, ending a comp, a 409 and a retried write, the audit, expiry, sign-out and API data shown as text, under the page's own CSP. Its logic's unit tests are `ops/test/` (`npm run test:ops`) |
| `dev-server.spec.js` | `npm run dev` and its query-string options |
| `aws-account.spec.js` | The web build's runtime (web runs only): `config.json`, sign-in and the code exchange, token refresh (including 401, refresh, retry), first sign-in, invites, the team switcher, view-only, sign-out, and the screens' accessibility and 320px layout |
| `aws-data.spec.js` | The web build's runtime (web runs only): the app's writes on the data routes, cursors, error codes, downloads (including exporting 1,000 projects listed page by page, and owners only), live events, re-lists, reconnecting, the polling fallback and removal from a team (found by a read or a refused write) |
| `aws-save-states.spec.js` | Saving on a slow or flaky connection in the web build (web runs only): one request per checkout however it's tapped, a return that times out (Playwright's clock) counted once on Try again, nothing sent offline and the latest shown when the connection is back, and a new project or item whose answer was lost saved once |
| `aws-rum.spec.js` | CloudWatch RUM in the web build (web runs only): an error reaches the app monitor with the release version, signed with the identity pool's guest credentials, without cookies, query strings, fragments, tokens or email addresses; scrubbing fails closed (unreadable or frozen details); navigation timing is sent and the API's requests aren't; no client without an app monitor in `config.json` or with a pool from another region; the app still runs when the client can't load |
| `aws-members.spec.js` | The members screen (web runs only): owners see members and roles, change roles and remove members, the last owner can't step down or leave, an owner stepping down or leaving starts again, refusals say why, only owners see it, accessibility and 320px layout |
| `aws-invites.spec.js` | Invites on the members screen (web runs only): inviting an address with a role, each invite as pending, failed ("Couldn't deliver", with why) or expired, resending and revoking, an email that couldn't be sent, refusals and rate limits say why, removing a member drops their invites, accessibility and 320px layout |

Every test also fails if the page throws an uncaught error or logs a console error.

## Browsers in CI

Each browser job in `.github/workflows/ci.yml` installs its one browser (`chromium`, `firefox`, `webkit` or `msedge`) and the Ubuntu packages it needs before the tests run. Two caches keep that quick, and a bound keeps a slow install from using up the tests' time:

- **The browsers** (`~/.cache/ms-playwright`) are cached per browser and Playwright version (`playwright-browsers-…`). With the same Playwright version, `playwright install` finds them and downloads nothing. Edge is a system package under `/opt`, so it isn't cached.
- **The OS packages.** The runner image already has most of them; the `.deb` files apt downloads for the rest (WebKit's GStreamer and media libraries, about 120 packages) are cached per browser, Playwright version and runner image (`playwright-debs-…`), and an older image's files are restored when the image changes. apt then installs from those files and downloads only what's newer. On 2026-10-01 the Ubuntu mirror served those packages at a crawl, and `playwright install --with-deps webkit` took 17 minutes and ran the iPhone Safari jobs into their 20-minute timeout.
- **The bound.** Each try at installing gets 3 minutes (a normal install takes under a minute), with up to 3 tries in a 10-minute step, and apt retries a failed download 3 times. The job's timeout is 30 minutes: the tests' 20 plus the install's 10.

A Playwright upgrade misses both caches once, and the first run on `main` saves them again. A pull request's run reads `main`'s caches but saves only into its own branch's scope, so it can't change what `main` or another branch restores. These jobs hold no credentials; the deploy workflow's jobs restore no cache at all ([releases](releases.md)).

## Journey tags and the traceability check

Tests that prove a [customer journey](journeys.md) are tagged with it: `@J4.2` on a test (or a `test.describe`) that proves step J4.2, or `@J4` on one that belongs to J4 without proving one step. A test that walks through several steps names its `test.step` blocks by step (`"J4.2 Scan an item and choose how many"`). The journeys, their steps and their alarms are in `journeys/registry.json`, with backend tests listed by path under each step.

```bash
npx playwright test --grep "@J4\b" --project=desktop-chrome   # J4's tests (\b keeps @J1 from matching @J10)
npx playwright test --grep "@J4.2\b" --project=desktop-chrome  # one step's (\b keeps @J4.1 from matching @J4.10)
npm run journeys:trace   # each step with its tests and alarms; fails if anything doesn't trace
npm run journeys:docs    # regenerate docs/journeys.md's table and step lists from the registry
```

`npm run journeys:trace` (`scripts/journeys.mjs`) lists the tests with `playwright test --list`, which loads the web build; it builds it first (`npm run build:web`) when `dist/web/` is missing, and when a spec can't be loaded it prints Playwright's own error. It fails when a built step of a journey that isn't phase 2 has no test (neither a tagged Playwright test nor a backend test in the registry) and no `untested` reason in the registry, when a planned step has tests tagged with it, when a critical journey has no alarm of its own, when a tag or `test.step` names a step that isn't in the registry, when a `test.step` named for a step is in a test that isn't tagged with that step, when an alarm the registry calls built isn't in `infra/lib/observability`, or when `docs/journeys.md` doesn't match the registry: its generated table and step lists, each journey's hand-written **Status** paragraph (which must start with the table's status), and its hand-written **Tests** paragraphs (every file they name exists, every spec file they name has at least one test tagged with the journey or one of its steps, and every test they quote by title, in a list of quoted titles right after the file's colon, is in that file and tagged the same way). A `test.step` is only checked against the test whose body it's in; one in a helper outside every test isn't. It warns, without failing, when a step's status disagrees with its beads in `.beads/issues.jsonl`. `--json <file>` also writes the whole trace, with each step's tests by title. CI's lint job runs it, and its tests are in `scripts/journeys.test.mjs` (`npm run test:scripts`).

## Journey videos

`npm run journeys:video` records a video of each [customer journey](journeys.md), J0 to J11 (J12 is phase 2), from the tests that prove it, so the video is evidence of what was tested rather than a demo. Every Playwright test tagged with one of the journey's steps (`@J4.2`; a test tagged only with the journey, `@J4`, isn't in it) runs against the web build, one at a time in one Chromium, and each is recorded. Over each test's page:

- a caption banner gives the step IDs, the step's text from `journeys/registry.json`, the test's file and name, and the step's state: Running, then Passed or Failed. A `test.step` named for a step (`"J4.2 …"`) switches the caption to that step and shows its own result; otherwise the result is the test's. A failed assertion turns the banner red with the matcher and what it expected and received. A step the registry marks `simulated` says so in the banner.
- a drawn cursor glides to each element the test clicks, types into or picks from, with a ripple on each click (Playwright's videos don't show the mouse). Only the drawing waits; each action is Playwright's own, unchanged.

A title card starts each video; a card stands in for each step with nothing to show on screen (not built yet, or built and proved by backend tests only, which it names, or built with an `untested` reason); an end card lists each step's result, with the counts of steps passed, failed, simulated, not built yet and proved by backend tests only. There's no narration. It runs against the same fakes as the tests (`tests/fake-aws.js`, `tests/mock-claude.js`), never a real AWS account, Stripe or email.

```bash
npm run journeys:video                      # every journey, in a visible browser
npm run journeys:video -- --only J4         # one journey (or --only J4,J7)
npm run journeys:video -- --viewport phone  # an iPhone 13's screen in Chromium's mobile emulation (default: desktop)
npm run journeys:video -- --headless        # no window; the videos are the same
npm run journeys:video -- --pace 0.3        # shorter pauses, for checking a change quickly
npm run journeys:video -- --slow-mo 100     # Playwright's slowMo in ms (default 0)
npm run journeys:video -- --skip-build      # use the dist/web already built
npm run journeys:video -- --evidence        # also keep each test's trace and a screenshot at each step's end
npm run journeys:report                     # the evidence report from what's in dist/journey-videos/
```

For each journey it writes, in `dist/journey-videos/` (gitignored):

- `<J#-slug>.webm`, e.g. `J4-check-supplies-out-and-back-in.webm`: 1280 × 804 on desktop (the tests' 1280 × 720 viewport plus the banner), or 780 × 1552 on a phone (390 × 776 at twice the size), with `-phone` at the end of the name. Its length follows the number of tests: about 12 seconds a test at `--pace 1`.
- `<J#-slug>.json`, the sidecar, for the release evidence pack: the journey; the video's name, viewport, size, build, commit and time; `duration` in seconds; `summary` (steps passed, failed, simulated, planned, backend, untested and skipped); `steps`, each with its registry text and status, `result` (`passed`, `failed`, `planned`, `backend`, `untested` or `skipped`), `simulated`, its backend tests, and its Playwright tests with each one's result, error and `at`, the second in the video where it shows that step; and `timeline`, each clip in order (`title`, `test`, `step` or `end`) with its start and end in seconds, and for a test its result and events (each step's start and end, and the test's end, in seconds into the video).

With `--evidence`, it also keeps each test's Playwright trace (without screenshots: the video has them) as `evidence/t<n>-trace.zip`, and a JPEG of the page, caption and all, at the end of each `test.step` named for a step and at the end of the test, as `evidence/t<n>-shot-<k>.jpg`. The fixture takes the screenshots only then. The sidecar names them: each test in `timeline` has its `trace`, each event its `shot`, and each step's test the `shot` at the end of its `test.step` for that step, else at the end of the test.

The command exits 1 if any recorded test failed; the videos are still written, and show the failure.

### The release evidence pack

`npm run journeys:report` (`scripts/journey-videos/report.mjs`) builds `dist/journey-videos/journey-evidence.html` from the sidecars there: one self-contained page (the screenshots are embedded, nothing loads from elsewhere) with a summary of each journey, then each journey's video and a table of its steps: what the customer does, the step's result, each test that proves it with its result, error, file and line (a link to the file at the release tag with `--tag` and `--repo`), the time in the video where it shows the step (clicking it seeks the page's player), the screenshot at the step's end and the test's trace, and the journey's alarms from `journeys/registry.json` (which `journeys:trace` keeps in step with `docs/journeys.md`), each linked to the alarms table at the end. Steps don't have alarms of their own yet, so each step lists its journey's. It refuses a sidecar whose `runtime` isn't `fakes` (`record.mjs` always writes `fakes`), since the report and videos go on the public release. Its tests are in `scripts/journey-videos/report.test.mjs` (`npm run test:scripts`).

On each release, `.github/workflows/release.yml` runs `npm run journeys:video -- --headless --evidence` and `npm run journeys:report` from the tag and attaches the report, the videos and `journey-traces.zip` to the GitHub Release ([Journey evidence pack](releases.md#journey-evidence-pack)).

How it's put together: `scripts/journey-videos/record.mjs` takes the Playwright run lock (`tests/run-lock.js`) for the whole run, builds the web app, lists the tests and picks each journey's (`assemble.mjs`), and runs them with `--grep` under its own config, `scripts/journey-videos/playwright.config.mjs` (one worker, no retries, Playwright's video on for each test). `record.mjs` sets `JOURNEY_VIDEO=1` in that run's environment, not the config: running the config directly records plain videos with no overlay. `tests/helpers.js` always imports `tests/journey-video.js`, but it does nothing unless `JOURNEY_VIDEO=1`; then the page fixture adds the overlay (drawn by `director.mjs`) and attaches each test's events. No other run, and nothing in CI, sets it. Then `record.mjs` records the cards and joins the clips in a fixed order into one video per journey, without re-encoding (`webm.mjs`, which refuses clips whose codec or size differ): the title card; each step's tests, each test at the first of the journey's steps it proves, ordered by file and line (a test that proves steps of two journeys is in both videos); the cards for steps without UI tests; and the end card. A test that opens a second page shows only its own page (the longest of its videos). Ctrl-C or SIGTERM stops the Playwright run and its browser (it runs in its own process group, which gets the signal), waits for it, removes the scratch directory, releases the lock and exits 130 or 143 (`process.mjs`). Its tests are in `scripts/journey-videos/journey-videos.test.mjs` (`npm run test:scripts`).

### Marketing clips

`npm run journeys:video -- --marketing` records the clips on the home page ([the web app](web-app.md#the-web-app)) from `journeys/marketing.json`: for each of J4, J13, J14 and J5, one tagged test (named in the file, with its `caption`, and a `pace` for a clip that would run short), in a phone viewport at 1x (390 × 664), with no test banner, cards or results: the cursor and nothing else drawn over the app. The file's `captions: true` would add a line over the bottom of the page (the clip's `caption`, or in a test that names its `test.step`s for journey steps, J4 and J5, the current step's text); it's off, because it takes up the screen. With made-up crew names (`persona` in `tests/journey-video.js`, which tests that assert a name read), not "Test User". Each is stretched by the file's `slow` (1.5: 50% slower, which also slows the cursor) and becomes `site/clips/<J#>-<slug>.mp4` (H.264, no sound, streamable) and a `.jpg` poster from the middle, with `clips.json`. It needs ffmpeg, fails if a clip's test fails or a clip is over 3 MB or outside 15 to 45 seconds (after `slow`), only takes journeys that are Tested, and `--only J4,J5` re-records some and keeps the others in `clips.json`. The clips are committed: re-record them when the UI they show changes, and commit them with the change (`scripts/journey-videos/marketing.test.mjs` checks the committed files against the config).

In a visible window, leave the mouse and keyboard alone while it records: a real click or key press reaches the page under test.

## Coverage

`npm run test:coverage` runs the suites in desktop Chrome with code coverage on. Coverage is mapped back to the files in `src/` through the builds' source maps. A run fails if lines, statements, functions or branches fall below **98%** (`THRESHOLD` in `tests/coverage.js`). CI runs this on every pull request.

When coverage is too low, `coverage/web/uncovered.txt` lists each gap by `src/` file and line: lines that never ran, lines that only partly ran, and branches that never ran. `coverage/web/index.html` is the full report; CI uploads it as the `coverage-report-web` workflow artifact.

Coverage counts what the web build ships, so `src/aws/` is in it and the demo and operator page aren't. The shared modules still have a fallback for a runtime without commands (`src/moves.js`, `removeLine` in `src/main.js`): the demo and the tests' mock runtime have no commands, so those paths run for real there. Don't lower the 98% threshold to make room; the rest of the headroom comes from tests for edge cases people can really hit, such as another user deleting a project while a form or a barcode read is open (`tests/concurrent.spec.js`, `tests/barcode.spec.js`), and from removing fallbacks no caller can reach.

The mock (`tests/mock-claude.js`) has opt-in failure modes, so tests can reach error paths: a missing runtime, declined capabilities, failed or path-specific writes, lost listeners, failed downloads, and a receipt read that waits to be cancelled. While the page is open, `window.__mock.hold()` and `release()` make writes wait like a slow connection (`hold("products/")`: only writes to those paths), and `window.__mock.failWrites` fails every write with a code until it's cleared (`{ prefix, code }`: only writes to those paths). `window.__mock.notify()` fires live updates after a test changes `window.__mock.docs`, to act as another user.
