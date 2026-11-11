"""Bind an operator-captured J6 electrical trace to one r18 pulse receipt."""

import csv
from decimal import Decimal, InvalidOperation
import hashlib
from io import StringIO


MAX_TRACE_BYTES = 8 * 1024 * 1024
MOTOR_MAX_ON_MS = 1000  # board::MotorMaxOnMs in firmware/include/board_r18.h.


def number(value):
    try:
        result = Decimal(value)
    except (InvalidOperation, TypeError) as error:
        raise ValueError("Invalid r18 pulse trace number") from error
    if not result.is_finite() or result.copy_abs() > 10**9:
        raise ValueError("Invalid r18 pulse trace number")
    return result


def inspect_pulse_trace(path, metadata, command_id, receipt_resource_id, receipt_sha256):
    expected = {"version": 1, "commandId": command_id, "cseResourceId": receipt_resource_id,
                "receiptSha256": receipt_sha256, "measurementPoint": "J6-motor-load"}
    if (not isinstance(metadata, dict) or metadata.keys() != expected.keys() | {"traceSha256", "highThresholdV"}
            or type(metadata["version"]) is not int or any(metadata[key] != value for key, value in expected.items())):
        raise ValueError("Pulse trace metadata differs from the applied r18 receipt")
    if type(metadata["highThresholdV"]) not in (int, float):
        raise ValueError("Expected a numeric pulse high threshold")
    threshold = number(str(metadata["highThresholdV"]))
    if threshold <= 0:
        raise ValueError("Expected a positive pulse high threshold")

    with path.open("rb") as stream:
        raw = stream.read(MAX_TRACE_BYTES + 1)
    if len(raw) > MAX_TRACE_BYTES:
        raise ValueError("r18 pulse trace exceeds the file size limit")
    digest = hashlib.sha256(raw).hexdigest()
    if digest != metadata["traceSha256"]:
        raise ValueError("r18 pulse trace SHA-256 differs from its metadata")
    reader = csv.reader(StringIO(raw.decode("utf-8-sig"), newline=""), strict=True)
    if next(reader, None) != ["offsetMs", "voltageV"]:
        raise ValueError("Expected r18 pulse CSV columns offsetMs,voltageV")
    offsets = []
    starts = []
    ends = []
    high = False
    max_gap = Decimal(0)
    for row in reader:
        if len(row) != 2:
            raise ValueError("Invalid r18 pulse trace row")
        offset, volts = map(number, row)
        if offsets:
            gap = offset - offsets[-1]
            if gap <= 0:
                raise ValueError("r18 pulse trace offsets must increase")
            max_gap = max(max_gap, gap)
        sample_high = volts >= threshold
        if sample_high and not high:
            starts.append(len(offsets))
        elif high and not sample_high:
            ends.append(len(offsets))
        high = sample_high
        offsets.append(offset)
    if len(offsets) < 2:
        raise ValueError("r18 pulse trace requires at least two samples")

    report = {**expected, "traceSha256": digest, "association": "operator", "highThresholdV": float(threshold),
              "sampleCount": len(offsets), "maxSampleGapMs": float(max_gap), "durationLimitMs": MOTOR_MAX_ON_MS}
    if not starts:
        return {**report, "measurementStatus": "no-pulse"}
    if len(starts) > 1:
        return {**report, "measurementStatus": "multiple-pulses"}
    if starts[0] == 0 or not ends:
        return {**report, "measurementStatus": "missing-edge"}

    first_high, first_low = starts[0], ends[0]
    rise = (offsets[first_high - 1], offsets[first_high])
    fall = (offsets[first_low - 1], offsets[first_low])
    minimum, maximum = fall[0] - rise[1], fall[1] - rise[0]
    duration_status = "inconclusive"
    if minimum > MOTOR_MAX_ON_MS:
        duration_status = "over-limit"
    elif maximum <= MOTOR_MAX_ON_MS:
        duration_status = "within-limit"
    return {**report, "measurementStatus": "measured", "durationStatus": duration_status,
            "riseBoundsMs": list(map(float, rise)), "fallBoundsMs": list(map(float, fall)),
            "durationBoundsMs": [float(minimum), float(maximum)]}
