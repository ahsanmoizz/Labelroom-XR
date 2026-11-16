# Checked deployment

`scripts/deploy.ps1` consolidates source checks, generated Edge bundles, explicit migration/function deployment, a public-only frontend build and exact served-byte verification. It defaults to **verification only**. Use a clean reviewed checkout and Node 24.19+ in the Node 24 line. Supabase 2.120.0 and Wrangler 4.163.0 are pinned by the lockfile. Use your ordinary authenticated CLI sessions or the providers' supported environment credentials; never put private values in build configuration or reports.

Run verification:

```powershell
powershell -NoProfile -File .\scripts\deploy.ps1 -Target staging
```

For frontend publication, create a local JSON file outside the checkout with exactly `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_APP_ORIGIN`, `VITE_TURNSTILE_SITE_KEY` and `VITE_GUEST_DEMO` (all strings). Copy the public values from the selected environment. The build rejects unknown keys, private-looking values, test site keys, a mismatched backend or origin, and an omitted demo choice. It clears inherited VITE variables before the build; inspect local Vite environment files before operating a release checkout.

```powershell
powershell -NoProfile -File .\scripts\deploy.ps1 -Target staging -DeployFrontend -PublicConfigPath C:\Release\staging-public.json
```

After staging acceptance, use `-Target production`, the production public configuration and `-StagingEvidencePath` pointing to the successful live integration report for that exact commit. Production publication also checks that HEAD equals the current remote main. These are software prototype deployment gates, not a substitute for the strict full acceptance checker. The existing `labelroom-xr` Pages project uses `guest-staging` for its preview and `main` for production. No new hosting project, domain, secret rotation, Auth configuration or dataset is created by this script. A nonzero exit stops subsequent deployment steps. Earlier successful provider operations are not automatically rolled back.

`-ApplyMigrations` first displays the real dry run, then applies pending migrations to the explicit project while skipping Vault configuration. `-DeployBackend` deploys the five verified generated functions with their checked config. Set these switches only for a reviewed backend change. Review `supabase/config.toml` against the selected deployment, especially gateway JWT mode, before enabling backend publication. Provider/AI/cleanup secrets are configured separately through the provider, never copied into public JSON. Keep the last working frontend version for rollback; do not drop service data as a rollback strategy.

The deployment receipt proves only steps actually completed. Hardware acceptance, full database disaster recovery, account eligibility and submission stay separate. A backend-only run is not represented as verified deployed-source equality; use the existing connected provider readback for that check.
