# Controlled demonstration labels

`make_demo.py` implements the original offline demo-generation step. Use Python 3.12+; it has no external dependencies, model calls, network access or pickle execution.

Start with a validated canonical `.lrx.zip` whose source and redistribution rights you have checked. Keep that original file. Choose three distinct frame/object occurrences using the actual IDs in your source labels. Edit `demo-fault-plan.example.json` to match them. The file is a plan template, not a runnable plan for an arbitrary clip.

```sh
python tools/converter/make_demo.py source.lrx.zip --plan your-fault-plan.json --output-dir new-demo-directory
python tools/converter/validate.py new-demo-directory/demo.lrx.zip --expected new-demo-directory/demo-world-boxes.json
```

The output directory must not exist. Input/output paths cannot pass through symlinks or Windows reparse points. Input is independently validated before processing; output is independently validated before any files are written. An invalid plan or failed generation produces no success receipt.

The plan defines exactly three controlled changes:

| Plan entry | Behavior |
| --- | --- |
| `offset` | Move the selected cuboid by exactly +0.4 or -0.4 source metres along x, y or z. |
| `duplicate` | Clone exactly one frame occurrence under a new globally unused ID of the same class. Other frames do not receive that ID. |
| `dimensionJump` | Multiply one source dimension by 1.21–1.5 in one frame. The preceding manifest frame must contain the same object within one second, the baseline must be stable, and the new ratio must exceed 20%. |

Point bytes and licence bytes are unchanged. Unknown/unrelated label metadata is preserved, including the original object records. Source kind, licence, URL and declared source digest are retained. Attribution gains a prominent injected-fault notice in the manifest and text file. A deterministic new bundle ID and hashes identify the changed labels. The script preserves a synthetic source's classification; it never presents a fixture as a real scan.

Outputs:

- `demo.lrx.zip`: the validated canonical bundle, with no added ZIP-member types.
- `review-demo-faults.json`: explicit injected changes, original/demo cuboids, provenance and point hashes.
- `baseline-world-boxes.json`: all uninjected baseline occurrences, compatible with the independent validator.
- `demo-world-boxes.json`: all intentionally changed occurrences, including the duplicate, for validating the generated bundle.

The sidecars stay beside the ZIP because the application has an exact member allowlist. Keep them with the source and generated sample. A baseline is a reference for reversing controlled changes; it does not establish that every natural annotation is correct. External data rights are not adjudicated by JSON validation. Actual support after a 0.4 m offset depends on the scan; the tool does not claim that every offset triggers a low-support warning.

Inputs with historical audit/review members and this generator's already disclosed output are rejected. The prepared production demo is not replaced or uploaded by this tool. Hosted review/export, physical Quest tests, extended AI evaluation and final video publication still need their own evidence.
