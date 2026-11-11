import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTileStyle, validMapGeofence } from '../shared/map-presentation.ts';
import type { MapGeofence } from '../shared/map-presentation.ts';

test('지도 공급자 전환은 각 공급자의 출처와 확대 한도를 함께 유지한다', () => {
  const light = mapTileStyle('light');
  assert.match(light.url, /^https:\/\/tiles\.stadiamaps\.com\/tiles\/alidade_smooth\//);
  for (const credit of ['Stadia Maps', 'OpenMapTiles', 'OpenStreetMap']) assert.ok(light.attribution.includes(credit));
  assert.equal(light.maxZoom, 20);
  const street = mapTileStyle('street', { stadiaKey: 'local-test-key' });
  assert.equal(street.url, 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(street.maxZoom, 19);
  assert.match(mapTileStyle('light', { stadiaKey: 'a+b/c?' }).url, /api_key=a%2Bb%2Fc%3F$/);
  const custom = mapTileStyle('light', { customUrl: 'https://maps.example/{z}/{x}/{y}.png', customAttribution: 'Registered map provider' });
  assert.equal(custom.attribution, 'Registered map provider');
});

test('지정된 안전 구역은 위경도·반경·경계 순서를 검증한 뒤 지도에 표시한다', () => {
  const circle: MapGeofence = { id: 'zone-1', label: '집 주변', simulation: true, shape: { type: 'circle', lat: 37.5, lon: 127, radiusM: 150 } };
  assert.equal(validMapGeofence(circle), true);
  assert.equal(validMapGeofence({ ...circle, shape: { ...circle.shape as Extract<MapGeofence['shape'], { type: 'circle' }>, radiusM: Infinity } }), false);
  assert.equal(validMapGeofence({ ...circle, shape: { type: 'circle', lat: 91, lon: 127, radiusM: 100 } }), false);
  assert.equal(validMapGeofence({ ...circle, shape: { type: 'bbox', minLat: 37, maxLat: 38, minLon: 126, maxLon: 127 } }), true);
  assert.equal(validMapGeofence({ ...circle, shape: { type: 'bbox', minLat: 38, maxLat: 37, minLon: 126, maxLon: 127 } }), false);
});
