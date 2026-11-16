# Current validation and release scope

The original six guides and file map describe the initial plan. Current executable checks are:

| Command | Coverage | Boundary |
| --- | --- | --- |
| `npm run verify` | Typecheck, units, build and preflight | Source checks; no hosted acceptance |
| `npm run test:e2e` | Eight native browser suites, including SDK sessions and emulated hands | Local synthetic services; no physical Quest claim |
| `npm run test:e2e -- --list` | Lists the eight suites without launching browsers | Discovery only |
| `npm run test:sql -- --runtime ABS_PACKAGE --output-dir ABS_NEW_DIR` | All six pinned PostgreSQL fixture suites | Synthetic auth/storage and scheduler ports |
| `node scripts/verify-public-build.mjs https://labelroom-xr.pages.dev ABS_NEW_DIR` | Rebuild using public client settings, compare served files and effective headers | Read-only public frontend; no backend writes |

`tests/sql/review-budget.mjs` and `core.mjs` replace references to the old planned `tests/sql/review.sql`. The browser specs now delegate to the existing assertion-heavy runners; their result receipts and minimum case counts are checked. The scheduler extension activation remains excluded from the lifecycle fixture and tested by its dedicated synthetic scheduler fixture. Production migrations are unchanged.

The current GitHub workflow runs the public browser command, native Windows entrypoints and all six SQL suites. The public-build job checks the actual served bytes separately, so CI on source cannot silently establish deployment identity.

Membership was confirmed by the project owner on 16 November 2026. Physical Quest acceptance and a VR reviewer comparison remain deferred under the owner-approved headset-free scope. Passing emulation does not certify physical FPS, tracking or comfort. A final public video and entry require real application footage and the remaining release/eligibility checks; source tests do not imply a submitted entry.
