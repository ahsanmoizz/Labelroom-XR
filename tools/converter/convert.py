"""Deterministic generic XYZ PCD/OpenLABEL conversion. Python 3.12+ stdlib only.

Inputs must explicitly declare metres, registered common world coordinates and
little-endian binary data. Only upright bbox cuboids and XYZ float32 PCD layouts
are supported. The restricted PandaSet reader decodes reviewed protocol-3 table
records without executing targets. No registration, sampling or rights inference.
"""
import argparse
import pickletools
import zlib
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


# LABELXR-PANDASET-RESTRICTED-READER-v1
# These are inert records. Serialized symbols are never imported, resolved,
# instantiated or called. Only the reviewed protocol-3 legacy layout is read.
class _PandaRecord:
    __slots__ = ('kind', 'value', 'state')

    def __init__(self, kind, value=None):
        self.kind, self.value, self.state = kind, value, None


_PANDA_SYMBOLS = frozenset((
    'pandas.core.frame DataFrame', 'pandas.core.internals.managers BlockManager',
    'pandas.core.indexes.base _new_Index', 'pandas.core.indexes.base Index',
    'pandas.core.indexes.range RangeIndex', 'numpy.core.multiarray _reconstruct',
    'numpy ndarray', 'numpy dtype', 'builtins slice'))


def _panda_check(ok, detail):
    require(ok, 'pandaset', 'restricted-layout', detail)


def _panda_symbol(value, name):
    return type(value) is _PandaRecord and value.kind == 'symbol' and value.value == name


def _panda_reduce(symbol, args):
    _panda_check(type(symbol) is _PandaRecord and symbol.kind == 'symbol' and
                 type(args) is tuple, 'Unexpected inert reduction declaration.')
    name = symbol.value
    if name == 'numpy.core.multiarray _reconstruct':
        _panda_check(len(args) == 3 and _panda_symbol(args[0], 'numpy ndarray') and
                     args[1] == (0,) and args[2] == b'b', 'Unsupported ndarray declaration.')
        return _PandaRecord('array')
    if name == 'numpy dtype':
        _panda_check(len(args) == 3 and args[0] in ('f8', 'i8', 'b1', 'O8') and
                     type(args[0]) is str and type(args[1]) is int and args[1] == 0 and
                     type(args[2]) is int and args[2] == 1, 'Unsupported dtype declaration.')
        return _PandaRecord('dtype', args[0])
    if name == 'pandas.core.indexes.base _new_Index':
        _panda_check(len(args) == 2 and type(args[1]) is dict, 'Unsupported index declaration.')
        if _panda_symbol(args[0], 'pandas.core.indexes.base Index'):
            return _PandaRecord('index', args[1])
        _panda_check(_panda_symbol(args[0], 'pandas.core.indexes.range RangeIndex'),
                     'Unsupported index symbol.')
        return _PandaRecord('range', args[1])
    if name == 'builtins slice':
        _panda_check(len(args) == 3 and all(type(v) is int and 0 <= v <= 1024 for v in args)
                     and args[2] > 0, 'Unsupported block slice declaration.')
        return _PandaRecord('slice', args)
    _panda_check(False, 'Serialized call target is unsupported; nothing was executed.')


def _panda_graph(value):
    active, complete = set(), set()

    def visit(v, depth):
        _panda_check(depth <= 32, 'Serialized graph exceeds the nesting limit.')
        if type(v) in (type(None), bool, int, float, str, bytes):
            return
        identity = id(v)
        _panda_check(identity not in active, 'Cyclic serialized graphs are unsupported.')
        if identity in complete:
            return
        active.add(identity)
        if type(v) is _PandaRecord:
            visit(v.value, depth + 1); visit(v.state, depth + 1)
        elif type(v) in (tuple, list):
            _panda_check(len(v) <= 4096, 'Serialized container exceeds the item limit.')
            for child in v:
                visit(child, depth + 1)
        else:
            _panda_check(type(v) is dict and len(v) <= 4096, 'Unexpected serialized container.')
            for key, child in v.items():
                _panda_check(type(key) is str and len(key) <= 4096, 'Unexpected serialized key.')
                visit(child, depth + 1)
        active.remove(identity); complete.add(identity)
    visit(value, 0)


def _panda_stream(raw):
    allowed = frozenset(('PROTO GLOBAL BINPUT LONG_BINPUT EMPTY_TUPLE NEWOBJ EMPTY_DICT MARK '
        'BINUNICODE EMPTY_LIST BININT1 BININT2 TUPLE1 SHORT_BINBYTES TUPLE3 REDUCE NONE BININT '
        'TUPLE BUILD NEWFALSE NEWTRUE APPENDS SETITEMS TUPLE2 BINGET LONG_BINGET BINBYTES '
        'APPEND SETITEM STOP BINFLOAT').split())
    stack, memo, marker, count = [], {}, object(), 0

    def pop():
        _panda_check(bool(stack) and stack[-1] is not marker, 'Serialized stack underflow.')
        return stack.pop()

    def marked():
        values = []
        while stack and stack[-1] is not marker:
            values.append(stack.pop())
        _panda_check(bool(stack), 'Serialized mark is missing.')
        stack.pop(); values.reverse()
        return values

    def set_pairs(target, values):
        _panda_check(type(target) is dict and len(values) % 2 == 0,
                     'Unexpected serialized dictionary operation.')
        for i in range(0, len(values), 2):
            key = values[i]
            _panda_check(type(key) is str and len(key) <= 4096 and key not in target,
                         'Repeated or unsupported serialized dictionary key.')
            target[key] = values[i + 1]
        _panda_check(len(target) <= 4096, 'Serialized dictionary is too large.')

    try:
        for opcode, argument, offset in pickletools.genops(raw):
            name = opcode.name; count += 1
            _panda_check(count <= 100000 and name in allowed and len(stack) <= 4096,
                         'Unsupported opcode or serialized resource limit.')
            if count == 1:
                _panda_check(name == 'PROTO' and argument == 3 and offset == 0,
                             'Only the reviewed protocol-3 layout is supported.')
                continue
            _panda_check(name != 'PROTO', 'Repeated protocol declaration.')
            if name == 'STOP':
                _panda_check(offset == len(raw) - 1 and len(stack) == 1,
                             'Trailing bytes or unresolved serialized stack.')
                _panda_graph(stack[0]); return stack[0]
            if name == 'MARK': stack.append(marker)
            elif name == 'GLOBAL':
                _panda_check(argument in _PANDA_SYMBOLS, 'Unsupported serialized symbol; no target was resolved.')
                stack.append(_PandaRecord('symbol', argument))
            elif name in ('BINPUT', 'LONG_BINPUT'):
                _panda_check(stack and stack[-1] is not marker and type(argument) is int and
                             0 <= argument < 4096 and argument not in memo, 'Invalid or repeated memo slot.')
                memo[argument] = stack[-1]
            elif name in ('BINGET', 'LONG_BINGET'):
                _panda_check(argument in memo, 'Serialized memo reference is missing.')
                stack.append(memo[argument])
            elif name == 'EMPTY_TUPLE': stack.append(())
            elif name == 'EMPTY_DICT': stack.append({})
            elif name == 'EMPTY_LIST': stack.append([])
            elif name in ('BINUNICODE', 'BININT1', 'BININT2', 'BININT', 'BINBYTES', 'SHORT_BINBYTES', 'BINFLOAT'):
                _panda_check(not isinstance(argument, str) or len(argument) <= 4096, 'Serialized text exceeds the limit.')
                stack.append(argument)
            elif name == 'NONE': stack.append(None)
            elif name == 'NEWFALSE': stack.append(False)
            elif name == 'NEWTRUE': stack.append(True)
            elif name.startswith('TUPLE'):
                if name == 'TUPLE': values = marked()
                else:
                    n = int(name[-1]); values = [pop() for _ in range(n)][::-1]
                stack.append(tuple(values))
            elif name == 'NEWOBJ':
                args, symbol = pop(), pop()
                _panda_check(type(args) is tuple and args == () and
                             (_panda_symbol(symbol, 'pandas.core.frame DataFrame') or
                              _panda_symbol(symbol, 'pandas.core.internals.managers BlockManager')),
                             'Unsupported object declaration; no object was instantiated.')
                stack.append(_PandaRecord('frame' if symbol.value.endswith('DataFrame') else 'manager'))
            elif name == 'REDUCE':
                args, symbol = pop(), pop(); stack.append(_panda_reduce(symbol, args))
            elif name == 'BUILD':
                state = pop()
                _panda_check(stack and type(stack[-1]) is _PandaRecord and
                             stack[-1].kind in ('array', 'dtype', 'frame', 'manager') and
                             stack[-1].state is None, 'Unsupported or repeated state declaration.')
                stack[-1].state = state
            elif name in ('APPEND', 'APPENDS'):
                values = [pop()] if name == 'APPEND' else marked()
                _panda_check(stack and type(stack[-1]) is list and len(stack[-1]) + len(values) <= 4096,
                             'Unexpected list operation or excessive container.')
                stack[-1].extend(values)
            elif name in ('SETITEM', 'SETITEMS'):
                if name == 'SETITEM':
                    value, key = pop(), pop(); values = [key, value]
                else: values = marked()
                _panda_check(bool(stack), 'Missing serialized dictionary.')
                set_pairs(stack[-1], values)
    except (IndexError, KeyError, TypeError, ValueError, OverflowError) as error:
        if isinstance(error, ConversionError): raise
        raise ConversionError('pandaset', 'restricted-layout', 'Malformed bounded protocol-3 stream.') from None
    _panda_check(False, 'Complete serialized stop marker is missing.')


def _panda_array(value):
    _panda_check(type(value) is _PandaRecord and value.kind == 'array' and
                 type(value.state) is tuple and len(value.state) == 5, 'Missing inert ndarray state.')
    version, shape, dtype, fortran, payload = value.state
    _panda_check(type(version) is int and version == 1 and type(shape) is tuple and
                 1 <= len(shape) <= 2 and all(type(n) is int and 0 <= n <= 200000 for n in shape) and
                 math.prod(shape) <= 1200000 and type(fortran) is bool and not fortran,
                 'Unsupported ndarray shape, version or storage order.')
    _panda_check(type(dtype) is _PandaRecord and dtype.kind == 'dtype' and dtype.value in ('f8', 'i8', 'b1', 'O8'),
                 'Unsupported inert dtype state.')
    code = dtype.value; order = '|' if code in ('b1', 'O8') else '<'
    _panda_check(dtype.state == (3, order, None, None, None, -1, -1, 63 if code == 'O8' else 0),
                 'Unsupported dtype byte order, fields or flags.')
    size = math.prod(shape)
    if code == 'O8':
        _panda_check(type(payload) is list and len(payload) == size and size <= 4096 and
                     all(type(v) in (str, int, float, bool, type(None)) for v in payload),
                     'Unsupported object-array payload; only inert scalar cells are supported.')
        _panda_check(all(type(v) is not str or len(v) <= 4096 for v in payload), 'Excessive object-array text.')
    else:
        _panda_check(type(payload) is bytes and len(payload) == size * (1 if code == 'b1' else 8),
                     'Numeric ndarray byte length differs from its shape.')
        if code == 'b1':
            _panda_check(all(v in (0, 1) for v in payload), 'Invalid boolean payload byte.')
    return shape, code, payload


def _panda_values(value):
    shape, code, payload = _panda_array(value)
    if code == 'O8': return tuple(payload)
    return struct.unpack('<' + str(math.prod(shape)) + {'f8':'d', 'i8':'q', 'b1':'?'}[code], payload)


def _panda_index(value):
    _panda_check(type(value) is _PandaRecord and value.kind == 'index' and type(value.value) is dict and
                 set(value.value) == {'data', 'name'} and value.value['name'] is None,
                 'Unsupported column index state.')
    shape, code, _ = _panda_array(value.value['data'])
    names = _panda_values(value.value['data'])
    _panda_check(len(shape) == 1 and code == 'O8' and 1 <= len(names) <= 32 and
                 all(type(n) is str and 0 < len(n) <= 128 for n in names) and len(set(names)) == len(names),
                 'Expected unique bounded literal column names.')
    return names


def read_pandaset_table(data, kind):
    """Decode the reviewed legacy PandaSet table; never invoke pickle targets.

    Returns immutable column tuples, keeping all cells/columns and row order.
    This reader does not convert coordinates, choose sensors, merge duplicate
    labels, infer provenance, or pass application/browser acceptance gates.
    """
    _panda_check(type(data) is bytes and 0 < len(data) <= 8 * 1024 * 1024 and
                 kind in ('points', 'cuboids'), 'Expected a bounded selected PandaSet member.')
    try:
        inflater = zlib.decompressobj(31)
        raw = inflater.decompress(data, 16 * 1024 * 1024 + 1)
        _panda_check(len(raw) <= 16 * 1024 * 1024 and inflater.eof and
                     not inflater.unused_data and not inflater.unconsumed_tail,
                     'Expected one complete gzip member within the inflated byte limit.')
    except zlib.error:
        raise ConversionError('pandaset', 'gzip', 'Malformed bounded gzip stream.') from None
    root = _panda_stream(raw)
    _panda_check(type(root) is _PandaRecord and root.kind == 'frame' and type(root.state) is dict and
                 set(root.state) == {'_data', '_typ', '_metadata', 'attrs'} and root.state['_typ'] == 'dataframe'
                 and root.state['_metadata'] == [] and root.state['attrs'] == {},
                 'Unsupported frame metadata layout; nothing will be silently discarded.')
    manager = root.state['_data']
    _panda_check(type(manager) is _PandaRecord and manager.kind == 'manager' and
                 type(manager.state) is tuple and len(manager.state) == 4, 'Unsupported legacy manager layout.')
    axes, arrays, items, extra = manager.state
    _panda_check(type(axes) is list and len(axes) == 2 and type(arrays) is list and type(items) is list and
                 1 <= len(arrays) == len(items) <= 32 and type(extra) is dict and set(extra) == {'0.14.1'},
                 'Legacy manager sections differ.')
    names = _panda_index(axes[0]); index = axes[1]
    _panda_check(type(index) is _PandaRecord and index.kind == 'range' and type(index.value) is dict and
                 set(index.value) == {'name', 'start', 'stop', 'step'} and index.value['name'] in (None, 'index') and
                 type(index.value['start']) is int and index.value['start'] == 0 and
                 type(index.value['step']) is int and index.value['step'] == 1 and type(index.value['stop']) is int,
                 'Expected a contiguous unfiltered source row index.')
    rows = index.value['stop']
    _panda_check((1 <= rows <= 200000) if kind == 'points' else (0 <= rows <= 100),
                 'Source row count exceeds product limits; no rows will be removed.')
    newer = extra['0.14.1']
    _panda_check(type(newer) is dict and set(newer) == {'axes', 'blocks'} and newer['axes'] is axes and
                 type(newer['blocks']) is list and len(newer['blocks']) == len(arrays),
                 'Redundant manager declarations disagree.')
    columns = {}; dtypes = {}
    for array, labels, block in zip(arrays, items, newer['blocks']):
        _panda_check(type(block) is dict and set(block) == {'values', 'mgr_locs'} and block['values'] is array,
                     'Redundant block value declarations disagree.')
        locations = block['mgr_locs']
        if type(locations) is _PandaRecord and locations.kind == 'slice':
            positions = tuple(range(*locations.value))
        else:
            shape, code, _ = _panda_array(locations)
            _panda_check(len(shape) == 1 and code == 'i8', 'Unsupported block placement array.')
            positions = _panda_values(locations)
        _panda_check(1 <= len(positions) <= 32 and len(set(positions)) == len(positions) and
                     all(type(p) is int and 0 <= p < len(names) for p in positions), 'Invalid block placement.')
        block_names = _panda_index(labels)
        _panda_check(block_names == tuple(names[p] for p in positions), 'Redundant block column declarations disagree.')
        shape, code, _ = _panda_array(array)
        _panda_check(shape == (len(positions), rows), 'Block dimensions disagree with row/column declarations.')
        values = _panda_values(array)
        for i, name in enumerate(block_names):
            _panda_check(name not in columns, 'Column appears in multiple blocks.')
            columns[name] = values[i * rows:(i + 1) * rows]; dtypes[name] = code
    _panda_check(set(columns) == set(names), 'Source columns are missing from the blocks.')
    if kind == 'points':
        _panda_check(names == ('x', 'y', 'z', 'i', 't', 'd') and
                     all(dtypes[n] == 'f8' for n in names[:-1]) and dtypes['d'] == 'i8',
                     'Unsupported PandaSet point-column layout.')
        _panda_check(all(math.isfinite(v) for n in names[:-1] for v in columns[n]) and
                     all(v in (0, 1) for v in columns['d']), 'Nonfinite point cell or unsupported sensor identifier.')
    else:
        geometry = ('yaw', 'position.x', 'position.y', 'position.z', 'dimensions.x', 'dimensions.y', 'dimensions.z')
        _panda_check({'uuid', 'label', *geometry} <= set(names), 'Required cuboid columns are missing.')
        _panda_check(all(dtypes[n] == 'f8' and all(math.isfinite(v) for v in columns[n]) for n in geometry),
                     'Cuboid geometry requires finite float64 source cells.')
        _panda_check(all(validator.text(v, 128) for n in ('uuid', 'label') for v in columns[n]) and
                     all(0.05 <= v <= 50 for n in geometry[-3:] for v in columns[n]),
                     'Unsupported cuboid identifiers, labels or dimensions.')
    return {'kind': kind, 'layout': 'pandaset-protocol3-legacy-blockmanager/v1', 'rowCount': rows,
            'columnNames': names, 'columns': {n: columns[n] for n in names}, 'dtypes': dtypes,
            'indexName': index.value['name'], 'targetsExecuted': False, 'dataframesConstructed': False}


# LABELXR-PANDASET-CONVERTER-v1
def _pandaset_cell(value):
    """Lossless scalar metadata; preserve nonfinite raw attributes as IEEE bits."""
    if type(value) is float:
        return {'type': 'float64-le', 'bits': struct.pack('<d', value).hex()}
    require(type(value) in (str, bool, int, type(None)), 'pandaset', 'metadata',
            'Unsupported raw annotation scalar; nothing will be discarded.')
    return {'type': {str: 'str', bool: 'bool', int: 'int', type(None): 'none'}[type(value)], 'value': value}


def _pandaset_origin(raw, frame_ids, poses):
    low, high = [math.inf] * 3, [-math.inf] * 3
    for fid in frame_ids:
        for kind, name, columns in [('points', f'lidar/{fid}.pkl.gz', ('x', 'y', 'z')),
                ('cuboids', f'annotations/cuboids/{fid}.pkl.gz', ('position.x', 'position.y', 'position.z'))]:
            table = read_pandaset_table(raw[name], kind)
            for axis, column in enumerate(columns):
                for value in table['columns'][column]:
                    low[axis] = min(low[axis], value); high[axis] = max(high[axis], value)
    first_pose = poses[int(frame_ids[0])]
    validator.obj(first_pose, 'poses.json', 'pose', ('position', 'heading'), strict=True)
    for key, names in [('position', ('x', 'y', 'z')), ('heading', ('w', 'x', 'y', 'z'))]:
        validator.obj(first_pose[key], 'poses.json', key, names, strict=True)
        require(all(validator.finite(first_pose[key][n]) for n in names), 'poses.json', key, 'Nonfinite pose.')
    require(abs(math.hypot(*first_pose['heading'].values()) - 1) <= 1e-4,
            'poses.json', 'heading', 'Expected a normalized pose quaternion; it is not applied to world points.')
    origin = [first_pose['position'][a] for a in ('x', 'y', 'z')]
    fits = lambda o: all(math.isfinite(v) and max(abs(l-v), abs(h-v)) <= 250 for l,h,v in zip(low,high,o))
    strategy = 'first-selected-lidar-pose'
    if not fits(origin):
        origin = [l / 2 + h / 2 for l,h in zip(low,high)]
        strategy = 'common-clip-bounds-midpoint'
    require(fits(origin), 'pandaset', 'sourceOrigin',
            'The complete selected clip cannot fit the unchanged 250 metre bounds; no rows or frames removed.')
    return origin, {'strategy': strategy, 'firstSelectedPosePosition': [first_pose['position'][a] for a in ('x','y','z')],
                    'worldMinimum': low, 'worldMaximum': high, 'coordinatesRotated': False, 'boundMetres': 250}


def _pandaset_points(table, origin):
    count = table['rowCount']; columns = table['columns']
    out = bytearray(('VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n'
                     f'WIDTH {count}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {count}\nDATA binary\n').encode())
    for i in range(count):
        world = [columns[a][i] for a in ('x', 'y', 'z')]
        local = [v-o for v,o in zip(world,origin)]
        require(all(math.isfinite(v) and abs(v) <= 250 for v in local), 'pandaset', 'point', 'Point exceeds origin bounds.')
        packed = struct.pack('<fff', *local)
        require(all(abs(v-(q+o)) <= POINT_TOLERANCE for v,q,o in zip(world,struct.unpack('<fff',packed),origin)),
                'pandaset', 'point', 'Float32 world reconstruction exceeds 1 mm.')
        out.extend(packed)
    # The canonical product format contains XYZ only. Non-XYZ source attributes
    # remain in the unchanged raw input; their exact column digests are disclosed.
    auxiliary = {n: digest(struct.pack('<' + str(count) + ('q' if n=='d' else 'd'), *columns[n]))
                 for n in ('i', 't', 'd')}
    return bytes(out), auxiliary


def convert_pandaset(*, sequence_dir, frame_ids, source, attribution, output):
    """Convert every requested row using the restricted inert table reader."""
    sequence_dir = directory(sequence_dir)
    require(type(frame_ids) is list and 1 <= len(frame_ids) <= 10 and
            all(type(f) is str and re.fullmatch(r'[0-7][0-9]', f) for f in frame_ids) and
            frame_ids == sorted(set(frame_ids)), 'pandaset', 'frames', 'Expected 1..10 unique increasing frame IDs, 00..79.')
    source = copy.deepcopy(source)
    validator.obj(source, 'pandaset-source.json', 'source', ('name', 'kind', 'url', 'licence', 'attribution'), strict=True)
    require(source['kind'] in ('real', 'synthetic-test'), 'pandaset-source.json', 'kind', 'Declare real or synthetic-test provenance.')
    relative = ['LICENSE.txt', 'lidar/poses.json', 'lidar/timestamps.json']
    relative += [n for f in frame_ids for n in (f'lidar/{f}.pkl.gz', f'annotations/cuboids/{f}.pkl.gz')]
    limits = {n: (8*1024*1024 if n.endswith('.pkl.gz') else 65536) for n in relative}
    raw = {n: read(sequence_dir / n, limits[n], n) for n in relative}
    require(sum(map(len,raw.values())) <= SOURCE_TOTAL_LIMIT, 'pandaset', 'bytes', 'Combined input byte limit exceeded.')
    attr = read(Path(attribution), 65536, 'ATTRIBUTION.txt')
    poses = validator.bounded_json(raw['lidar/poses.json'], 'poses.json', 65536, 8)
    times = validator.bounded_json(raw['lidar/timestamps.json'], 'timestamps.json', 65536, 8)
    require(type(poses) is list and type(times) is list and len(poses)==len(times) and
            1 <= len(times) <= 80 and int(frame_ids[-1]) < len(times), 'pandaset', 'metadata', 'Pose/timestamp coverage differs.')
    selected_times = [times[int(f)] for f in frame_ids]
    require(all(validator.finite(t) for t in selected_times) and all(a<b for a,b in zip(selected_times,selected_times[1:])),
            'timestamps.json', 'timestamp', 'Selected timestamps must be finite and strictly increasing.')
    origin, origin_decision = _pandaset_origin(raw, frame_ids, poses)
    inventory = {'schemaVersion': 'labelxr-pandaset-input/v1', 'frames': frame_ids,
                 'hashes': {n: digest(b) for n,b in raw.items()}, 'attributionSha256': digest(attr), 'source': source}
    source_digest = digest(encoded(inventory))
    members = {'LICENSE.txt': raw['LICENSE.txt'], 'ATTRIBUTION.txt': attr}
    globals, frames, label_frames, expected, auxiliary = {}, [], {}, [], {}
    for i, (fid, timestamp) in enumerate(zip(frame_ids,selected_times)):
        points = read_pandaset_table(raw[f'lidar/{fid}.pkl.gz'], 'points')
        boxes = read_pandaset_table(raw[f'annotations/cuboids/{fid}.pkl.gz'], 'cuboids')
        name = f'frames/{i:03}.pcd'; members[name], auxiliary[fid] = _pandaset_points(points, origin)
        frames.append({'id': fid, 'timestamp': timestamp, 'pcd': name, 'pointCount': points['rowCount'], 'sha256': digest(members[name])})
        objects = {}; columns = boxes['columns']
        for row in range(boxes['rowCount']):
            oid, label = columns['uuid'][row], columns['label'][row]
            require(oid not in objects, 'pandaset', 'uuid', 'Repeated UUID within one frame is ambiguous; no deduplication performed.')
            require(oid not in globals or globals[oid]['type']==label, 'pandaset', 'label', 'A tracked UUID changes class.')
            globals[oid] = {'type': label}
            require(len(globals) <= 1000, 'pandaset', 'objects', 'More than 1000 global objects.')
            center = [columns[n][row] for n in ('position.x', 'position.y', 'position.z')]
            # Upstream: yaw=0 points along +Y (length); canonical box +X is
            # length. Swap width/length axes and add pi/2 without moving corners.
            yaw = columns['yaw'][row] + math.pi/2
            yaw = math.atan2(math.sin(yaw), math.cos(yaw))
            size = [columns[n][row] for n in ('dimensions.y', 'dimensions.x', 'dimensions.z')]
            val = [v-o for v,o in zip(center,origin)] + [0,0,math.sin(yaw/2),math.cos(yaw/2)] + size
            original = {n: {'dtype': boxes['dtypes'][n], 'cell': _pandaset_cell(columns[n][row])} for n in boxes['columnNames']}
            objects[oid] = {'object_data': {'cuboid': [{'name': 'bbox', 'val': val}]},
                            'pandaset': {'sourceRow': row, 'columnOrder': list(boxes['columnNames']), 'original': original}}
            expected.append({'frameId': fid, 'objectId': oid, 'center': center, 'size': size, 'yaw': yaw})
        label_frames[fid] = {'frame_properties': {'timestamp': timestamp}, 'objects': objects}
    metadata = {'schema_version': '1.0.0', 'pandaset_conversion': {'schemaVersion': 'labelxr-pandaset-conversion/v1',
        'inputInventory': inventory, 'originDecision': origin_decision, 'sourcePointColumns': ['x','y','z','i','t','d'],
        'canonicalPointColumns': ['x','y','z'], 'sourceOnlyPointAttributeSha256': auxiliary,
        'pointAttributeDisclosure': 'Canonical PCD preserves all XYZ rows within 1 mm; i/t/d values remain in unchanged raw source files, identified by exact column SHA-256.',
        'annotationMapping': 'canonical size=(dimensions.y,dimensions.x,dimensions.z); canonical yaw=source yaw+pi/2',
        'targetsExecuted': False, 'sourceRowsDropped': 0}}
    members['labels.openlabel.json'] = encoded({'openlabel': {'metadata': metadata, 'objects': globals, 'frames': label_frames}})
    manifest = {'schemaVersion': '1.0', 'bundleId': str(uuid.uuid5(uuid.NAMESPACE_URL, 'labelxr-pandaset-sha256:'+source_digest)),
                'source': {**source, 'sha256': source_digest}, 'sourceOrigin': origin,
                'units': 'meters', 'coordinates': 'x-y-ground-z-up', 'frames': frames,
                'hashes': {n: digest(members[n]) for n in ('labels.openlabel.json','LICENSE.txt','ATTRIBUTION.txt')}}
    members['manifest.json'] = encoded(manifest)
    reference = encoded({'schemaVersion': 'labelxr-world-boxes/v1', 'boxes': expected})
    out = io.BytesIO()
    with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_STORED,allowZip64=False) as archive:
        for name in ['manifest.json','labels.openlabel.json','LICENSE.txt','ATTRIBUTION.txt',*[f['pcd'] for f in frames]]:
            info = zipfile.ZipInfo(name,(1980,1,1,0,0,0)); info.create_system,info.external_attr=3,0o100644<<16
            archive.writestr(info,members[name])
    data=out.getvalue();proof=validator.validate_bundle(data,reference)
    for name,value in raw.items():
        require(digest(read(sequence_dir/name,limits[name],name))==digest(value), name,'sha256','Source changed during conversion; no output published.')
    require(digest(read(Path(attribution),65536,'ATTRIBUTION.txt'))==digest(attr), 'ATTRIBUTION.txt','sha256','Attribution changed during conversion.')
    publish(output,data)
    return {'schema':'labelxr-pandaset-conversion/v1','converted':True,'bundleSha256':proof['bundleSha256'],
            'sourceSha256':source_digest,'frameCount':proof['frameCount'],'pointCount':proof['pointCount'],
            'boxCount':proof['boxCount'],'sourceWorldBoxesChecked':proof['expectedWorldBoxesChecked'],
            'sourceOrigin':origin,'originStrategy':origin_decision['strategy'],'sourceRowsDropped':0,
            'targetsExecuted':False,'pointWorldToleranceMetres':POINT_TOLERANCE,'rights':proof['rights']}


def pandaset_main(argv=None):
    parser=argparse.ArgumentParser(description='Restricted PandaSet conversion; no serialized target execution.')
    parser.add_argument('--sequence-dir',required=True);parser.add_argument('--frames',required=True)
    parser.add_argument('--source',required=True);parser.add_argument('--attribution',required=True);parser.add_argument('--out',required=True)
    args=parser.parse_args(argv)
    try:
        source=validator.bounded_json(read(Path(args.source),65536,'pandaset-source.json'),'pandaset-source.json',65536,8)
        receipt=convert_pandaset(sequence_dir=args.sequence_dir,frame_ids=args.frames.split(','),source=source,attribution=args.attribution,output=args.out)
    except (ConversionError,validator.ValidationError,OSError,OverflowError,ValueError,KeyError,TypeError):
        print(json.dumps({'converted':False,'detail':'PandaSet conversion stopped; exact layout, geometry, rights or output state differs.'}),file=sys.stderr)
        return 1
    print(json.dumps(receipt,sort_keys=True));return 0


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
    sys.exit(pandaset_main(sys.argv[2:]) if sys.argv[1:2] == ['pandaset'] else main())
