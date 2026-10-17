"""Independent, read-only canonical LabelRoom XR validator (Python 3.12+ stdlib).

Run: python validate.py clip.lrx.zip [--expected world-boxes.json]
The optional reference is {schemaVersion: "labelxr-world-boxes/v1", boxes: [
  {frameId, objectId, center: [world x,y,z], size: [x,y,z], yaw: radians}, ...]}.
It must describe every occurrence, including unchanged boxes. It is a trusted
external numerical reference, never approval data read from inside the bundle.
No pickle, network, extraction, correction, dependency install or source writes.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import struct
import sys
from urllib.parse import urlsplit
import zlib

COMPRESSED_LIMIT = 25 * 1024 * 1024
EXPANDED_LIMIT = 40 * 1024 * 1024
JSON_LIMIT = 2 * 1024 * 1024
SHA = re.compile(r"[0-9a-f]{64}\Z")
FRAME_PATH = re.compile(r"frames/[0-9]{3}\.pcd\Z")
REQUIRED = {"manifest.json", "labels.openlabel.json", "LICENSE.txt", "ATTRIBUTION.txt"}
OPTIONAL = {"audit.json", "review.json"}


class ValidationError(ValueError):
    def __init__(self, code, member, field, detail):
        self.code, self.member, self.field = code, member, field
        super().__init__(f"{member} | {field}: {detail}")


def need(ok, member, field, detail, code="SCHEMA"):
    if not ok:
        raise ValidationError(code, member, field, detail)


def finite(v):
    return type(v) in (int, float) and math.isfinite(v)


def text(v, limit):
    return isinstance(v, str) and 0 < len(v.encode("utf-16-le", errors="surrogatepass")) // 2 <= limit and bool(v.replace("\ufeff", "").strip())


def obj(v, member, field, required=(), optional=(), strict=False):
    need(type(v) is dict, member, field, "Expected an object.")
    need(set(required) <= v.keys(), member, field, "Required field missing.")
    if strict:
        need(v.keys() <= set(required) | set(optional), member, field, "Unknown field.")
    return v


def bounded_json(data, member, limit=JSON_LIMIT, depth=32):
    need(len(data) <= limit, member, "file", "JSON byte ceiling exceeded.", "BYTE_LIMIT")
    try:
        need(not data.startswith(b"\xef\xbb\xbf"), member, "file", "JSON BOM is forbidden.", "UTF8")
        decoded = data.decode("utf-8", errors="strict")
    except UnicodeError as e:
        raise ValidationError("UTF8", member, "file", "Invalid UTF-8.") from e
    # Bound nesting before invoking the JSON decoder, including unknown metadata.
    level, string, escaped = 0, False, False
    for c in decoded:
        if string:
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                string = False
        elif c == '"':
            string = True
        elif c in "[{":
            level += 1
            need(level <= depth, member, "file", "JSON nesting ceiling exceeded.", "JSON")
        elif c in "]}":
            level -= 1

    def pairs(items):
        result = {}
        for k, v in items:
            need(k not in result, member, "file", "Duplicate decoded JSON key.", "JSON")
            result[k] = v
        return result

    def constant(_):
        raise ValidationError("JSON", member, "file", "Non-standard JSON number.")

    try:
        value = json.loads(decoded, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, RecursionError) as e:
        if isinstance(e, ValidationError):
            raise
        raise ValidationError("JSON", member, "file", "Invalid JSON.") from e
    queue, nodes = [(value, "document")], 0
    while queue:
        v, where = queue.pop()
        nodes += 1
        need(nodes <= 100000, member, where, "JSON node ceiling exceeded.", "NODE_LIMIT")
        if type(v) in (int, float):
            try:
                ok = finite(v)
            except OverflowError:
                ok = False
            need(ok, member, where, "Expected a finite number.", "NON_FINITE")
        if type(v) is dict:
            queue.extend((x, where + "[" + json.dumps(k, ensure_ascii=True) + "]") for k, x in v.items())
        elif type(v) is list:
            need(len(v) <= 100000 - nodes, member, where, "JSON node ceiling exceeded.", "NODE_LIMIT")
            queue.extend((x, where + f"[{i}]") for i, x in enumerate(v))
        need(nodes + len(queue) <= 100000, member, where, "JSON node ceiling exceeded.", "NODE_LIMIT")
    return value


def member_limit(name):
    return 128 * 1024 if name == "manifest.json" else 64 * 1024 if name in {"LICENSE.txt", "ATTRIBUTION.txt"} else 16384 + 200000 * 12 if FRAME_PATH.fullmatch(name) else JSON_LIMIT


def read_archive(data):
    """ZIP32 preflight, followed by bounded raw-deflate decoding and CRC checks."""
    need(type(data) is bytes and 22 <= len(data) <= COMPRESSED_LIMIT, "archive", "file", "Expected 22 bytes..25 MiB ZIP.", "ZIP")
    end = -1
    for p in range(len(data) - 22, max(-1, len(data) - 65558), -1):
        if data[p:p + 4] == b"PK\x05\x06" and p + 22 + struct.unpack_from("<H", data, p + 20)[0] == len(data):
            end = p
            break
    need(end >= 0, "archive", "directory", "Missing exact ZIP footer.", "ZIP")
    disk, start_disk, on_disk, count, length, directory, _ = struct.unpack_from("<4H2IH", data, end + 4)
    need(disk == start_disk == 0 and on_disk == count and 5 <= count <= 20 and directory + length == end, "archive", "directory", "Unsupported ZIP64, disks, entry count or layout.", "ZIP")
    need(data[max(0, end - 20):end - 16] != b"PK\x06\x07", "archive", "directory", "ZIP64 is unsupported.", "ZIP")
    entries, names, total, p = [], set(), 0, directory

    def extra(at, n, name):
        stop = at + n
        while at < stop:
            need(at + 4 <= stop, name, "extra", "Truncated extra header.", "ZIP")
            tag, size = struct.unpack_from("<HH", data, at)
            at += 4
            need(at + size <= stop and tag not in {1, 0x17, 0x7075, 0x6375, 0x9901}, name, "extra", "Unsupported/truncated ZIP extra.", "ZIP")
            at += size

    for _ in range(count):
        need(p + 46 <= end and data[p:p + 4] == b"PK\x01\x02", "archive", "directory", "Truncated central entry.", "ZIP")
        version, flags, method = struct.unpack_from("<HHH", data, p + 6)
        crc, compressed, size = struct.unpack_from("<III", data, p + 16)
        nl, xl, cl, start = struct.unpack_from("<4H", data, p + 28)
        attributes, local = struct.unpack_from("<II", data, p + 38)
        nxt = p + 46 + nl + xl + cl
        need(nl > 0 and nxt <= end, "archive", "directory", "Truncated member name.", "ZIP")
        raw_name = data[p + 46:p + 46 + nl]
        need(all(32 <= c <= 126 for c in raw_name), "archive", "path", "Member names must be canonical ASCII.", "PATH")
        name = raw_name.decode("ascii")
        need(name in REQUIRED | OPTIONAL or FRAME_PATH.fullmatch(name), name, "path", "Member is outside the exact allowlist.", "PATH")
        need(name not in names, name, "path", "Duplicate member.", "PATH")
        names.add(name)
        total += size
        mode = attributes >> 16
        need(start == 0 and version <= 20 and method in (0, 8) and flags & ~0x080E == 0 and (method != 0 or flags & 6 == 0), name, "header", "Unsupported ZIP version, compression or flags.", "ZIP")
        need((mode & 0o170000) in (0, stat.S_IFREG) and attributes & 0x10 == 0, name, "type", "Only regular members are supported.", "ZIP")
        need(size <= member_limit(name) and total <= EXPANDED_LIMIT and compressed <= COMPRESSED_LIMIT, name, "size", "Member/expanded ceiling exceeded.", "BYTE_LIMIT")
        extra(p + 46 + nl, xl, name)
        need(local + 30 <= directory and data[local:local + 4] == b"PK\x03\x04", name, "local", "Missing local header.", "ZIP")
        lv, lf, lm = struct.unpack_from("<HHH", data, local + 4)
        lc, lz, ls = struct.unpack_from("<III", data, local + 14)
        ln, lx = struct.unpack_from("<HH", data, local + 26)
        offset = local + 30 + ln + lx
        tail = offset + compressed
        need((lv, lf, lm, ln) == (version, flags, method, nl) and offset <= directory and tail <= directory and data[local + 30:local + 30 + ln] == raw_name, name, "local", "Local/central layout or names differ.", "ZIP")
        extra(local + 30 + ln, lx, name)
        if flags & 8:
            need(lc == lz == ls == 0, name, "descriptor", "Descriptor local sizes must be zero.", "ZIP")
            d = tail + (4 if data[tail:tail + 4] == b"PK\x07\x08" else 0)
            need(d + 12 <= directory and struct.unpack_from("<III", data, d) == (crc, compressed, size), name, "descriptor", "Descriptor differs.", "ZIP")
            tail = d + 12
        else:
            need((lc, lz, ls) == (crc, compressed, size), name, "local", "Local CRC/sizes differ.", "ZIP")
        need(method != 0 or compressed == size, name, "size", "Stored size differs.", "ZIP")
        entries.append((name, local, tail, offset, compressed, size, method, crc))
        p = nxt
    need(p == end and REQUIRED <= names and 1 <= sum(bool(FRAME_PATH.fullmatch(n)) for n in names) <= 10, "archive", "members", "Directory size or required member set differs.", "ZIP")
    cursor = 0
    for e in sorted(entries, key=lambda v: v[1]):
        need(e[1] == cursor, e[0], "local", "Overlapping, prefixed or hidden member bytes.", "ZIP")
        cursor = e[2]
    need(cursor == directory, "archive", "local", "Unrecorded file-area bytes.", "ZIP")
    members, actual_total = {}, 0
    for name, _, _, offset, compressed, size, method, crc in entries:
        raw = data[offset:offset + compressed]
        if method == 0:
            value = raw
        else:
            decoder, chunks, produced = zlib.decompressobj(-15), [], 0
            try:
                for at in range(0, len(raw), 1024):
                    chunk = decoder.decompress(raw[at:at + 1024], min(size, member_limit(name)) - produced + 1)
                    produced += len(chunk)
                    need(produced <= size and produced <= member_limit(name), name, "inflate", "Actual inflated size exceeds its bound.", "BYTE_LIMIT")
                    need(not decoder.unconsumed_tail and not decoder.unused_data, name, "inflate", "Trailing or unconsumed deflate data.", "ZIP")
                    chunks.append(chunk)
                need(decoder.eof, name, "inflate", "Truncated deflate stream.", "ZIP")
                value = b"".join(chunks)
            except zlib.error as e:
                raise ValidationError("ZIP", name, "inflate", "Invalid deflate stream.") from e
        actual_total += len(value)
        need(len(value) == size and actual_total <= EXPANDED_LIMIT and zlib.crc32(value) & 0xFFFFFFFF == crc, name, "CRC/size", "Expanded size or CRC differs.", "ZIP")
        members[name] = value
    return members


def validate_manifest(data):
    m = bounded_json(data, "manifest.json", 128 * 1024, 16)
    obj(m, "manifest.json", "manifest", ("schemaVersion", "bundleId", "source", "sourceOrigin", "units", "coordinates", "frames", "hashes"), strict=True)
    need(m["schemaVersion"] == "1.0" and m["units"] == "meters" and m["coordinates"] == "x-y-ground-z-up", "manifest.json", "format", "Unsupported schema, units or coordinates.")
    need(isinstance(m["bundleId"], str) and re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", m["bundleId"]), "manifest.json", "bundleId", "Expected a UUID.")
    source = obj(m["source"], "manifest.json", "source", ("name", "kind", "url", "licence", "attribution", "sha256"), strict=True)
    for key, length in (("name", 1024), ("licence", 1024), ("attribution", 4096)):
        need(text(source[key], length), "manifest.json", "source." + key, "Expected a meaningful bounded declaration.")
    need(source["kind"] in ("real", "synthetic-test") and isinstance(source["sha256"], str) and SHA.fullmatch(source["sha256"]), "manifest.json", "source", "Invalid kind or declared source digest.")
    url = source["url"]
    try:
        parts = urlsplit(url) if isinstance(url, str) else None
        url_ok = (url == "" and source["kind"] == "synthetic-test") or (isinstance(url, str) and len(url) <= 2048 and url == url.strip() and not any(ord(c) < 33 for c in url) and parts.scheme in ("http", "https") and parts.hostname and parts.username is None and parts.password is None and (parts.port is None or 0 <= parts.port <= 65535))
    except ValueError:
        url_ok = False
    need(url_ok, "manifest.json", "source.url", "Expected HTTP(S) provenance without credentials.")
    need(type(m["sourceOrigin"]) is list and len(m["sourceOrigin"]) == 3 and all(finite(x) for x in m["sourceOrigin"]), "manifest.json", "sourceOrigin", "Expected three finite world coordinates.")
    frames = m["frames"]
    need(type(frames) is list and 1 <= len(frames) <= 10, "manifest.json", "frames", "Expected 1..10 frames.")
    ids, paths, previous = set(), set(), -math.inf
    for i, f in enumerate(frames):
        field = f"frames[{i}]"
        obj(f, "manifest.json", field, ("id", "timestamp", "pcd", "sha256", "pointCount"), strict=True)
        need(text(f["id"], 128) and f["id"] not in ids, "manifest.json", field + ".id", "Invalid or duplicate frame ID.")
        need(isinstance(f["pcd"], str) and FRAME_PATH.fullmatch(f["pcd"]) and f["pcd"] not in paths, "manifest.json", field + ".pcd", "Invalid or duplicate point path.")
        need(finite(f["timestamp"]) and f["timestamp"] > previous, "manifest.json", field + ".timestamp", "Timestamps must be finite and strictly increasing.")
        need(finite(f["pointCount"]) and 1 <= f["pointCount"] <= 200000 and int(f["pointCount"]) == f["pointCount"], "manifest.json", field + ".pointCount", "Expected 1..200000 integer points.")
        need(isinstance(f["sha256"], str) and SHA.fullmatch(f["sha256"]), "manifest.json", field + ".sha256", "Expected lowercase SHA-256.")
        ids.add(f["id"]); paths.add(f["pcd"]); previous = f["timestamp"]
    hashes = obj(m["hashes"], "manifest.json", "hashes", REQUIRED - {"manifest.json"}, OPTIONAL, strict=True)
    need(all(isinstance(v, str) and SHA.fullmatch(v) for v in hashes.values()), "manifest.json", "hashes", "Expected lowercase SHA-256.")
    return m


def validate_pcd(data, name, expected):
    keys = ["VERSION", "FIELDS", "SIZE", "TYPE", "COUNT", "WIDTH", "HEIGHT", "VIEWPOINT", "POINTS", "DATA"]
    rows, cursor = {}, 0
    while len(rows) < 10:
        end = data.find(b"\n", cursor, 16384)
        need(end >= 0, name, "header", "Missing newline or header exceeds 16 KiB.", "PCD")
        raw = data[cursor:end]; cursor = end + 1
        need(all(c in (9, 13) or 32 <= c <= 126 for c in raw), name, "header", "Expected ASCII header.", "PCD")
        if raw.endswith(b"\r"):
            raw = raw[:-1]
        need(b"\r" not in raw, name, "header", "Unexpected carriage return.", "PCD")
        line = raw.decode("ascii").strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"[ \t]+", line)
        need(parts[0] == keys[len(rows)], name, "header", "Duplicate or noncanonical header order.", "PCD")
        rows[parts[0]] = " ".join(parts[1:])
    need(rows["VERSION"] in ("0.7", ".7"), name, "VERSION", "Unsupported PCD version.", "PCD")
    for k, v in {"FIELDS": "x y z", "SIZE": "4 4 4", "TYPE": "F F F", "COUNT": "1 1 1", "HEIGHT": "1", "VIEWPOINT": "0 0 0 1 0 0 0", "DATA": "binary"}.items():
        need(rows[k] == v, name, k, "Unsupported canonical XYZ layout.", "PCD")
    need(all(re.fullmatch(r"[0-9]+", rows[k]) and len(rows[k].lstrip("0")) <= 6 for k in ("WIDTH", "POINTS")), name, "POINTS", "Invalid or excessive decimal count.", "PCD")
    count = int(rows["POINTS"].lstrip("0") or "0")
    need(1 <= count <= 200000 and int(rows["WIDTH"].lstrip("0") or "0") == count == expected and len(data) - cursor == count * 12, name, "POINTS/payload", "Count or exact payload size differs.", "PCD")
    lo, hi = [math.inf] * 3, [-math.inf] * 3
    for i, point in enumerate(struct.iter_unpack("<fff", memoryview(data)[cursor:])):
        for axis, x in enumerate(point):
            need(math.isfinite(x) and abs(x) <= 250, name, f"point[{i}].{'xyz'[axis]}", "Nonfinite or out-of-range coordinate.", "PCD")
            lo[axis], hi[axis] = min(lo[axis], x), max(hi[axis], x)
    return {"pointCount": count, "localBounds": [lo, hi]}


def validate_labels(data, manifest):
    name = "labels.openlabel.json"
    document = bounded_json(data, name)
    ol = obj(obj(document, name, "document", ("openlabel",))["openlabel"], name, "openlabel", ("metadata", "frames"))
    need(obj(ol["metadata"], name, "metadata", ("schema_version",))["schema_version"] == "1.0.0", name, "metadata.schema_version", "Unsupported OpenLABEL schema.")
    globals = obj(ol.get("objects", {}), name, "openlabel.objects")
    need(len(globals) <= 1000, name, "openlabel.objects", "More than 1000 global objects.")
    for key, v in globals.items():
        need(text(key, 128), name, "objects", "Invalid object ID.")
        obj(v, name, f"objects[{key!r}]", ("type",))
        need(text(v["type"], 1024) and ("name" not in v or isinstance(v["name"], str) and len(v["name"]) <= 1024), name, f"objects[{key!r}]", "Invalid class or name.")
    frames = obj(ol["frames"], name, "openlabel.frames")
    need(frames.keys() == {f["id"] for f in manifest["frames"]}, name, "openlabel.frames", "Frame set differs from manifest.")
    result = []
    for expected in manifest["frames"]:
        fid = expected["id"]; field = f"openlabel.frames[{fid!r}]"
        f = obj(frames[fid], name, field, ("frame_properties",))
        props = obj(f["frame_properties"], name, field + ".frame_properties", ("timestamp",))
        need(finite(props["timestamp"]) and props["timestamp"] == expected["timestamp"], name, field + ".timestamp", "Timestamp differs from manifest.")
        objects = obj(f.get("objects", {}), name, field + ".objects")
        need(len(objects) <= 100, name, field + ".objects", "More than 100 labels.")
        for oid, occurrence in objects.items():
            op = field + f".objects[{oid!r}]"
            need(oid in globals, name, op, "Missing global object reference.")
            cuboids = obj(obj(occurrence, name, op, ("object_data",))["object_data"], name, op + ".object_data", ("cuboid",))["cuboid"]
            need(type(cuboids) is list and len(cuboids) == 1, name, op, "Expected exactly one cuboid.")
            c = obj(cuboids[0], name, op + ".cuboid[0]", ("name", "val")); v = c["val"]
            need(c["name"] == "bbox" and type(v) is list and len(v) == 10 and all(finite(x) for x in v), name, op + ".val", "Expected finite XYZ/xyzw/size bbox.")
            need(all(abs(x) <= 250 for x in v[:3]) and all(0.05 <= x <= 50 for x in v[7:]), name, op + ".val", "Box center or dimensions exceed limits.")
            x, y, z, w = v[3:7]
            need(abs(math.hypot(x, y, z, w) - 1) <= 1e-4 and abs(x) <= 1e-4 and abs(y) <= 1e-4, name, op + ".quaternion", "Expected normalized upright xyzw quaternion.")
            # Independent scalar formula; no frontend geometry is imported.
            raw_yaw = 2 * math.atan2(z, w)
            yaw = math.atan2(math.sin(raw_yaw), math.cos(raw_yaw))
            center = [v[i] + manifest["sourceOrigin"][i] for i in range(3)]
            need(all(finite(x) for x in center), name, op + ".worldCenter", "World reconstruction overflow.")
            result.append({"frameId": fid, "objectId": oid, "center": center, "size": v[7:], "yaw": yaw})
    return result


def compare_reference(boxes, expected_bytes):
    reference = bounded_json(expected_bytes, "expected-world-boxes.json")
    obj(reference, "expected-world-boxes.json", "reference", ("schemaVersion", "boxes"), strict=True)
    need(reference["schemaVersion"] == "labelxr-world-boxes/v1" and type(reference["boxes"]) is list and len(reference["boxes"]) <= 1000, "expected-world-boxes.json", "boxes", "Unsupported bounded reference.", "REFERENCE")
    actual = {(b["frameId"], b["objectId"]): b for b in boxes}; seen = set()
    for b in reference["boxes"]:
        obj(b, "expected-world-boxes.json", "box", ("frameId", "objectId", "center", "size", "yaw"), strict=True)
        need(text(b["frameId"], 128) and text(b["objectId"], 128), "expected-world-boxes.json", "box", "Invalid reference IDs.", "REFERENCE")
        key = b["frameId"], b["objectId"]
        need(key in actual and key not in seen, "expected-world-boxes.json", repr(key), "Missing or duplicate occurrence.", "REFERENCE")
        for k in ("center", "size"):
            need(type(b[k]) is list and len(b[k]) == 3 and all(finite(x) for x in b[k]) and all(abs(a - e) <= 1e-5 for a, e in zip(actual[key][k], b[k])), "expected-world-boxes.json", repr(key) + "." + k, "World reference differs beyond 1e-5 metres.", "REFERENCE")
        need(finite(b["yaw"]) and abs(math.atan2(math.sin(actual[key]["yaw"] - b["yaw"]), math.cos(actual[key]["yaw"] - b["yaw"]))) <= 1e-5, "expected-world-boxes.json", repr(key) + ".yaw", "Yaw differs beyond 1e-5 radians.", "REFERENCE")
        seen.add(key)
    need(seen == actual.keys(), "expected-world-boxes.json", "boxes", "Reference must cover every occurrence.", "REFERENCE")


def validate_bundle(data, expected_bytes=None):
    members = read_archive(data)
    manifest = validate_manifest(members["manifest.json"])
    wanted = {**manifest["hashes"], **{f["pcd"]: f["sha256"] for f in manifest["frames"]}}
    need(members.keys() == wanted.keys() | {"manifest.json"}, "manifest.json", "members", "Declared and actual member sets differ.", "MEMBER_SET")
    hashes = {name: hashlib.sha256(value).hexdigest() for name, value in members.items()}
    for name, expected in wanted.items():
        need(hashes[name] == expected, name, "sha256", "Member SHA-256 differs.", "HASH")
    # Hash all members before dependent semantic parsing.
    for name in ("LICENSE.txt", "ATTRIBUTION.txt"):
        try:
            value = members[name].decode("utf-8-sig", errors="strict")
        except UnicodeError as e:
            raise ValidationError("RIGHTS", name, "text", "Invalid UTF-8 rights text.") from e
        need(bool(value.replace("\ufeff", "").strip()) and not re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", value), name, "text", "Expected nonempty rights text without controls.", "RIGHTS")
    frames = [{"id": f["id"], **validate_pcd(members[f["pcd"]], f["pcd"], f["pointCount"])} for f in manifest["frames"]]
    boxes = validate_labels(members["labels.openlabel.json"], manifest)
    for name in OPTIONAL & members.keys():
        bounded_json(members[name], name)  # Historical data only; never authority.
    if expected_bytes is not None:
        compare_reference(boxes, expected_bytes)
    return {"schema": "labelxr-independent-validation/v1", "valid": True, "bundleSha256": hashlib.sha256(data).hexdigest(), "declaredSourceSha256": manifest["source"]["sha256"], "sourceKind": manifest["source"]["kind"], "memberHashes": hashes, "frameCount": len(frames), "pointCount": sum(f["pointCount"] for f in frames), "boxCount": len(boxes), "frames": frames, "worldBoxes": boxes, "expectedWorldBoxesChecked": expected_bytes is not None, "rights": "declarations validated; external rights evidence not adjudicated"}


def read_regular(path, limit):
    p = Path(os.path.abspath(path))
    for ancestor in [p, *p.parents]:
        s = ancestor.lstat()
        need(not stat.S_ISLNK(s.st_mode) and not getattr(s, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400), str(p), "path", "Redirected input path.", "INPUT")
    s = p.stat()
    need(stat.S_ISREG(s.st_mode) and s.st_size <= limit, str(p), "file", "Expected bounded regular file.", "INPUT")
    with p.open("rb") as stream:
        value = stream.read(limit + 1)
    need(len(value) <= limit, str(p), "file", "Input changed or exceeds byte limit.", "INPUT")
    return value


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle")
    parser.add_argument("--expected", help="Independent complete world-space box reference JSON")
    args = parser.parse_args(argv)
    try:
        result = validate_bundle(read_regular(args.bundle, COMPRESSED_LIMIT), read_regular(args.expected, JSON_LIMIT) if args.expected else None)
        # Default terminal receipt omits point coordinates and individual labels.
        print(json.dumps({k: v for k, v in result.items() if k not in {"worldBoxes", "frames"}}, ensure_ascii=True, allow_nan=False, sort_keys=True))
        return 0
    except (ValidationError, OSError) as e:
        print(json.dumps({"schema": "labelxr-independent-validation/v1", "valid": False, "code": getattr(e, "code", "IO"), "member": getattr(e, "member", str(args.bundle)), "field": getattr(e, "field", "file"), "error": str(e)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
