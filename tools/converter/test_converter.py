"""Independent validator and generic conversion tests; synthetic evidence only."""
import argparse
import copy
import hashlib
import importlib.util
import io
import inspect
import json
import math
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import warnings
import zipfile
from unittest import mock

HERE = Path(__file__).absolute().parent
spec = importlib.util.spec_from_file_location("labelxr_independent_validator", HERE / "validate.py")
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
converter_spec = importlib.util.spec_from_file_location("labelxr_generic_converter", HERE / "convert.py")
converter = importlib.util.module_from_spec(converter_spec)
converter_spec.loader.exec_module(converter)
SUPPLIED_FIXTURE = HERE.parents[1] / "fixtures/contract-example.zip"


def encoded(value):
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), allow_nan=True).encode()


def point_bytes(points):
    header = ("VERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\n"
              f"WIDTH {len(points)}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS {len(points)}\nDATA binary\n").encode()
    return header + b"".join(struct.pack("<fff", *p) for p in points)


def fixture(count=1, object_id="track-A"):
    values = [2, 3, 4, 0, 0, math.sqrt(0.5), math.sqrt(0.5), 4, 2, 2]
    labels = {"openlabel": {"metadata": {"schema_version": "1.0.0", "unknown": ["retained", {"unicode": "\u03b1"}]}, "objects": {object_id: {"name": "asymmetric car", "type": "car", "attributes": {"source": 7}}}, "frames": {}}}
    members = {"LICENSE.txt": b"Synthetic test rights\r\n", "ATTRIBUTION.txt": b"Analytic fixture, no real scan.\n"}
    frames = []
    for i in range(count):
        fid, pcd = str(i), f"frames/{i:03}.pcd"
        members[pcd] = point_bytes([(1.25, -2.5, 3), (-5, 1, 2)])
        frames.append({"id": fid, "timestamp": i + 0.125, "pcd": pcd, "sha256": "0" * 64, "pointCount": 2})
        labels["openlabel"]["frames"][fid] = {"frame_properties": {"timestamp": i + 0.125}, "objects": {object_id: {"object_data": {"cuboid": [{"name": "bbox", "val": values.copy(), "metadata": {"keep": True}}]}}}}
    members["labels.openlabel.json"] = encoded(labels)
    manifest = {"schemaVersion": "1.0", "bundleId": "12345678-1234-1234-1234-123456789abc", "source": {"name": "analytic independent test", "kind": "synthetic-test", "url": "", "licence": "Synthetic test only", "attribution": "Independent numerical test", "sha256": "a" * 64}, "sourceOrigin": [1000, 2000, -100], "units": "meters", "coordinates": "x-y-ground-z-up", "frames": frames, "hashes": {}}
    return members, manifest, labels


def pack(members, manifest, labels=None, method=zipfile.ZIP_DEFLATED, extras=()):
    members = dict(members); manifest = copy.deepcopy(manifest)
    if labels is not None:
        members["labels.openlabel.json"] = encoded(labels)
    for f in manifest["frames"]:
        if f["pcd"] in members:
            f["sha256"] = hashlib.sha256(members[f["pcd"]]).hexdigest()
    manifest["hashes"] = {n: hashlib.sha256(b).hexdigest() for n, b in members.items() if n in {"labels.openlabel.json", "LICENSE.txt", "ATTRIBUTION.txt", "audit.json", "review.json"}}
    members["manifest.json"] = encoded(manifest)
    return raw_pack(list(members.items()) + list(extras), method)


def raw_pack(items, method=zipfile.ZIP_DEFLATED):
    out = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(out, "w", compression=method) as z:
            for name, b in items:
                z.writestr(name, b)
    return out.getvalue()


class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.members, self.manifest, self.labels = fixture()

    def archive(self, **kwargs):
        return pack(self.members, self.manifest, self.labels, **kwargs)

    def fails(self, data, code=None, member=None):
        with self.assertRaises(validator.ValidationError) as context:
            validator.validate_bundle(data)
        if code:
            self.assertEqual(context.exception.code, code)
        if member:
            self.assertEqual(context.exception.member, member)
        self.assertTrue(context.exception.field)

    def val(self):
        return self.labels["openlabel"]["frames"]["0"]["objects"]["track-A"]["object_data"]["cuboid"][0]["val"]

    def reference(self, center=None, yaw=math.pi / 2):
        return encoded({"schemaVersion": "labelxr-world-boxes/v1", "boxes": [{"frameId": "0", "objectId": "track-A", "center": center or [1002, 2003, -96], "size": [4, 2, 2], "yaw": yaw}]})

    def test_analytic_world_coordinates_yaw_and_float32_points(self):
        b = self.archive(); before = hashlib.sha256(b).hexdigest()
        r = validator.validate_bundle(b, self.reference())
        self.assertEqual(r["worldBoxes"][0]["center"], [1002, 2003, -96])
        self.assertAlmostEqual(r["worldBoxes"][0]["yaw"], math.pi / 2, places=14)
        self.assertEqual(r["worldBoxes"][0]["size"], [4, 2, 2])
        self.assertEqual(r["frames"][0]["localBounds"], [[-5, -2.5, 2], [1.25, 1, 3]])
        self.assertEqual(r["bundleSha256"], before)
        self.assertEqual(hashlib.sha256(b).hexdigest(), before)
        self.assertNotEqual(r["bundleSha256"], r["declaredSourceSha256"])

    def test_stored_zip_and_rights_bom_newlines(self):
        self.members["LICENSE.txt"] = b"\xef\xbb\xbfSynthetic rights\r\n"
        r = validator.validate_bundle(self.archive(method=zipfile.ZIP_STORED))
        self.assertEqual(r["memberHashes"]["LICENSE.txt"], hashlib.sha256(self.members["LICENSE.txt"]).hexdigest())

    def test_data_descriptors_comments_and_bounded_extra_fields(self):
        class Pipe(io.BytesIO):
            def seek(self, *args):
                raise OSError("nonseekable fixture")
        original = self.archive()
        with zipfile.ZipFile(io.BytesIO(original)) as z:
            members = [(n, z.read(n)) for n in z.namelist()]
        out = Pipe()
        with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.comment = b"comment PK fake footer"
            for name, value in members:
                info = zipfile.ZipInfo(name)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.extra = struct.pack("<HHI", 0x5455, 4, 7)
                z.writestr(info, value)
        self.assertEqual(validator.validate_bundle(out.getvalue())["pointCount"], 2)

    def test_numeric_integer_count_and_bounded_pcd_leading_zeros(self):
        self.manifest["frames"][0]["pointCount"] = 2.0
        self.members["frames/000.pcd"] = self.members["frames/000.pcd"].replace(b"WIDTH 2", b"WIDTH 0002").replace(b"POINTS 2", b"POINTS 0002")
        self.assertEqual(validator.validate_bundle(self.archive())["pointCount"], 2)

    def test_supplied_contract_zip_independent_validation(self):
        self.assertIsNotNone(SUPPLIED_FIXTURE, "Pass --fixture for the supplied synthetic bundle")
        data = Path(SUPPLIED_FIXTURE).read_bytes()
        r = validator.validate_bundle(data)
        self.assertTrue(r["valid"])
        self.assertEqual(r["sourceKind"], "synthetic-test")
        self.assertEqual(r["bundleSha256"], hashlib.sha256(data).hexdigest())

    def test_ten_frames_and_prototype_like_ids(self):
        m, h, l = fixture(10, "__proto__")
        r = validator.validate_bundle(pack(m, h, l))
        self.assertEqual((r["frameCount"], r["pointCount"], r["boxCount"]), (10, 20, 10))
        self.assertEqual(r["worldBoxes"][-1]["objectId"], "__proto__")

    def test_quaternion_sign_and_wrapped_negative_yaws(self):
        for yaw in [0, -math.pi / 2, math.pi, -math.pi, 0.75]:
            for sign in [1, -1]:
                with self.subTest(yaw=yaw, sign=sign):
                    self.val()[3:7] = [0, 0, sign * math.sin(yaw / 2), sign * math.cos(yaw / 2)]
                    r = validator.validate_bundle(self.archive())
                    self.assertLess(abs(math.atan2(math.sin(r["worldBoxes"][0]["yaw"] - yaw), math.cos(r["worldBoxes"][0]["yaw"] - yaw))), 1e-12)

    def test_external_reference_tolerance_and_yaw_wrap(self):
        validator.validate_bundle(self.archive(), self.reference([1002 + 0.000005, 2003, -96], math.pi / 2 + 2 * math.pi))
        with self.assertRaises(validator.ValidationError) as c:
            validator.validate_bundle(self.archive(), self.reference([1002 + 0.00002, 2003, -96]))
        self.assertEqual(c.exception.code, "REFERENCE")

    def test_external_reference_requires_exact_occurrence_set(self):
        for boxes in [[], [{"frameId": "missing", "objectId": "track-A", "center": [1002, 2003, -96], "size": [4, 2, 2], "yaw": math.pi / 2}]]:
            with self.subTest(boxes=boxes), self.assertRaises(validator.ValidationError):
                validator.validate_bundle(self.archive(), encoded({"schemaVersion": "labelxr-world-boxes/v1", "boxes": boxes}))
        ref = json.loads(self.reference()); ref["boxes"].append(copy.deepcopy(ref["boxes"][0]))
        with self.assertRaises(validator.ValidationError):
            validator.validate_bundle(self.archive(), encoded(ref))

    def test_external_reference_size_and_yaw_mismatch(self):
        for key, value in [("size", [4.01, 2, 2]), ("yaw", 0.0)]:
            r = json.loads(self.reference()); r["boxes"][0][key] = value
            with self.subTest(key=key), self.assertRaises(validator.ValidationError):
                validator.validate_bundle(self.archive(), encoded(r))

    def test_optional_history_is_only_finite_bounded_json(self):
        self.members["audit.json"] = encoded({"approved": True, "revision": 999, "role": "owner"})
        self.members["review.json"] = encoded(["untrusted"])
        r = validator.validate_bundle(self.archive())
        self.assertNotIn("approved", r); self.assertNotIn("revision", r)
        self.assertEqual(r["boxCount"], 1)

    def test_sha_checked_before_corrupt_semantics(self):
        b = self.archive(method=zipfile.ZIP_STORED)
        with zipfile.ZipFile(io.BytesIO(b)) as z:
            files = {n: z.read(n) for n in z.namelist()}
        files["labels.openlabel.json"] = b"not JSON"
        self.fails(raw_pack(files.items()), "HASH", "labels.openlabel.json")

    def test_unknown_or_undeclared_member(self):
        self.fails(self.archive(extras=[("other.txt", b"no")]), "PATH")
        self.fails(self.archive(extras=[("audit.json", b"{}")]), "MEMBER_SET")

    def test_missing_required_member(self):
        b = self.archive()
        with zipfile.ZipFile(io.BytesIO(b)) as z:
            files = [(n, z.read(n)) for n in z.namelist() if n != "LICENSE.txt"]
        self.fails(raw_pack(files), "ZIP")

    def test_traversal_absolute_drive_backslash_nested_zip(self):
        for n in ["../x", "/x", "C:/x", "frames\\000.pcd", "nested.zip", "frames/../000.pcd", "frames/000.pcd/"]:
            with self.subTest(path=n):
                self.fails(self.archive(extras=[(n, b"bad")]), "PATH")

    def test_duplicate_zip_member(self):
        self.fails(self.archive(extras=[("LICENSE.txt", b"again")]), "PATH")

    def test_crc_corruption(self):
        b = bytearray(self.archive(method=zipfile.ZIP_STORED))
        b[b.index(b"Synthetic test rights")] ^= 1
        self.fails(bytes(b), "ZIP", "LICENSE.txt")

    def test_truncated_prefixed_and_trailing_archives(self):
        b = self.archive()
        for bad in [b[:-1], b + b"junk", b"MZ" + b]:
            with self.subTest(length=len(bad)):
                self.fails(bad, "ZIP")

    def test_symlink_member(self):
        b = bytearray(self.archive()); p = b.index(b"PK\x01\x02")
        struct.pack_into("<I", b, p + 38, 0o120777 << 16)
        self.fails(bytes(b), "ZIP")

    def test_encryption_zip64_and_method_rejected(self):
        for offset, value in [(8, 1), (6, 45), (10, 99)]:
            b = bytearray(self.archive()); p = b.index(b"PK\x01\x02")
            struct.pack_into("<H", b, p + offset, value)
            with self.subTest(offset=offset):
                self.fails(bytes(b), "ZIP")

    def test_declared_size_ceiling_before_inflation(self):
        b = bytearray(self.archive()); p = b.index(b"PK\x01\x02")
        struct.pack_into("<I", b, p + 24, 64 * 1024 + 1)
        self.fails(bytes(b), "BYTE_LIMIT")

    def test_actual_inflate_beyond_declared_size(self):
        self.members["LICENSE.txt"] = b"a" * 60000
        b = bytearray(self.archive()); p = b.index(b"PK\x01\x02"); local = struct.unpack_from("<I", b, p + 42)[0]
        struct.pack_into("<I", b, p + 24, 1); struct.pack_into("<I", b, local + 22, 1)
        self.fails(bytes(b), "BYTE_LIMIT", "LICENSE.txt")

    def test_malformed_utf8_bom_duplicate_and_deep_json(self):
        for raw in [b"\xff", b"\xef\xbb\xbf{}", b'{"a":1,"\\u0061":2}', b"[" * 33 + b"0" + b"]" * 33, b'{"x":NaN}', b'{"x":1e999}']:
            self.members["review.json"] = raw
            with self.subTest(raw=raw):
                self.fails(self.archive())

    def test_json_node_limit(self):
        self.members["review.json"] = encoded([0] * 100000)
        self.fails(self.archive(), "NODE_LIMIT")

    def test_rights_empty_control_and_invalid_utf8(self):
        for raw in [b"  \r\n", b"\xef\xbb\xbf \xef\xbb\xbf", b"rights\x00", b"\xff"]:
            self.members["LICENSE.txt"] = raw
            with self.subTest(raw=raw):
                self.fails(self.archive(), "RIGHTS", "LICENSE.txt")

    def test_source_rights_and_real_provenance(self):
        self.manifest["source"]["kind"] = "real"
        self.fails(self.archive(), member="manifest.json")
        self.manifest["source"]["url"] = "https://example.org/licensed-source"
        self.assertEqual(validator.validate_bundle(self.archive())["sourceKind"], "real")
        for url in ["https://user:pass@example.org", "file:///x", " https://example.org", "https://example.org:bad"]:
            self.manifest["source"]["url"] = url
            with self.subTest(url=url):
                self.fails(self.archive())

    def test_manifest_units_origin_strict_fields_and_boolean_count(self):
        for mutate in [lambda m: m.update(units="feet"), lambda m: m.update(sourceOrigin=[0, 0]), lambda m: m.update(extra=True), lambda m: m["frames"][0].update(pointCount=True), lambda m: m["source"].update(licence=" ")]:
            saved = copy.deepcopy(self.manifest); mutate(self.manifest)
            with self.subTest(manifest=self.manifest):
                self.fails(self.archive(), member="manifest.json")
            self.manifest = saved

    def test_manifest_order_and_duplicate_frame_paths_ids(self):
        m, h, l = fixture(2)
        for field, value in [("id", "0"), ("pcd", "frames/000.pcd"), ("timestamp", 0.125)]:
            mutated = copy.deepcopy(h); mutated["frames"][1][field] = value
            with self.subTest(field=field):
                self.fails(pack(m, mutated, l), member="manifest.json")

    def test_frame_and_point_limits(self):
        m, h, l = fixture(11)
        self.fails(pack(m, h, l))
        self.manifest["frames"][0]["pointCount"] = 200001
        self.fails(self.archive(), member="manifest.json")

    def test_pcd_ascii_extra_fields_bigendian_layout_refused(self):
        original = self.members["frames/000.pcd"]
        for old, new in [(b"DATA binary", b"DATA ascii"), (b"FIELDS x y z", b"FIELDS x y z intensity"), (b"SIZE 4 4 4", b"SIZE 8 8 8"), (b"HEIGHT 1", b"HEIGHT 2"), (b"VIEWPOINT 0 0 0 1 0 0 0", b"VIEWPOINT 0 0 0 0 0 0 1")]:
            self.members["frames/000.pcd"] = original.replace(old, new)
            with self.subTest(new=new):
                self.fails(self.archive(), "PCD", "frames/000.pcd")
        # Bytes chosen as big-endian 1.0 become an out-of-range little-endian value.
        self.members["frames/000.pcd"] = original[:-24] + struct.pack(">ffffff", 123.456, 2, 3, 1, 2, 3)
        self.fails(self.archive(), "PCD")

    def test_pcd_nan_inf_coordinates_and_payload_size(self):
        for point in [(math.nan, 0, 0), (math.inf, 0, 0), (251, 0, 0)]:
            self.members["frames/000.pcd"] = point_bytes([point, (0, 0, 0)])
            with self.subTest(point=point):
                self.fails(self.archive(), "PCD")
        for suffix in [b"x", b"\x00" * 12]:
            self.members["frames/000.pcd"] = point_bytes([(0, 0, 0), (0, 0, 0)]) + suffix
            self.fails(self.archive(), "PCD")

    def test_pcd_header_ceiling_and_duplicate_order(self):
        original = self.members["frames/000.pcd"]
        for b in [b"#" + b"a" * 16384 + b"\n" + original, original.replace(b"FIELDS x y z\n", b"VERSION 0.7\n")]:
            self.members["frames/000.pcd"] = b
            self.fails(self.archive(), "PCD")

    def test_pcd_manifest_count_and_float32_edge(self):
        self.manifest["frames"][0]["pointCount"] = 1
        self.fails(self.archive(), "PCD")
        self.manifest["frames"][0]["pointCount"] = 2
        self.members["frames/000.pcd"] = point_bytes([(250, -250, 0.1), (-0.2, 0, 0)])
        r = validator.validate_bundle(self.archive())
        self.assertLess(abs(r["frames"][0]["localBounds"][1][2] - 0.1), 1e-3)

    def test_label_frame_set_timestamp_and_global_reference(self):
        for change in [lambda l: l["openlabel"]["frames"].update(extra={}), lambda l: l["openlabel"]["frames"]["0"]["frame_properties"].update(timestamp=1), lambda l: l["openlabel"].update(objects={})]:
            saved = copy.deepcopy(self.labels); change(self.labels)
            with self.subTest(labels=self.labels):
                self.fails(self.archive(), member="labels.openlabel.json")
            self.labels = saved

    def test_label_limits(self):
        o = self.labels["openlabel"]["frames"]["0"]["objects"]["track-A"]
        self.labels["openlabel"]["objects"] = {str(i): {"type": "car"} for i in range(101)}
        self.labels["openlabel"]["frames"]["0"]["objects"] = {str(i): copy.deepcopy(o) for i in range(101)}
        self.fails(self.archive(), member="labels.openlabel.json")

    def test_pitched_unnormalized_box_dimensions_and_centers(self):
        original = self.val().copy()
        for values in [[*original[:3], 0.2, 0, 0, 0.98, *original[7:]], [*original[:3], 0, 0, 0, 2, *original[7:]], [251, *original[1:]], [*original[:7], 0.04, 2, 2], [*original[:7], 51, 2, 2]]:
            self.val()[:] = values
            with self.subTest(values=values):
                self.fails(self.archive(), member="labels.openlabel.json")

    def test_unknown_metadata_nonfinite_and_geometry_preservation(self):
        before = copy.deepcopy(self.labels)
        validator.validate_bundle(self.archive())
        self.assertEqual(self.labels, before)
        self.labels["openlabel"]["metadata"]["bad"] = math.inf
        self.fails(self.archive(), member="labels.openlabel.json")

    def test_cli_valid_invalid_external_reference_and_no_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            d = Path(directory); bundle = d / "clip.lrx.zip"; ref = d / "world.json"
            bundle.write_bytes(self.archive()); ref.write_bytes(self.reference())
            before = {p.name: p.read_bytes() for p in d.iterdir()}
            command = [sys.executable, "-I", "-B", str(HERE / "validate.py"), str(bundle), "--expected", str(ref)]
            p = subprocess.run(command, capture_output=True, timeout=15)
            self.assertEqual(p.returncode, 0, p.stderr)
            receipt = json.loads(p.stdout); self.assertTrue(receipt["expectedWorldBoxesChecked"])
            self.assertNotIn("worldBoxes", receipt)
            self.assertEqual({p.name: p.read_bytes() for p in d.iterdir()}, before)
            bundle.write_bytes(b"not ZIP")
            p = subprocess.run(command, capture_output=True, timeout=15)
            self.assertEqual(p.returncode, 1); self.assertEqual(p.stdout, b"")
            self.assertFalse(json.loads(p.stderr)["valid"])

    def test_cli_missing_path_and_nonbytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "absent.zip"
            p = subprocess.run([sys.executable, "-I", "-B", str(HERE / "validate.py"), str(path)], capture_output=True, timeout=15)
            self.assertEqual(p.returncode, 1)
            self.assertEqual(json.loads(p.stderr)["code"], "IO")
            with self.assertRaises(validator.ValidationError):
                validator.validate_bundle(bytearray(self.archive()))


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.pcd = self.root / "pcd"
        self.pcd.mkdir()
        self.output = self.root / "clip.lrx.zip"
        self.members, _, self.labels = fixture()
        self.labels["openlabel"]["frames"]["0"]["objects"]["track-A"]["object_data"]["cuboid"][0]["val"][:3] = [1002, 2003, -96]
        self.mapping = {"schemaVersion": "labelxr-generic-source/v1", "units": "meters", "coordinates": "x-y-ground-z-up",
                        "coordinateFrame": "registered-world-common", "binaryByteOrder": "little",
                        "source": {"name": "Synthetic analytic conversion", "kind": "synthetic-test", "url": "",
                                   "licence": "Synthetic test only", "attribution": "Hand-known geometry"},
                        "frames": [{"id": "0", "timestamp": 0.125, "pcd": "scan-000.pcd"}]}
        self.points = [(998.75, 1997.5, -99), (1001.25, 2002.5, -101)]
        self.write_pcd()
        (self.root / "LICENSE.txt").write_bytes(self.members["LICENSE.txt"])
        (self.root / "ATTRIBUTION.txt").write_bytes(self.members["ATTRIBUTION.txt"])
        self.write_json()

    def write_json(self):
        (self.root / "labels.json").write_bytes(encoded(self.labels))
        (self.root / "map.json").write_bytes(encoded(self.mapping))

    def write_pcd(self, mode="ascii", points=None, name="scan-000.pcd"):
        points = self.points if points is None else points
        data = point_bytes(points)
        if mode == "ascii":
            data = data[:data.index(b"DATA binary")] + b"DATA ascii\n" + b"\n".join(" ".join(format(v, ".17g") for v in point).encode() for point in points) + b"\n"
        (self.pcd / name).write_bytes(data)

    def kwargs(self):
        return dict(pcd_dir=self.pcd, labels=self.root / "labels.json", mapping=self.root / "map.json",
                    license_file=self.root / "LICENSE.txt", attribution=self.root / "ATTRIBUTION.txt", output=self.output)

    def run_conversion(self):
        return converter.convert_generic(**self.kwargs())

    def fails_conversion(self):
        with self.assertRaises((converter.ConversionError, converter.validator.ValidationError, OSError, ValueError)):
            self.run_conversion()
        self.assertFalse(self.output.exists())
        self.assertFalse(list(self.root.glob(".labelxr-owned-*")))

    def contents(self):
        with zipfile.ZipFile(self.output) as z:
            return {n: z.read(n) for n in z.namelist()}

    def test_convert_ascii_known_world_roundtrip_and_origin(self):
        before = {p: p.read_bytes() for p in self.root.rglob("*") if p.is_file()}
        r = self.run_conversion()
        self.assertTrue(r["sourceWorldBoxesChecked"])
        self.assertEqual((r["frameCount"], r["pointCount"], r["boxCount"]), (1, 2, 1))
        members = self.contents(); manifest = json.loads(members["manifest.json"])
        self.assertEqual(manifest["sourceOrigin"], [1000, 2000, -100])
        proof = validator.validate_bundle(self.output.read_bytes(), encoded({"schemaVersion": "labelxr-world-boxes/v1", "boxes": [
            {"frameId": "0", "objectId": "track-A", "center": [1002, 2003, -96], "size": [4, 2, 2], "yaw": math.pi / 2}]}))
        self.assertEqual(proof["frames"][0]["localBounds"], [[-1.25, -2.5, -1], [1.25, 2.5, 1]])
        self.assertEqual({p: p.read_bytes() for p in before}, before)
        self.assertNotEqual(r["sourceSha256"], r["bundleSha256"])

    def test_convert_binary_preserves_all_points_and_order(self):
        self.write_pcd("binary")
        self.run_conversion()
        data = self.contents()["frames/000.pcd"]
        self.assertEqual(list(struct.iter_unpack("<fff", data[data.index(b"DATA binary\n") + 12:])), [(-1.25, -2.5, 1), (1.25, 2.5, -1)])

    def test_convert_deterministic_bytes_across_paths_and_no_private_paths(self):
        self.run_conversion(); original = self.output.read_bytes()
        self.output = self.root / "other-name.zip"
        self.run_conversion()
        self.assertEqual(self.output.read_bytes(), original)
        self.assertNotIn(str(self.root).encode(), original)
        with zipfile.ZipFile(self.output) as z:
            self.assertTrue(all(i.date_time == (1980, 1, 1, 0, 0, 0) and i.compress_type == 0 for i in z.infolist()))

    def test_convert_metadata_classes_ids_sizes_and_signed_yaw_retained(self):
        val = self.labels["openlabel"]["frames"]["0"]["objects"]["track-A"]["object_data"]["cuboid"][0]["val"]
        val[3:7] = [0, 0, -math.sin(0.375), -math.cos(0.375)]
        val[7:] = [4.25, 1.75, 2.125]
        self.write_json(); self.run_conversion()
        out = json.loads(self.contents()["labels.openlabel.json"])
        original = copy.deepcopy(self.labels)
        original["openlabel"]["frames"]["0"]["objects"]["track-A"]["object_data"]["cuboid"][0]["val"][:3] = [2, 3, 4]
        receipt = out["openlabel"]["metadata"].pop("labelroom_converter")
        self.assertEqual(out, original)
        self.assertEqual(receipt["inputInventory"]["hashes"]["labels.openlabel.json"], hashlib.sha256((self.root / "labels.json").read_bytes()).hexdigest())

    def test_convert_ten_frames_keep_single_origin_and_explicit_ids(self):
        for i in range(1, 10):
            self.mapping["frames"].append({"id": f"frame-{i}", "timestamp": i + .125, "pcd": f"scan-{i:03}.pcd"})
            self.labels["openlabel"]["frames"][f"frame-{i}"] = copy.deepcopy(self.labels["openlabel"]["frames"]["0"])
            self.labels["openlabel"]["frames"][f"frame-{i}"]["frame_properties"]["timestamp"] = i + .125
            self.write_pcd(points=[(1000 + i, 2000, -100)], name=f"scan-{i:03}.pcd")
        self.write_json(); r = self.run_conversion()
        self.assertEqual((r["frameCount"], r["pointCount"], r["boxCount"]), (10, 11, 10))
        proof = validator.validate_bundle(self.output.read_bytes())
        self.assertEqual(proof["frames"][-1]["localBounds"], [[9, 0, 0], [9, 0, 0]])

    def test_convert_odd_median_and_nonzero_ascii_roundoff(self):
        self.write_pcd(points=[(1000.1, 2000, -100), (1000.2, 2001, -101), (1000.9, 2002, -102)])
        self.run_conversion()
        self.assertEqual(json.loads(self.contents()["manifest.json"])["sourceOrigin"], [1000.2, 2001, -101])

    def test_convert_requires_common_world_metres_and_little_endian(self):
        for key, bad in [("units", "millimeters"), ("coordinates", "camera"), ("coordinateFrame", "frame-local"), ("binaryByteOrder", "big")]:
            saved = self.mapping[key]; self.mapping[key] = bad; self.write_json()
            with self.subTest(key=key): self.fails_conversion()
            self.mapping[key] = saved

    def test_convert_rejects_frame_map_unknown_missing_or_duplicate_keys(self):
        for data in [encoded({**self.mapping, "guess": True}), b'{"units":"meters","units":"meters"}', encoded([])]:
            (self.root / "map.json").write_bytes(data); self.fails_conversion()

    def test_convert_rejects_duplicate_ids_times_and_casefold_paths(self):
        for row in [{"id": "0", "timestamp": 1, "pcd": "two.pcd"}, {"id": "1", "timestamp": .125, "pcd": "two.pcd"},
                    {"id": "1", "timestamp": 1, "pcd": "SCAN-000.pcd"}, {"id": [], "timestamp": 1, "pcd": "two.pcd"}]:
            self.mapping["frames"] = [self.mapping["frames"][0], row]; self.write_json(); self.fails_conversion()

    def test_convert_rejects_unsafe_windows_reserved_or_traversal_paths(self):
        for name in ["../a.pcd", "dir/a.pcd", "C:\\x.pcd", "CON.pcd", "LPT1.pcd", "a.PCD", "a.pcd "]:
            self.mapping["frames"][0]["pcd"] = name; self.write_json(); self.fails_conversion()

    def test_convert_rejects_zero_or_eleven_frames(self):
        for frames in [[], self.mapping["frames"] * 11]:
            self.mapping["frames"] = frames; self.write_json(); self.fails_conversion()

    def test_convert_requires_exact_label_frame_set_timestamp_and_global_refs(self):
        for mutate in [lambda: self.labels["openlabel"]["frames"].update(extra={}),
                       lambda: self.labels["openlabel"]["frames"]["0"]["frame_properties"].update(timestamp=1),
                       lambda: self.labels["openlabel"].update(objects={})]:
            saved = copy.deepcopy(self.labels); mutate(); self.write_json(); self.fails_conversion(); self.labels = saved

    def test_convert_rejects_reserved_metadata_collision(self):
        self.labels["openlabel"]["metadata"]["labelroom_converter"] = {}; self.write_json(); self.fails_conversion()

    def test_convert_rejects_pitched_invalid_sizes_and_distant_boxes(self):
        val = self.labels["openlabel"]["frames"]["0"]["objects"]["track-A"]["object_data"]["cuboid"][0]["val"]
        saved = val.copy()
        for v in [[*saved[:3], .2, 0, 0, .98, *saved[7:]], [*saved[:7], .01, 2, 2], [2000, *saved[1:]], [*saved[:3], 0, 0, 0, 2, *saved[7:]]]:
            val[:] = v; self.write_json(); self.fails_conversion()

    def test_convert_rejects_nonfinite_or_extra_ascii_tokens(self):
        p = self.pcd / "scan-000.pcd"; original = p.read_bytes()
        for suffix in [b"nan 0 0\n0 0 0", b"inf 0 0\n0 0 0", b"1e309 0 0\n0 0 0", b"0 0 0", b"0 0 0\n0 0 0\n0", b"0x1 0 0\n0 0 0"]:
            p.write_bytes(original[:original.index(b"DATA ascii\n") + 11] + suffix); self.fails_conversion()

    def test_convert_rejects_binary_length_nan_and_compressed_layouts(self):
        self.write_pcd("binary"); p = self.pcd / "scan-000.pcd"; original = p.read_bytes()
        for value in [original[:-1], original + b"x", original[:-24] + struct.pack("<ffffff", math.nan, 0, 0, 0, 0, 0), original.replace(b"DATA binary", b"DATA binary_compressed")]:
            p.write_bytes(value); self.fails_conversion()

    def test_convert_rejects_nonidentity_viewpoint_and_extra_fields(self):
        p = self.pcd / "scan-000.pcd"; original = p.read_bytes()
        for value in [original.replace(b"VIEWPOINT 0 0 0", b"VIEWPOINT 1 0 0"), original.replace(b"FIELDS x y z", b"FIELDS x y z intensity"), original.replace(b"TYPE F F F", b"TYPE D D D"), original.replace(b"WIDTH 2", b"WIDTH 3")]:
            p.write_bytes(value); self.fails_conversion()

    def test_convert_rejects_header_byte_count_and_source_byte_limits(self):
        p = self.pcd / "scan-000.pcd"; original = p.read_bytes()
        for value in [b"#" + b"a" * 16384 + b"\n" + original, original.replace(b"POINTS 2", b"POINTS 200001"), original.replace(b"POINTS 2", b"POINTS 0")]:
            p.write_bytes(value); self.fails_conversion()
        p.write_bytes(original)
        with mock.patch.object(converter, "SOURCE_FRAME_LIMIT", 8): self.fails_conversion()
        with mock.patch.object(converter, "SOURCE_TOTAL_LIMIT", 8): self.fails_conversion()

    def test_convert_never_drops_outliers(self):
        self.write_pcd(points=[(0, 0, 0), (0, 0, 0), (251, 0, 0)])
        self.fails_conversion()

    def test_convert_rights_bytes_preserved_and_empty_or_invalid_refused(self):
        path = self.root / "LICENSE.txt"
        for data in [b"", b" \r\n", b"\xff", b"rights\x00"]:
            path.write_bytes(data); self.fails_conversion()
        path.write_bytes(b"\xef\xbb\xbfRights\r\n"); self.run_conversion()
        self.assertEqual(self.contents()["LICENSE.txt"], path.read_bytes())

    def test_convert_real_provenance_requires_url_and_bounded_declarations(self):
        self.mapping["source"]["kind"] = "real"; self.write_json(); self.fails_conversion()
        self.mapping["source"]["url"] = "https://example.org/source"; self.write_json()
        receipt = self.run_conversion()
        self.assertEqual(json.loads(self.contents()["manifest.json"])["source"]["kind"], "real")
        self.assertEqual(receipt["rights"], "declarations validated; external rights evidence not adjudicated")

    def test_convert_maximum_point_count_kept_without_sampling(self):
        self.write_pcd("binary", points=[(1000, 2000, -100)] * 200000)
        receipt = self.run_conversion()
        self.assertEqual(receipt["pointCount"], 200000)
        self.assertEqual(validator.validate_bundle(self.output.read_bytes())["pointCount"], 200000)

    def test_convert_existing_output_never_overwritten(self):
        self.output.write_bytes(b"existing")
        with self.assertRaises(converter.ConversionError): self.run_conversion()
        self.assertEqual(self.output.read_bytes(), b"existing")
        self.assertFalse(list(self.root.glob(".labelxr-owned-*")))

    def test_convert_atomic_output_race_and_unsupported_link_leave_no_owned_temp(self):
        real_link = converter.os.link
        def raced(source, target):
            Path(target).write_bytes(b"racer")
            return real_link(source, target)
        with mock.patch.object(converter.os, "link", raced), self.assertRaises(FileExistsError): self.run_conversion()
        self.assertEqual(self.output.read_bytes(), b"racer")
        self.assertFalse(list(self.root.glob(".labelxr-owned-*")))
        self.output.unlink()
        with mock.patch.object(converter.os, "link", side_effect=OSError("unsupported")): self.fails_conversion()

    def test_convert_source_changed_before_publish_fails_closed(self):
        original = converter.read; seen = 0
        def changed(path, limit, member):
            nonlocal seen
            value = original(path, limit, member)
            if member == "scan-000.pcd":
                seen += 1
                if seen == 2: return value + b"\n"
            return value
        with mock.patch.object(converter, "read", changed): self.fails_conversion()

    def test_convert_redirected_input_or_output_parent_refused(self):
        # Directory junction creation needs privileges on some Windows machines;
        # exercise the exact lstat branch deterministically without skipping it.
        original = converter.Path.lstat
        def redirected(path):
            s = original(path)
            if path == self.pcd:
                return type("ReparseStat", (), {"st_mode": s.st_mode, "st_file_attributes": 0x400})()
            return s
        with mock.patch.object(converter.Path, "lstat", redirected): self.fails_conversion()

    def test_convert_cli_receipt_invalid_input_and_no_geometry_leak(self):
        command = [sys.executable, "-I", "-B", str(HERE / "convert.py"), "--pcd-dir", str(self.pcd), "--labels", str(self.root / "labels.json"),
                   "--frame-map", str(self.root / "map.json"), "--license", str(self.root / "LICENSE.txt"), "--attribution", str(self.root / "ATTRIBUTION.txt"), "--out", str(self.output)]
        p = subprocess.run(command, capture_output=True, timeout=20)
        self.assertEqual(p.returncode, 0, p.stderr)
        r = json.loads(p.stdout); self.assertTrue(r["converted"]); self.assertNotIn("worldBoxes", r)
        self.assertNotIn(str(self.root), p.stdout.decode())
        self.output.unlink(); (self.root / "map.json").write_bytes(b"bad")
        p = subprocess.run(command, capture_output=True, timeout=20)
        self.assertEqual(p.returncode, 1); self.assertEqual(p.stdout, b"")
        self.assertFalse(json.loads(p.stderr)["converted"]); self.assertFalse(self.output.exists())


class _PandaFixture:
    def __init__(self, kind, value=None, state=None):
        self.kind, self.value, self.state = kind, value, state


def _panda_fixture_array(code, shape, cells):
    import struct
    dtype = _PandaFixture('dtype', code, (3, '|' if code in ('O8', 'b1') else '<', None, None, None, -1, -1, 63 if code == 'O8' else 0))
    raw = list(cells) if code == 'O8' else struct.pack('<' + str(len(cells)) + {'f8':'d', 'i8':'q', 'b1':'?'}[code], *cells)
    return _PandaFixture('array', state=(1, tuple(shape), dtype, False, raw))


def _panda_fixture_table(kind='points', rows=3):
    names = ['x', 'y', 'z', 'i', 't', 'd'] if kind == 'points' else [
        'uuid','label','yaw','position.x','position.y','position.z','dimensions.x','dimensions.y','dimensions.z','stationary','unknown.column']
    def index(values):
        return _PandaFixture('index', {'data':_panda_fixture_array('O8', (len(values),), values), 'name':None})
    axes = [index(names), _PandaFixture('range', {'name':None, 'start':0, 'stop':rows, 'step':1})]
    if kind == 'points':
        types = ['f8']*5 + ['i8']
        columns = [[(i+1)*1.25*(-1 if r%2 else 1)+r/8 for r in range(rows)] for i in range(5)] + [[r%2 for r in range(rows)]]
    else:
        types = ['O8','O8'] + ['f8']*7 + ['b1','O8']
        columns = [['same-id']*rows, ['Car']*rows] + [[0.25+i/8+r/16 for r in range(rows)] for i in range(7)] + [[r%2 == 0 for r in range(rows)], [float('nan') if r%2 == 0 else 'kept-α' for r in range(rows)]]
    arrays, items, blocks = [], [], []
    for code in dict.fromkeys(types):
        positions = [i for i,t in enumerate(types) if t == code]
        array = _panda_fixture_array(code, (len(positions), rows), [v for i in positions for v in columns[i]])
        arrays.append(array);items.append(index([names[i] for i in positions]))
        blocks.append({'values':array, 'mgr_locs':_panda_fixture_array('i8', (len(positions),), positions)})
    manager = _PandaFixture('manager', state=(axes, arrays, items, {'0.14.1':{'axes':axes,'blocks':blocks}}))
    frame = _PandaFixture('frame', state={'_data':manager,'_typ':'dataframe','_metadata':[],'attrs':{}})
    return frame, dict(zip(names, columns))


def _panda_fixture_bytes(value, compressed=True):
    # Hand-assembled inert declarations; no pickle serializer or unpickler.
    import gzip, struct
    memo, symbols = {}, {}
    def symbol(name):
        if name not in symbols: symbols[name]=_PandaFixture('symbol',name)
        return symbols[name]
    def emit(v):
        if v is None:return b'N'
        if type(v) is bool:return b'\x88' if v else b'\x89'
        if type(v) is int:return b'J'+struct.pack('<i',v)
        if type(v) is float:return b'G'+struct.pack('>d',v)
        if type(v) is str:
            raw=v.encode('utf-8');return b'X'+struct.pack('<I',len(raw))+raw
        if type(v) is bytes:return b'B'+struct.pack('<I',len(v))+v
        if type(v) is tuple:return b'('+b''.join(emit(x) for x in v)+b't'
        key=id(v)
        if key in memo:return b'j'+struct.pack('<I',memo[key])
        if type(v) is list:prefix=b']'
        elif type(v) is dict:prefix=b'}'
        elif v.kind == 'symbol':
            module,name=v.value.split(' ');prefix=b'c'+module.encode()+b'\n'+name.encode()+b'\n'
        elif v.kind in ('frame','manager'):
            prefix=emit(symbol('pandas.core.frame DataFrame' if v.kind=='frame' else 'pandas.core.internals.managers BlockManager'))+b')\x81'
        elif v.kind == 'array':prefix=emit(symbol('numpy.core.multiarray _reconstruct'))+emit((symbol('numpy ndarray'),(0,),b'b'))+b'R'
        elif v.kind == 'dtype':prefix=emit(symbol('numpy dtype'))+emit((v.value,0,1))+b'R'
        elif v.kind in ('index','range'):
            prefix=emit(symbol('pandas.core.indexes.base _new_Index'))+emit((symbol('pandas.core.indexes.base Index' if v.kind=='index' else 'pandas.core.indexes.range RangeIndex'),v.value))+b'R'
        elif v.kind == 'slice':prefix=emit(symbol('builtins slice'))+emit(v.value)+b'R'
        else:raise AssertionError('Bad test fixture')
        slot=len(memo);memo[key]=slot;prefix+=b'r'+struct.pack('<I',slot)
        if type(v) is list:return prefix+b'('+b''.join(emit(x) for x in v)+b'e'
        if type(v) is dict:return prefix+b'('+b''.join(emit(k)+emit(x) for k,x in v.items())+b'u'
        return prefix+(emit(v.state)+b'b' if v.state is not None else b'')
    raw=b'\x80\x03'+emit(value)+b'.'
    return gzip.compress(raw,mtime=0) if compressed else raw


class PandaSetReaderTests(unittest.TestCase):
    def table(self, kind='points', rows=3, change=lambda r:None):
        frame,expected=_panda_fixture_table(kind,rows);change(frame)
        return converter.read_pandaset_table(_panda_fixture_bytes(frame),kind),expected

    def refused(self, change, kind='points', rows=3):
        with self.assertRaises(converter.ConversionError):self.table(kind,rows,change)

    def test_pandaset_known_float64_and_sensor_values_keep_order_and_all_columns(self):
        out,expected=self.table()
        self.assertEqual(out['rowCount'],3);self.assertEqual(tuple(expected),out['columnNames'])
        self.assertEqual(out['columns'],{k:tuple(v) for k,v in expected.items()})
        self.assertFalse(out['targetsExecuted']);self.assertFalse(out['dataframesConstructed'])

    def test_pandaset_unknown_columns_nan_boolean_unicode_and_duplicate_ids_are_preserved(self):
        out,expected=self.table('cuboids')
        self.assertEqual(out['columns']['uuid'],('same-id',)*3)
        self.assertEqual(out['columns']['stationary'],(True,False,True))
        self.assertTrue(math.isnan(out['columns']['unknown.column'][0]));self.assertEqual(out['columns']['unknown.column'][1],'kept-α')

    def test_pandaset_slice_placements_keep_original_column_order(self):
        def change(r):
            blocks=r.state['_data'].state[3]['0.14.1']['blocks']
            blocks[0]['mgr_locs']=_PandaFixture('slice',(0,5,1));blocks[1]['mgr_locs']=_PandaFixture('slice',(5,6,1))
        out,expected=self.table(change=change);self.assertEqual(out['columns'],{k:tuple(v) for k,v in expected.items()})

    def test_pandaset_empty_cuboids_are_supported_and_empty_points_rejected(self):
        out,_=self.table('cuboids',0);self.assertEqual(out['rowCount'],0)
        self.refused(lambda r:None,rows=0)

    def test_pandaset_exact_point_limit_is_supported_without_sampling(self):
        out,_=self.table(rows=200000);self.assertEqual(out['rowCount'],200000);self.assertEqual(len(out['columns']['d']),200000)

    def test_pandaset_point_and_annotation_row_limits_fail_without_drops(self):
        self.refused(lambda r:None,rows=200001);self.refused(lambda r:None,kind='cuboids',rows=101)

    def test_pandaset_wrong_byte_order_dtype_flags_shape_and_fortran_fail(self):
        def array(r):return r.state['_data'].state[1][0]
        def endian(r):array(r).state[2].state=(3,'>',None,None,None,-1,-1,0)
        def flags(r):array(r).state[2].state=(3,'<',None,None,None,-1,-1,1)
        def shape(r):a=array(r);a.state=(1,(5,4),*a.state[2:])
        def fortran(r):a=array(r);a.state=(*a.state[:3],True,a.state[4])
        for fn in [endian,flags,shape,fortran]:self.refused(fn)

    def test_pandaset_numeric_payload_length_nonfinite_and_sensor_drift_fail(self):
        def short(r):a=r.state['_data'].state[1][0];a.state=(*a.state[:4],a.state[4][:-1])
        def nan(r):
            a=r.state['_data'].state[1][0];a.state=(*a.state[:4],struct.pack('<d',float('nan'))+a.state[4][8:])
        def sensor(r):
            a=r.state['_data'].state[1][1];a.state=(*a.state[:4],struct.pack('<q',2)+a.state[4][8:])
        for fn in [short,nan,sensor]:self.refused(fn)

    def test_pandaset_duplicate_columns_placements_and_missing_blocks_fail(self):
        def duplicate(r):r.state['_data'].state[0][0].value['data'].state[4][1]='x'
        def repeated(r):
            p=r.state['_data'].state[3]['0.14.1']['blocks'][1]['mgr_locs'];p.state=(*p.state[:4],struct.pack('<q',0))
        def missing(r):r.state['_data'].state[3]['0.14.1']['blocks'].pop()
        for fn in [duplicate,repeated,missing]:self.refused(fn)

    def test_pandaset_redundant_axes_values_and_block_labels_must_agree(self):
        def axes(r):r.state['_data'].state[3]['0.14.1']['axes']=list(r.state['_data'].state[0])
        def values(r):r.state['_data'].state[3]['0.14.1']['blocks'][0]['values']=copy.deepcopy(r.state['_data'].state[1][0])
        def labels(r):r.state['_data'].state[2][0].value['data'].state[4][0]='wrong'
        for fn in [axes,values,labels]:self.refused(fn)

    def test_pandaset_unknown_frame_metadata_and_noncontiguous_indices_fail(self):
        self.refused(lambda r:r.state['attrs'].update(extra='kept or rejected, never dropped'))
        self.refused(lambda r:r.state['_data'].state[0][1].value.update(start=1))
        self.refused(lambda r:r.state['_data'].state[0][1].value.update(step=2))

    def test_pandaset_cuboid_geometry_size_and_identifiers_are_validated(self):
        def size(r):
            a=r.state['_data'].state[1][1];v=bytearray(a.state[4]);struct.pack_into('<d',v,4*3*8,100);a.state=(*a.state[:4],bytes(v))
        def label(r):r.state['_data'].state[1][0].state[4][0]=''
        self.refused(size,'cuboids');self.refused(label,'cuboids')

    def test_pandaset_gzip_truncation_concatenation_bomb_and_trailing_pickle_fail(self):
        import gzip
        frame,_=_panda_fixture_table();data=_panda_fixture_bytes(frame);raw=_panda_fixture_bytes(frame,False)
        for bad in [data[:-8],data+gzip.compress(b'extra'),gzip.compress(b'x'*(16*1024*1024+1)),gzip.compress(raw+b'extra'),gzip.compress(raw[:-1])]:
            with self.assertRaises(converter.ConversionError):converter.read_pandaset_table(bad,'points')

    def test_pandaset_unsupported_protocol_opcode_global_and_call_never_execute(self):
        import gzip
        for raw in [b'\x80\x04N.',b'\x80\x03N0.',b'\x80\x03cos\nsystem\nX\x07\0\0\0SECRET!\x85R.',b'\x80\x03cnumpy\nndarray\n)R.']:
            with self.assertRaises(converter.ConversionError):converter.read_pandaset_table(gzip.compress(raw),'points')

    def test_pandaset_missing_repeated_memo_malformed_stack_and_cycles_fail(self):
        import gzip
        for raw in [b'\x80\x03h\xff.',b'\x80\x03Nr\0\0\0\0r\0\0\0\0.',b'\x80\x03t.',b'\x80\x03]q\0h\0a.']:
            with self.assertRaises(converter.ConversionError):converter.read_pandaset_table(gzip.compress(raw),'points')

    def test_pandaset_container_text_stack_memo_and_op_count_budgets_fail(self):
        import gzip
        for raw in [b'\x80\x03X'+struct.pack('<I',4097)+b'x'*4097+b'.',b'\x80\x03'+b'N'*4098+b'.',b'\x80\x03N'+b'r'+struct.pack('<I',4096)+b'.']:
            with self.assertRaises(converter.ConversionError):converter.read_pandaset_table(gzip.compress(raw),'points')

    def test_pandaset_nonprimitive_object_payload_and_unknown_scalar_types_fail(self):
        def change(r):r.state['_data'].state[1][0].state[4][0]=['unsupported']
        self.refused(change,'cuboids')

    def test_pandaset_reader_does_not_import_pickle_pandas_numpy_or_resolve_globals(self):
        import ast
        tree=ast.parse(inspect.getsource(converter));functions=[n for n in tree.body if isinstance(n,(ast.FunctionDef,ast.ClassDef)) and ('panda' in n.name.lower())]
        for node in functions:
            for n in ast.walk(node):
                if isinstance(n,(ast.Import,ast.ImportFrom)):self.fail('Reader imports an input-directed dependency')
                if isinstance(n,ast.Call) and isinstance(n.func,ast.Name):self.assertNotIn(n.func.id,{'eval','exec','getattr','__import__','compile'})


class PandaSetConversionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
        self.seq=self.root/'sequence';(self.seq/'lidar').mkdir(parents=True);(self.seq/'annotations/cuboids').mkdir(parents=True)
        self.attr=self.root/'attribution.txt';self.attr.write_bytes(b'Synthetic test attribution\n')
        (self.seq/'LICENSE.txt').write_bytes(b'Synthetic test licence\r\n')
        (self.seq/'lidar/timestamps.json').write_bytes(encoded([1.0,2.0,3.0]))
        self.poses=[{'position':{'x':0.0,'y':0.0,'z':0.0},'heading':{'w':1.0,'x':0.0,'y':0.0,'z':0.0}} for _ in range(3)]
        (self.seq/'lidar/poses.json').write_bytes(encoded(self.poses))
        self.tables={};self.source={'name':'synthetic PandaSet fixture','kind':'synthetic-test','url':'',
            'licence':'Synthetic only','attribution':'Synthetic test attribution'}
        for i in range(3):
            fid=f'{i:02}';p=b'points'+fid.encode();b=b'boxes'+fid.encode()
            (self.seq/f'lidar/{fid}.pkl.gz').write_bytes(p);(self.seq/f'annotations/cuboids/{fid}.pkl.gz').write_bytes(b)
            self.tables[p]={'rowCount':3,'columns':{'x':[9.,10.,11.],'y':[19.,20.,21.],'z':[2.,3.,4.],
                'i':[1.,2.,3.],'t':[1.,1.,1.],'d':[0,1,0]}}
            columns={'uuid':['track-A'],'label':['Car'],'yaw':[0.],'position.x':[10.],'position.y':[20.],
                'position.z':[3.],'dimensions.x':[2.],'dimensions.y':[4.],'dimensions.z':[1.],
                'unknown.attribute':[float('nan')]}
            self.tables[b]={'rowCount':1,'columnNames':tuple(columns),'columns':columns,
                'dtypes':{k:('O8' if k in ('uuid','label','unknown.attribute') else 'f8') for k in columns}}
        self.output=self.root/'clip.lrx.zip'
        patch=mock.patch.object(converter,'read_pandaset_table',side_effect=lambda b,k:copy.deepcopy(self.tables[b]))
        patch.start();self.addCleanup(patch.stop)

    def run_conversion(self, frames=None, output=None):
        return converter.convert_pandaset(sequence_dir=self.seq,frame_ids=['00'] if frames is None else frames,
            source=self.source,attribution=self.attr,output=self.output if output is None else output)

    def members(self):
        with zipfile.ZipFile(self.output) as z:return {n:z.read(n) for n in z.namelist()}

    def refused(self, frames=None):
        with self.assertRaises((converter.ConversionError,validator.ValidationError,OSError,ValueError,KeyError,TypeError)):
            self.run_conversion(frames)
        self.assertFalse(self.output.exists())

    def test_panda_convert_known_geometry_yaw_and_swapped_dimensions(self):
        r=self.run_conversion();self.assertEqual((r['pointCount'],r['boxCount']),(3,1))
        ref={'schemaVersion':'labelxr-world-boxes/v1','boxes':[{'frameId':'00','objectId':'track-A','center':[10.,20.,3.],
            'size':[4.,2.,1.],'yaw':math.pi/2}]}
        self.assertEqual(validator.validate_bundle(self.output.read_bytes(),encoded(ref))['expectedWorldBoxesChecked'],1)
        m=self.members();c=json.loads(m['labels.openlabel.json'])['openlabel']['frames']['00']['objects']['track-A']['object_data']['cuboid'][0]['val']
        self.assertAlmostEqual(c[5],math.sin(math.pi/4));self.assertEqual(c[7:],[4.,2.,1.])

    def test_panda_convert_fallback_origin_keeps_distant_point_and_all_frames(self):
        self.tables[b'points01']['columns']['x']=[-133.,0.,273.]
        r=self.run_conversion(['00','01']);self.assertEqual(r['originStrategy'],'common-clip-bounds-midpoint')
        self.assertEqual(r['sourceOrigin'][0],70.);self.assertEqual(r['pointCount'],6);self.assertEqual(r['sourceRowsDropped'],0)
        m=self.members();points=list(struct.iter_unpack('<fff',m['frames/001.pcd'].split(b'DATA binary\n',1)[1]))
        self.assertEqual([p[0]+70 for p in points],[-133.,0.,273.])

    def test_panda_convert_prefers_first_selected_pose_when_it_fits(self):
        self.poses[1]['position']['x']=5.;(self.seq/'lidar/poses.json').write_bytes(encoded(self.poses))
        r=self.run_conversion(['01']);self.assertEqual(r['sourceOrigin'],[5.,0.,0.]);self.assertEqual(r['originStrategy'],'first-selected-lidar-pose')

    def test_panda_convert_rejects_bad_frame_selection(self):
        for frames in [[],['00']*2,['01','00'],['../00'],['80'],['0'],tuple(['00']),[f'{i:02}' for i in range(11)]]:
            with self.subTest(frames=frames):self.refused(frames)

    def test_panda_convert_checks_timestamp_coverage_and_order(self):
        for times in [[1.],[1.,1.,2.],[1.,float('nan'),3.]]:
            (self.seq/'lidar/timestamps.json').write_bytes(encoded(times));self.refused(['00','01'])

    def test_panda_convert_rejects_bad_pose_identity(self):
        for value in [float('inf'),2.]:
            self.poses[0]['heading']['w']=value;(self.seq/'lidar/poses.json').write_bytes(encoded(self.poses));self.refused()

    def test_panda_convert_refuses_duplicate_uuid_without_deduplication(self):
        b=self.tables[b'boxes00'];b['rowCount']=2
        for k in b['columns']:b['columns'][k]*=2
        self.refused()

    def test_panda_convert_refuses_tracked_class_change(self):
        self.tables[b'boxes01']['columns']['label']=['Pedestrian'];self.refused(['00','01'])

    def test_panda_convert_preserves_all_annotation_cells_including_nan_bits(self):
        self.run_conversion();v=json.loads(self.members()['labels.openlabel.json'])['openlabel']['frames']['00']['objects']['track-A']['pandaset']
        self.assertEqual(v['columnOrder'],list(self.tables[b'boxes00']['columnNames']))
        cell=v['original']['unknown.attribute']['cell'];self.assertEqual(cell,{'type':'float64-le','bits':struct.pack('<d',float('nan')).hex()})
        self.assertEqual(v['original']['uuid']['cell'],{'type':'str','value':'track-A'})

    def test_panda_convert_discloses_source_only_point_attributes_and_exact_digests(self):
        self.run_conversion();v=json.loads(self.members()['labels.openlabel.json'])['openlabel']['metadata']['pandaset_conversion']
        self.assertEqual(v['canonicalPointColumns'],['x','y','z']);self.assertEqual(v['sourcePointColumns'],['x','y','z','i','t','d'])
        self.assertEqual(v['sourceOnlyPointAttributeSha256']['00']['d'],hashlib.sha256(struct.pack('<3q',0,1,0)).hexdigest())
        self.assertIn('remain in unchanged raw source',v['pointAttributeDisclosure'])

    def test_panda_convert_deterministic_output_names_and_no_private_path_leak(self):
        self.run_conversion();other=self.root/'other.zip';self.run_conversion(output=other)
        self.assertEqual(self.output.read_bytes(),other.read_bytes());self.assertNotIn(str(self.root).encode(),self.output.read_bytes())

    def test_panda_convert_input_change_before_publish_leaves_no_output(self):
        original=converter.read;seen=0
        def changed(path,limit,member):
            nonlocal seen
            data=original(path,limit,member)
            if member=='lidar/00.pkl.gz':
                seen+=1
                if seen==2:return data+b'x'
            return data
        with mock.patch.object(converter,'read',changed):self.refused()

    def test_panda_convert_licence_bytes_retained_and_invalid_rights_refused(self):
        p=self.seq/'LICENSE.txt';original=p.read_bytes();self.run_conversion();self.assertEqual(self.members()['LICENSE.txt'],original);self.output.unlink()
        for data in [b'',b' ',b'\xff',b'rights\x00']:p.write_bytes(data);self.refused()

    def test_panda_convert_attribution_required(self):
        self.attr.write_bytes(b'');self.refused()

    def test_panda_convert_existing_output_is_never_overwritten(self):
        self.output.write_bytes(b'existing')
        with self.assertRaises(converter.ConversionError):self.run_conversion()
        self.assertEqual(self.output.read_bytes(),b'existing')

    def test_panda_convert_atomic_publication_race_keeps_other_writer(self):
        link=converter.os.link
        def raced(a,b):Path(b).write_bytes(b'racer');return link(a,b)
        with mock.patch.object(converter.os,'link',raced),self.assertRaises(FileExistsError):self.run_conversion()
        self.assertEqual(self.output.read_bytes(),b'racer');self.assertFalse(list(self.root.glob('.labelxr-owned-*')))

    def test_panda_convert_span_exceeding_product_bounds_is_refused(self):
        self.tables[b'points00']['columns']['x']=[-251.,0.,251.];self.refused()

    def test_panda_convert_cli_success_and_bounded_failure(self):
        source=self.root/'source.json';source.write_bytes(encoded(self.source))
        args=['--sequence-dir',str(self.seq),'--frames','00','--source',str(source),'--attribution',str(self.attr),'--out',str(self.output)]
        out=io.StringIO()
        with mock.patch.object(sys,'stdout',out):self.assertEqual(converter.pandaset_main(args),0)
        self.assertTrue(json.loads(out.getvalue())['converted'])
        out=io.StringIO()
        with mock.patch.object(sys,'stderr',out):self.assertEqual(converter.pandaset_main(args),1)
        self.assertFalse(json.loads(out.getvalue())['converted']);self.assertNotIn(str(self.seq),out.getvalue())

    def test_panda_convert_large_world_coordinates_reconstruct_within_one_millimetre(self):
        self.poses[0]['position']['x']=1e7;(self.seq/'lidar/poses.json').write_bytes(encoded(self.poses))
        self.tables[b'points00']['columns']['x']=[1e7+.123456,1e7+2.123456,1e7+3.123456]
        self.tables[b'boxes00']['columns']['position.x']=[1e7+1.]
        r=self.run_conversion();self.assertEqual(r['sourceOrigin'][0],1e7)
        points=list(struct.iter_unpack('<fff',self.members()['frames/000.pcd'].split(b'DATA binary\n',1)[1]))
        for p,q in zip(points,self.tables[b'points00']['columns']['x']):self.assertLessEqual(abs(p[0]+1e7-q),.001)

    def test_panda_convert_unsupported_raw_annotation_cell_fails_instead_of_dropping(self):
        self.tables[b'boxes00']['columns']['unknown.attribute']=[['unsupported']];self.refused()


def main():
    global SUPPLIED_FIXTURE
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--fixture", required=True)
    args = parser.parse_args(); SUPPLIED_FIXTURE = args.fixture
    suite = unittest.TestSuite([*unittest.defaultTestLoader.loadTestsFromTestCase(ValidatorTests),
                               *unittest.defaultTestLoader.loadTestsFromTestCase(ConversionTests),
                               *unittest.defaultTestLoader.loadTestsFromTestCase(PandaSetReaderTests),
                               *unittest.defaultTestLoader.loadTestsFromTestCase(PandaSetConversionTests)])
    names = [t.id().split(".")[-1] for t in suite]
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    receipt = {"schema": "labelxr-python-pandaset-conversion-tests/v1", "passed": result.wasSuccessful() and not result.skipped and result.testsRun == len(names), "count": result.testsRun, "tests": names, "failed": len(result.failures), "errors": len(result.errors), "skipped": len(result.skipped), "pythonVersion": sys.version.split()[0], "validatorSha256": hashlib.sha256((HERE / "validate.py").read_bytes()).hexdigest(), "converterSha256": hashlib.sha256((HERE / "convert.py").read_bytes()).hexdigest(), "testSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "fixtureSha256": hashlib.sha256(Path(SUPPLIED_FIXTURE).read_bytes()).hexdigest()}
    with open(args.receipt, "x", encoding="utf-8", newline="\n") as stream:
        json.dump(receipt, stream, sort_keys=True); stream.write("\n")
    print(json.dumps(receipt, sort_keys=True))
    return 0 if receipt["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
