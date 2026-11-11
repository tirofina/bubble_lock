import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { loadLocationFeed, LocationFeedError } from '../server/location-feed.ts';

async function journal(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-location-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { path: join(directory, 'locations.jsonl'), anchors: join(directory, 'gateways.json') };
}

function mec(deviceId: string, timestamp: string, lat = 37.5665) {
  return {
    contractId: 'privacy-bubble.integration.v1', docRevision: '2.0.0', eventId: `${deviceId}:${timestamp}`,
    service: 'Location', eventType: 'UE_LOCATION_UPDATE', ueId: deviceId, timestamp,
    location: { lat, lon: 126.978, accuracyM: 6 },
  };
}

const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const time1 = '2026-11-10T00:00:00.000Z';
const time2 = '2026-11-10T00:00:05.000Z';

test('demo fixture preserves measurement timestamps across polling snapshots', async () => {
  const feed = await loadLocationFeed();
  const first = await feed.readSnapshot();
  const next = await feed.readSnapshot();
  assert.equal(first.mode, 'demo');
  assert.equal(first.simulation, true);
  assert.ok(first.devices.length >= 2);
  assert.deepEqual(next.devices, first.devices);
  assert.ok(first.gateways.length >= 1);
});

test('location file tails complete JSONL records while preserving earlier devices', async (t) => {
  const { path } = await journal(t);
  await writeFile(path, line(mec('keyring-A', time1)));
  const feed = await loadLocationFeed({ locationFile: path, simulation: false });
  const first = await feed.readSnapshot();
  assert.equal(first.mode, 'live');
  assert.equal(first.devices[0]?.position?.observedAt, time1);
  assert.equal(first.devices[0]?.position?.simulation, false);
  const second = line(mec('keyring-B', time2));
  await appendFile(path, second.slice(0, -12));
  assert.equal((await feed.readSnapshot()).devices.length, 1);
  await appendFile(path, second.slice(-12));
  const next = await feed.readSnapshot();
  assert.deepEqual(next.devices.map((device) => device.deviceId).sort(), ['keyring-A', 'keyring-B']);
  assert.equal(next.caughtUp, true);
  assert.equal(next.rejectedRecords, 0);
});

test('file truncate and replacement reset the previous journal snapshot', async (t) => {
  const { path } = await journal(t);
  await writeFile(path, line(mec('keyring-A', time1)) + line(mec('keyring-B', time1)));
  const feed = await loadLocationFeed({ locationFile: path });
  assert.equal((await feed.readSnapshot()).devices.length, 2);
  await writeFile(path, line(mec('keyring-C', time2)));
  assert.deepEqual((await feed.readSnapshot()).devices.map((device) => device.deviceId), ['keyring-C']);
  await rename(path, `${path}.1`);
  await writeFile(path, line(mec('keyring-D', time2)));
  assert.deepEqual((await feed.readSnapshot()).devices.map((device) => device.deviceId), ['keyring-D']);
});

test('same-prefix same-size rewrites replace stale values at the tail', async (t) => {
  const { path } = await journal(t);
  const prefix = line(mec('keyring-A', time1));
  const before = prefix + line(mec('keyring-B', time2, 37.5665));
  const after = prefix + line(mec('keyring-B', time2, 37.5775));
  assert.equal(before.length, after.length);
  assert.equal(before.slice(0, 128), after.slice(0, 128));
  await writeFile(path, before);
  const feed = await loadLocationFeed({ locationFile: path });
  await feed.readSnapshot();
  await writeFile(path, after);
  const updated = await feed.readSnapshot();
  assert.equal(updated.devices.find((device) => device.deviceId === 'keyring-B')?.position?.coordinates.lat, 37.5775);
});

test('invalid and oversized rows are bounded and later valid observations remain readable', async (t) => {
  const { path } = await journal(t);
  await writeFile(path, `broken JSON\n${'x'.repeat(70 * 1024)}\n${line(mec('keyring-A', time1))}`);
  const feed = await loadLocationFeed({ locationFile: path });
  const snapshot = await feed.readSnapshot();
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.rejectedRecords, 2);
  assert.equal(snapshot.devices[0]?.position?.simulation, true);
});

test('configured file errors remain explicit and omit filesystem paths', async (t) => {
  const { path, anchors } = await journal(t);
  const feed = await loadLocationFeed({ locationFile: path });
  await assert.rejects(feed.readSnapshot(), (error: unknown) => {
    assert.ok(error instanceof LocationFeedError);
    assert.equal(error.message.includes(path), false);
    return true;
  });
  await writeFile(path, line(mec('keyring-A', time1)));
  await writeFile(anchors, JSON.stringify([{ gatewayId: 'invalid', position: { lat: 1000, lon: 0 } }]));
  const invalid = await loadLocationFeed({ locationFile: path, gatewayLocationsFile: anchors });
  await assert.rejects(invalid.readSnapshot(), LocationFeedError);
  assert.equal((await feed.readSnapshot()).devices.length, 1);
});

test('concurrent polling shares one cursor and reloads gateway coordinates', async (t) => {
  const { path, anchors } = await journal(t);
  await writeFile(path, line(mec('keyring-A', time1)));
  const gateway = { gatewayId: 'pi-01', label: '수신기 1', position: { lat: 37.5665, lon: 126.978 },
    simulation: false, referenceRssiDbm: -59, pathLossExponent: 2 };
  await writeFile(anchors, JSON.stringify([gateway]));
  const feed = await loadLocationFeed({ locationFile: path, gatewayLocationsFile: anchors });
  const snapshots = await Promise.all([feed.readSnapshot(), feed.readSnapshot(), feed.readSnapshot()]);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.devices.length), [1, 1, 1]);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.rejectedRecords), [0, 0, 0]);
  await writeFile(anchors, JSON.stringify([{ ...gateway, label: '입구 수신기' }]));
  assert.equal((await feed.readSnapshot()).gateways[0]?.label, '입구 수신기');
});

test('active device memory is bounded while retaining the newest observations', async (t) => {
  const { path } = await journal(t);
  await writeFile(path, Array.from({ length: 1005 }, (_, index) => line(mec(`keyring-${index}`,
    new Date(Date.parse(time1) + index * 1000).toISOString()))).join(''));
  const feed = await loadLocationFeed({ locationFile: path });
  const snapshot = await feed.readSnapshot();
  assert.equal(snapshot.devices.length, 1000);
  assert.ok(snapshot.devices.some((device) => device.deviceId === 'keyring-1004'));
  assert.equal(snapshot.devices.some((device) => device.deviceId === 'keyring-0'), false);
});
