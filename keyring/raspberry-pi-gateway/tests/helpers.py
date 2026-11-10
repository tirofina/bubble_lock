"""Synthetic identities and payloads; never load operator configuration or DBs."""
from datetime import timedelta
from types import SimpleNamespace

from bubble_gateway.model import iso_time, utc_now

BINDING = {
    "bindingVersion": 1, "gatewayId": "gw-test", "originator": "Ctest",
    "cseId": "test-cse", "rvi": "3", "observationContainer": "/test/observations",
    "receiptContainer": "/test/receipts", "healthContainer": "/test/health",
}
DEVICES = {"kr-test": "00:00:00:00:00:01"}


def config(database=None):
    return SimpleNamespace(
        database=database, gateway_id="gw-test", originator="Ctest", cse_id="test-cse", rvi="3",
        observation_container=BINDING["observationContainer"],
        receipt_container=BINDING["receiptContainer"], health_container=BINDING["healthContainer"],
        ble_gatt_profile="core-v1", ble_devices=DEVICES, ble_command_timeout=1,
        core_bridge_enabled=True, credential_ttl=60,
    )


def command(**changes):
    now = utc_now()
    value = dict(version=1, gatewayId="gw-test", deviceId="kr-test", commandId="cmd-test",
                 claimId="claim-test", desiredState={"state": True},
                 issuedAt=iso_time(now - timedelta(seconds=1)),
                 deadline=iso_time(now + timedelta(seconds=20)), grantRevision=3, ownershipEpoch=2)
    value.update(changes)
    return value


def observation(**changes):
    value = dict(version=1, gatewayId="gw-test", deviceId="kr-test", bootId="boot-test",
                 sequence=1, observedAt=iso_time(), receivedAt=iso_time(), rssi=-60, battery=50,
                 buttonState="released", sensorValues={}, state=False,
                 firmwareRevision="keyring-0.7.0", timestampSource="gateway-received")
    value.update(changes)
    return value


def device_receipt(cmd, digest, **changes):
    value = dict(version=1, deviceId=cmd["deviceId"], bootId="boot-test",
                 commandId=cmd["commandId"], payloadHash=digest, ackCode="APPLIED",
                 acceptedUptimeMs=100, appliedUptimeMs=101, readback={"state": True},
                 firmwareRevision="keyring-0.7.0")
    value.update(changes)
    return value
