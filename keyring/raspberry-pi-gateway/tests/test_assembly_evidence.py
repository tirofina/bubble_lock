import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from bubble_gateway.assembly_evidence import DESIGN_FILES, assembly_reference, record_assembly


class AssemblyEvidenceTests(unittest.TestCase):
    def test_preserves_unknown_assembly_revision_and_binds_photos_to_the_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = []
            for name in DESIGN_FILES:
                data = name.encode("ascii")
                source = root / name
                source.parent.mkdir(exist_ok=True)
                source.write_bytes(data)
                files.append({"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
            inventory = root / "source-inventory.json"
            inventory.write_text(json.dumps({"inventoryVersion": 1, "documentRevision": "2.0.0",
                                             "boardRevision": "privacy_bubble_r18_hand_solder", "files": files}),
                                 encoding="utf-8")
            notes, front, back = (root / name for name in ("notes.json", "front.bin", "back.bin"))
            notes.write_text(json.dumps({"version": 1, "boardTag": "r18-01", "assemblyRevision": None,
                                         "revisionSource": "unknown", "population": "bare", "lcdModel": "st7789"}),
                             encoding="utf-8")
            front.write_bytes(b"front view fixture")
            back.write_bytes(b"back view fixture")
            record = record_assembly(inventory, notes, front, back)
            receipt = root / "assembly.json"
            receipt.write_text(json.dumps(record), encoding="utf-8")
            reference = assembly_reference(receipt, "r18-01", "r18-hand-solder", "st7789")
            self.assertIsNone(reference["assemblyRevision"])
            self.assertEqual(reference["recordSha256"], hashlib.sha256(receipt.read_bytes()).hexdigest())
            with self.assertRaisesRegex(ValueError, "board tag"):
                assembly_reference(receipt, "r18-02", "r18-hand-solder", "st7789")
            with self.assertRaisesRegex(ValueError, "LCD model"):
                assembly_reference(receipt, "r18-01", "r18-hand-solder", "jd9853")
            with self.assertRaisesRegex(ValueError, "separate views"):
                record_assembly(inventory, notes, front, front)
            (root / DESIGN_FILES[0]).write_bytes(b"another design")
            with self.assertRaisesRegex(ValueError, "source inventory does not match"):
                record_assembly(inventory, notes, front, back)
