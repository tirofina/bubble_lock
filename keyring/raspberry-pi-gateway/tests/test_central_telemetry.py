import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock

from bubble_gateway.store import Store
from bubble_gateway.transport import TransportHub, RemoteResponseError
from helpers import BINDING, observation


class CentralTelemetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_and_central_routes_share_durable_observation_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "telemetry.sqlite3"
            store = Store(path, 100, 100000, 20, BINDING)
            value = observation(sensorValues={"location": {"lat": 37.5, "lon": 127.0, "source": "gps", "accuracyM": 8}})
            self.assertTrue(store.observation(BINDING["observationContainer"], value, central_enabled=True))
            self.assertFalse(store.observation(BINDING["observationContainer"], value, central_enabled=True))
            store.close()
            restored = Store(path, 100, 100000, 20, BINDING)
            try:
                rows = restored.db.execute("SELECT rqi,container,payload FROM outbox").fetchall()
                self.assertEqual(len(rows), 2)
                self.assertEqual({row["container"] for row in rows}, {BINDING["observationContainer"], "@central/telemetry"})
                self.assertEqual([json.loads(row["payload"]) for row in rows], [value, value])
                hub = object.__new__(TransportHub)
                hub._api = AsyncMock(return_value={"status": "ACCEPTED", "deviceId": value["deviceId"], "observationId": "test"})
                await hub.publish("central-rqi", "@central/telemetry", value)
                hub._api.assert_awaited_once_with("POST", "/telemetry", value, "central-rqi")
                hub._api.return_value = {"status": "ACCEPTED", "deviceId": "another-device"}
                with self.assertRaises(RemoteResponseError):
                    await hub.publish("central-rqi", "@central/telemetry", value)
            finally:
                restored.close()


if __name__ == "__main__":
    unittest.main()
