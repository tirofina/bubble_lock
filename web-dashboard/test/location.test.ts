import assert from 'node:assert/strict';
import test from 'node:test';
import demo from '../fixtures/location-demo.json' with { type: 'json' };
import {
  estimateBleProximity, freshness, ingestLocationRecord, initialLocationState,
  locationReducer, parseGatewayAnchors, parseLocationSnapshot, validCoordinates,
} from '../shared/location.ts';
import type { BleReading, LocationSnapshot } from '../shared/location.ts';
import { createReceiptAdapter } from '../shared/receipt-adapter.ts';

const at = '2026-11-10T08:20:00.000Z';
const anchors = parseGatewayAnchors(demo.gateways);
const live = { simulation: false, now: Date.parse(at) + 5000 } as const;
const mec = (time = at, lat = 37.56588) => ({ service: 'Location', eventType: 'UE_LOCATION_UPDATE', ueId: 'keyring-A', timestamp: time, location: { lat, lon: 126.97808, accuracyM: 4 } });
const ble = (rssiDbm: number, time = at) => ({ deviceId: 'keyring-A', gatewayId: 'pi-01', rssiDbm, observedAt: time });

test('MEC 위치와 CORE/Gateway BLE 관측은 각각 최신값을 유지한다', () => {
  let state = ingestLocationRecord(initialLocationState, mec(), live).state;
  const location = state['keyring-A']?.position;
  const core = { status: 'MQTT_DISPATCHED', gatewayId: 'pi-01', payload: { deviceId: 'keyring-A', rssiDbm: -75, timestamp: '2026-11-10T08:20:02Z' } };
  state = ingestLocationRecord(state, core, live).state;
  assert.equal(state['keyring-A']?.position, location);
  assert.equal(state['keyring-A']?.ble?.rssiDbm, -75);
  const prior = state;
  state = ingestLocationRecord(state, ble(-90, '2026-11-10T08:19:59Z'), live).state;
  assert.equal(state, prior);
  state = ingestLocationRecord(state, mec('2026-11-10T08:19:59Z', 36), live).state;
  assert.equal(state, prior);
  state = ingestLocationRecord(state, { deviceId: 'keyring-A', gatewayId: 'pi-01', rssi: -60, observedAt: '2026-11-10T08:20:03Z' }, live).state;
  assert.equal(state['keyring-A']?.ble?.rssiDbm, -60);
  assert.equal(state['keyring-A']?.position, location);
});

test('BLE-only 키링은 수신기 중심의 원을 제공하고 좌표 필드는 대기로 유지한다', () => {
  const state = ingestLocationRecord(initialLocationState, ble(-79), live).state;
  const device = state['keyring-A'];
  assert.ok(device?.ble);
  assert.equal(device.position, null);
  const proximity = estimateBleProximity(device.ble, anchors);
  assert.ok(proximity);
  assert.equal(proximity.distanceM, 10);
  assert.deepEqual(proximity.center, anchors[0]?.position);
  assert.equal(proximity.simulation, true);
  assert.equal(estimateBleProximity(device.ble, []), null);
});

test('수신 세기와 교정값을 반영하고 매우 약한 신호의 지도 반경은 상한을 표시한다', () => {
  const reading: BleReading = { gatewayId: 'pi-01', rssiDbm: -59, observedAt: at, simulation: false };
  assert.equal(estimateBleProximity(reading, anchors)?.distanceM, 1);
  assert.equal(estimateBleProximity({ ...reading, rssiDbm: -79 }, anchors)?.distanceM, 10);
  const weaker = estimateBleProximity({ ...reading, rssiDbm: -127 }, anchors);
  assert.ok(weaker && weaker.distanceM > 1000);
  assert.equal(weaker.radiusM, 1000);
  assert.equal(weaker.capped, true);
  assert.equal(estimateBleProximity({ ...reading, rssiDbm: Number.NaN }, anchors), null);
  assert.equal(estimateBleProximity(reading, [{ ...anchors[0]!, pathLossExponent: 0 }]), null);
});

test('입력 좌표·시각·RSSI·교정값 경계를 검증한다', () => {
  for (const point of [{ lat: 91, lon: 0 }, { lat: 0, lon: -181 }, { lat: '37', lon: 127 }, { lat: Number.NaN, lon: 127 }]) {
    assert.equal(validCoordinates(point), false);
    assert.equal(ingestLocationRecord(initialLocationState, { ...mec(), location: point }, live).accepted, false);
  }
  for (const rssi of [-128, 21, -60.5, Number.NaN, null]) {
    assert.equal(ingestLocationRecord(initialLocationState, { ...ble(-60), rssiDbm: rssi }, live).accepted, false);
  }
  assert.equal(ingestLocationRecord(initialLocationState, { ...mec(), timestamp: '어제' }, live).accepted, false);
  assert.equal(ingestLocationRecord(initialLocationState, { ...mec(), location: { lat: 37, lon: 127, accuracyM: -1 } }, live).accepted, false);
  assert.throws(() => parseGatewayAnchors([{ ...anchors[0], pathLossExponent: 0 }]));
  assert.throws(() => parseGatewayAnchors([{ ...anchors[0], referenceRssiDbm: 1 }]));
  assert.throws(() => parseGatewayAnchors([anchors[0], anchors[0]]));
});

test('센서 GPS 좌표를 읽고 모의 출처를 수집 경로 전체에 보존한다', () => {
  const observation = {
    deviceId: 'keyring-B', gatewayId: 'pi-01', observedAt: at, rssi: -65,
    sensorValues: { location: { lat: 37.56573, lon: 126.97812, source: 'gps', accuracyM: 5 } }, simulation: true,
  };
  const device = ingestLocationRecord(initialLocationState, observation, live).state['keyring-B'];
  assert.equal(device?.position?.source, 'gps');
  assert.equal(device.position.simulation, true);
  assert.equal(device.ble?.simulation, true);
  const replay = ingestLocationRecord(initialLocationState, { ...observation, simulation: false }, { ...live, simulation: true }).state['keyring-B'];
  assert.equal(replay?.position?.simulation, true);
  assert.equal(ingestLocationRecord(initialLocationState, { deviceId: 'A', payload: { ...ble(-65), deviceId: 'B' } }, live).accepted, false);
});

test('최근 이벤트 100개 표시 범위를 넘어도 키링별 좌표는 누적 상태에 남는다', () => {
  let state = initialLocationState;
  for (let index = 0; index < 150; index++) {
    state = ingestLocationRecord(state, { ...mec(), ueId: `keyring-${index}` }, live).state;
  }
  assert.equal(Object.keys(state).length, 150);
  assert.ok(state['keyring-0']?.position);
  assert.ok(state['keyring-149']?.position);
});

test('관측 시각으로 현재·오래된 기록·시계 앞섬을 판정한다', () => {
  const now = Date.parse(at);
  assert.equal(freshness(at, now + 60_000), 'fresh');
  assert.equal(freshness(at, now + 60_001), 'stale');
  assert.equal(freshness(at, now - 5001), 'future');
  assert.equal(freshness(at, now - 3000), 'fresh');
  assert.equal(freshness('어제', now), 'unknown');
  assert.equal(freshness('2026-02-31T08:20:00Z', now), 'unknown');
});

test('미래 시각 관측을 격리하고 기존 미래 상태에서 정상 시각으로 회복한다', () => {
  const current = ingestLocationRecord(initialLocationState, mec(), live).state;
  const future = ingestLocationRecord(current, mec('2099-11-10T08:20:00Z', 0), live);
  assert.equal(future.accepted, false);
  assert.equal(future.state, current);
  const device = current['keyring-A']!;
  const poisoned = { ...current, 'keyring-A': { ...device, position: { ...device.position!, observedAt: '2099-11-10T08:20:00Z' } } };
  const recovered = ingestLocationRecord(poisoned, mec(), live);
  assert.equal(recovered.accepted, true);
  assert.equal(recovered.state['keyring-A']?.position?.observedAt, at);
});

test('데모는 3개 키링·2개 직접 좌표·3개 BLE 관측과 원본 시각을 제공한다', () => {
  let state = initialLocationState;
  for (const record of demo.records) {
    const result = ingestLocationRecord(state, record, { simulation: true });
    assert.equal(result.accepted, true);
    state = result.state;
  }
  const devices = Object.values(state);
  assert.equal(devices.length, 3);
  assert.equal(devices.filter((device) => device.position).length, 2);
  assert.equal(devices.filter((device) => device.ble).length, 3);
  const snapshot: LocationSnapshot = {
    schemaVersion: '1.0.0', mode: 'demo', simulation: true, source: 'demo-fixture', updatedAt: at,
    devices, gateways: anchors, rejectedRecords: 0, caughtUp: true,
  };
  assert.deepEqual(parseLocationSnapshot(snapshot), snapshot);
  assert.throws(() => parseLocationSnapshot({ ...snapshot, mode: 'live' }));
  assert.throws(() => parseLocationSnapshot({ ...snapshot, devices: [devices[0], devices[0]] }));
  assert.throws(() => parseLocationSnapshot({ ...snapshot, devices: [{ ...devices[0], position: { ...devices[0]?.position, simulation: false } }] }));
});

test('통합 journal adapter가 만든 위치 receipt는 공통 reducer로 연결된다', () => {
  const adapter = createReceiptAdapter({ source: 'integration-journal-replay' });
  const event = adapter.adaptReceipt({ ...mec(), contractId: 'privacy-bubble.integration.v1', docRevision: '2.0.0', eventId: 'mec-location-1' });
  const state = locationReducer(initialLocationState, event, live.now);
  assert.equal(state['keyring-A']?.position?.simulation, true);
  assert.equal(state['keyring-A']?.position?.coordinates.lat, 37.56588);
});
