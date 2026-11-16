# Physical Quest acceptance — record actual observations

Required device: the actual supported Quest browser and hand tracking. Record headset model, OS/browser version, tested commit, URL, date, reviewer code and whether controllers were unpaired. Desktop emulation is a separate result.

For each of three fresh attempts, seat the reviewer with controls within a two-foot reach. Start in a fresh guest session with real CAPTCHA. Open the licensed sample, enter VR, select a box, isolate it, step frames, reset the view, preview and reject an edit, explicitly approve one correction, preview/approve undo, export, exit VR and reopen the saved state. Use both hands, briefly interrupt tracking and test sleep/resume. Record any desktop/controller rescue, accidental confirmation, unreadable text, fatigue or lost state. A useful complete task should finish within ten minutes without rescue.

For performance, record a ten-minute warmed review with a valid maximum frame of 200,000 points and 100 boxes. Collect actual application/XR frame timing rather than equating headset refresh rate with app FPS. Record p95 frame interval, any sustained one-second interval below 60 FPS, warmed frame swap time, analysis latency, input response and memory/crashes. Targets: 72 FPS; acceptance floor: no sustained one-second interval below 60 FPS; p95 app frame interval at most 16.7 ms outside explicit load; frame swap at most one second, analysis at most two seconds, selected UI response at most 150 ms.

Record result, actual measurement and evidence filename for each check. Leave unavailable data blank and mark it pending. If a device is unavailable, this gate is pending; a build, video mockup or synthetic test is not a physical pass.
