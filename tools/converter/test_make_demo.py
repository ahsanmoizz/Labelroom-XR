"""Synthetic regression cases for controlled demo generation, not live evidence."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from test_converter import fixture, pack, encoded

HERE = Path(__file__).absolute().parent
spec = importlib.util.spec_from_file_location("labelxr_demo_generator", HERE / "make_demo.py")
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)


class DemoGenerationTests(unittest.TestCase):
    def setUp(self):
        self.members, self.manifest, self.labels = fixture(2, "box-A")
        root = self.labels["openlabel"]
        for name in ("box-B", "box-C"):
            root["objects"][name] = copy.deepcopy(root["objects"]["box-A"])
            for frame in root["frames"].values():
                frame["objects"][name] = copy.deepcopy(frame["objects"]["box-A"])
        self.plan = json.loads((HERE / "demo-fault-plan.example.json").read_text())

    def source(self):
        return pack(self.members, self.manifest, self.labels)

    def run_generator(self):
        return demo.generate(self.source(), encoded(self.plan))

    def test_exact_faults_unchanged_points_metadata_rights_and_world_references(self):
        original = self.source()
        original_labels = copy.deepcopy(self.labels)
        out = demo.generate(original, encoded(self.plan))
        source = demo.validator.read_archive(original)
        changed = demo.validator.read_archive(out["demo.lrx.zip"])
        self.assertEqual(self.labels, original_labels)
        self.assertEqual(changed["LICENSE.txt"], source["LICENSE.txt"])
        for frame in self.manifest["frames"]:
            self.assertEqual(changed[frame["pcd"]], source[frame["pcd"]])
        data = json.loads(changed["labels.openlabel.json"])
        expected = copy.deepcopy(self.labels)
        frames = expected["openlabel"]["frames"]
        frames["0"]["objects"]["box-A"]["object_data"]["cuboid"][0]["val"][0] += .4
        expected["openlabel"]["objects"]["demo-duplicate-B"] = copy.deepcopy(expected["openlabel"]["objects"]["box-B"])
        frames["0"]["objects"]["demo-duplicate-B"] = copy.deepcopy(frames["0"]["objects"]["box-B"])
        frames["1"]["objects"]["box-C"]["object_data"]["cuboid"][0]["val"][7] *= 1.4
        self.assertEqual(data, expected)
        self.assertNotIn("demo-duplicate-B", data["openlabel"]["frames"]["1"]["objects"])
        check = demo.validator.validate_bundle(out["demo.lrx.zip"], out["demo-world-boxes.json"])
        self.assertEqual(check["boxCount"], 7)
        demo.validator.validate_bundle(original, out["baseline-world-boxes.json"])
        disclosure = json.loads(out["review-demo-faults.json"])
        self.assertTrue(disclosure["injected"])
        self.assertEqual(disclosure["sourceKind"], "synthetic-test")
        self.assertEqual(len(disclosure["faults"]), 3)
        self.assertEqual(disclosure["demoBundleSha256"], demo.digest(out["demo.lrx.zip"]))
        self.assertIn(demo.MARKER.encode(), changed["ATTRIBUTION.txt"])
        self.assertTrue(changed["ATTRIBUTION.txt"].startswith(source["ATTRIBUTION.txt"]))
        manifest = json.loads(changed["manifest.json"])
        self.assertIn(demo.MARKER, manifest["source"]["attribution"])
        for key in ("kind", "licence", "url", "sha256", "name"):
            self.assertEqual(manifest["source"][key], self.manifest["source"][key])

    def test_output_is_byte_deterministic_and_source_objects_are_not_mutated(self):
        before = copy.deepcopy(self.labels)
        source, plan = self.source(), encoded(self.plan)
        self.assertEqual(demo.generate(source, plan), demo.generate(source, plan))
        self.assertEqual(self.labels, before)

    def test_negative_offset_and_other_axes(self):
        self.plan["offset"].update(axis="z", metres=-.4)
        self.plan["dimensionJump"].update(axis="y")
        out = self.run_generator()
        f = json.loads(out["review-demo-faults.json"])["faults"]
        self.assertEqual(f[0]["demoCuboid"][2], f[0]["baselineCuboid"][2] - .4)
        self.assertEqual(f[2]["demoCuboid"][8], f[2]["baselineCuboid"][8] * 1.4)

    def test_rejects_bad_ids_unknown_fields_nan_boolean_and_confounded_targets(self):
        bad = []
        for item in ("offset", "duplicate", "dimensionJump"):
            value = copy.deepcopy(self.plan); value[item]["objectId"] = "missing"; bad.append(value)
        value = copy.deepcopy(self.plan); value["extra"] = True; bad.append(value)
        value = copy.deepcopy(self.plan); value["offset"]["metres"] = float("nan"); bad.append(value)
        value = copy.deepcopy(self.plan); value["dimensionJump"]["factor"] = True; bad.append(value)
        value = copy.deepcopy(self.plan); value["offset"]["axis"] = "yaw"; bad.append(value)
        value = copy.deepcopy(self.plan); value["offset"]["metres"] = .5; bad.append(value)
        value = copy.deepcopy(self.plan); value["duplicate"]["duplicateId"] = "box-C"; bad.append(value)
        value = copy.deepcopy(self.plan); value["offset"]["objectId"] = "box-B"; bad.append(value)
        for plan in bad:
            with self.subTest(plan=plan):
                with self.assertRaises((demo.DemoError, demo.validator.ValidationError)):
                    demo.generate(self.source(), encoded(plan))

    def test_rejects_missing_or_distant_previous_track_and_existing_jump(self):
        for mode in ("first", "missing", "distant", "already-jumped", "no-new-jump"):
            saved = copy.deepcopy((self.labels, self.manifest, self.plan))
            with self.subTest(mode=mode):
                if mode == "first": self.plan["dimensionJump"]["frameId"] = "0"
                if mode == "missing": del self.labels["openlabel"]["frames"]["0"]["objects"]["box-C"]
                if mode == "distant":
                    self.manifest["frames"][1]["timestamp"] = 10
                    self.labels["openlabel"]["frames"]["1"]["frame_properties"]["timestamp"] = 10
                val = self.labels["openlabel"]["frames"]["1"]["objects"]["box-C"]["object_data"]["cuboid"][0]["val"]
                if mode == "already-jumped": val[7] = 8
                if mode == "no-new-jump": val[7] = 3.6; self.plan["dimensionJump"]["factor"] = 1.21
                with self.assertRaises(demo.DemoError): self.run_generator()
            self.labels, self.manifest, self.plan = saved

    def test_refuses_historical_audit_and_repeated_injection(self):
        self.members["audit.json"] = b"[]"
        with self.assertRaises(demo.DemoError): self.run_generator()
        del self.members["audit.json"]
        out = self.run_generator()
        with self.assertRaises(demo.DemoError): demo.generate(out["demo.lrx.zip"], encoded(self.plan))

    def test_revalidates_ceilings_and_detects_corrupt_source_hash(self):
        self.plan["dimensionJump"]["factor"] = 2
        with self.assertRaises(demo.DemoError): self.run_generator()
        self.plan["dimensionJump"]["factor"] = 1.4
        raw = demo.validator.read_archive(self.source())
        raw["frames/000.pcd"] += b"bad"
        with self.assertRaises(demo.validator.ValidationError): demo.generate(demo.archive(raw), encoded(self.plan))
        self.manifest["source"]["attribution"] = "a" * 4090
        with self.assertRaises(demo.validator.ValidationError): self.run_generator()

    def test_never_overwrites_input_or_existing_output_and_cli_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); source = root / "source.lrx.zip"; plan = root / "plan.json"; out = root / "new-demo"
            source_bytes = self.source()
            source.write_bytes(source_bytes); plan.write_bytes(encoded(self.plan))
            args = [sys.executable, str(HERE / "make_demo.py"), str(source), "--plan", str(plan), "--output-dir", str(out)]
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)["pointBytesUnchanged"])
            self.assertFalse(json.loads(result.stdout)["rightsVerified"])
            self.assertEqual(source.read_bytes(), source_bytes)
            validator = subprocess.run([sys.executable, str(HERE / "validate.py"), str(out / "demo.lrx.zip"), "--expected", str(out / "demo-world-boxes.json")], capture_output=True, text=True)
            self.assertEqual(validator.returncode, 0, validator.stderr)
            snapshot = {f.name: f.read_bytes() for f in out.iterdir()}
            self.assertNotEqual(subprocess.run(args, capture_output=True).returncode, 0)
            self.assertEqual({f.name: f.read_bytes() for f in out.iterdir()}, snapshot)
            with self.assertRaises(FileExistsError): demo.write_outputs(source, {})

    def test_redirected_output_parent_and_input_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); actual = root / "actual"; actual.mkdir(); link = root / "redirect"
            try: link.symlink_to(actual, target_is_directory=True)
            except (OSError, NotImplementedError): self.skipTest("Symlinks unavailable")
            with self.assertRaises(demo.DemoError): demo.write_outputs(link / "new", {"a": b"x"})
            (actual / "source.zip").write_bytes(self.source())
            with self.assertRaises(demo.validator.ValidationError): demo.validator.read_regular(link / "source.zip", demo.validator.COMPRESSED_LIMIT)


if __name__ == "__main__":
    unittest.main()
