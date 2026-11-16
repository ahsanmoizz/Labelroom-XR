# Remaining acceptance and reproducible checks

The owner selected a headset-free prototype and excluded the final video from this completion batch. Software results must not be converted into physical, reviewer, eligibility or submission passes.

## Display settings

Open **User guide → Display settings**. Text/panel size has 100%, 115% and 130% choices, and High contrast is optional. These non-identifying device preferences persist in this browser; storage failures leave them usable in memory with an honest notice. They have no project or network capability. In XR use **SELECT → Text/panel** or **Contrast** with either hand. The whole canvas panel enlarges so text and hit targets stay aligned. A preference change cancels held input and requires **Resume**. Actual reach and comfort still need a headset.

## Live integration

```sh
node scripts/test-live-staging.mjs /absolute/new/report-folder
```

The committed runner targets only the existing staging backend. It signs in normally through anonymous Auth, verifies the real identity, opens the licensed source, measures actual points, validates and discards a local preview, saves a manual correction, proves replay/conflict behavior, keeps an issue, explicitly confirms one duplicate removal, exports/reimports, undoes the last decision, tests direct-write denial and two legitimate guests' isolation, and confirms the guest reset. It never uses a service key, SQL, manufactured challenge token, fake backend/model or customer project. Separate Node geometry execution is identified; this is not a browser UI or physical input result.

`--run-ai` adds at most three real guest tool turns. Staging's AI switch must already be enabled by the operator. Failure stops that AI plan without replacement turns; ordinary data checks continue. The runner revokes its consent after the normal plan. It does not change server configuration or budgets. `--extended-ai --session-file /private/session.json --project-id OWN_TEST_PROJECT_UUID` requires one existing legitimate permanent account and a full remaining 30-turn daily allowance. The session file stays local and must never enter a repository or report. It runs the original 20 planned categories plus ten rehearsals, records actual tool measurements/citations and checks saved labels after each turn. Automated tool-plan traceability is not human annotation correctness or a reviewer study. Any omitted, failed or interrupted turn leaves extended acceptance incomplete.

The **Live staging integration** workflow runs the real caller-owned API path and the independent Python validator. Its default makes no model requests. A manually selected AI smoke is distinct from the 20+10 evaluation. Production CAPTCHA, outside-user OTP and full public browser acceptance remain separate.

## Restore rehearsal

The main regression workflow starts a new PostgreSQL 17 instance, applies the eight application migrations unchanged with explicit synthetic Auth/Storage schemas, saves one real fixture command, dumps with `pg_dump`, restores into a second fresh database with `pg_restore`, and compares rows, complete history, procedure bodies, ACLs, policies and RLS. It tests the restored owner boundary and copies/checks the separate fixture object bytes. The hosted Cron migration has its separate fixture and operational receipts.

This is an actual isolated database recovery rehearsal. It does not download customer data, prove a hosted managed backup, or restore hosted Storage/Auth/Vault/provider secrets. Those require the operator's properly scoped backup environment and separate evidence. Supabase's [backup/restore guide](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) documents the broader project operation.

## Publication and final gates

Use the [consolidated deployment entrypoint](deployment.md). A tested candidate is not published until the hosting provider succeeds and the exact served-byte comparison passes. Retain failed hosting, blocked live and earlier test receipts. Leave `release:check` strict. Real hardware/study measurements, a normal outside-user OTP, the public video, entrant facts and an actual portal acknowledgement cannot be generated from an emulator report.
