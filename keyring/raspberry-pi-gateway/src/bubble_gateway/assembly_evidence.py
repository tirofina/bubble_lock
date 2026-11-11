"""Record operator-observed r18 assembly identity and its reference files."""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from .ble import BleProtocolError
from .config import ID
from .display_evidence import media_fingerprint
from .model import canonical, iso_time
from .power_evidence import METER_LIMIT, SHA256, read_json

BOARD_REVISION = "r18-hand-solder"
INVENTORY_BOARD = "privacy_bubble_r18_hand_solder"
DOCUMENT_REVISION = "2.0.0"
INVENTORY_LIMIT = 512 * 1024
DESIGN_FILES = (
    "privacy_bubble.kicad_pro", "privacy_bubble.kicad_sch", "privacy_bubble.kicad_pcb",
    "working_data/BOM_by_reference.csv", "external_parts/Connector_pinout.csv",
)
NOTE_FIELDS = {"version", "boardTag", "assemblyRevision", "revisionSource", "population", "lcdModel"}


def validate_notes(notes: dict) -> None:
    if (not isinstance(notes, dict) or set(notes) != NOTE_FIELDS or type(notes["version"]) is not int or notes["version"] != 1
            or not isinstance(notes["boardTag"], str) or not ID.fullmatch(notes["boardTag"])):
        raise ValueError("Invalid r18 assembly note format or board tag")
    revision, source = notes["assemblyRevision"], notes["revisionSource"]
    if (source not in ("silkscreen", "assembly-record", "unknown") or (revision is None) != (source == "unknown")
            or (revision is not None and (not isinstance(revision, str) or not 1 <= len(revision) <= 64
                                         or not revision.strip() or not revision.isprintable()))
            or notes["population"] not in ("bare", "partial", "assembled", "unknown")
            or notes["lcdModel"] not in ("none", "st7789", "jd9853", "unknown")):
        raise ValueError("Invalid r18 assembly revision or operator observations")


def _valid_fingerprint(value) -> bool:
    return (isinstance(value, dict) and set(value) == {"bytes", "sha256"} and type(value["bytes"]) is int
            and value["bytes"] > 0 and isinstance(value["sha256"], str) and SHA256.fullmatch(value["sha256"]) is not None)


def record_assembly(inventory_path: Path, notes_path: Path, front: Path, back: Path) -> dict:
    inventory, inventory_sha = read_json(inventory_path, INVENTORY_LIMIT)
    if (type(inventory.get("inventoryVersion")) is not int or inventory["inventoryVersion"] != 1
            or inventory.get("documentRevision") != DOCUMENT_REVISION or inventory.get("boardRevision") != INVENTORY_BOARD):
        raise ValueError("Expected the DOC-REV 2.0.0 r18 source inventory")
    notes, notes_sha = read_json(notes_path, METER_LIMIT)
    validate_notes(notes)
    entries = {}
    for entry in inventory["files"]:
        name = entry["path"]
        if name in DESIGN_FILES:
            if name in entries:
                raise ValueError("Duplicate r18 source inventory path")
            entries[name] = {key: entry[key] for key in ("bytes", "sha256")}
    for name in DESIGN_FILES:
        expected = entries.get(name)
        if not _valid_fingerprint(expected) or media_fingerprint(inventory_path.parent / name) != expected:
            raise ValueError(f"r18 source inventory does not match {name}")
    photos = {"front": media_fingerprint(front), "back": media_fingerprint(back)}
    if photos["front"]["sha256"] == photos["back"]["sha256"]:
        raise ValueError("Supply separate views of the front and back of the tagged board")
    return {"version": 1, "recordedAt": iso_time(), "boardRevision": BOARD_REVISION, "observationSource": "operator",
            "designInventorySha256": inventory_sha, "designFiles": entries, "notesSha256": notes_sha,
            "assembly": notes, "photos": photos}


def assembly_reference(path: Path, board_tag: str, board_revision: str, display_profile: str | None) -> dict:
    record, digest = read_json(path, METER_LIMIT)
    notes, design, photos = (record[key] for key in ("assembly", "designFiles", "photos"))
    validate_notes(notes)
    if (type(record.get("version")) is not int or record["version"] != 1
            or board_revision != BOARD_REVISION or record.get("boardRevision") != board_revision
            or record.get("observationSource") != "operator" or notes["boardTag"] != board_tag
            or not isinstance(record.get("designInventorySha256"), str) or not SHA256.fullmatch(record["designInventorySha256"])
            or not isinstance(design, dict) or set(design) != set(DESIGN_FILES)
            or not all(_valid_fingerprint(value) for value in design.values())
            or not isinstance(photos, dict) or set(photos) != {"front", "back"}
            or not all(_valid_fingerprint(value) for value in photos.values())
            or photos["front"]["sha256"] == photos["back"]["sha256"]):
        raise ValueError("Assembly record does not match the operator's r18 board tag")
    if display_profile is not None and notes["lcdModel"] in ("st7789", "jd9853") and notes["lcdModel"] != display_profile:
        raise ValueError("Assembly LCD model differs from the recorded bring-up display")
    return {"recordSha256": digest, "association": "operator-board-tag", "boardTag": board_tag,
            "assemblyRevision": notes["assemblyRevision"], "revisionSource": notes["revisionSource"],
            "designInventorySha256": record["designInventorySha256"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", type=Path, required=True)
    parser.add_argument("--notes", type=Path, required=True)
    parser.add_argument("--front", type=Path, required=True)
    parser.add_argument("--back", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        record = record_assembly(args.inventory, args.notes, args.front, args.back)
        os.umask(0o077)
        with args.output.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(canonical(record) + "\n")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, BleProtocolError) as error:
        parser.exit(1, f"Assembly evidence recording stopped ({type(error).__name__}).\n")


if __name__ == "__main__":
    main()
