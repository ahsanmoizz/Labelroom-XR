# Submission material to complete from the accepted build

## Short description

LabelRoom XR helps a reviewer inspect existing 3D boxes against point-cloud scans in a seated spatial workspace. Deterministic checks and optional measured AI assistance identify candidates for review. The person previews and approves each change, saves an auditable revision, and exports corrected labels with the original point data preserved.

## Record these exact release facts

- Tested commit, frontend URL/deployment and backend revisions.
- Account eligibility and the actual competition deadline/timezone, checked in the submission portal.
- Dataset name, original licence/terms, attribution and disclosed artificial sample-label changes.
- Physical headset and browser used; actual performance measurements and limitations.
- Number of intended reviewers, observed correctness, task times and comfort. Claim a speed advantage only if the recorded comparison supports it.
- Public no-account judge instructions, support contact and availability during judging.
- Actual video URL and final submission receipt.

## 165-second recording outline

| Time | Show | Explain with short on-screen text |
| --- | --- | --- |
| 0–15 s | A misaligned box against real scan points | Existing labels need inspection in depth. |
| 15–35 s | Fresh no-account guest, sample and visible attribution | Real licensed sample; altered labels disclosed. |
| 35–65 s | Seated hands selecting, isolating and comparing a box | Inspect points and measurements before deciding. |
| 65–95 s | Deterministic candidate; optional actual AI tool evidence if its release gate passed | Low support is uncertain; AI suggests and never saves. |
| 95–125 s | Preview, reject once, approve a correction, saved revision and undo | Every edit needs explicit human approval. |
| 125–145 s | Download and independent reimport of corrected labels/audit | Original point bytes remain unchanged. |
| 145–165 s | Final product view, tested URL and honest limitations | State measured results and the next use case. |

Use actual accepted behavior. Do not substitute an animation for an unpassed feature or hide an error in a way that misrepresents the working build. A live AI provider failure should be disclosed; manual review can remain useful. Verify the portal's actual video length and link rules before recording the final cut.

## Reviewer protocol

Recruit three intended dataset reviewers. Give each six matched tasks, three desktop and three VR, alternate the order and include a valid occluded label that should be kept. Use an independent correct-answer reference. Record task time, correctness, destructive changes, usable export, comfort and a short useful/not-useful explanation in `tests/manual/reviewer-study.csv`. Obtain permission before sharing recordings or identifying participants. Report raw medians and limitations rather than guaranteed productivity claims.
