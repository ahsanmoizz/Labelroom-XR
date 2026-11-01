<!-- LABELXR-CORE-SQL-TEST-README-v1 -->
# Core database tests

Run `core.mjs` with Node 24 and an explicit PGlite 0.3.14 package directory. The 108 SQL cases preserve the accepted Step090 case bodies. They execute PostgreSQL 17.5 grants, RLS, triggers, constraints and rollback against synthetic Supabase auth/storage schemas. They never connect to Supabase or install a package automatically.

The runtime can be the unchanged private Step090 `vendor/pglite` directory. An independent developer may explicitly install `@electric-sql/pglite@0.3.14` into a separate temporary npm prefix, outside this repository, then point `--runtime` at that package's root. The runner checks the SHA-256 values of all twelve required upstream files before import. Extra unreferenced upstream package files are allowed. No application dependency or lockfile change is required.

```powershell
node tests/sql/core.mjs --runtime 'C:\path\to\pglite-0.3.14' --output 'C:\temp\core-sql-repeat.json'
```

Both arguments must be absolute paths. The output must be a new `core-sql-*.json` file outside the repository and runtime, with an existing directory. The runner refuses overwrites and blocks Node network connections. Database contents exist only in memory and are closed after testing. `node tests/sql/core.mjs --list` lists the case names without importing a runtime or writing a result.

The migration is intentionally hash-bound in this test. A migration change requires review of the SQL, expectations and pinned migration hash together. Do not paste the synthetic auth/storage fixture into a cloud database.

This test does not establish live gateway/JWT behavior, object-store upload/persistence, signed URL expiry, two simultaneous database sessions, or a saved review. Project-admin, atomic review/budget RPCs, staging authorization and Quest acceptance remain separate gates. The frontend unit suite remains 796 cases; these 108 SQL cases are reported separately.

<!-- LABELXR-REVIEW-BUDGET-SQL-README-v1 -->

## Atomic review and budget source

Migrations run in numeric order:001 core,002 review,003 agent budget,004 projects. This source package applies no cloud migration. `commit_review(command jsonb)` is authenticated-only and derives `auth.uid()`. It checks current ownership/account/project lifetime,strict command shape,revision,before geometry,upright cuboid bounds and oriented duplicate overlap. It commits one version,audit and head atomically. Identical request UUID/payload retries return the same receipt. Undo references the latest decision request UUID;the internal audit links its mutation UUID and restores the prior snapshot/verdicts exactly. Original metadata and source remain immutable.

`reserve_ai_budget(owner,project,turn,base_revision,call_index)` is service-role only. A verified endpoint must derive owner using `auth.getUser`. Only `disposition=new` permits one provider dispatch;replay never permits a second call. Lost acknowledgements/failures consume reservations without automatic refund. Calls must be sequential1–3;UTC limits are3 guest or30 member turns and300 global reserved calls/day. A turn UUID cannot cross project,revision or UTC day. No provider endpoint is added here.

`review-budget.mjs --runtime ABS_PGLITE --compiled ABS_REFERENCE --output ABS_NEW_JSON` uses pinned in-memory PostgreSQL17.5 with synthetic auth/storage. The private reference exports existing TypeScript review/geometry functions and `unzipSync`. Its82 cases cover SQL grants,identity,atomic failure,metadata,replay,undo,duplicate threshold,UTF16/numeric hashes and budgets. Existing108 core and45 project cases remain required separately. Hash/overlap formatting and reset timezone are fixed independently of session settings.

These fixtures do not prove live JWT/RLS/storage,real concurrent connections,browser acknowledgements,provider dispatch or Quest acceptance. Review UI/service wiring,scheduled staging/guest cleanup and licensed demo reset remain pending.
