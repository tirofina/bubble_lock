import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTileStyle, validMapGeofence } from '../shared/map-presentation.ts';
import type { MapGeofence } from '../shared/map-presentation.ts';

test('지도 공급자 전환은 각 공급자의 출처와 확대 한도를 함께 유지한다', () => {
  const light = mapTileStyle('light', { stadiaKey: 'local-test-key' });
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

test('키와 등록 도메인이 없으면 키 없는 일반 지도를 사용한다', () => {
  const street = mapTileStyle('street');
  assert.deepEqual(mapTileStyle('light'), street);
  assert.deepEqual(mapTileStyle('light', { stadiaKey: '   ', stadiaDomain: '  ', hostname: 'localhost' }), street);
});

test('등록 도메인이 현재 호스트와 일치하면 API 키 없이 Stadia를 사용한다', () => {
  const source = mapTileStyle('light', { stadiaDomain: '  MAPS.EXAMPLE.TEST  ', hostname: 'maps.example.test' });
  assert.equal(source.url, 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png');
  assert.match(source.attribution, /Stadia Maps/);
  assert.equal(source.maxZoom, 20);
});

test('등록 도메인은 정확한 호스트에만 적용하고 불일치하면 일반 지도를 사용한다', () => {
  for (const hostname of ['', 'localhost', 'other.example.test', 'maps.example.test.attacker.test', 'sub.maps.example.test']) {
    assert.deepEqual(mapTileStyle('light', { stadiaDomain: 'maps.example.test', hostname }), mapTileStyle('street'));
  }
  for (const stadiaDomain of ['https://maps.example.test', 'maps.example.test:443', '*.example.test']) {
    assert.deepEqual(mapTileStyle('light', { stadiaDomain, hostname: 'maps.example.test' }), mapTileStyle('street'));
  }
});

test('API 키는 도메인 설정보다 우선하고 앞뒤 공백을 제거한 뒤 인코딩한다', () => {
  const source = mapTileStyle('light', { stadiaKey: ' a+b/c? ', stadiaDomain: 'registered.example.test', hostname: 'localhost' });
  assert.equal(source.url, 'https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=a%2Bb%2Fc%3F');
});

test('로컬 타일 설정은 키와 도메인보다 우선하며 공급자 키를 전달하지 않는다', () => {
  const source = mapTileStyle('light', {
    customUrl: '/offline-tiles/{z}/{x}/{y}.png', customAttribution: 'Local QA tiles',
    stadiaKey: 'test-key', stadiaDomain: 'maps.example.test', hostname: 'maps.example.test',
  });
  assert.deepEqual(source, { url: '/offline-tiles/{z}/{x}/{y}.png', attribution: 'Local QA tiles', maxZoom: 19 });
  assert.deepEqual(mapTileStyle('street', { customUrl: source.url, stadiaKey: 'test-key', stadiaDomain: 'maps.example.test' }), mapTileStyle('street'));
});

test('지정된 안전 구역은 위경도·반경·경계 순서를 검증한 뒤 지도에 표시한다', () => {
  const circle: MapGeofence = { id: 'zone-1', label: '집 주변', simulation: true, shape: { type: 'circle', lat: 37.5, lon: 127, radiusM: 150 } };
  assert.equal(validMapGeofence(circle), true);
  assert.equal(validMapGeofence({ ...circle, shape: { ...circle.shape as Extract<MapGeofence['shape'], { type: 'circle' }>, radiusM: Infinity } }), false);
  assert.equal(validMapGeofence({ ...circle, shape: { type: 'circle', lat: 91, lon: 127, radiusM: 100 } }), false);
  assert.equal(validMapGeofence({ ...circle, shape: { type: 'bbox', minLat: 37, maxLat: 38, minLon: 126, maxLon: 127 } }), true);
  assert.equal(validMapGeofence({ ...circle, shape: { type: 'bbox', minLat: 38, maxLat: 37, minLon: 126, maxLon: 127 } }), false);
});
