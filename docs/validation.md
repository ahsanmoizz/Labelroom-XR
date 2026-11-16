# Current validation and release scope

The original six guides and file map describe the initial plan. Current executable checks are:

The [controlled demo generator](../tools/converter/DEMO.md) now implements the original offline fault-injection tool. Run all converter/generator cases with `python -m unittest discover -s tools/converter -p 'test_*.py'`. Its synthetic tests do not establish a new real-clip or physical acceptance result.

Recording reports distinguish browser launch, video-context creation, app loading and normal security entry. Anonymous authentication is counted only after the UI reports a connected verified account. The AI segment requires rendered `inspectBoxSupport` evidence, not just a completed response. These stronger checks do not imply that the blocked full hosted recording has completed.

| Command | Coverage | Boundary |
| --- | --- | --- |
| `npm run verify` | Typecheck, units, build and preflight | Source checks; no hosted acceptance |
| `npm run test:e2e` | Eight native browser suites, including SDK sessions and emulated hands | Local synthetic services; no physical Quest claim |
| `npm run test:e2e -- --list` | Lists the eight suites without launching browsers | Discovery only |
| `npm run test:sql -- --runtime ABS_PACKAGE --output-dir ABS_NEW_DIR` | All six pinned PostgreSQL fixture suites | Synthetic auth/storage and scheduler ports |
| `node scripts/verify-public-build.mjs https://labelroom-xr.pages.dev ABS_NEW_DIR` | Rebuild using public client settings, compare served files and effective headers | Read-only public frontend; no backend writes |

`tests/sql/review-budget.mjs` and `core.mjs` replace references to the old planned `tests/sql/review.sql`. The browser specs now delegate to the existing assertion-heavy runners; their result receipts and minimum case counts are checked. The scheduler extension activation remains excluded from the lifecycle fixture and tested by its dedicated synthetic scheduler fixture. Production migrations are unchanged.

The current GitHub workflow runs the public browser command, native Windows entrypoints, independent Python converter tests, production dependency advisory checks and all six SQL suites. The public-build job checks the actual served bytes separately, so CI on source cannot silently establish deployment identity. `implementation-map.json` reconciles historical paths without changing the original feature/test acceptance definitions; the pack check verifies every replacement exists and leaves partial/pending work explicit.

`node scripts/record-live-demo.mjs ABS_NEW_DIRECTORY --headed` attempts to record the real hosted no-account demo on a WebGL-capable PC with browser Quest emulation. It uses normal CAPTCHA/authentication, the licensed source, actual saves, a bounded live AI turn, consent revocation, undo, reload and export. It never substitutes a backend or manufactures CAPTCHA tokens. The operator has up to five minutes to complete a normal security challenge in the headed browser. A blocked or failed step produces a stopped report rather than a passed acceptance claim. The hosted CI attempt on 16 November stopped before sign-in because its security check did not complete. Its later review/AI/export recording steps are therefore not yet verified. The optional recording job now requires an explicit manual workflow dispatch with `record_live_demo=true`; ordinary source checks do not turn that blocked external session into a product pass. See the [PC recording instructions](submission-preparation.md).

Membership was confirmed by the project owner on 16 November 2026. Physical Quest acceptance and a VR reviewer comparison remain deferred under the owner-approved headset-free scope. Passing emulation does not certify physical FPS, tracking or comfort. A final public video and entry require real application footage and the remaining release/eligibility checks; source tests do not imply a submitted entry.
