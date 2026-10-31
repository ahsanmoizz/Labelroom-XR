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
