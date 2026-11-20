import unittest

from bubble_gateway.power_evidence import pair_measurements


class PowerEvidenceTests(unittest.TestCase):
    capture_sha = "a" * 64

    def setUp(self):
        ina219 = {"status": "ok", "busVoltageMv": 3300, "currentUa": 25000, "loadPowerUw": 82500,
                  "shuntVoltageUv": 2500, "readUptimeMs": 700}
        event = {"event": "notification", "session": 1, "sequence": 8, "deviceUptimeMs": 710,
                 "atMs": 450, "ina219": ina219}
        self.capture = {"version": 1, "mode": "bringup", "hardware": "r18-pcb", "boardRevision": "r18-hand-solder",
                        "firmwareRevision": "keyring-0.7.15-bringup", "status": "INSUFFICIENT", "durationMs": 1000,
                        "bringup": {"session": 1, "usbBoot": {"sameBoot": True, "logSha256": "b" * 64}},
                        "events": [event, dict(event, session=2, sequence=12, atMs=700)]}
        self.reading = {"sequence": 8, "readUptimeMs": 700, "point": "load-3v3", "voltageMv": 3290, "currentUa": 26000}
        self.meter = {"version": 1, "captureSha256": self.capture_sha, "readings": [self.reading]}

    def test_compares_only_load_side_readings(self):
        self.capture["bringup"]["assemblyEvidence"] = {"recordSha256": "d" * 64, "boardTag": "r18-01"}
        self.meter["readings"] += [dict(self.reading, point="usb-input", voltageMv=5000),
                                   dict(self.reading, point="battery-terminal", voltageMv=3800, currentUa=None)]
        report = pair_measurements(self.capture, self.capture_sha, self.meter)
        self.assertEqual(report["captureStatus"], "INSUFFICIENT")
        self.assertEqual(report["assemblyRecordSha256"], "d" * 64)
        self.assertNotIn("r18-01", str(report))
        self.assertEqual(report["readings"][0]["meterMinusIna219"], {"voltageMv": -10, "currentUa": 1000})
        for reading in report["readings"][1:]:
            self.assertNotIn("meterMinusIna219", reading)
            self.assertNotIn("ina219", reading)

    def test_repeated_notifications_cannot_supply_two_readings_at_one_sample_and_point(self):
        event = self.capture["events"][0]
        replay = dict(event, sequence=9, atMs=500, ina219=dict(event["ina219"]))
        self.capture["events"].insert(1, replay)
        self.meter["readings"].append(dict(self.reading, sequence=9))
        with self.assertRaisesRegex(ValueError, "Duplicate meter reading"):
            pair_measurements(self.capture, self.capture_sha, self.meter)

        self.meter["readings"][1]["point"] = "usb-input"
        self.assertEqual(len(pair_measurements(self.capture, self.capture_sha, self.meter)["readings"]), 2)

        replay["ina219"].update(currentUa=30000, loadPowerUw=99000, shuntVoltageUv=3000)
        with self.assertRaisesRegex(ValueError, "Conflicting INA219 readings"):
            pair_measurements(self.capture, self.capture_sha, self.meter)

    def test_requires_exact_capture_and_sample_in_first_session(self):
        for reading in (dict(self.reading, sequence=12), dict(self.reading, readUptimeMs=699)):
            with self.subTest(reading=reading), self.assertRaisesRegex(ValueError, "no matching INA219"):
                pair_measurements(self.capture, self.capture_sha, dict(self.meter, readings=[reading]))
        with self.assertRaisesRegex(ValueError, "exact capture"):
            pair_measurements(self.capture, "c" * 64, self.meter)
        self.capture["bringup"]["usbBoot"]["sameBoot"] = False
        with self.assertRaisesRegex(ValueError, "matching USB and BLE boot"):
            pair_measurements(self.capture, self.capture_sha, self.meter)
