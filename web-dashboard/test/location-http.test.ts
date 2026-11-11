import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { parseLocationSnapshot } from '../shared/location.ts';
import { startReplayServer } from '../server/sse.ts';

async function workspace(t: TestContext) {
  const path = await mkdtemp(join(tmpdir(), 'bubble-location-http-'));
  t.after(() => rm(path, { force: true, recursive: true }));
  return { locations: join(path, 'positions.jsonl'), gateways: join(path, 'gateways.json') };
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const gateway = { gatewayId: 'pi-01', label: '입구', position: { lat: 37.5665, lon: 126.978 },
  simulation: false, referenceRssiDbm: -59, pathLossExponent: 2 };
function observation(observedAt: string, rssi: number, lat: number) {
  return { deviceId: 'keyring-A', gatewayId: 'pi-01', observedAt, rssi,
    sensorValues: { location: { lat, lon: 126.978, source: 'gps', accuracyM: 6 } } };
}

test('location HTTP endpoint returns a validated explicit demo snapshot', async (t) => {
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  const response = await fetch(`${service.url}/api/locations`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const snapshot = parseLocationSnapshot(await response.json());
  assert.equal(snapshot.mode, 'demo');
  assert.equal(snapshot.source, 'demo-fixture');
  assert.equal(snapshot.simulation, true);
  assert.equal(snapshot.devices.length, 3);
  assert.equal(snapshot.devices.filter((device) => device.position !== null).length, 2);
  assert.equal(snapshot.devices.filter((device) => device.ble !== null).length, 3);
});

test('location HTTP polling reflects appended GPS RSSI and updated gateway settings', async (t) => {
  const files = await workspace(t);
  await writeFile(files.locations, line(observation('2026-11-10T08:00:00.000Z', -67, 37.5665)));
  await writeFile(files.gateways, JSON.stringify([gateway]));
  const service = await startReplayServer({ port: 0, locationFile: files.locations,
    gatewayLocationsFile: files.gateways, locationSimulation: false });
  t.after(service.close);
  const read = async () => {
    const response = await fetch(`${service.url}/api/locations`);
    assert.equal(response.status, 200);
    return parseLocationSnapshot(await response.json());
  };
  const first = await read();
  assert.equal(first.simulation, false);
  assert.equal(first.devices[0]?.position?.coordinates.lat, 37.5665);
  assert.equal(first.devices[0]?.ble?.rssiDbm, -67);
  await appendFile(files.locations, line(observation('2026-11-10T08:00:05.000Z', -75, 37.5675)));
  await writeFile(files.gateways, JSON.stringify([{ ...gateway, position: { lat: 37.568, lon: 126.979 } }]));
  const next = await read();
  assert.equal(next.devices.length, 1);
  assert.equal(next.devices[0]?.position?.coordinates.lat, 37.5675);
  assert.equal(next.devices[0]?.ble?.rssiDbm, -75);
  assert.equal(next.devices[0]?.ble?.observedAt, '2026-11-10T08:00:05.000Z');
  assert.equal(next.gateways[0]?.position.lat, 37.568);
});

test('configured missing location file returns explicit 503 and recovers after file creation', async (t) => {
  const files = await workspace(t);
  const service = await startReplayServer({ port: 0, locationFile: files.locations });
  t.after(service.close);
  const response = await fetch(`${service.url}/api/locations`);
  assert.equal(response.status, 503);
  const error = await response.text();
  assert.match(error, /location_feed_unavailable/);
  assert.equal(error.includes(files.locations), false);
  assert.equal(error.includes('demo-fixture'), false);
  await writeFile(files.locations, line(observation('2026-11-10T08:00:00.000Z', -67, 37.5665)));
  const recovered = await fetch(`${service.url}/api/locations`);
  assert.equal(recovered.status, 200);
  const snapshot = parseLocationSnapshot(await recovered.json());
  assert.equal(snapshot.mode, 'live');
  assert.equal(snapshot.simulation, true);
  assert.equal(snapshot.devices[0]?.deviceId, 'keyring-A');
});

test('location HTTP endpoint preserves GET-only policy', async (t) => {
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  const response = await fetch(`${service.url}/api/locations`, { method: 'POST', body: '{}' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.deepEqual(await response.json(), { error: 'method_not_allowed' });
});
