"""Connection replacement races using fake GATT clients; no scanner or radio."""
import asyncio
import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from bubble_gateway.ble import BleFleet, BleProtocolError, BleUnavailable
from bubble_gateway.ble_characterize import read_firmware_image, read_usb_boot, summarize
from bubble_gateway.model import payload_hash
from helpers import command, config, device_receipt


class WakeCaptureTests(unittest.TestCase):
    def test_requires_a_new_boot_and_the_expected_button_mask(self):
        board = "r18-hand-solder"

        def frame(kind, at, phase, boot, **fields):
            return dict(event=kind, atNs=at * 1_000_000, phase=phase, generation=1,
                        bootId=boot, boardRevision=board, **fields)

        ready = {"advertisingRssiDbm": None, "advertisingAgeMs": None}
        for boot, pins, status in (("boot-after", 64, "RECORDED"), ("boot-before", 64, "INSUFFICIENT"),
                                   ("boot-after", 128, "INSUFFICIENT"), ("boot-after", 192, "INSUFFICIENT")):
            with self.subTest(boot=boot, pins=pins):
                events = [
                    frame("ready", 1, "baseline", "boot-before", **ready),
                    frame("notification", 2, "baseline", "boot-before", sequence=1),
                    frame("ready", 20, "after-wake", boot, **ready),
                    frame("notification", 21, "after-wake", boot, sequence=2,
                          wakeCause="button", wakePins=pins, deviceUptimeMs=700),
                ]
                report = summarize(events, 0, 30_000_000, board=board, mode="wake", truncated=False,
                                   dropped=0, expected_wake="confirm", release_ms=5)
                self.assertEqual(report["status"], status)
                self.assertEqual(len(report["sessions"]), 2)
                self.assertEqual(report["wake"]["releaseToFirstNotificationMs"], 16)
                if status == "RECORDED":
                    self.assertEqual(report["wake"]["bootIdSha256"], hashlib.sha256(boot.encode()).hexdigest())
                    self.assertEqual(report["wake"]["sequence"], 2)
                    self.assertNotIn(boot, json.dumps(report))
                else:
                    self.assertNotIn("bootIdSha256", report["wake"])

    def test_power_capture_deduplicates_same_boot_and_requires_first_wake_boot(self):
        board = "r18-hand-solder"

        def frame(kind, at, phase, boot, generation, **fields):
            return dict(event=kind, atNs=at * 1_000_000, phase=phase, generation=generation,
                        bootId=boot, boardRevision=board, **fields)

        ready = {"advertisingRssiDbm": None, "advertisingAgeMs": None}
        sample = dict(status="ok", busVoltageMv=3300, currentUa=-100, loadPowerUw=-330,
                      shuntVoltageUv=-10, readUptimeMs=700)
        stale = dict.fromkeys(sample)
        stale["status"] = "stale"
        events = [
            frame("ready", 1, "baseline", "before", 1, **ready),
            frame("notification", 2, "baseline", "before", 1, sequence=1, ina219=sample, deviceUptimeMs=750),
            frame("lost", 3, "baseline", "before", 1),
            frame("ready", 4, "baseline", "before", 2, **ready),
            frame("notification", 5, "baseline", "before", 2, sequence=2, ina219=sample, deviceUptimeMs=800),
            frame("ready", 10, "after-wake", "first-after", 1, **ready),
            frame("notification", 11, "after-wake", "first-after", 1, sequence=1,
                  wakeCause="button", wakePins=64, deviceUptimeMs=600),
            frame("notification", 12, "after-wake", "first-after", 1, sequence=2, ina219=None, deviceUptimeMs=650),
            frame("notification", 13, "after-wake", "first-after", 1, sequence=3, ina219=stale, deviceUptimeMs=690),
            frame("ready", 20, "after-wake", "later-after", 2, **ready),
            frame("notification", 21, "after-wake", "later-after", 2, sequence=1, ina219=sample, deviceUptimeMs=750),
        ]
        options = dict(board=board, mode="wake", truncated=False, dropped=0, expected_wake="confirm", release_ms=6)
        baseline = summarize(events, 0, 30_000_000, **options)
        self.assertEqual(baseline["status"], "RECORDED")
        self.assertNotIn("power", baseline)
        self.assertTrue(all("ina219" not in row for row in baseline["events"]))

        missing = summarize(events, 0, 30_000_000, include_power=True, **options)
        self.assertEqual(missing["status"], "INSUFFICIENT")
        self.assertEqual(missing["power"], dict(uniqueValidSamples=2, repeatedValidFrames=1,
                                               invalidFrames=1, missingEnergyFrames=1, missingPhases=["after-wake"]))

        after_power = frame("notification", 14, "after-wake", "first-after", 1,
                            sequence=4, ina219=sample, deviceUptimeMs=750)
        complete_events = sorted([*events, after_power], key=lambda event: event["atNs"])
        complete = summarize(complete_events, 0, 30_000_000, include_power=True, **options)
        self.assertEqual(complete["status"], "RECORDED")
        self.assertEqual(complete["power"]["uniqueValidSamples"], 3)
        self.assertEqual([row["newPowerSample"] for row in complete["events"] if "newPowerSample" in row],
                         [True, False, True, True])


class BatteryCaptureTests(unittest.TestCase):
    def capture(self, samples, *, split_at=None, thresholds=(20, 25), mode="battery"):
        board = "r18-hand-solder"
        events = []

        def event(kind, generation, **fields):
            events.append(dict(event=kind, generation=generation, atNs=len(events) * 1_000_000,
                               bootId="same-boot", boardRevision=board, **fields))

        def ready(generation):
            event("ready", generation, advertisingRssiDbm=None, advertisingAgeMs=None)

        generation = 1
        ready(generation)
        for sequence, sample in enumerate(samples, start=1):
            if sequence == split_at:
                event("lost", generation)
                generation += 1
                ready(generation)
            fields = {} if sample is None else dict(batteryPercent=sample[0], batteryAlert=sample[1])
            event("notification", generation, sequence=sequence, **fields)
        return summarize(events, 0, len(events) * 1_000_000, board=board, mode=mode,
                         truncated=False, dropped=0, battery_thresholds=thresholds)

    def test_both_in_band_states_and_boundary_samples_in_one_session(self):
        report = self.capture([(26, False), (22, False), (20, True), (None, None), (22, True), (25, False)])
        self.assertEqual(report["status"], "RECORDED")
        self.assertEqual(report["battery"]["unknownFrames"], 1)
        cycle = report["battery"]["matchedCycle"]
        self.assertEqual([marker["stage"] for marker in cycle],
                         ["initialClear", "clearInBand", "lowAlert", "alertInBand", "recovered"])
        self.assertEqual([marker["sequence"] for marker in cycle], [1, 2, 3, 5, 6])
        self.assertEqual({marker["session"] for marker in cycle}, {1})

    def test_incomplete_sweeps_and_sessions_are_not_combined(self):
        samples = [(25, False), (22, False), (20, True), (22, True), (25, False)]
        for report in (self.capture(samples, split_at=4), self.capture(samples[:3] + samples[4:]),
                       self.capture(samples[:3] + [(22, False)] + samples[3:])):
            self.assertEqual(report["status"], "INSUFFICIENT")
            self.assertIsNone(report["battery"]["matchedCycle"])

    def test_mismatch_or_missing_field_prevents_recorded_status(self):
        samples = [(25, False), (22, False), (20, True), (22, True), (25, False)]
        for mismatch in ((20, False), (25, True)):
            report = self.capture([*samples, mismatch])
            self.assertEqual(report["status"], "MISMATCH")
            self.assertEqual(report["battery"]["mismatchedFrames"], 1)
        missing = self.capture([*samples, None])
        self.assertEqual(missing["status"], "INSUFFICIENT")
        self.assertEqual(missing["battery"]["missingAlertFrames"], 1)

    def test_custom_thresholds_and_battery_data_omitted_from_range_report(self):
        samples = [(35, False), (32, False), (30, True), (32, True), (35, False)]
        self.assertEqual(self.capture(samples, thresholds=(30, 35))["status"], "RECORDED")
        self.assertEqual(self.capture(samples)["status"], "MISMATCH")
        report = self.capture(samples, mode="range")
        self.assertNotIn("battery", report)
        self.assertTrue(all("batteryAlert" not in row and "batteryPercent" not in row for row in report["events"]))


class BringupCaptureTests(unittest.TestCase):
    board = "r18-hand-solder"
    firmware = "keyring-0.7.14-bringup"
    boot = "0123456789abcdef" * 2
    ready_sensor_status = {"batteryStatus": "ok", "accelStatus": "ok", "motion": "ready"}

    def events(self, *, split_at=None, command_ready=False):
        events = []

        def add(kind, generation, **fields):
            events.append(dict(event=kind, generation=generation, atNs=len(events) * 1_000_000,
                               bootId="private-boot", boardRevision=self.board, **fields))

        def ready(generation):
            add("ready", generation, commandReady=command_ready, advertisingRssiDbm=None, advertisingAgeMs=None)

        generation = 1
        ready(generation)
        cases = (
            ("released", [2, 1], dict(detail="sensors", batteryStatus="ok", accelStatus="ok",
                                      motion="ready", accelerationG=[0, 0, 1])),
            ("confirm", [3, 1], {}),
            ("released", [3, 1], dict(detail="energy")),
            ("panic", [3, 2], {}),
            ("released", [3, 2], dict(detail="health", power="disabled")),
        )
        for sequence, (button, presses, sensor) in enumerate(cases):
            if sequence == split_at:
                add("lost", generation)
                generation += 1
                ready(generation)
            energy = {"ina219": {"status": "ok", "readUptimeMs": 100}, "deviceUptimeMs": 150} if sequence == 2 else {}
            observation = dict(state=False, buttonState=button, battery=73, deviceId="private-device", uptimeMs=150,
                               sensorValues=dict(sensor, fault=False, journal="disabled", buttonPresses=presses,
                                                 arbitraryField="private-payload"))
            add("notification", generation, sequence=sequence, observation=observation, **energy)
        return events

    def report(self, events, *, usb_boot=None, firmware_revision=None):
        return summarize(events, 0, len(events) * 1_000_000, board=self.board, mode="bringup",
                         truncated=False, dropped=0, usb_boot=usb_boot, firmware_revision=firmware_revision)

    def usb_log(self):
        line = (f"KEYRING bringup: board={self.board} firmware={self.firmware} boot={self.boot} "
                "motor=0 aux=0 fault=0 fuel=ok accel=ok motion=ready\r\n")
        return ("BOOT\r\n" + line).encode("utf-8")

    def test_usb_log_accepts_identical_replays_and_rejects_other_records(self):
        raw = self.usb_log()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "usb.log"
            path.write_bytes(raw)
            self.assertEqual(read_usb_boot(path, self.board, self.firmware),
                             {"bootId": self.boot, "logSha256": hashlib.sha256(raw).hexdigest(),
                              "motorActive": False, "auxEnabled": False, "mainFault": False,
                              "sensorStatus": self.ready_sensor_status})
            current = raw.replace(b"0.7.14", b"0.7.15")
            current_firmware = "keyring-0.7.15-bringup"
            repeated = current + current
            path.write_bytes(repeated)
            self.assertEqual(read_usb_boot(path, self.board, current_firmware),
                             {"bootId": self.boot, "logSha256": hashlib.sha256(repeated).hexdigest(),
                              "motorActive": False, "auxEnabled": False, "mainFault": False,
                              "sensorStatus": self.ready_sensor_status})
            path.write_bytes(current.replace(b"accel=ok", b"accel=unavailable"))
            self.assertEqual(read_usb_boot(path, self.board, current_firmware)["sensorStatus"]["accelStatus"], "unavailable")
            for bad in (raw + raw.replace(self.boot.encode(), b"b" * 32), raw + raw.replace(b"fault=0", b"fault=1"),
                        raw + raw.replace(b"motor=0", b"motor=?"), raw.replace(b"0.7.14", b"0.7.13"),
                        raw.replace(b"r18-hand-solder", b"other-board"), raw + raw[:-9]):
                with self.subTest(log=bad):
                    path.write_bytes(bad)
                    with self.assertRaisesRegex(ValueError, "one matching r18 bring-up record"):
                        read_usb_boot(path, self.board, self.firmware)

    def test_display_bringup_profile_matches_usb_revision_and_same_ble_boot(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "usb.log"
            for revision, panel in (("0.7.15", "st7789"), ("0.7.15", "jd9853"),
                                    ("0.7.16", "st7789"), ("0.7.16", "jd9853"),
                                    ("0.7.17", "st7789"), ("0.7.17", "jd9853"),
                                    ("0.7.18", "st7789"), ("0.7.18", "jd9853")):
                firmware = f"keyring-{revision}-{panel}-bringup"
                raw = self.usb_log().replace(self.firmware.encode(), firmware.encode())
                digest_field = f" appSha256={'a' * 64}" if revision == "0.7.18" else ""
                full = raw.replace(b"motion=ready\r\n", f"motion=ready panel={panel}{digest_field}\r\n".encode())
                with self.subTest(firmware=firmware):
                    path.write_bytes(full)
                    evidence = read_usb_boot(path, self.board, firmware)
                    events = [dict(row, bootId=self.boot) for row in self.events()]
                    report = self.report(events, usb_boot=evidence)
                    self.assertEqual(report["bringup"]["usbBoot"]["displayProfile"], panel)
                    self.assertTrue(report["bringup"]["usbBoot"]["sameBoot"])
                    path.write_bytes(raw)
                    with self.assertRaisesRegex(ValueError, "one matching r18 bring-up record"):
                        read_usb_boot(path, self.board, firmware)
                    other = "st7789" if panel == "jd9853" else "jd9853"
                    path.write_bytes(full.replace(f"panel={panel}".encode(), f"panel={other}".encode()))
                    with self.assertRaisesRegex(ValueError, "one matching r18 bring-up record"):
                        read_usb_boot(path, self.board, firmware)

    def test_usb_app_digest_matches_the_unsigned_firmware_file_and_same_ble_boot(self):
        firmware = "keyring-0.7.18-bringup"
        header = bytearray(24)
        header[0], header[1], header[12], header[23] = 0xe9, 1, 9, 1
        segment = b"\x32\x54\xcd\xab" + bytes(252)
        unsigned = bytes(header) + bytes(4) + len(segment).to_bytes(4, "little") + segment + bytes(15) + b"\xef"
        digest = hashlib.sha256(unsigned).digest()
        image = unsigned + digest
        raw = self.usb_log().replace(self.firmware.encode(), firmware.encode())
        with tempfile.TemporaryDirectory() as folder:
            log = Path(folder) / "usb.log"
            binary = Path(folder) / "firmware.bin"
            log.write_bytes(raw.replace(b"motion=ready", f"motion=ready appSha256={digest.hex()}".encode()))
            usb = read_usb_boot(log, self.board, firmware)
            binary.write_bytes(image)
            usb["firmwareImage"] = read_firmware_image(binary, usb)
            events = [dict(row, bootId=self.boot) for row in self.events()]
            result = self.report(events, usb_boot=usb, firmware_revision=firmware)["bringup"]["usbBoot"]
            self.assertTrue(result["sameBoot"])
            self.assertEqual(result["appSha256"], digest.hex())
            self.assertEqual(result["firmwareImage"], {"fileSha256": hashlib.sha256(image).hexdigest(), "sizeBytes": len(image)})

            other = unsigned[:36] + b"\x01" + unsigned[37:-1] + b"\xee"
            for data, error in ((other + digest, "does not match its contents"),
                                (other + hashlib.sha256(other).digest(), "differs from the running app"),
                                (image + bytes(16), "no trailing data")):
                with self.subTest(error=error):
                    binary.write_bytes(data)
                    with self.assertRaisesRegex(ValueError, error):
                        read_firmware_image(binary, usb)

            log.write_bytes(raw)
            with self.assertRaisesRegex(ValueError, "one matching r18 bring-up record"):
                read_usb_boot(log, self.board, firmware)
            log.write_bytes(raw.replace(b"motion=ready", b"motion=ready appSha256=unavailable"))
            with self.assertRaisesRegex(ValueError, "no running app image digest"):
                read_firmware_image(binary, read_usb_boot(log, self.board, firmware))

    def test_display_draws_must_match_button_counts_in_the_selected_session(self):
        for panel in ("st7789", "jd9853"):
            firmware = f"keyring-0.7.17-{panel}-bringup"
            for status, drawn, expected in (
                (f"{panel}_unverified", [3, 2], "RECORDED"),
                (f"{panel}_unverified", [2, 1], "INSUFFICIENT"),
                (f"{panel}_unverified", [3, True], "INSUFFICIENT"),
                ("starting", [3, 2], "INSUFFICIENT"),
                ("bus_error", [3, 2], "MISMATCH"),
                ("worker_error", [3, 2], "MISMATCH"),
                (("st7789_unverified" if panel == "jd9853" else "jd9853_unverified"), [3, 2], "MISMATCH"),
            ):
                with self.subTest(panel=panel, status=status, drawn=drawn):
                    events = self.events()
                    events[-1]["observation"]["sensorValues"].update(display=status, displayDrawnPresses=drawn)
                    report = self.report(events, firmware_revision=firmware)
                    self.assertEqual(report["status"], expected)
                    self.assertEqual(report["bringup"]["displayTest"]["expectedPresses"], [3, 2])
                    self.assertEqual(report["bringup"]["displayTest"]["buttonFramesMatched"], expected == "RECORDED")

    def test_usb_boot_match_is_required_when_supplied_and_raw_identity_is_private(self):
        initial_status = dict(self.ready_sensor_status, accelStatus="unavailable")
        raw = self.usb_log().replace(b"accel=ok", b"accel=unavailable")
        usb = {"bootId": self.boot, "logSha256": hashlib.sha256(raw).hexdigest(),
               "motorActive": False, "auxEnabled": False, "mainFault": False, "sensorStatus": initial_status}
        events = [dict(row, bootId=self.boot) for row in self.events()]
        report = self.report(events, usb_boot=usb)
        self.assertEqual(report["status"], "RECORDED")
        self.assertTrue(report["bringup"]["usbBoot"]["sameBoot"])
        self.assertEqual(report["bringup"]["usbBoot"]["sensorStatus"], initial_status)
        self.assertEqual(report["bringup"]["latestSensor"]["accelStatus"], "ok")
        self.assertNotIn(self.boot, json.dumps(report))
        report = self.report(self.events(), usb_boot=dict(usb, auxEnabled=True))
        self.assertEqual(report["status"], "MISMATCH")
        self.assertEqual(report["bringup"]["mismatches"], ["usbBootMismatch", "usbPinsUnsafe"])
        report = self.report(events[:1], usb_boot=usb)
        self.assertEqual(report["status"], "INSUFFICIENT")
        self.assertIn("usbBootMatch", report["bringup"]["missing"])

        next_boot = [dict(row, bootId="other-boot", generation=2, atNs=row["atNs"] + len(events) * 1_000_000)
                     for row in events[:2]]
        report = self.report(events + next_boot, usb_boot=usb)
        self.assertEqual(report["status"], "MISMATCH")
        self.assertIn("usbBootMismatch", report["bringup"]["mismatches"])

    def test_one_session_records_buttons_sensors_power_and_health_without_raw_frame(self):
        report = self.report(self.events())
        self.assertEqual(report["status"], "RECORDED")
        self.assertEqual(report["bringup"], dict(session=1, buttonSequences=[0, 1, 2, 3, 4],
                                                 sensorSequence=0, powerSequence=2, healthSequence=4,
                                                 latestSensor=dict(self.ready_sensor_status, sequence=0, ready=True),
                                                 latestPower={"sequence": 2, "status": "ok"},
                                                 missing=[], mismatches=[]))
        contents = json.dumps(report)
        for private in ("private-boot", "private-device", "private-payload"):
            self.assertNotIn(private, contents)

    def test_latest_sensor_and_power_failures_do_not_inherit_earlier_success(self):
        events = self.events()
        last = events[-1]
        observation = last["observation"]
        sensor_values = observation["sensorValues"]
        failed_sensor = dict(sensor_values, detail="sensors", batteryStatus="ok",
                             accelStatus="unavailable", motion="unavailable")
        events.append(dict(last, sequence=5, atNs=last["atNs"] + 1_000_000,
                           observation=dict(observation, sensorValues=failed_sensor)))
        events.append(dict(last, sequence=6, atNs=last["atNs"] + 2_000_000,
                           observation=dict(observation, sensorValues=dict(sensor_values, detail="energy")),
                           ina219={"status": "i2c_error"}, deviceUptimeMs=observation["uptimeMs"]))
        report = self.report(events)
        self.assertEqual(report["status"], "MISMATCH")
        self.assertEqual(report["bringup"]["mismatches"], ["sensorUnavailableAfterReady", "powerUnavailableAfterReady"])
        self.assertEqual(report["bringup"]["sensorSequence"], 0)
        self.assertEqual(report["bringup"]["latestSensor"]["sequence"], 5)
        self.assertEqual(report["bringup"]["latestPower"], {"sequence": 6, "status": "i2c_error"})

        events[-2]["observation"]["sensorValues"] = dict(sensor_values, detail="sensors")
        events[-1]["ina219"] = None
        report = self.report(events)
        self.assertEqual(report["status"], "INSUFFICIENT")
        self.assertEqual(report["bringup"]["missing"], ["sensors", "power"])

    def test_capture_does_not_splice_sessions_even_on_the_same_boot(self):
        report = self.report(self.events(split_at=3))
        self.assertEqual(report["status"], "INSUFFICIENT")
        self.assertEqual(report["bringup"]["buttonSequences"], [0, 1, 2])
        self.assertEqual(report["bringup"]["missing"], ["buttons", "health"])

    def test_counter_requires_an_observed_press_and_release(self):
        events = self.events()
        events[2]["observation"]["sensorValues"]["buttonPresses"] = [True, 1]
        report = self.report(events)
        self.assertEqual(report["status"], "INSUFFICIENT")
        self.assertIn("buttons", report["bringup"]["missing"])

    def test_safety_mismatches_and_counter_regression_prevent_recorded_status(self):
        events = self.events(command_ready=True)
        events[1]["observation"]["state"] = True
        events[4]["observation"]["sensorValues"]["fault"] = True
        events[5]["observation"]["sensorValues"].update(journal="ready", buttonPresses=[1, 1])
        report = self.report(events)
        self.assertEqual(report["status"], "MISMATCH")
        self.assertEqual(set(report["bringup"]["mismatches"]),
                         {"commandReady", "outputActive", "mainFault", "journalEnabled", "buttonCounterRegressed"})


class ReconnectContinuityTests(unittest.TestCase):
    board = "r18-hand-solder"

    def events(self, *, intermediate_boot=None, recovered_boot="original-boot"):
        events = []

        def add(kind, generation, boot, **fields):
            events.append(dict(event=kind, generation=generation, atNs=len(events) * 1_000_000,
                               bootId=boot, boardRevision=self.board, **fields))

        def ready(generation, boot):
            add("ready", generation, boot, advertisingRssiDbm=None, advertisingAgeMs=None)

        def notify(generation, boot, sequence, uptime, presses):
            add("notification", generation, boot, sequence=sequence, observation={
                "uptimeMs": uptime, "buttonState": "released",
                "sensorValues": {"buttonPresses": presses, "unselected": "private-payload"},
            })

        ready(1, "original-boot")
        notify(1, "original-boot", 9, 900, [1, 2])
        notify(1, "original-boot", 12, 1200, [2, 3])
        add("lost", 1, "original-boot")
        generation = 2
        if intermediate_boot is not None:
            ready(generation, intermediate_boot)
            add("lost", generation, intermediate_boot)
            generation += 1
        ready(generation, recovered_boot)
        notify(generation, recovered_boot, 17, 1900, [2, 4])
        return events

    def report(self, events, *, verify=True):
        return summarize(events, 0, len(events) * 1_000_000, board=self.board, mode="reconnect",
                         truncated=False, dropped=0, verify_button_continuity=verify)

    def test_boundary_uses_last_before_and_first_recovered_notifications_across_empty_session(self):
        events = self.events(intermediate_boot="original-boot")
        report = self.report(events)
        self.assertEqual(report["status"], "RECORDED")
        self.assertEqual(report["reconnects"], [dict(fromSession=1, toSession=3, lossToNotificationMs=4, sameBoot=True)])
        evidence = report["buttonContinuity"]
        self.assertEqual((evidence["before"]["sequence"], evidence["after"]["sequence"]), (12, 17))
        self.assertEqual(evidence["sequenceGap"], 4)
        self.assertEqual(evidence["buttonDelta"], [0, 1])
        serialized = json.dumps(report)
        self.assertNotIn("original-boot", serialized)
        self.assertNotIn("private-payload", serialized)
        ordinary = self.report(events, verify=False)
        self.assertNotIn("buttonContinuity", ordinary)
        self.assertTrue(all("buttonPresses" not in row for row in ordinary["events"]))

    def test_new_boot_is_not_button_continuity_even_if_numbers_increase(self):
        for events in (self.events(recovered_boot="replacement-boot"),
                       self.events(intermediate_boot="replacement-boot")):
            with self.subTest(events=events):
                report = self.report(events)
                self.assertEqual(report["status"], "MISMATCH")
                self.assertEqual(report["buttonContinuity"]["mismatches"], ["bootChanged"])
                self.assertIsNone(report["buttonContinuity"]["buttonDelta"])

    def test_regression_at_first_recovery_is_not_hidden_by_later_good_sample(self):
        events = self.events()
        recovered = events[-1]
        later = {**recovered, "sequence": 18, "atNs": len(events) * 1_000_000}
        recovered["sequence"] = 12
        recovered["observation"] = dict(uptimeMs=1000, buttonState="released", sensorValues={"buttonPresses": [1, 3]})
        report = self.report([*events, later])
        self.assertEqual(report["status"], "MISMATCH")
        self.assertEqual(report["buttonContinuity"]["mismatches"],
                         ["sequenceDidNotAdvance", "uptimeRegressed", "buttonCounterRegressed"])

    def test_missing_baseline_or_recovered_button_counts_are_insufficient(self):
        events = self.events()
        events[2]["observation"]["sensorValues"]["buttonPresses"] = [2, 0]
        events[-1]["observation"]["sensorValues"]["buttonPresses"] = [False, 4]
        report = self.report(events)
        self.assertEqual(report["status"], "INSUFFICIENT")
        self.assertEqual(report["buttonContinuity"]["missing"], ["buttonBaseline", "recoveredButtons"])
        self.assertEqual(self.report(events[:-1])["buttonContinuity"]["missing"], ["recovery"])


class SessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        cfg = config()
        cfg.ble_pair, cfg.request_timeout, cfg.ble_scan_seconds = True, 1, 1
        cfg.firmware_revision_allowlist = ()
        self.fleet = BleFleet(cfg)
        self.peer = self.fleet._peers["kr-test"]
        self.clients = []
        self.watcher = None

    async def asyncTearDown(self):
        self.fleet._closed.set()
        if self.peer.pending is not None:
            self.peer.pending.cancel()
        if self.watcher is not None:
            self.watcher.cancel()
            await asyncio.gather(self.watcher, return_exceptions=True)

    def factory(self, _device, *, disconnected_callback, **_kwargs):
        fleet = self.fleet
        number = len(self.clients) + 1

        class Client:
            is_connected = True
            characteristics = {fleet.command_uuid: SimpleNamespace(properties=["write"]),
                               fleet.receipt_uuid: SimpleNamespace(properties=["notify"])}
            services = SimpleNamespace(get_service=lambda _: SimpleNamespace(
                get_characteristic=lambda uuid: Client.characteristics.get(uuid)))

            def __init__(self):
                self.callbacks = {}
                self.disconnect_callback = disconnected_callback
                self.identity = dict(version=1, deviceId="kr-test", firmwareRevision="keyring-0.7.0",
                                     boardRevision="r18", bootId=f"boot-{number}")

            async def connect(self):
                self.is_connected = True

            async def disconnect(self):
                self.is_connected = False

            async def start_notify(self, uuid, callback):
                self.callbacks[uuid] = callback

            async def read_gatt_char(self, uuid):
                return json.dumps(self.identity if uuid == fleet.identity_uuid else self.frame()).encode()

            def frame(self, sequence=1):
                return dict(version=1, deviceId="kr-test", bootId=self.identity["bootId"], sequence=sequence,
                            uptimeMs=100, battery=None, buttonState="released", sensorValues={}, state=False)

        client = Client()
        self.clients.append(client)
        return client

    async def ready(self, number):
        async with asyncio.timeout(1):
            while not (len(self.clients) == number and self.peer.ready.is_set()
                       and self.peer.client is self.clients[number - 1]):
                if self.watcher is not None and self.watcher.done():
                    self.watcher.result()
                    self.fail("fake connection watcher stopped before readiness")
                await asyncio.sleep(0)

    async def reconnect(self, *, factory=None, before_disconnect=None):
        self.patch_client = patch("bubble_gateway.ble.BleakClient", side_effect=factory or self.factory)
        self.patch_client.start()
        self.addCleanup(self.patch_client.stop)

        async def advertise(_seconds):
            self.peer.seen.set()
            await asyncio.sleep(0)

        self.fleet._pause = advertise
        self.peer.discovered = object()
        self.peer.seen.set()
        self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
        await self.ready(1)
        old = self.clients[0]
        if before_disconnect is not None:
            before_disconnect(old)
        old.disconnect_callback(old)
        await self.ready(2)
        return old, self.clients[1]

    def same_boot_factory(self, *args, **kwargs):
        client = self.factory(*args, **kwargs)
        client.identity["bootId"] = "boot-1"
        return client

    def notify_observation(self, client, sequence, uptime_ms, *, presses=None):
        frame = dict(client.frame(sequence), uptimeMs=uptime_ms)
        if presses is not None:
            frame["sensorValues"] = dict(frame["sensorValues"], buttonPresses=presses)
        client.callbacks[self.fleet.observation_uuid](None, bytearray((json.dumps(frame) + "\n").encode()))

    async def test_wrong_enrolled_board_never_subscribes_or_becomes_command_ready(self):
        self.fleet.config.ble_board_revision = "r18-hand-solder"
        self.peer.discovered = object()
        self.peer.seen.set()

        async def stop_after_first_attempt(_seconds):
            self.fleet._closed.set()

        self.fleet._pause = stop_after_first_attempt
        with patch("bubble_gateway.ble.BleakClient", side_effect=self.factory):
            async with asyncio.timeout(1):
                await self.fleet._watch(self.peer)
        self.assertEqual(len(self.clients), 1)
        self.assertEqual(self.clients[0].callbacks, {})
        self.assertFalse(self.peer.ready.is_set())
        self.assertIsNone(self.fleet.command_session("kr-test"))

    async def test_same_boot_reconnect_ignores_stale_read_and_notify_until_new_observation(self):
        events = []
        self.fleet._trace = events.append
        _, current = await self.reconnect(factory=self.same_boot_factory,
                                          before_disconnect=lambda client: self.notify_observation(client, 6, 600))
        self.assertEqual(self.peer.observations.qsize(), 2)  # First READ and the last notification of session one.
        self.assertIsNone(self.peer.anchor)
        self.notify_observation(current, 6, 600)
        self.assertEqual(self.peer.observations.qsize(), 2)
        self.assertEqual(self.peer.observation_watermark, ("boot-1", 6, 600))
        cmd = command()
        receipt = device_receipt(cmd, payload_hash(cmd), bootId="boot-1", ackCode="DUPLICATE",
                                 acceptedUptimeMs=610, appliedUptimeMs=620)
        self.assertEqual(self.fleet._receipt_times(self.peer, receipt)["timestampSource"], "unavailable")

        self.notify_observation(current, 7, 700)
        self.assertEqual(self.peer.observations.qsize(), 3)
        self.assertEqual([event["sequence"] for event in events if event["event"] == "notification"], [6, 7])
        self.assertEqual(self.fleet._receipt_times(self.peer, receipt)["timestampSource"], "gateway-estimated")

    async def test_higher_sequence_cannot_hide_an_uptime_regression_on_same_boot(self):
        _, current = await self.reconnect(factory=self.same_boot_factory)
        self.notify_observation(current, 2, 99)
        self.assertEqual(self.peer.observations.qsize(), 1)
        self.assertEqual(self.peer.observation_watermark, ("boot-1", 1, 100))
        self.assertIsNone(self.peer.anchor)
        self.assertFalse(self.peer.ready.is_set())
        self.assertEqual(self.peer.last_error, "invalid_observation")

    async def test_new_boot_admits_its_lower_sequence_and_uptime(self):
        _, current = await self.reconnect(before_disconnect=lambda client: self.notify_observation(client, 6, 600, presses=[5, 3]))
        self.assertEqual(self.peer.observations.qsize(), 3)
        self.assertEqual(self.peer.observation_watermark, ("boot-2", 1, 100))
        self.assertEqual(self.peer.anchor[:2], ("boot-2", 100))
        self.notify_observation(current, 2, 200, presses=[0, 1])
        self.assertEqual(self.peer.button_presses, (0, 1))

    async def test_same_boot_reconnect_keeps_button_floor_across_missing_counters(self):
        _, current = await self.reconnect(factory=self.same_boot_factory,
                                          before_disconnect=lambda client: self.notify_observation(client, 6, 600, presses=[5, 3]))
        self.notify_observation(current, 7, 700)
        self.assertEqual(self.peer.button_presses, (5, 3))
        self.notify_observation(current, 8, 800, presses=[6, 2])
        self.assertEqual(self.peer.observations.qsize(), 3)
        self.assertEqual(self.peer.observation_watermark, ("boot-1", 7, 700))
        self.assertEqual(self.peer.button_presses, (5, 3))
        self.assertFalse(self.peer.ready.is_set())
        self.assertEqual(self.peer.last_error, "invalid_observation")

    async def test_start_uses_committed_sequence_without_reusing_a_clock_anchor(self):
        self.peer.discovered = object()
        self.peer.seen.set()
        deliver = AsyncMock()
        with (patch("bubble_gateway.ble.BleakClient", side_effect=self.factory),
              patch.object(self.fleet, "_scan", new_callable=AsyncMock)):
            await self.fleet.start(deliver, pass_device_uptime=True, observation_heads={"kr-test": ("boot-1", 6)})
            try:
                await self.ready(1)
                self.assertEqual(self.peer.observation_watermark, ("boot-1", 6, None))
                deliver.assert_not_awaited()
                self.assertIsNone(self.peer.anchor)
                self.notify_observation(self.clients[0], 7, 700)
                self.assertEqual(self.peer.observation_watermark, ("boot-1", 7, 700))
                self.assertEqual(self.peer.anchor[:2], ("boot-1", 700))
                await asyncio.wait_for(self.peer.observations.join(), timeout=1)
                deliver.assert_awaited_once()
                payload, uptime = deliver.await_args.args
                self.assertEqual((payload["sequence"], uptime), (7, 700))
                self.assertNotIn("uptimeMs", payload)
            finally:
                await self.fleet.close()

    async def test_start_uses_committed_button_floor_without_admitting_regressed_frame(self):
        self.peer.discovered = object()
        self.peer.seen.set()
        deliver = AsyncMock()
        with (patch("bubble_gateway.ble.BleakClient", side_effect=self.factory),
              patch.object(self.fleet, "_scan", new_callable=AsyncMock)):
            await self.fleet.start(deliver, observation_heads={"kr-test": ("boot-1", 6, (5, 3))})
            try:
                await self.ready(1)
                self.notify_observation(self.clients[0], 7, 700, presses=[4, 3])
                deliver.assert_not_awaited()
                self.assertEqual(self.peer.observation_watermark, ("boot-1", 6, None))
                self.assertEqual(self.peer.button_presses, (5, 3))
                self.assertFalse(self.peer.ready.is_set())
            finally:
                await self.fleet.close()

    async def test_start_uses_committed_uptime_floor_without_creating_an_anchor(self):
        self.peer.discovered = object()
        self.peer.seen.set()
        deliver = AsyncMock()
        with (patch("bubble_gateway.ble.BleakClient", side_effect=self.factory),
              patch.object(self.fleet, "_scan", new_callable=AsyncMock)):
            await self.fleet.start(deliver, observation_heads={"kr-test": ("boot-1", 6, None, 600)})
            try:
                await self.ready(1)
                self.assertIsNone(self.peer.anchor)
                self.notify_observation(self.clients[0], 7, 599)
                deliver.assert_not_awaited()
                self.assertEqual(self.peer.observation_watermark, ("boot-1", 6, 600))
                self.assertFalse(self.peer.ready.is_set())
                self.assertEqual(self.peer.last_error, "invalid_observation")
            finally:
                await self.fleet.close()

    async def test_old_disconnect_does_not_disconnect_replacement(self):
        old, current = await self.reconnect()
        old.disconnect_callback(old)
        self.assertTrue(self.peer.ready.is_set())
        self.assertIs(self.peer.client, current)
        self.assertFalse(self.peer.disconnected.is_set())
        # Current disconnect must still fence its pending command.
        pending = self.peer.pending = asyncio.get_running_loop().create_future()
        current.disconnect_callback(current)
        with self.assertRaises(BleUnavailable):
            await pending
        self.assertFalse(self.peer.ready.is_set())

    async def test_diagnostic_trace_excludes_reads_and_old_connection_notifications(self):
        events = []
        self.fleet._trace = events.append
        old, current = await self.reconnect()
        self.assertEqual([event["event"] for event in events], ["ready", "lost", "ready"])
        old.callbacks[self.fleet.observation_uuid](None, bytearray((json.dumps(old.frame(2)) + "\n").encode()))
        current.callbacks[self.fleet.observation_uuid](None, bytearray((json.dumps(current.frame(2)) + "\n").encode()))
        self.assertEqual([event["event"] for event in events], ["ready", "lost", "ready", "notification"])
        self.assertEqual(events[-1]["generation"], events[2]["generation"])
        self.assertEqual(events[-1]["sequence"], 2)
        self.assertNotIn("observation", events[-1])

    async def test_observation_trace_is_opt_in_and_excludes_initial_read(self):
        events = []
        self.fleet._trace = events.append
        self.fleet._trace_observation = True
        _, current = await self.reconnect()
        self.assertTrue(all("observation" not in event for event in events))
        frame = current.frame(2)
        current.callbacks[self.fleet.observation_uuid](None, bytearray((json.dumps(frame) + "\n").encode()))
        self.assertEqual(events[-1]["observation"], frame)

    async def test_observation_timeout_disconnects_silent_peer_and_fences_pending_command(self):
        reconnect_reasons = []

        async def advertise(_seconds):
            reconnect_reasons.append(self.peer.last_error)
            self.peer.seen.set()

        self.fleet._pause = advertise
        self.peer.discovered = object()
        self.peer.seen.set()
        with patch("bubble_gateway.ble.BleakClient", side_effect=self.factory):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await self.ready(1)
            original_session = self.fleet.command_session("kr-test")
            pending = self.peer.pending = asyncio.get_running_loop().create_future()
            self.peer.observation_timeout.reschedule(asyncio.get_running_loop().time())
            with self.assertRaises(BleUnavailable):
                await asyncio.wait_for(pending, timeout=1)
            await self.ready(2)
        self.assertEqual(reconnect_reasons, ["observation_notification_timeout"])
        self.assertFalse(self.clients[0].is_connected)
        self.assertIsNotNone(original_session)
        self.assertNotEqual(self.fleet.command_session("kr-test"), original_session)

    async def test_only_a_new_observation_from_current_session_extends_timeout(self):
        old, current = await self.reconnect()
        timeout = self.peer.observation_timeout
        deadline = asyncio.get_running_loop().time() + 1
        timeout.reschedule(deadline)

        self.notify_observation(old, 2, 101)
        self.notify_observation(current, 1, 100)
        self.assertEqual(timeout.when(), deadline)

        self.notify_observation(current, 2, 101)
        self.assertGreater(timeout.when(), deadline)

    async def test_diagnostic_trace_distinguishes_missing_unknown_and_known_battery_alerts(self):
        events = []
        self.fleet._trace = events.append
        _, current = await self.reconnect()
        callback = current.callbacks[self.fleet.observation_uuid]
        for sequence, battery, sensor in ((2, 55, {}), (3, None, {"batteryAlert": None}),
                                          (4, 18, {"batteryAlert": True})):
            frame = dict(current.frame(sequence), battery=battery, sensorValues=sensor)
            callback(None, bytearray((json.dumps(frame) + "\n").encode()))
        notifications = [event for event in events if event["event"] == "notification"]
        self.assertEqual(len(notifications), 3)
        self.assertNotIn("batteryAlert", notifications[0])
        self.assertIsNone(notifications[1]["batteryAlert"])
        self.assertIsNone(notifications[1]["batteryPercent"])
        self.assertIs(notifications[2]["batteryAlert"], True)
        self.assertEqual(notifications[2]["batteryPercent"], 18)

    async def test_observation_ready_without_command_characteristic(self):
        def observation_only(*args, **kwargs):
            client = self.factory(*args, **kwargs)
            client.services = SimpleNamespace(get_service=lambda _: SimpleNamespace(
                get_characteristic=lambda _uuid: None))
            return client

        self.peer.discovered = object()
        self.peer.seen.set()
        with patch("bubble_gateway.ble.BleakClient", side_effect=observation_only):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await self.ready(1)
            self.assertEqual(self.peer.observations.qsize(), 1)
            self.assertEqual(set(self.clients[0].callbacks), {self.fleet.observation_uuid})
            self.assertIsNone(self.fleet.command_session("kr-test"))
            snapshot = self.fleet.snapshot()[0]
            self.assertTrue(snapshot["connected"])
            self.assertFalse(snapshot["commandReady"])

    async def test_r18_bringup_accepts_observations_and_rejects_cached_write_handles(self):
        def bringup(*args, **kwargs):
            client = self.factory(*args, **kwargs)
            client.identity.update(boardRevision="r18-hand-solder", firmwareRevision="keyring-0.7.13-bringup")
            client.write_gatt_char = AsyncMock()
            return client

        self.peer.discovered = object()
        self.peer.seen.set()
        with patch("bubble_gateway.ble.BleakClient", side_effect=bringup):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await self.ready(1)
            client = self.clients[0]
            self.assertIsNotNone(client.services.get_service(None).get_characteristic(self.fleet.command_uuid))
            self.assertEqual(set(client.callbacks), {self.fleet.observation_uuid})
            self.assertEqual(self.peer.observations.qsize(), 1)
            self.assertTrue(self.fleet.snapshot()[0]["connected"])
            self.assertIsNone(self.fleet.command_session("kr-test"))
            cmd = command()
            with self.assertRaisesRegex(BleUnavailable, "does not support command"):
                await self.fleet.execute(cmd, 1000, payload_hash(cmd))
            with self.assertRaisesRegex(BleProtocolError, "does not expose the command journal"):
                await self.fleet.capture_journal("kr-test")
            client.write_gatt_char.assert_not_awaited()

    async def test_missing_receipt_characteristic_preserves_observation_only_session(self):
        def missing_receipt(*args, **kwargs):
            client = self.factory(*args, **kwargs)
            client.characteristics.pop(self.fleet.receipt_uuid)
            client.write_gatt_char = AsyncMock()
            return client

        self.peer.discovered = object()
        self.peer.seen.set()
        with patch("bubble_gateway.ble.BleakClient", side_effect=missing_receipt):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await self.ready(1)
            client = self.clients[0]
            self.assertEqual(set(client.callbacks), {self.fleet.observation_uuid})
            self.notify_observation(client, 2, 200)
            self.assertEqual(self.peer.observations.qsize(), 2)
            self.assertIsNone(self.fleet.command_session("kr-test"))
            self.assertEqual(self.peer.last_error, "receipt_characteristic_unavailable")
            cmd = command()
            with self.assertRaisesRegex(BleUnavailable, "does not support command"):
                await self.fleet.execute(cmd, 1000, payload_hash(cmd))
            client.write_gatt_char.assert_not_awaited()

    async def test_authorized_generation_cannot_write_on_replacement(self):
        old, current = await self.reconnect()
        old_generation = self.peer.generation - 2
        self.assertEqual(self.fleet.command_session("kr-test"), self.peer.generation)
        self.assertTrue(self.fleet.snapshot()[0]["commandReady"])
        current.write_gatt_char = AsyncMock()
        cmd = command()
        with self.assertRaises(BleUnavailable):
            await self.fleet.execute(cmd, 1000, payload_hash(cmd), expected_generation=old_generation)
        current.write_gatt_char.assert_not_awaited()
        self.assertTrue(self.peer.ready.is_set())

    async def test_command_session_requires_successful_receipt_subscription(self):
        def rejected_receipt(*args, **kwargs):
            client = self.factory(*args, **kwargs)
            client.start_notify = AsyncMock(side_effect=BleUnavailable("receipt subscription failed"))
            return client

        self.peer.discovered = object()
        self.peer.seen.set()

        async def stop_after_attempt(_seconds):
            self.fleet._closed.set()

        self.fleet._pause = stop_after_attempt
        with patch("bubble_gateway.ble.BleakClient", side_effect=rejected_receipt):
            async with asyncio.timeout(1):
                await self.fleet._watch(self.peer)
        self.clients[0].start_notify.assert_awaited_once()
        self.assertEqual(self.clients[0].start_notify.await_args.args[0], self.fleet.receipt_uuid)
        self.assertIsNone(self.fleet.command_session("kr-test"))
        self.assertFalse(self.fleet.snapshot()[0]["commandReady"])

    async def test_scan_completion_preserves_watcher_cancellation(self):
        started = asyncio.Event()
        discovered = asyncio.Event()

        async def scan_ready():
            started.set()
            await discovered.wait()
            asyncio.get_running_loop().call_soon(self.watcher.cancel)
            return True

        self.peer.seen.wait = scan_ready
        self.peer.discovered = object()
        with patch("bubble_gateway.ble.BleakClient", side_effect=self.factory):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await started.wait()
            discovered.set()
            try:
                done, _ = await asyncio.wait({self.watcher}, timeout=1)
                self.assertIn(self.watcher, done, "scan completion consumed watcher cancellation")
                self.assertTrue(self.watcher.cancelled())
                self.assertFalse(self.peer.ready.is_set())
                self.assertIsNone(self.peer.client)
            finally:
                self.watcher.cancel()
                await asyncio.gather(self.watcher, return_exceptions=True)

    async def test_stalled_reads_and_subscriptions_reconnect_even_if_disconnect_stalls(self):
        reasons = []

        async def never_replies(*_args):
            await asyncio.Future()

        def factory(*args, **kwargs):
            client = self.factory(*args, **kwargs)
            if len(self.clients) == 1:
                client.read_gatt_char = AsyncMock(side_effect=never_replies)
            elif len(self.clients) == 2:
                async def notify(uuid, callback):
                    client.callbacks[uuid] = callback
                    if uuid == self.fleet.observation_uuid:
                        await never_replies()

                client.start_notify = notify
                client.disconnect = AsyncMock(side_effect=never_replies)
            return client

        async def advertise(_seconds):
            reasons.append(self.peer.last_error)
            self.peer.seen.set()

        self.fleet._pause = advertise
        self.peer.discovered = object()
        self.peer.seen.set()
        self.peer.ready.set = Mock(wraps=self.peer.ready.set)
        with (patch("bubble_gateway.ble.BleakClient", side_effect=factory),
              patch("bubble_gateway.ble.GATT_SETUP_TIMEOUT", 0.02),
              patch("bubble_gateway.ble.BLE_DISCONNECT_TIMEOUT", 0.02)):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await self.ready(3)

        self.assertEqual(reasons, ["BleHandshakeTimeout", "BleHandshakeTimeout"])
        self.assertFalse(self.clients[0].is_connected)
        self.clients[1].disconnect.assert_awaited_once()
        self.peer.ready.set.assert_called_once()
        self.clients[1].callbacks[self.fleet.observation_uuid](None, bytearray(b"{}\n"))
        self.assertIsNotNone(self.fleet.command_session("kr-test"))

    async def test_old_observation_cannot_poison_new_frame_buffer(self):
        old, current = await self.reconnect()
        count = self.peer.observations.qsize()
        old.callbacks[self.fleet.observation_uuid](None, bytearray(b'{"broken":'))
        self.assertEqual(self.peer.observation_frames.data, bytearray())
        self.assertTrue(self.peer.ready.is_set())
        current.callbacks[self.fleet.observation_uuid](None, bytearray(json.dumps(current.frame(2)).encode() + b"\n"))
        self.assertEqual(self.peer.observations.qsize(), count + 1)
        self.assertTrue(self.peer.ready.is_set())

    async def test_bluez_read_value_does_not_contaminate_notification_fragments(self):
        original_factory = self.factory

        def bluez_client(*args, **kwargs):
            client = original_factory(*args, **kwargs)
            original_read = client.read_gatt_char

            async def read(uuid):
                value = await original_read(uuid)
                # BlueZ also emits a Value PropertiesChanged event for READ.
                # Bleak forwards it when this characteristic is subscribed.
                callback = client.callbacks.get(uuid)
                if callback is not None:
                    callback(None, bytearray(value))
                return value

            client.read_gatt_char = read
            return client

        self.peer.discovered = object()
        self.peer.seen.set()
        with patch("bubble_gateway.ble.BleakClient", side_effect=bluez_client):
            self.watcher = asyncio.create_task(self.fleet._watch(self.peer))
            await self.ready(1)
            client = self.clients[0]
            first, _ = self.peer.observations.get_nowait()
            self.assertEqual(first["sequence"], 1)
            notification = json.dumps(client.frame(2)).encode() + b"\n"
            for offset in range(0, len(notification), 20):
                client.callbacks[self.fleet.observation_uuid](
                    None, bytearray(notification[offset:offset + 20]))
            self.assertTrue(self.peer.ready.is_set(), "READ polluted the LF-framed notification stream")
            self.assertFalse(self.peer.disconnected.is_set())
            self.assertIsNone(self.peer.last_error)
            second, _ = self.peer.observations.get_nowait()
            self.assertEqual(second["sequence"], 2)
            self.assertTrue(self.peer.observations.empty())
            self.assertEqual(self.peer.observation_frames.data, bytearray())

    def wait_for_receipt(self, cmd, digest):
        pending = self.peer.pending = asyncio.get_running_loop().create_future()
        self.peer.pending_command, self.peer.pending_hash = cmd["commandId"], digest
        self.peer.pending_final_write_at = time.monotonic()
        self.peer.pending_receipt_deadline = self.peer.pending_final_write_at + 1
        return pending

    async def test_old_receipt_cannot_settle_current_pending_command(self):
        old, current = await self.reconnect()
        cmd = command()
        digest = payload_hash(cmd)
        pending = self.wait_for_receipt(cmd, digest)
        receipt = device_receipt(cmd, digest, bootId=old.identity["bootId"])
        old.callbacks[self.fleet.receipt_uuid](None, bytearray(json.dumps(receipt).encode() + b"\n"))
        self.assertFalse(pending.done())
        receipt["bootId"] = current.identity["bootId"]
        current.callbacks[self.fleet.receipt_uuid](None, bytearray(json.dumps(receipt).encode() + b"\n"))
        self.assertEqual((await pending)["bootId"], "boot-2")

    async def test_applied_from_a_different_boot_cannot_settle_current_command(self):
        old, current = await self.reconnect()
        cmd = command()
        digest = payload_hash(cmd)
        pending = self.wait_for_receipt(cmd, digest)
        receipt = device_receipt(cmd, digest, bootId=old.identity["bootId"])
        notify = current.callbacks[self.fleet.receipt_uuid]
        unrelated = dict(receipt, commandId="unrelated")
        notify(None, bytearray(json.dumps(unrelated).encode() + b"\n"))
        self.assertFalse(pending.done())
        self.assertTrue(self.peer.ready.is_set())
        notify(None, bytearray(json.dumps(receipt).encode() + b"\n"))
        with self.assertRaises(BleUnavailable):
            await pending
        self.assertEqual(self.peer.last_error, "receipt_boot_mismatch")
        self.assertFalse(self.peer.ready.is_set())

    async def test_duplicate_from_a_different_boot_preserves_historical_readback(self):
        old, current = await self.reconnect()
        cmd = command()
        digest = payload_hash(cmd)
        pending = self.wait_for_receipt(cmd, digest)
        receipt = device_receipt(cmd, digest, bootId=old.identity["bootId"], ackCode="DUPLICATE")
        current.callbacks[self.fleet.receipt_uuid](None, bytearray(json.dumps(receipt).encode() + b"\n"))
        result = await pending
        self.assertEqual(result["bootId"], "boot-1")
        self.assertEqual(result["readback"], {"state": True})
        self.assertEqual(result["timestampSource"], "unavailable")
        self.assertTrue(self.peer.ready.is_set())

    async def test_partial_command_never_continues_on_replacement_client(self):
        replacement = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock())

        async def switch_connection(*_args, **_kwargs):
            self.fleet._lost(self.peer)
            self.peer.client = replacement
            self.peer.disconnected.clear()
            self.peer.ready.set()

        original = SimpleNamespace(is_connected=True, write_gatt_char=AsyncMock(side_effect=switch_connection))
        self.peer.client = original
        self.peer.ready.set()
        self.peer.command_writable = True
        cmd = command()
        with self.assertRaises(BleUnavailable):
            await self.fleet.execute(cmd, 1000, payload_hash(cmd))
        original.write_gatt_char.assert_awaited_once()
        replacement.write_gatt_char.assert_not_awaited()
        self.assertTrue(self.peer.ready.is_set())  # Old operation cleanup cannot kill the replacement.
        self.assertIsNone(self.peer.pending)

    async def test_failed_handshake_never_marks_session_ready(self):
        original_factory = self.factory

        def invalid_handshake(*args, **kwargs):
            client = original_factory(*args, **kwargs)
            original_notify = client.start_notify

            async def notify(uuid, callback):
                await original_notify(uuid, callback)
                if uuid == self.fleet.observation_uuid:
                    callback(None, bytearray(b"{}\n"))

            client.start_notify = notify
            return client

        self.peer.ready.set = Mock(wraps=self.peer.ready.set)
        self.peer.seen.set()

        async def stop(_seconds):
            self.fleet._closed.set()

        self.fleet._pause = stop
        with patch("bubble_gateway.ble.BleakClient", side_effect=invalid_handshake):
            async with asyncio.timeout(1):
                await self.fleet._watch(self.peer)
        self.peer.ready.set.assert_not_called()
