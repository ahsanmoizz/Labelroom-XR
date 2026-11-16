# Submission preparation, 16 November 2026

The owner confirmed Start membership and chose an emulator-demonstrated prototype while physical Quest testing is unavailable. Membership is recorded as owner-confirmed. The original hardware, reviewer and live-provider benchmarks are not marked passed.

## Verified software and hosted state

The 130 distinct archived ZIP payloads passed CRC checks, all 351 handoff file hashes matched, and the 226 original source files matched GitHub at `20de3b364d0c1b3338570e9c722f254d53ba1829`. Subsequent changes repair validation/documentation and add recording tools; application and backend runtime source is unchanged.

[CI run 43858762682](https://github.com/ahsanmoizz/Labelroom-XR/actions/runs/43858762682) passed Linux source/browser, Windows Edge, all 246 database fixture cases and production public readback. Its separate optional live recording failed at the security check before authentication. Do not describe the whole run as successful. The Linux suite passed 1,082 units with the existing seed-dependent skip; that skipped case passed separately using the recovered hash-verified real seed. The independent Python suite passed 104 cases locally and is included in CI.

The public frontend's 21 served files match a rebuild with its exact public settings, including the current isolate/depth controls. All five deployed Edge Function bundles and their import maps match source; production has all nine expected migration versions. Read-only Cron/HTTP observations show 96 successful scheduled calls over the preceding day, including three real eligible demo cleanups with completed=1 and failed=0 each. No expired projects or orphaned project objects remained at observation. No schema, Auth settings or existing customer project was modified during this readback.

## Record on a PC without a headset

Use this branch/current reviewed checkout and Node 24.19+ within Node 24. On Windows PowerShell:

```powershell
powershell -NoProfile -File .\scripts\record-demo.ps1
```

This installs the pinned dependencies and Playwright Chromium, then opens the real hosted application with Quest 3 hand emulation. Complete the normal security check yourself when it appears. The script has a five-minute window for that step. It uses a new anonymous demo, not an existing private project. Once the demo opens, leave the window alone.

The recorder attempts explicit hand preview/reject/approve, display-only isolation/depth/rotation, one bounded live AI inspection, consent revocation, approved undo, hard reload and export. It labels footage as emulation and writes `labelroom-live-emulator.webm`, `recording-report.json` and, on success, `saved-export.lrx.zip`. No backend or AI response is mocked. The full automated path has not yet run beyond the security check, so a stopped report must be inspected and fixed before publishing. A passing software fixture is not a substitute for that result.

For macOS/Linux after `npm ci` and `npx playwright install chromium`:

```sh
node scripts/record-live-demo.mjs /ABSOLUTE/NEW/OUTPUT --headed
```

If automation stops after authentication, retain its report and record the equivalent manual desktop/emulator path. Never turn off CAPTCHA or manufacture tokens. Do not repeatedly create guests to evade quotas. Use manual review if AI reports unavailability, and disclose that state rather than claiming a live AI demonstration.

## Public video outline

Aim for 2 minutes 35 seconds. These are planned segments, not completed footage:

| Time | Show | Suggested narration |
| --- | --- | --- |
| 0:00–0:18 | Product and licensed scan | “LabelRoom XR helps reviewers inspect existing 3D boxes against scan points. This demonstration uses Quest 3 browser emulation.” |
| 0:18–0:45 | Enter XR, select and inspect | “The same dataset opens in a seated spatial workspace. Hands select labels and control the review panel.” |
| 0:45–1:15 | Preview, reject, then explicit approval | “A preview does not save. A separate approval creates a versioned change with its audit.” |
| 1:15–1:40 | Isolate and depth views | “Inspect nearby points and source-axis projections without changing labels.” |
| 1:40–2:05 | Optional real AI evidence | “With consent, the assistant uses measured inspection tools. It cannot approve changes.” Show only a genuine successful call; otherwise show the honest unavailable state. |
| 2:05–2:35 | Undo, reload, export | “Undo creates another audited revision. Saved work reopens, and export preserves the original scan points.” |

Trim the sign-in/security wait and installation. Review the complete final recording. Verify the actual export with `python tools/converter/validate.py PATH_TO_SAVED_EXPORT.lrx.zip`, then reimport and compare point-member hashes. Keep the successful report and exact code revision with the footage. Do not publish a failed recording or display private accounts, tokens, browser storage or customer scans.

Upload title: **LabelRoom XR | Hands-first 3D Label Review | Quest 3 Emulator Demo**

Suggested description: “A working prototype for inspecting existing point-cloud 3D labels, previewing human-approved edits, saving an audit trail, undoing and exporting. Footage uses browser Quest 3 emulation, not a physical headset. The sample uses licensed PandaSet scan points with disclosed injected label faults. Physical tracking, comfort and headset performance are not yet measured. Try the app: https://labelroom-xr.pages.dev/ . Source: https://github.com/ahsanmoizz/Labelroom-XR .”

The competition requires a public YouTube/Vimeo video shorter than three minutes. A file or GitHub artifact alone does not satisfy that hosting requirement. The entry and public video are not yet submitted/published.

## Honest remaining statuses

| Requirement | Current status |
| --- | --- |
| XR Setup / Enter XR wiring, SDK session, recovery and tested hand controls | PASS under software/emulator scope |
| Physical Quest performance, tracking, comfort and three hardware attempts | DEFERRED, no physical pass |
| VR reviewer comparison and measured productivity claims | DEFERRED for this prototype; original study unfulfilled |
| Full new hosted judge task and independent new real-clip acceptance | UNVERIFIED; live recorder stopped before authentication |
| Live AI 20-case evaluation and 10 clean rehearsals | OPEN; earlier bounded live smoke is narrower |
| Public demo video | BLOCKED on an interactive recording session, then public upload |
| Membership | CONFIRMED BY OWNER |
| Age/territory/division and other eligibility, final form, submission receipt | UNVERIFIED / PENDING |

Keep `npm run release:check` strict. Its original full-product checklist is deliberately not filled with emulator passes for physical tests. [Official rules](https://start-developer-competition-26.devpost.com/rules) and the current original contracts remain authoritative for final entry requirements.
