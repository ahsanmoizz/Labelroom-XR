"""Deterministic generic XYZ PCD/OpenLABEL conversion. Python 3.12+ stdlib only.

Inputs must explicitly declare metres, registered common world coordinates and
little-endian binary data. Only upright bbox cuboids and XYZ float32 PCD layouts
are supported. No frame registration, sampling, rights inference or pickle use.
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
import re
import stat
import struct
import sys
import tempfile
import uuid
import zipfile

HERE = Path(__file__).absolute().parent
spec = importlib.util.spec_from_file_location("labelxr_output_validator", HERE / "validate.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
SOURCE_FRAME_LIMIT = 16 * 1024 * 1024
SOURCE_TOTAL_LIMIT = 160 * 1024 * 1024
POINT_TOLERANCE = 0.001
DECIMAL = re.compile(rb"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?")


class ConversionError(ValueError):
    def __init__(self, member, field, detail):
        super().__init__(detail)
        self.member, self.field, self.detail = member, field, detail


def require(ok, member, field, detail):
    if not ok:
        raise ConversionError(member, field, detail)


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True,
                      allow_nan=False, separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def directory(path):
    p = Path(os.path.abspath(path))
    for ancestor in (p, *p.parents):
        s = ancestor.lstat()
        require(stat.S_ISDIR(s.st_mode) and not stat.S_ISLNK(s.st_mode) and
                not getattr(s, "st_file_attributes", 0) & 0x400,
                "input", "directory", "Expected existing, nonredirected directories.")
    return p


def read(path, limit, member):
    try:
        return validator.read_regular(path, limit)
    except (OSError, validator.ValidationError) as e:
        raise ConversionError(member, "file", "Expected a bounded, nonredirected regular file.") from e


def frame_map(data):
    m = validator.bounded_json(data, "frame-map.json", 128 * 1024, 16)
    validator.obj(m, "frame-map.json", "source", ("schemaVersion", "units", "coordinates",
                  "coordinateFrame", "binaryByteOrder", "source", "frames"), strict=True)
    require(m["schemaVersion"] == "labelxr-generic-source/v1" and m["units"] == "meters" and
            m["coordinates"] == "x-y-ground-z-up" and m["coordinateFrame"] == "registered-world-common"
            and m["binaryByteOrder"] == "little", "frame-map.json", "coordinates",
            "Explicit common-world metre coordinates and little-endian input are required.")
    validator.obj(m["source"], "frame-map.json", "source", ("name", "kind", "url", "licence", "attribution"), strict=True)
    require(type(m["frames"]) is list and 1 <= len(m["frames"]) <= 10,
            "frame-map.json", "frames", "Expected 1..10 explicitly mapped frames.")
    seen, ids, previous = set(), set(), -math.inf
    for f in m["frames"]:
        validator.obj(f, "frame-map.json", "frame", ("id", "timestamp", "pcd"), strict=True)
        require(validator.text(f["id"], 128) and f["id"] not in ids and
                validator.finite(f["timestamp"]) and f["timestamp"] > previous,
                "frame-map.json", "frames", "Unique IDs and strictly increasing finite timestamps are required.")
        ids.add(f["id"])
        previous = f["timestamp"]
        name = f["pcd"]
        require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,119}\.pcd", name)
                and name.split(".")[0].upper() not in {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}
                and name.casefold() not in seen, "frame-map.json", "pcd", "Expected unique portable PCD basenames.")
        seen.add(name.casefold())
    return m


def source_points(data, name):
    keys = ["VERSION", "FIELDS", "SIZE", "TYPE", "COUNT", "WIDTH", "HEIGHT", "VIEWPOINT", "POINTS", "DATA"]
    rows, cursor = {}, 0
    while len(rows) < len(keys):
        end = data.find(b"\n", cursor, 16384)
        require(end >= 0, name, "header", "Missing newline or header exceeds 16 KiB.")
        raw, cursor = data[cursor:end], end + 1
        require(all(c in (9, 13) or 32 <= c <= 126 for c in raw), name, "header", "Expected ASCII header.")
        raw = raw[:-1] if raw.endswith(b"\r") else raw
        require(b"\r" not in raw, name, "header", "Unexpected carriage return.")
        parts = raw.strip().split()
        if not parts or parts[0].startswith(b"#"):
            continue
        require(parts[0].decode() == keys[len(rows)], name, "header", "Unexpected or repeated header key/order.")
        rows[keys[len(rows)]] = b" ".join(parts[1:]).decode()
    require(rows["VERSION"] in ("0.7", ".7") and rows["DATA"] in ("ascii", "binary"), name, "format", "Unsupported version or data encoding.")
    for key, value in {"FIELDS": "x y z", "SIZE": "4 4 4", "TYPE": "F F F", "COUNT": "1 1 1", "HEIGHT": "1", "VIEWPOINT": "0 0 0 1 0 0 0"}.items():
        require(rows[key] == value, name, key, "Unsupported layout or nonidentity viewpoint; no inferred transform.")
    for key in ("WIDTH", "POINTS"):
        require(re.fullmatch(r"[0-9]{1,16}", rows[key]) is not None, name, key, "Expected bounded decimal count.")
    count = int(rows["POINTS"])
    require(1 <= count <= 200000 and int(rows["WIDTH"]) == count, name, "POINTS", "Expected 1..200000 unorganized XYZ points.")
    payload = memoryview(data)[cursor:]
    if rows["DATA"] == "binary":
        require(len(payload) == count * 12, name, "payload", "Binary payload size differs.")
        iterator = struct.iter_unpack("<fff", payload)
    else:
        def ascii_iterator():
            tokens = re.finditer(rb"[^ \t\r\n]+", payload)
            for i in range(count):
                point = []
                for _ in range(3):
                    token = next(tokens, None)
                    require(token is not None and len(token[0]) <= 64 and DECIMAL.fullmatch(token[0]),
                            name, f"point[{i}]", "Expected exact finite decimal XYZ tokens.")
                    point.append(float(token[0]))
                yield tuple(point)
            require(next(tokens, None) is None, name, "payload", "Unexpected additional point data.")
        iterator = ascii_iterator()
    def checked():
        for i, point in enumerate(iterator):
            require(all(math.isfinite(v) for v in point), name, f"point[{i}]", "Nonfinite source coordinate.")
            yield point
    return count, checked()


def median(values):
    values.sort()
    n = len(values)
    return values[n // 2] if n % 2 else values[n // 2 - 1] / 2 + values[n // 2] / 2


def canonical_points(data, name, origin):
    count, points = source_points(data, name)
    out = bytearray(("VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n"
                     f"WIDTH {count}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {count}\nDATA binary\n").encode())
    for i, point in enumerate(points):
        local = [p - o for p, o in zip(point, origin)]
        require(all(math.isfinite(v) and abs(v) <= 250 for v in local), name, f"point[{i}]",
                "Point exceeds the common origin's 250 metre bounds; no sampling or outlier removal.")
        packed = struct.pack("<fff", *local)
        require(all(abs(p - (q + o)) <= POINT_TOLERANCE for p, q, o in zip(point, struct.unpack("<fff", packed), origin)),
                name, f"point[{i}]", "Float32 source-world reconstruction exceeds 1 mm.")
        out.extend(packed)
    return bytes(out), count


def translated_labels(data, frames, origin, inventory):
    labels = copy.deepcopy(validator.bounded_json(data, "labels.openlabel.json"))
    ol = validator.obj(validator.obj(labels, "labels.openlabel.json", "document", ("openlabel",))["openlabel"],
                       "labels.openlabel.json", "openlabel", ("metadata", "frames"))
    metadata = validator.obj(ol["metadata"], "labels.openlabel.json", "metadata", ("schema_version",))
    require("labelroom_converter" not in metadata, "labels.openlabel.json", "metadata.labelroom_converter", "Reserved conversion metadata already exists.")
    source_frames = validator.obj(ol["frames"], "labels.openlabel.json", "frames")
    require(set(source_frames) == {f["id"] for f in frames}, "labels.openlabel.json", "frames", "Source labels and explicit frame map differ.")
    expected = []
    for frame in frames:
        f = validator.obj(source_frames[frame["id"]], "labels.openlabel.json", "frame", ("frame_properties",))
        objects = validator.obj(f.get("objects", {}), "labels.openlabel.json", "objects")
        require(len(objects) <= 100, "labels.openlabel.json", "objects", "More than 100 occurrences in a frame.")
        for oid, occurrence in objects.items():
            obj = validator.obj(validator.obj(occurrence, "labels.openlabel.json", "occurrence", ("object_data",))["object_data"],
                                "labels.openlabel.json", "object_data", ("cuboid",))
            cuboids = obj["cuboid"]
            require(type(cuboids) is list and len(cuboids) == 1, "labels.openlabel.json", "cuboid", "Expected exactly one bbox cuboid.")
            val = validator.obj(cuboids[0], "labels.openlabel.json", "cuboid", ("name", "val"))["val"]
            require(type(val) is list and len(val) == 10 and all(validator.finite(v) for v in val), "labels.openlabel.json", "cuboid.val", "Expected finite XYZ/xyzw/size.")
            raw_yaw = 2 * math.atan2(val[5], val[6])
            expected.append({"frameId": frame["id"], "objectId": oid, "center": val[:3], "size": val[7:],
                             "yaw": math.atan2(math.sin(raw_yaw), math.cos(raw_yaw))})
            val[:3] = [val[i] - origin[i] for i in range(3)]
    metadata["labelroom_converter"] = {"schemaVersion": "labelxr-generic-conversion/v1", "sourceOrigin": origin,
                                      "sourceDigestKind": "sha256-of-canonical-input-inventory", "inputInventory": inventory}
    return encoded(labels), encoded({"schemaVersion": "labelxr-world-boxes/v1", "boxes": expected})


def publish(output, data):
    output = Path(os.path.abspath(output))
    parent = directory(output.parent)
    require(not os.path.lexists(output), "output", "path", "Output already exists; overwrite is forbidden.")
    fd, temporary = tempfile.mkstemp(prefix=".labelxr-owned-", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        # Hard-link creation is atomic and fails if the destination appeared.
        # No replace/rename fallback on filesystems lacking this capability.
        os.link(temporary, output)
    finally:
        os.unlink(temporary)


def convert_generic(*, pcd_dir, labels, mapping, license_file, attribution, output):
    """Convert explicitly selected inputs; validate all output before publication."""
    pcd_dir = directory(pcd_dir)
    inputs = [(Path(mapping), 128 * 1024, "frame-map.json"), (Path(labels), 2 * 1024 * 1024, "labels.openlabel.json"),
              (Path(license_file), 64 * 1024, "LICENSE.txt"), (Path(attribution), 64 * 1024, "ATTRIBUTION.txt")]
    raw = {name: read(path, limit, name) for path, limit, name in inputs}
    m = frame_map(raw["frame-map.json"])
    records = []
    total = 0
    origin = None
    members = {name: raw[name] for name in ("LICENSE.txt", "ATTRIBUTION.txt")}
    frames = []
    for i, f in enumerate(m["frames"]):
        name = f["pcd"]
        data = read(pcd_dir / name, SOURCE_FRAME_LIMIT, name)
        total += len(data)
        require(total <= SOURCE_TOTAL_LIMIT, name, "file", "Combined source byte limit exceeded.")
        if origin is None:
            _, points = source_points(data, name)
            axes = [[], [], []]
            for point in points:
                for a, value in zip(axes, point):
                    a.append(value)
            origin = [median(axis) for axis in axes]
        value, count = canonical_points(data, name, origin)
        target = f"frames/{i:03}.pcd"
        members[target] = value
        frames.append({"id": f["id"], "timestamp": f["timestamp"], "pcd": target, "pointCount": count, "sha256": digest(value)})
        records.append({"id": f["id"], "timestamp": f["timestamp"], "path": name, "sha256": digest(data), "pointCount": count})
        inputs.append((pcd_dir / name, SOURCE_FRAME_LIMIT, name))
    inventory = {"schemaVersion": "labelxr-input-inventory/v1", "frames": records,
                 "hashes": {name: digest(b) for name, b in raw.items()}}
    source_digest = digest(encoded(inventory))
    members["labels.openlabel.json"], reference = translated_labels(raw["labels.openlabel.json"], frames, origin, inventory)
    manifest = {"schemaVersion": "1.0", "bundleId": str(uuid.uuid5(uuid.NAMESPACE_URL, "labelxr-input-sha256:" + source_digest)),
                "source": {**m["source"], "sha256": source_digest}, "sourceOrigin": origin,
                "units": "meters", "coordinates": "x-y-ground-z-up", "frames": frames,
                "hashes": {name: digest(members[name]) for name in ("labels.openlabel.json", "LICENSE.txt", "ATTRIBUTION.txt")}}
    members["manifest.json"] = encoded(manifest)
    validator.validate_manifest(members["manifest.json"])
    # Reuse the unchanged independent reader for the final member and world-box checks.
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
        for name in ["manifest.json", "labels.openlabel.json", "LICENSE.txt", "ATTRIBUTION.txt", *[f["pcd"] for f in frames]]:
            info = zipfile.ZipInfo(name, (1980, 1, 1, 0, 0, 0))
            info.create_system, info.external_attr = 3, 0o100644 << 16
            archive.writestr(info, members[name])
    data = out.getvalue()
    proof = validator.validate_bundle(data, reference)
    hashes = {**inventory["hashes"], **{r["path"]: r["sha256"] for r in records}}
    for path, limit, name in inputs:
        require(digest(read(path, limit, name)) == hashes[name], name, "sha256", "Source changed during conversion; no output published.")
    publish(output, data)
    return {"schema": "labelxr-generic-conversion/v1", "converted": True, "bundleSha256": proof["bundleSha256"],
            "sourceSha256": source_digest, "frameCount": proof["frameCount"], "pointCount": proof["pointCount"],
            "boxCount": proof["boxCount"], "sourceWorldBoxesChecked": proof["expectedWorldBoxesChecked"],
            "pointWorldToleranceMetres": POINT_TOLERANCE, "rights": proof["rights"]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pcd-dir", required=True)
    parser.add_argument("--labels", required=True)
    parser.add_argument("--frame-map", required=True)
    parser.add_argument("--license", required=True)
    parser.add_argument("--attribution", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        receipt = convert_generic(pcd_dir=args.pcd_dir, labels=args.labels, mapping=args.frame_map,
                                  license_file=args.license, attribution=args.attribution, output=args.out)
    except (ConversionError, validator.ValidationError, OSError, OverflowError, ValueError) as e:
        failure = {"converted": False, "member": getattr(e, "member", "conversion"),
                   "field": getattr(e, "field", "input/output"),
                   "detail": e.detail if hasattr(e, "detail") else "Conversion stopped; input or publication state differs."}
        # Paths from the validator's input reader are replaced by bounded logical names.
        print(json.dumps(failure, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(receipt, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
