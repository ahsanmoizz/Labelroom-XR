"""Build a disclosed controlled-label demo from a validated canonical bundle.

Python 3.12+ stdlib only. No network, pickle, sampling or inference of rights.
Original points/licence bytes and unrelated label metadata are preserved.
The reference describes the uninjected baseline, not adjudicated natural truth.
"""
import argparse
import copy
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import stat
import sys
import uuid
import zipfile

HERE = Path(__file__).absolute().parent
_spec = importlib.util.spec_from_file_location("labelxr_demo_validator", HERE / "validate.py")
validator = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(validator)
MARKER = "LabelRoom XR controlled-demo/v1"
NOTICE = (MARKER + ": labels contain deliberate demonstration faults: a 0.4 m offset, "
          "one duplicate occurrence and a one-frame dimension change. Scan points are unchanged. "
          "See the accompanying review-demo-faults.json; these are not discovered natural errors.")


class DemoError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise DemoError(message)


def encoded(value):
    return (json.dumps(value, ensure_ascii=True, allow_nan=False,
                       sort_keys=True, separators=(",", ":")) + "\n").encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def fields(value, wanted, name):
    require(type(value) is dict and set(value) == set(wanted), name + ": fields differ.")


def read_plan(data):
    p = validator.bounded_json(data, "fault-plan.json", 8192, 12)
    fields(p, ("schemaVersion", "offset", "duplicate", "dimensionJump"), "plan")
    require(p["schemaVersion"] == "labelxr-demo-fault-plan/v1", "Unsupported fault plan.")
    for key, extra in (("offset", ("axis", "metres")),
                       ("duplicate", ("duplicateId",)),
                       ("dimensionJump", ("axis", "factor"))):
        item = p[key]
        fields(item, ("frameId", "objectId", *extra), key)
        require(all(validator.text(item[k], 128) for k in ("frameId", "objectId")), key + ": invalid IDs.")
        if key != "duplicate":
            require(item["axis"] in ("x", "y", "z"), key + ": invalid axis.")
    require(validator.text(p["duplicate"]["duplicateId"], 128), "Invalid duplicate ID.")
    metres, factor = p["offset"]["metres"], p["dimensionJump"]["factor"]
    require(validator.finite(metres) and math.isclose(abs(metres), .4, abs_tol=1e-12, rel_tol=0),
            "Offset must be exactly +0.4 or -0.4 source metres.")
    require(validator.finite(factor) and 1.21 <= factor <= 1.5, "Dimension factor must be within 1.21..1.5.")
    targets = [(p[k]["frameId"], p[k]["objectId"]) for k in ("offset", "duplicate", "dimensionJump")]
    require(len(set(targets)) == 3, "Use three distinct frame/object targets.")
    return p


def archive(members):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9,
                         allowZip64=False) as z:
        for name in sorted(members):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o600) << 16
            z.writestr(info, members[name], compresslevel=9)
    return stream.getvalue()


def generate(bundle_data, plan_data):
    """Return four validated output files, without filesystem or source mutation."""
    before = validator.validate_bundle(bundle_data)
    members = validator.read_archive(bundle_data)
    require(not (validator.OPTIONAL & members.keys()), "Use an uninjected source without historical audit/review members.")
    manifest = validator.validate_manifest(members["manifest.json"])
    require(MARKER not in manifest["source"]["attribution"], "This bundle already contains controlled demo faults.")
    plan = read_plan(plan_data)
    original = validator.bounded_json(members["labels.openlabel.json"], "labels.openlabel.json")
    labels = copy.deepcopy(original)
    frames, objects = labels["openlabel"]["frames"], labels["openlabel"]["objects"]
    frame_order = [f["id"] for f in manifest["frames"]]

    def occurrence(item, document=labels):
        require(item["frameId"] in frame_order, "Target frame is not in the manifest.")
        found = document["openlabel"]["frames"][item["frameId"]].get("objects", {}).get(item["objectId"])
        require(found is not None, "Target object occurrence is missing.")
        return found["object_data"]["cuboid"][0]["val"]

    for name in ("offset", "duplicate", "dimensionJump"):
        occurrence(plan[name])
    duplicate = plan["duplicate"]
    require(duplicate["duplicateId"] not in objects and all(
        duplicate["duplicateId"] not in f.get("objects", {}) for f in frames.values()),
        "Duplicate ID already exists; no source object may be overwritten.")

    jump = plan["dimensionJump"]
    index = frame_order.index(jump["frameId"])
    require(index > 0, "Dimension jump requires a preceding frame.")
    previous_id = frame_order[index - 1]
    dt = manifest["frames"][index]["timestamp"] - manifest["frames"][index - 1]["timestamp"]
    require(0 < dt <= 1, "Dimension jump requires a preceding frame within one second.")
    prior = occurrence({"frameId": previous_id, "objectId": jump["objectId"]}, original)
    current = occurrence(jump, original)
    require(all(abs(current[i] / prior[i] - 1) <= .2 for i in (7, 8, 9)),
            "The baseline already has a dimension jump; choose a stable control.")
    dimension = 7 + ("x", "y", "z").index(jump["axis"])
    require(current[dimension] * jump["factor"] / prior[dimension] > 1.2,
            "This factor would not create the intended greater-than-20-percent jump.")

    faults = []
    offset = plan["offset"]
    values = occurrence(offset)
    baseline = values.copy()
    values[("x", "y", "z").index(offset["axis"])] += offset["metres"]
    faults.append({"kind": "offset", **offset, "baselineCuboid": baseline, "demoCuboid": values.copy()})

    fid, oid, new_id = duplicate["frameId"], duplicate["objectId"], duplicate["duplicateId"]
    objects[new_id] = copy.deepcopy(objects[oid])
    frames[fid]["objects"][new_id] = copy.deepcopy(frames[fid]["objects"][oid])
    faults.append({"kind": "duplicate", **duplicate, "baselinePresent": False,
                   "demoCuboid": occurrence(duplicate).copy(), "sameClass": True})

    values = occurrence(jump)
    baseline = values.copy()
    values[dimension] *= jump["factor"]
    faults.append({"kind": "dimension-jump", **jump, "previousFrameId": previous_id,
                   "baselineCuboid": baseline, "demoCuboid": values.copy()})

    members = dict(members)
    members["labels.openlabel.json"] = encoded(labels)
    members["ATTRIBUTION.txt"] = members["ATTRIBUTION.txt"] + b"\n\n" + NOTICE.encode() + b"\n"
    manifest["source"]["attribution"] += "\n\n" + NOTICE
    manifest["bundleId"] = str(uuid.uuid5(uuid.NAMESPACE_URL, MARKER + ":" + digest(bundle_data) + ":" + digest(encoded(plan))))
    manifest["hashes"] = {name: digest(members[name]) for name in manifest["hashes"]}
    members["manifest.json"] = encoded(manifest)
    result = archive(members)
    after = validator.validate_bundle(result)
    point_hashes = {f["pcd"]: before["memberHashes"][f["pcd"]] for f in manifest["frames"]}
    require(all(after["memberHashes"][name] == sha for name, sha in point_hashes.items()), "Point bytes changed.")
    baseline_reference = encoded({"schemaVersion": "labelxr-world-boxes/v1", "boxes": before["worldBoxes"]})
    demo_reference = encoded({"schemaVersion": "labelxr-world-boxes/v1", "boxes": after["worldBoxes"]})
    validator.validate_bundle(bundle_data, baseline_reference)
    validator.validate_bundle(result, demo_reference)
    disclosure = encoded({
        "schemaVersion": "labelxr-demo-faults/v1", "injected": True,
        "sourceKind": before["sourceKind"], "sourceBundleSha256": digest(bundle_data),
        "demoBundleSha256": digest(result), "planSha256": digest(encoded(plan)),
        "referenceMeaning": "Uninjected source labels for controlled-change comparison; natural annotation correctness and external rights are not adjudicated.",
        "pointMembersSha256": point_hashes, "faults": faults,
    })
    return {"demo.lrx.zip": result, "review-demo-faults.json": disclosure,
            "baseline-world-boxes.json": baseline_reference, "demo-world-boxes.json": demo_reference}


def write_outputs(directory, files):
    output = Path(os.path.abspath(directory))
    for parent in (output.parent, *output.parent.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode) and
                not getattr(info, "st_file_attributes", 0) & 0x400, "Output parent must be an existing nonredirected directory.")
    # Exclusive directory creation prevents replacement of earlier output/input.
    output.mkdir(mode=0o700)
    for name, data in files.items():
        with (output / name).open("xb") as stream:
            stream.write(data)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", help="Canonical uninjected input .lrx.zip")
    parser.add_argument("--plan", required=True, help="Explicit three-target fault plan")
    parser.add_argument("--output-dir", required=True, help="New directory; existing data is never replaced")
    args = parser.parse_args(argv)
    try:
        outputs = generate(validator.read_regular(args.bundle, validator.COMPRESSED_LIMIT),
                           validator.read_regular(args.plan, 8192))
        write_outputs(args.output_dir, outputs)
        print(json.dumps({"schema": "labelxr-demo-generation/v1", "passed": True,
                          "injectedFaults": 3, "pointBytesUnchanged": True,
                          "demoBundleSha256": digest(outputs["demo.lrx.zip"]),
                          "rightsVerified": False}, sort_keys=True))
        return 0
    except (DemoError, validator.ValidationError, OSError, ValueError) as error:
        print(json.dumps({"schema": "labelxr-demo-generation/v1", "passed": False,
                          "error": str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
