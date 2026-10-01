# Releases

How releases are cut is in the [README](../README.md#releases).

## Real-device check

Playwright can't open a phone's camera, so before publishing a release, check scanning on a real iPhone and a real Android phone: your own phones, or a real-device cloud such as BrowserStack Live. Check the web build and the artifact on claude.ai. Scanning takes a photo through the file input (`capture="environment"`), then decodes it with the browser's `BarcodeDetector` where there is one (Chrome and Samsung Internet on Android) or ZXing otherwise (Safari on iPhone and iPad, Firefox).

1. **iPhone, Safari** (current iOS): open a sheet, tap **Scan to check out**, and photograph a real barcode with the rear camera. The checkout dialog opens with the right item. Then, on the sheet list, tap **Scan receipt**, photograph a paper receipt, and check the review screen lists its lines.
2. **Android phone, Chrome** (current Android): repeat step 1.
3. **Android phone, Samsung Internet** and **Firefox for Android**: open a sheet and scan one barcode in each.
4. On both phones, photograph something that isn't a barcode: the app says no barcode was found and suggests typing the number.
5. On both phones, turn to landscape and back on the sheet and receipt screens: nothing scrolls sideways and no button is cut off.

Note the devices and OS versions in the release PR before merging it.

## Journey evidence pack

Each GitHub Release also gets a journey evidence pack, built by the `evidence` and `evidence-upload` jobs in `.github/workflows/release.yml` after the full check suite passes:

- `journey-evidence.html`: for every journey, each step with its result, the tests that prove it and their results, the time in the video where each shows the step, a screenshot at the step's end, and the alarms that watch the journey.
- `J<n>-<name>.webm`: one video per journey, J0 to J11 (phase 2 journeys have nothing built to show), recorded on desktop Chromium.
- `journey-traces.zip`: each test's Playwright trace.

It's recorded from the release tag against the test suite's fakes and demo data, never production or a real account: the job has no secrets or cloud credentials and only a read-only token, and a separate job with `contents: write` uploads the files. Release assets are public. A test that fails while recording doesn't stop the upload: the report shows it failed, and the workflow run has a warning. How it works: [Journey videos](testing.md#journey-videos).

To check it, open the release on GitHub and look for those assets. Download the report, the videos and `journey-traces.zip` into one folder and unzip the traces there; then the report plays each video in the page, its timestamps seek to the step, and its trace links open the files (`npx playwright show-trace <file>`, or drop one on trace.playwright.dev).

## Publishing to claude.ai

Publishing the artifact is a manual step, because claude.ai artifacts are published from a Claude session rather than from CI. After a release, download `index.html` from the GitHub Release (or run `npm run build:artifact` on the release tag), and ask Claude to republish that file to the existing [artifact URL](https://claude.ai/artifact/LcSb29dTE99AK4N6iuVFrj). Publish `dist/artifact/index.html`, never `src/index.html`: the source page loads its script and styles as separate files, which an artifact can't serve. Publishing to the same URL keeps all saved sheets and inventory.
