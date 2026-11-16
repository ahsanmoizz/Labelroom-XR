# Browser validation

`npm run test:e2e` discovers and runs eight suites using the existing native browser runners. `npm run test:e2e -- --list` lists them without launching a browser. Install the locked dependencies and Playwright Chromium first, or set `LABELXR_CHROMIUM_PATH` to an existing compatible Chromium/Edge executable.

The runners test actual DOM, workers, IndexedDB, Three.js geometry and, in the SDK/session and XR suites, WebGL and emulated Quest hand input. Services and identities are synthetic and outbound requests are restricted. These tests do not certify production authentication, live model behavior or physical headset performance.

The Playwright output directory holds a JSON receipt and child-process log per suite. CI also copies the eight receipts into its artifact root using `LABELXR_E2E_REPORT_DIR`. A failed process, invalid report, page error or dropped case count fails the public command. There is no shared preview server or dependency on an empty `dist` configuration.

The original standalone `scripts/test-browser-*.mjs` commands remain available for guarded native operator workflows. Physical Quest results remain deferred when a headset is unavailable.
