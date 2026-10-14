# LabelRoom XR

Hands-first VR review of existing point-cloud 3D boxes, with human-approved edits, private projects, audit history and corrected export.

- GitHub: https://github.com/ahsanmoizz/Labelroom-XR
- Local checkout: `C:\Users\hanan\Projects\labelxr`
- Working target: 35 days. Feature acceptance remains governed by `build-contract.json` and `test-contract.json`.

This starting source pack contains the pinned IWSDK scaffold, coordinate helpers, partial geometry code, existing geometry tests, contracts and guides. It does not implement the completed review product. Dependency installation, compilation, unit tests and runtime checks require their own execution evidence.

Open `docs/engineering-tracker.html` for the Local PC / GitHub tree and operation history. The six original guides describe the source pack's 40-day plan; their requirements remain reference material under the current 35-day target.

Development follows Signature-Guarded Deterministic Development: inspect the exact path and state, verify hashes and signature counts, apply one bounded operation, then validate and record its result. Run only the current guarded step supplied for this checkout. The original broad bootstrap and GitHub-link scripts are not included in this starting source pack.

Node is pinned by `.nvmrc`; dependencies are pinned by `package-lock.json`. After the controlled dependency setup, `npm run verify` runs type checking, unit tests, the build and scaffold preflight. `npm run pack:check` validates the supplied contracts and guide links. Passing scaffold checks does not pass product acceptance.

Real environment files, private datasets, build output and key files are excluded from Git. Only placeholder `.env.example` files belong in source. Each future commit will stage an explicit reviewed file list and bind the tested bytes to its commit and report.
