# LabelRoom XR

Hands-first VR review of existing point-cloud 3D boxes, with human-approved edits, private projects, audit history and corrected export.

- GitHub: https://github.com/ahsanmoizz/Labelroom-XR
- Local checkout: `C:\Users\hanan\Projects\labelxr`
- Current submission status and recording instructions: [submission preparation](docs/submission-preparation.md). Feature acceptance remains governed by `build-contract.json` and `test-contract.json`.

The source implements validated PCD/OpenLABEL import, private projects, a licensed guest demo, deterministic inspection, bounded AI tools, human-approved review and undo, durable recovery, versioned saves and corrected export. The guest completion candidate adds review controls, confirmed reset, expired-session restart and bounded scheduled cleanup. A source implementation is separate from a tested hosted release: live deployment, physical hands/performance and reviewer evidence remain explicit release requirements.

The six original guides, engineering tracker and 48-hour release runbook preserve the original plan and historical state. Use [current validation commands](docs/validation.md) and [the implementation map](implementation-map.json) for today's executable paths and evidence boundaries.

See [current validation commands](docs/validation.md) for the working browser/SQL entrypoints and the read-only public build comparison. `npm run test:e2e` runs eight browser suites, including the actual SDK session and emulated hands; `npm run test:sql` runs all six database fixture suites. Hosted and physical evidence remain separate.

Development follows Signature-Guarded Deterministic Development: inspect the exact path and state, verify hashes and signature counts, apply one bounded operation, then validate and record its result. Run only the current guarded step supplied for this checkout. The original broad bootstrap and GitHub-link scripts are not included in this starting source pack.

Node is pinned by `.nvmrc`; dependencies are pinned by `package-lock.json`. `npm ci` installs those dependencies. `npm run verify` runs type checking, unit tests, production build and source preflight. `npm run pack:check` checks contract/document consistency. `node scripts/test-browser-review.mjs ABSOLUTE_NEW_REPORT.json` runs native DOM, worker and IndexedDB regression cases with an explicit local synthetic backend. `LABELXR_CHROMIUM_PATH` can select an existing compatible Chromium/Edge executable. These checks do not substitute for live provider or physical headset acceptance.

Real environment files, private datasets, build output and key files are excluded from Git. Only placeholder `.env.example` files belong in source. Each future commit will stage an explicit reviewed file list and bind the tested bytes to its commit and report.
