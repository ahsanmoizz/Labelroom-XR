# Submission completion runbook

The immediate target is a submission within the next 48 hours, retaining the ten-feature product scope. Source completion, staging acceptance, production publication, physical acceptance and submission are separate states. This branch is a completion candidate until those checks are measured.

## Order for the remaining work

| Window | Work | Required result |
| --- | --- | --- |
| Hours 0–8 | Finish the current guest A/reopen/guest B read check; verify this candidate locally | New `Guest-Read-Evidence.zip`; typecheck, unit, SQL, generated bundle and production build results |
| Hours 8–18 | Apply the guest review/reset/cleanup candidate to staging; run the complete sample task | Preview/reject, approved correction, keep, duplicate confirmation, undo, saved export and independent validator all work |
| Hours 18–30 | Run the hands-only Quest checklist and three reviewer sessions; complete bounded live AI checks | Actual recordings/measurements and sanitized transcripts; report failures rather than replacing them with desktop evidence |
| Hours 30–40 | Rehearse and publish the tested release, verify the public judge path and maintenance job | Exact commit and frontend/function versions, two-guest isolation, no-account entry, reset and expiry behavior, working download |
| Hours 40–48 | Record the demo, finish the form and submit with a buffer | Public URL tested in a fresh session, video, truthful feature/limitation statement and actual submission receipt |

Current historical evidence already covers the controlled member AI tool smoke, member private saves/undo/conflict and a limited PC/phone reopen/export. It does not establish the full live AI usefulness, Quest, reviewer, new guest lifecycle or production release gates. Keep that distinction in `evidence/release.json`.

## Software included in this candidate

- The reviewed guest-provision staging implementation, brought forward from the exact published base.
- Guest review workspace using the same validated snapshot, command, acknowledgement, recovery, undo and export machinery as private projects.
- Separate confirmation before a guest reset, owner-bound deletion, immutable source copies and one fresh revision-zero project. Interrupted reset can be retried; restart after expiry does not need the old ID.
- Bounded maintenance for expired demos, abandoned staging uploads and interrupted deletions, with eligibility rechecked under a database row lock before removal.
- Explicit release configuration for the demo, public help/privacy pages, local browser regression runner, SQL lifecycle tests and device/reviewer evidence templates.

## Before staging application

Preserve the existing guest A session until the current read-only check finishes. New application code must not change that run's expected revision-zero controls. Keep `AI_ENABLED=false` during provisioning and lifecycle tests.

Use a fresh isolated checkout of the candidate. Inspect the owner PC's current HEAD/status and match all base hashes before applying any change there. The branch does not itself apply a cloud migration, deploy a function or enable public guest access. Existing operator source and stopped run folders remain preserved.

Install the pinned dependencies with Node 24 and `npm ci`. Run:

```sh
npm run typecheck
npm test
node scripts/build-demo-provision.mjs --verify
node scripts/build-project-cleanup.mjs --verify
npm run build
npm run pack:check
```

For server source typechecking use the pinned Deno executable on `supabase/functions/demo-provision/entry.ts` and `supabase/functions/project-cleanup/entry.ts`. For SQL tests, install the exact external PGlite 0.3.14 runtime as described in `tests/sql/README.md`, then run `tests/sql/guest-release.mjs ABS_RUNTIME_PACKAGE ABS_NEW_REPORT`. Do not run the synthetic schema fixture in a hosted database.

Run `node scripts/test-browser-review.mjs ABS_NEW_REPORT.json` on Windows with a compatible Chromium/Edge executable if a Playwright browser is not installed. Set `LABELXR_CHROMIUM_PATH` to the existing executable. The runner permits requests only to its own temporary local server. It tests actual DOM, IndexedDB and workers with an explicitly synthetic backend, and never claims live Supabase or Quest acceptance.

## Deployment configuration

Apply migrations in order, including the reviewed demo-provision migration and the new demo-reset/cleanup migration. Apply staging first and run security/performance advisors before production. Service-only RPCs must remain unavailable to `anon` and `authenticated`; existing RLS and storage restrictions must stay enabled.

Deploy and verify the exact generated `project-admin`, `review-commit`, `agent`, `demo-provision` and `project-cleanup` bundles and their Deno import maps. Browser functions verify the caller with Auth `getUser` before work; review commits additionally retain the caller's bearer/RLS. Gateway legacy JWT verification is disabled in this candidate to support the ES256 signing keys observed in staging, following Supabase's signing-key migration guidance. This is not anonymous authorization: missing/forged callers must still fail the handler tests before any privileged work. Keep the shared `ALLOWED_ORIGIN` consistent with the selected frontend for review/project/AI endpoints.

Zod is pinned to 4.6.7 in npm and all relevant Edge import maps to address GHSA-mrhx-c7xc-m3w5. Retain this targeted patch when publishing functions and frontend; do not deploy an old import map beside a patched frontend.

For the `demo-provision` function set `DEMO_PROVISION_ENABLED=true`, `DEMO_PROJECT_URL` to that exact Supabase origin and `DEMO_ALLOWED_ORIGIN` to the exact frontend origin. Existing staging variable names are retained for compatibility, but production requires the explicit release variable names. Keep the pinned licensed seed at `project-data/demo-seeds/pandaset-v1/original.lrx.zip`; do not put it in public frontend assets.

For the frontend set the four public configuration values and `VITE_GUEST_DEMO=true` only after that backend is ready. Copy the publishable key once from the correct project; test it against Auth before building. Private/legacy service keys, cleanup tokens and provider credentials never belong in `VITE_*` values.

For `project-cleanup`, set a random 32–256 character URL-safe `PROJECT_CLEANUP_TOKEN` in Edge secrets. It is a separate maintenance credential. The function rejects browser origins and requires that exact bearer before privileged work. Store the same value under a narrowly accessible Vault secret and invoke `POST /functions/v1/project-cleanup` with JSON `{"limit":10}` through Cron every 15 minutes. Use Supabase's documented Cron/pg_net/Vault pattern; do not put the token in committed SQL, logs or frontend code. Check successful aggregate responses and failures after deployment. Do not claim scheduled cleanup from the presence of this source alone.

After applying the schema, use `supabase db advisors --project-ref PROJECT_REF --type security --fail-on error` with the pinned CLI and authenticated operator session. Review every remaining warning. No advisor result has been claimed by this branch.

## Live guest acceptance sequence

1. Fresh browser, real CAPTCHA, Enter demo, Open PandaSet demo. Confirm five real frames and visible licence/injected-label disclosure.
2. Change one known box only through preview and approve. Confirm revision advancement, refresh, reopen the same guest and verify that saved change.
3. Reject a different preview and verify no saved revision change. Keep a legitimate/occluded label with a reason. Confirm duplicate removal only for the selected frame; preview and approve last-edit undo.
4. Export the saved revision. Run the independent converter validator, reimport and compare point member hashes and the exact approved labels/audit.
5. In a separate InPrivate guest, verify a different project and denied direct access to the first guest's rows, versions, audit and original file. Treat authentication errors as failed controls, not isolation passes.
6. Cancel the first reset confirmation and verify no change. Confirm reset and verify old rows/history/object disappear, a different project starts at revision 0 and the pinned original source is reused.
7. Test an interrupted reset/storage failure and retry the same operation. Verify that the maintenance job recovers deleting/stale staging records while retaining unrelated ready private projects and the shared seed.
8. Verify expiry with a naturally expired disposable guest in the 48-hour window. Existing observed guest expiry was `2026-11-12T19:17:26.358Z`; use it only if the current run still refers to that guest. Do not change production timestamps or replace this with a synthetic clock claim.

## Release and rollback

Record the exact tested commit, migration set, frontend deployment and function hashes. Rehearse a database backup/restore separately. Roll back a faulty frontend to the previous known deployment; retain the new service-only schema until a reviewed recovery is prepared rather than dropping data or rewriting migration history. Keep AI off during recovery. Recheck the public URL after publishing and again before submission.

`npm run release:check` must continue to fail until real evidence is filled and reviewed. Never mark physical tests, reviewer results, eligibility, public judge access or the final submission receipt as passed because source or local tests passed.
