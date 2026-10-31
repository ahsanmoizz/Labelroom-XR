<!-- LABELXR-PROJECTS-INTEGRATION-README-v1 -->
# Private project lifecycle checks

The standalone `projects.mjs` suite runs the actual HTTP handler and browser project service against the lifecycle SQL and core RLS using the pinned external PGlite runtime. Authentication and Storage HTTP transport are explicit local stand-ins. It opens no provider connection and installs no dependency. Original `tests/sql/core.mjs` and its 108 cases stay unchanged and run separately.

The guarded runner performs a strict compile against the installed Supabase SDK, builds an isolated bridge, and supplies `--runtime`, `--compiled` and a new `--output` outside the repository. It also retains all 796 permanent unit names and requires the full application typecheck and production build.

`supabase/functions/project-admin/index.ts` is generated from `entry.ts` and the existing data validators. Run `node scripts/build-project-admin.mjs --verify` to check the exact generated endpoint; `--write` is an authoring command requiring a reviewed source change. Gateway JWT verification remains enabled.

These results do not establish live Supabase authorization, concurrent database behavior, browser persistence, Quest acceptance or production readiness. Do not deploy this checkpoint alone. Browser project-panel wiring, scheduled abandoned-upload/expired-demo cleanup, licensed demo reset, review/budget RPCs, live two-user and failure/reload checks remain required. All migrations must be reviewed in version order together before a cloud application. Privileged keys belong only in Edge secrets, never in browser settings or source.
