import unittest

from bubble_gateway.display_evidence import pair_display


class DisplayEvidenceTests(unittest.TestCase):
    capture_sha = "a" * 64

    def setUp(self):
        events = [dict(event="notification", session=1, sequence=sequence, atMs=sequence * 100,
                       buttonState=button, buttonPresses=presses)
                  for sequence, (button, presses) in enumerate([
                      ("released", [2, 1]), ("confirm", [3, 1]), ("released", [3, 1]),
                      ("panic", [3, 2]), ("released", [3, 2]),
                  ], start=20)]
        self.capture = {
            "version": 1, "mode": "bringup", "hardware": "r18-pcb", "boardRevision": "r18-hand-solder",
            "firmwareRevision": "keyring-0.7.17-st7789-bringup", "status": "RECORDED", "durationMs": 3000,
            "bringup": {"session": 1, "usbBoot": {"sameBoot": True, "displayProfile": "st7789", "logSha256": "b" * 64},
                        "buttonSequences": [20, 21, 22, 23, 24],
                        "displayTest": {"profile": "st7789", "buttonFramesMatched": True}},
            "events": events,
        }
        confirm = {"button": "confirm", "releaseSequence": 22, "panelLabel": "ST7789 LCD", "screenText": "CONFIRM",
                   "borderVisible": True, "colorOrder": ["red", "green", "blue"], "displaySize": [240, 240],
                   "mediaOffsetMs": None}
        panic = dict(confirm, button="panic", releaseSequence=24, screenText="PANIC")
        self.notes = {"version": 1, "captureSha256": self.capture_sha, "observations": [confirm, panic]}
        self.media = ({"bytes": 300, "sha256": "c" * 64}, {"bytes": 301, "sha256": "d" * 64})

    def test_release_sequences_and_observer_result_are_reported_separately_from_software(self):
        self.capture["bringup"]["displayTest"]["buttonFramesMatched"] = False
        report = pair_display(self.capture, self.capture_sha, self.notes, self.media)
        self.assertEqual(report["operatorObservationStatus"], "MATCHED")
        self.assertFalse(report["buttonFramesMatched"])
        self.assertEqual([row["pressSequence"] for row in report["observations"]], [21, 23])
        self.assertEqual([row["releaseAtMs"] for row in report["observations"]], [2200, 2400])

        panic = self.notes["observations"][1]
        panic["screenText"] = None
        self.assertEqual(pair_display(self.capture, self.capture_sha, self.notes, self.media)["operatorObservationStatus"],
                         "INSUFFICIENT")
        panic["screenText"] = "CONFIRM"
        report = pair_display(self.capture, self.capture_sha, self.notes, self.media)
        self.assertEqual(report["operatorObservationStatus"], "MISMATCH")
        self.assertEqual(report["observations"][1]["mismatches"], ["screenText"])

    def test_requires_same_capture_boot_and_a_release_in_the_selected_session(self):
        with self.assertRaisesRegex(ValueError, "exact capture"):
            pair_display(self.capture, "f" * 64, self.notes, self.media)
        self.notes["observations"][0]["releaseSequence"] = 21
        with self.assertRaisesRegex(ValueError, "release sequence"):
            pair_display(self.capture, self.capture_sha, self.notes, self.media)
        self.notes["observations"][0]["releaseSequence"] = 22
        self.capture["events"][2]["session"] = 2
        with self.assertRaisesRegex(ValueError, "complete button sequence"):
            pair_display(self.capture, self.capture_sha, self.notes, self.media)
        self.capture["bringup"]["usbBoot"]["sameBoot"] = False
        with self.assertRaisesRegex(ValueError, "same USB boot"):
            pair_display(self.capture, self.capture_sha, self.notes, self.media)

    def test_shared_video_requires_two_distinct_increasing_offsets(self):
        media = (self.media[0], self.media[0])
        confirm, panic = self.notes["observations"]
        for first, second in ((None, None), (400, 400), (500, 400)):
            confirm["mediaOffsetMs"], panic["mediaOffsetMs"] = first, second
            with self.subTest(first=first, second=second), self.assertRaisesRegex(ValueError, "increasing video offsets"):
                pair_display(self.capture, self.capture_sha, self.notes, media)
        confirm["mediaOffsetMs"], panic["mediaOffsetMs"] = 400, 500
        report = pair_display(self.capture, self.capture_sha, self.notes, media)
        self.assertEqual(report["operatorObservationStatus"], "MATCHED")
