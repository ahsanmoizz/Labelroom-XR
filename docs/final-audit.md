# Final scope audit — 15 November 2026

The six numbered planning guides, the original 149-row engineering tracker, the current hosted recovery tracker, build-contract.json and all 19 test groups were compared with the accepted production release and this refresh/AI repair. Historical unchecked planning boxes are not proof of missing code or passed acceptance. This report does not mark hardware or human evidence as completed.

| Planned feature | Current evidence and remaining work |
| --- | --- |
| F01 Real input | Supported PCD/OpenLABEL ZIP import, licensed PandaSet conversion and point/hash validation are implemented and tested. General LAS/LAZ/PLY and arbitrary OpenLABEL were deliberately excluded. |
| F02 Private projects | Email OTP, owner-scoped storage, three-project quota, list/open/delete are implemented. Previously accepted live privacy and ownership checks remain relevant. Refresh bookmarks are added by this repair; native/live acceptance of the repair is still required. |
| F03 Hands workspace | Seated scene, ray selection, frame changes, reset and spatial review panel have emulator/SDK evidence. Dedicated isolate/depth-view controls listed in the early plan are not present in the released source. Physical hands-only completion, maximum-load headset FPS and comfort remain unverified. Do not describe desktop Focus scene as object isolation or an orthographic depth view. |
| F04 Candidate checks | Low support, oriented overlap/duplicate and adjacent-frame dimension warnings are implemented. Measurements remain potential issues, not ground-truth label errors. |
| F05 AI | Allowlisted inspection tools, consent, budgets, replay/stale guards and no-auto-save boundary are implemented. The accepted production deployment deliberately set AI_ENABLED=false. This update enables only that production flag after native checks; one real measured tool turn plus consent revocation must pass before claiming current live AI works. No usefulness or accuracy study is claimed. |
| F06 Decisions | Edit/keep/confirmed duplicate removal/preview/reject/last-edit undo are implemented, with earlier accepted staging lifecycle evidence. |
| F07 Save/resume | Atomic version/audit/idempotency and pending/typed recovery exist. This repair remembers the open demo/member project or local preview, frame/object/scale and review-open state. Reopen uses verified reads, never provisioning/reset/save replay. Typed recovery is explicit; an unapproved preview must be previewed again. |
| F08 Export | Original point bytes, corrected supported labels, audit, provenance and hashes have accepted roundtrip/export evidence. |
| F09 Guest demo | No email required; real licensed sample, altered-label disclosure, owner isolation and reset are implemented. The original 24-hour access boundary remains; refresh does not extend it. |
| F10 Release | Public HTTPS production and protected staging were verified. The new source/AI flag require their own update receipt. Three intended-reviewer sessions, physical device/performance evidence, membership/developer/division/launch-date confirmations, actual public video and final portal acknowledgement remain outstanding. |

## What this repair changes

- An account/backend-scoped view bookmark and bounded local ZIP recovery, with explicit Close dataset.
- Latest server revision on reopening; same frame/object/scale; Close review stays closed after refresh.
- A warning while typed recovery is still being written or its durability failed. Existing typed and pending caches are retained.
- Clear AI availability/consent/server-disabled/provider-error states, preserving model limits and human approval.
- Help/privacy/guide text describing device-local ZIP recovery and the actual AI sequence.

The login page, authentication service, styling, generated Edge code, schema, RLS, source seed, review-commit protocol and production maintenance schedule are not changed by this repair. Browser storage can be unavailable or cleared by the user/browser. Guest access still expires; no application can promise indefinite retention after sign-out, site-data deletion, storage eviction or access revocation.

## Release gate

Local unit/type/build checks and a synthetic browser fixture are separate from native Edge and live cloud acceptance. The update runner must pass native review/layout/navigation, account-entry, SDK refocus, XR-emulator, SDK-session and the new hard-refresh/AI fixtures before requesting deployment tokens. It then verifies the exact accepted production deployment, preserves existing private/Auth/schema/function/source/staging state, enables only AI_ENABLED, publishes once and checks its actual public asset bytes. A separate new disposable public demo verifies a real bounded AI inspection, consent revocation and a manually performed hard refresh. The runner can resume read-only verification of an uncertain publication; it must not publish or repeat AI automatically.

This audit is the requested final comparison. It does not silently remove unfinished requirements from the original plan or certify A-to-Z completion where evidence is absent.
