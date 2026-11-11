import type { DashboardEvent } from './types.ts';

export interface Coordinates { readonly lat: number; readonly lon: number }
export interface GatewayAnchor {
  readonly gatewayId: string;
  readonly label: string;
  readonly position: Coordinates;
  readonly simulation: boolean;
  /** 수신기·키링 조합의 1 m 기준 수신 세기와 경로 손실 지수. */
  readonly referenceRssiDbm: number;
  readonly pathLossExponent: number;
}
export interface PositionFix {
  readonly coordinates: Coordinates;
  readonly source: 'gps' | 'mec' | 'relay';
  readonly observedAt: string;
  readonly accuracyM: number | null;
  readonly simulation: boolean;
}
export interface BleReading {
  readonly gatewayId: string;
  readonly rssiDbm: number;
  readonly observedAt: string;
  readonly simulation: boolean;
}
export interface LocationDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly position: PositionFix | null;
  readonly ble: BleReading | null;
}
export interface LocationSnapshot {
  readonly schemaVersion: '1.0.0';
  readonly mode: 'demo' | 'live';
  readonly simulation: boolean;
  readonly source: 'demo-fixture' | 'local-jsonl' | 'portal-api' | 'combined';
  readonly updatedAt: string;
  readonly readExpiresAt?: string;
  readonly devices: readonly LocationDevice[];
  readonly gateways: readonly GatewayAnchor[];
  readonly rejectedRecords: number;
  readonly caughtUp: boolean;
}
export type LocationState = Readonly<Record<string, LocationDevice>>;
export const initialLocationState: LocationState = Object.freeze({});
export const LOCATION_STALE_AFTER_MS = 60_000;
export const MAX_BLE_RADIUS_M = 1000;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}
function label(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}
function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (parts === null || !Number.isFinite(Date.parse(value))) return false;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]!
    && Number(parts[4]) <= 23 && Number(parts[5]) <= 59 && Number(parts[6]) <= 59;
}
export function validCoordinates(value: unknown): value is Coordinates {
  return object(value) && finite(value['lat'], -90, 90) && finite(value['lon'], -180, 180);
}
function validRssi(value: unknown): value is number {
  return finite(value, -127, 20) && Number.isInteger(value);
}
function validPosition(value: unknown): value is PositionFix {
  return object(value) && validCoordinates(value['coordinates']) && ['gps','mec','relay'].includes(String(value['source']))
    && timestamp(value['observedAt']) && typeof value['simulation'] === 'boolean'
    && (value['accuracyM'] === null || finite(value['accuracyM'], 0, 100_000));
}
function validBle(value: unknown): value is BleReading {
  return object(value) && identifier(value['gatewayId']) && validRssi(value['rssiDbm'])
    && timestamp(value['observedAt']) && typeof value['simulation'] === 'boolean';
}

export function parseGatewayAnchors(value: unknown): readonly GatewayAnchor[] {
  if (!Array.isArray(value) || value.length > 1000) throw new TypeError('Gateway 좌표 배열을 확인하세요.');
  const ids = new Set<string>();
  return value.map((item: unknown) => {
    if (!object(item) || !identifier(item['gatewayId']) || !label(item['label']) || !validCoordinates(item['position'])
      || typeof item['simulation'] !== 'boolean' || !finite(item['referenceRssiDbm'], -127, -1)
      || !finite(item['pathLossExponent'], 1, 6) || ids.has(item['gatewayId'])) {
      throw new TypeError('Gateway 식별자·좌표·BLE 교정값을 확인하세요.');
    }
    ids.add(item['gatewayId']);
    return {
      gatewayId: item['gatewayId'], label: item['label'], position: { lat: item['position'].lat, lon: item['position'].lon },
      simulation: item['simulation'], referenceRssiDbm: item['referenceRssiDbm'], pathLossExponent: item['pathLossExponent'],
    };
  });
}

export function parseLocationSnapshot(value: unknown): LocationSnapshot {
  if (!object(value) || value['schemaVersion'] !== '1.0.0' || !['demo', 'live'].includes(String(value['mode']))
    || !['demo-fixture', 'local-jsonl', 'portal-api', 'combined'].includes(String(value['source'])) || typeof value['simulation'] !== 'boolean'
    || !timestamp(value['updatedAt']) || (value['readExpiresAt']!==undefined&&!timestamp(value['readExpiresAt'])) || typeof value['caughtUp'] !== 'boolean'
    || !Number.isSafeInteger(value['rejectedRecords']) || (value['rejectedRecords'] as number) < 0
    || !Array.isArray(value['devices']) || value['devices'].length > 1000) {
    throw new TypeError('위치 응답 형식을 확인하세요.');
  }
  if ((value['mode'] === 'demo') !== (value['source'] === 'demo-fixture') || (value['mode'] === 'demo' && value['simulation'] !== true)) {
    throw new TypeError('위치 데이터 출처를 확인하세요.');
  }
  const gateways = parseGatewayAnchors(value['gateways']);
  const ids = new Set<string>();
  const devices = value['devices'].map((item: unknown): LocationDevice => {
    if (!object(item) || !identifier(item['deviceId']) || !label(item['label']) || ids.has(item['deviceId'])
      || (item['position'] !== null && !validPosition(item['position'])) || (item['ble'] !== null && !validBle(item['ble']))
      || (item['position'] === null && item['ble'] === null)) throw new TypeError('키링 위치·BLE 관측 형식을 확인하세요.');
    const position = item['position'] as PositionFix | null;
    const ble = item['ble'] as BleReading | null;
    if (value['simulation'] === true && (position?.simulation === false || ble?.simulation === false)) {
      throw new TypeError('모의 위치 데이터의 출처 표기를 확인하세요.');
    }
    ids.add(item['deviceId']);
    return { deviceId: item['deviceId'], label: item['label'], position, ble };
  });
  return {
    schemaVersion: '1.0.0', mode: value['mode'] as LocationSnapshot['mode'], source: value['source'] as LocationSnapshot['source'],
    simulation: value['simulation'], updatedAt: value['updatedAt'], caughtUp: value['caughtUp'],
    rejectedRecords: value['rejectedRecords'] as number, devices, gateways,
    ...(typeof value['readExpiresAt']==='string'?{readExpiresAt:value['readExpiresAt']}:{}),
  };
}

/** MEC, CORE telemetry, Gateway observation을 독립된 위치·신호 시계열로 정규화합니다. */
export function ingestLocationRecord(
  state: LocationState,
  raw: unknown,
  options: { readonly simulation: boolean; readonly now?: number },
): { readonly state: LocationState; readonly accepted: boolean } {
  if (!object(raw)) return { state, accepted: false };
  const payload = object(raw['payload']) ? raw['payload'] : raw;
  const sensors = object(payload['sensorValues']) ? payload['sensorValues'] : {};
  const deviceId = payload['deviceId'] ?? raw['deviceId'] ?? raw['ueId'];
  const observedAt = payload['observedAt'] ?? payload['timestamp'] ?? raw['observedAt'] ?? raw['timestamp'];
  if (!identifier(deviceId) || !timestamp(observedAt)) return { state, accepted: false };
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now) || Date.parse(observedAt) > now + 5000) return { state, accepted: false };
  if (raw['deviceId'] !== undefined && payload['deviceId'] !== undefined && raw['deviceId'] !== payload['deviceId']) {
    return { state, accepted: false };
  }
  const simulation = options.simulation || raw['simulation'] === true || payload['simulation'] === true;
  const point = payload['location'] ?? payload['position'] ?? sensors['location'];
  const positionSource = raw['sourceType']==='BLE_RELAY_OBSERVATION' ? 'relay' : raw['service'] === 'Location' ? 'mec'
    : payload['locationSource'] ?? sensors['locationSource'] ?? (object(point) ? point['source'] : undefined);
  const accuracy = object(point) ? point['accuracyM'] ?? payload['accuracyM'] ?? null : null;
  const position: PositionFix | null = validCoordinates(point) && (positionSource === 'gps' || positionSource === 'mec' || positionSource === 'relay')
    && (accuracy === null || finite(accuracy, 0, 100_000))
    ? { coordinates: { lat: point.lat, lon: point.lon }, source: positionSource, observedAt, accuracyM: accuracy, simulation } : null;
  const gatewayId = payload['gatewayId'] ?? raw['gatewayId'];
  const rssi = payload['rssiDbm'] ?? payload['rssi'];
  const ble: BleReading | null = identifier(gatewayId) && validRssi(rssi)
    ? { gatewayId, rssiDbm: rssi, observedAt, simulation } : null;
  if (position === null && ble === null) return { state, accepted: false };
  const previous = Object.hasOwn(state, deviceId) ? state[deviceId] : undefined;
  const newer = <T extends { readonly observedAt: string }>(next: T | null, prior: T | null): T | null =>
    next !== null && (prior === null || Date.parse(prior.observedAt) > now + 5000
      || Date.parse(next.observedAt) >= Date.parse(prior.observedAt)) ? next : prior;
  const nextPosition = newer(position, previous?.position ?? null);
  const nextBle = newer(ble, previous?.ble ?? null);
  const nextLabel = label(raw['label']) ? raw['label'] : previous?.label ?? deviceId;
  if (previous?.position === nextPosition && previous.ble === nextBle && previous.label === nextLabel) return { state, accepted: true };
  return {
    state: { ...state, [deviceId]: { deviceId, label: nextLabel, position: nextPosition, ble: nextBle } },
    accepted: true,
  };
}

export function locationReducer(state: LocationState, event: DashboardEvent, now = Date.now()): LocationState {
  if (event.type !== 'integration.receipt' && event.type !== 'gateway.telemetry') return state;
  return ingestLocationRecord(state, event.receipt, { simulation: event.simulation, now }).state;
}

export function freshness(observedAt: string, now = Date.now(), maxAgeMs = LOCATION_STALE_AFTER_MS): 'fresh' | 'stale' | 'future' | 'unknown' {
  if (!timestamp(observedAt) || !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return 'unknown';
  const age = now - Date.parse(observedAt);
  if (age < -5000) return 'future';
  return age > maxAgeMs ? 'stale' : 'fresh';
}

export interface BleProximity {
  readonly center: Coordinates;
  readonly gatewayLabel: string;
  readonly distanceM: number;
  readonly radiusM: number;
  readonly capped: boolean;
  readonly referenceRssiDbm: number;
  readonly pathLossExponent: number;
  readonly simulation: boolean;
}

/** d = 10^((RSSI@1m − RSSI)/(10n)); 원 중심은 BLE 수신기 좌표입니다. */
export function estimateBleProximity(reading: BleReading, gateways: readonly GatewayAnchor[]): BleProximity | null {
  if (!validBle(reading)) return null;
  const gateway = gateways.find((anchor) => anchor.gatewayId === reading.gatewayId);
  if (gateway === undefined || !validCoordinates(gateway.position) || !finite(gateway.referenceRssiDbm, -127, -1)
    || !finite(gateway.pathLossExponent, 1, 6)) return null;
  const distanceM = 10 ** ((gateway.referenceRssiDbm - reading.rssiDbm) / (10 * gateway.pathLossExponent));
  return {
    center: gateway.position, gatewayLabel: gateway.label, distanceM, radiusM: Math.min(distanceM, MAX_BLE_RADIUS_M),
    capped: distanceM > MAX_BLE_RADIUS_M, referenceRssiDbm: gateway.referenceRssiDbm, pathLossExponent: gateway.pathLossExponent,
    simulation: reading.simulation || gateway.simulation,
  };
}
