import { useEffect, useId, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { estimateBleProximity, freshness } from '../shared/location.ts';
import type { Coordinates, LocationDevice } from '../shared/location.ts';
import { fallbackMapTile, mapTileStyle, validMapGeofence } from '../shared/map-presentation.ts';
import type { MapGeofence, MapStyle } from '../shared/map-presentation.ts';
import { useLocations } from './useLocations.ts';
import { Badge, Timestamp } from './ui.tsx';
import { useLang } from './i18n.tsx';
import './location-map.css';

type Tr = (ko: string, en: string) => string;
const colors = ['#0070d1', '#7d4cdb', '#c2410c', '#0f8a5f', '#b4237a'];
const coordinate = (point: Coordinates): L.LatLngTuple => [point.lat, point.lon];
const meters = (value: number) => value < 10 ? `${value.toFixed(1)} m` : `${Math.round(value).toLocaleString()} m`;
const observationTime = (device: LocationDevice) => [device.position?.observedAt, device.ble?.observedAt]
  .filter((at): at is string => at !== undefined).sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
const emptyGeofences: readonly MapGeofence[] = [];
type Overlay = 'proximity' | 'accuracy' | 'receivers' | 'zones';
const allOverlays: Readonly<Record<Overlay, boolean>> = { proximity: true, accuracy: true, receivers: true, zones: true };

function textElement(text: string, className = '') {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function MapIcon({ name }: { readonly name: 'locate' | 'refresh' | 'pin' | 'signal' | 'layers' }) {
  const paths = {
    locate: <><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" /><path d="M12 2v3m0 14v3M2 12h3m14 0h3" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2" /></>,
    pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z" /><circle cx="12" cy="10" r="2" /></>,
    signal: <><path d="M5 18v2m5-7v7m5-12v12m5-17v17" /></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5" /></>,
  };
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function sourceName(device: LocationDevice, user: boolean, tr: Tr) {
  if (device.position?.source === 'relay') return user ? tr('근처 릴레이가 감지한 범위', 'Range seen by a nearby relay') : tr('릴레이 범위 (BLE, MEC)', 'Relay range (BLE, MEC)');
  if (device.position?.source === 'gps') return user ? tr('GPS로 확인한 위치', 'Location from GPS') : tr('GPS 위치', 'GPS location');
  if (device.position?.source === 'mec') return user ? tr('통신망 위치 서비스로 확인', 'Location from the network service') : tr('통신망 위치 (MEC)', 'Network location (MEC)');
  return user ? tr('수신기 근처에서 감지', 'Seen near a receiver') : tr('수신기 기준 (BLE)', 'From a receiver (BLE)');
}

export function LocationMap({ refresh, variant = 'operator', geofences = emptyGeofences, locationUrl = '/api/locations' }: {
  readonly refresh: number;
  readonly variant?: 'operator' | 'user';
  readonly locationUrl?: string;
  readonly geofences?: readonly MapGeofence[];
}) {
  const { lang, tr } = useLang();
  const feed = useLocations(refresh, locationUrl);
  const [selectedId, setSelectedId] = useState('');
  const [tileStyle, setTileStyle] = useState<MapStyle>('map');
  const [tileFallback, setTileFallback] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [overlays, setOverlays] = useState(allOverlays);
  const [layerOpen, setLayerOpen] = useState(false);
  const layerControl = useRef<HTMLDivElement>(null);
  const layerPanelId = useId();
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<L.FeatureGroup | null>(null);
  const [tileReload, setTileReload] = useState(0);
  const initialFit = useRef(false);
  const markers = useRef(new Map<string, L.Marker>());
  const devices = feed.snapshot?.devices ?? [];
  const selected = devices.find((device) => device.deviceId === selectedId) ?? devices[0];
  const selectedProximity = selected?.ble && feed.snapshot ? estimateBleProximity(selected.ble, feed.snapshot.gateways) : null;
  const demo = feed.snapshot?.mode === 'demo';
  const user = variant === 'user';
  const plotSignature = JSON.stringify({ devices, gateways: feed.snapshot?.gateways, selected: selected?.deviceId, demo, overlays, geofences, lang,
    ages: devices.map((device) => [device.position && freshness(device.position.observedAt, feed.now), device.ble && freshness(device.ble.observedAt, feed.now)]) });

  useEffect(() => {
    if (!container.current) return;
    const instance = L.map(container.current, { scrollWheelZoom: true, wheelPxPerZoomLevel: 80, zoomControl: false, zoomAnimation: false }).setView([37.5665, 126.978], 16);
    L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(instance);
    map.current = instance;
    layers.current = L.featureGroup().addTo(instance);
    const observer = new ResizeObserver(() => instance.invalidateSize({ pan: false }));
    observer.observe(container.current);
    return () => { observer.disconnect(); instance.stop(); instance.remove(); map.current = null; layers.current = null; initialFit.current = false; };
  }, []);

  // Zoom buttons carry their titles in the current language; the control is rebuilt when the language changes.
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const zoom = L.control.zoom({ zoomInTitle: tr('지도 확대', 'Zoom in'), zoomOutTitle: tr('지도 축소', 'Zoom out'), position: 'bottomright' }).addTo(instance);
    return () => { zoom.remove(); };
  }, [lang]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    const useFallback = tileStyle === 'map' && tileFallback;
    const source = useFallback ? fallbackMapTile : mapTileStyle(tileStyle, {
      customUrl: import.meta.env['VITE_MAP_TILE_URL'] || '',
      customAttribution: import.meta.env['VITE_MAP_ATTRIBUTION'] || '',
      stadiaKey: import.meta.env['VITE_STADIA_MAPS_KEY'] || '',
      stadiaDomain: import.meta.env['VITE_STADIA_MAPS_DOMAIN'] || '',
      hostname: window.location.hostname,
    });
    setTileError(false);
    instance.setMaxZoom(source.maxZoom);
    // A road map that fails (no Stadia key on a public domain, custom server down) switches to OpenStreetMap once.
    const failed = () => { if (tileStyle === 'map' && !useFallback) setTileFallback(true); else setTileError(true); };
    const background = L.tileLayer(source.url, { maxZoom: source.maxZoom, attribution: source.attribution }).addTo(instance);
    background.on('tileerror', failed);
    return () => { background.remove(); };
  }, [tileStyle, tileFallback, tileReload]);

  useEffect(() => {
    if (!layerOpen) return;
    const close = (event: PointerEvent) => { if (!layerControl.current?.contains(event.target as Node)) setLayerOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setLayerOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape); };
  }, [layerOpen]);

  useEffect(() => {
    const group = layers.current;
    const instance = map.current;
    if (!group || !instance) return;
    if(!feed.snapshot){group.clearLayers();markers.current.clear();initialFit.current=false;instance.setView([37.5665,126.978],12,{animate:false});return;}
    group.clearLayers();
    markers.current.clear();
    if(!devices.length){initialFit.current=false;instance.setView([37.5665,126.978],12,{animate:false});}
    for (const fence of overlays.zones ? geofences.filter(validMapGeofence) : []) {
      const style = { color: '#348e70', weight: 1.5, fillColor: '#79c9aa', fillOpacity: 0.09, dashArray: '4 6' };
      const shape = fence.shape;
      const geometry = shape.type === 'circle' ? L.circle([shape.lat, shape.lon], { ...style, radius: shape.radiusM })
        : L.rectangle([[shape.minLat, shape.minLon], [shape.maxLat, shape.maxLon]], style);
      geometry.bindTooltip(textElement(`${fence.label} (${fence.simulation ? tr('모의 안전 구역', 'simulated safe zone') : tr('등록한 안전 구역', 'registered safe zone')})`)).addTo(group);
    }
    for (const gateway of overlays.receivers ? feed.snapshot.gateways : []) {
      L.circleMarker(coordinate(gateway.position), { radius: 5, color: '#3b5067', fillColor: '#fff', fillOpacity: 1, weight: 2 })
        .bindTooltip(textElement(`${gateway.label} (${tr('수신기', 'receiver')})`)).addTo(group);
    }
    devices.forEach((device, index) => {
      const color = colors[index % colors.length]!;
      const proximity = device.ble ? estimateBleProximity(device.ble, feed.snapshot!.gateways) : null;
      const fix = device.position;
      const active = selected?.deviceId === device.deviceId;
      if (proximity && device.ble && overlays.proximity) {
        const old = freshness(device.ble.observedAt, feed.now) !== 'fresh' && !demo;
        L.circle(coordinate(proximity.center), {
          radius: proximity.radiusM, color, weight: active ? 2 : 1,
          fillOpacity: old ? 0.025 : active ? 0.14 : 0.055, opacity: old ? 0.35 : active ? 0.85 : 0.45,
          dashArray: old ? '2 6' : '5 5',
        }).bindTooltip(textElement(tr(`${device.label}: ${proximity.gatewayLabel}에서 약 ${meters(proximity.distanceM)} (${device.ble.rssiDbm} dBm, ${proximity.simulation ? '모의' : '실측'})`, `${device.label}: about ${meters(proximity.distanceM)} from ${proximity.gatewayLabel} (${device.ble.rssiDbm} dBm, ${proximity.simulation ? 'simulated' : 'measured'})`)))
          .on('click', () => setSelectedId(device.deviceId)).addTo(group);
      }
      if (fix?.accuracyM && overlays.accuracy) {
        L.circle(coordinate(fix.coordinates), { radius: fix.accuracyM, color, weight: 1, fillOpacity: 0.035, opacity: 0.25 })
          .bindTooltip(textElement(tr(`${device.label}: 오차 범위 ${meters(fix.accuracyM)}`, `${device.label}: accuracy ${meters(fix.accuracyM)}`))).addTo(group);
      }
      const point = fix?.coordinates ?? proximity?.center;
      if (!point) return;
      const markerName = `${device.label}, ${fix ? tr(`${fix.source.toUpperCase()} 위치`, `${fix.source.toUpperCase()} location`) : tr('수신기 기준 위치', 'receiver-based location')}`;
      const icon = document.createElement('div');
      icon.className = `keyring-pin${fix ? '' : ' receiver-pin'}${active ? ' selected' : ''}`;
      icon.style.setProperty('--pin-color', color);
      icon.append(textElement(String(index + 1), 'keyring-pin-number'));
      if (active) icon.append(textElement(device.label, 'keyring-pin-label'));
      const marker = L.marker(coordinate(point), {
        icon: L.divIcon({ html: icon, className: 'keyring-marker', iconSize: [40, 48], iconAnchor: fix ? [20, 46] : [20, 20] }),
        title: markerName, alt: markerName, keyboard: true, riseOnHover: true,
        opacity: freshness((fix ?? device.ble)!.observedAt, feed.now) === 'fresh' || demo ? 1 : 0.5,
        zIndexOffset: active ? 500 : 0,
      }).bindTooltip(textElement(markerName), { direction: 'top', offset: [0, -45] })
        .on('click', () => setSelectedId(device.deviceId)).addTo(group);
      markers.current.set(device.deviceId, marker);
    });
    if (!initialFit.current && devices.length && group.getBounds().isValid()) {
      instance.fitBounds(group.getBounds(), { padding: [70, 70], maxZoom: 18 });
      initialFit.current = true;
    }
  }, [plotSignature]);

  function fitAll() {
    const bounds = layers.current?.getBounds();
    if (bounds?.isValid()) map.current?.fitBounds(bounds, { padding: [70, 70], maxZoom: 18 });
  }
  function focusDevice(device: LocationDevice) {
    setSelectedId(device.deviceId);
    const marker = markers.current.get(device.deviceId);
    if (marker) map.current?.setView(marker.getLatLng(), Math.max(map.current.getZoom(), 18));
  }
  const selectedTime = selected && observationTime(selected);
  const status = selectedTime ? freshness(selectedTime, feed.now) : 'unknown';
  const signalLabel = selected?.ble ? selected.ble.rssiDbm >= -65 ? tr('강함', 'strong') : selected.ble.rssiDbm >= -80 ? tr('보통', 'fair') : tr('약함', 'weak') : tr('신호 기다리는 중', 'waiting for a signal');
  const simulatedLabel = tr('모의 데이터', 'Simulated data');
  const sourceLabel = demo ? simulatedLabel : feed.snapshot ? feed.snapshot.simulation ? simulatedLabel : tr('실제 위치', 'Real location') : tr('연결하는 중', 'Connecting');
  const geofenceCount = geofences.filter(validMapGeofence).length;
  const feedError = feed.error && lang === 'en' ? (feed.error.includes('권한') ? 'A location share permission is needed to see the location.' : 'Lost the connection to the location server. Showing the last location and time.') : feed.error;
  const overlayOptions: readonly (readonly [Overlay, string, string])[] = [
    ['proximity', 'legend-ring', tr('블루투스 추정 범위', 'Bluetooth proximity range')],
    ['accuracy', 'legend-accuracy', tr('위치 오차 범위', 'Location accuracy')],
    ['receivers', 'legend-anchor', tr('수신기', 'Receivers')],
    ...(geofenceCount > 0 ? [['zones', 'legend-zone', tr(`안전 구역 ${geofenceCount}개`, `${geofenceCount} safe zones`)] as const] : []),
  ];
  const sim = (value: boolean) => (value ? tr(' (모의)', ' (simulated)') : tr(' (실측)', ' (measured)'));

  return <div className={`location-experience location-${variant}`}>
    <div className="location-toolbar">
      <div className="location-feed-state"><span className={`location-status-dot${feed.error ? ' attention' : ''}`} />
        <strong>{user ? tr('키링 위치', 'Keyring location') : tr('위치 모니터링', 'Location monitoring')}</strong><span className="location-divider" /><span>{tr(`키링 ${devices.length}개`, `${devices.length} ${devices.length === 1 ? 'keyring' : 'keyrings'}`)}</span>
        <Badge tone={feed.snapshot?.simulation ? 'warning' : 'info'}>{sourceLabel}</Badge>
      </div>
      <div className="location-actions">
        <button type="button" className="map-quiet-button" onClick={fitAll}><MapIcon name="locate" />{tr('모두 보기', 'Show all')}</button>
        <button type="button" className="map-icon-button" onClick={feed.reload} aria-label={tr('위치 새로고침', 'Refresh location')} title={tr('위치 새로고침', 'Refresh location')}><MapIcon name="refresh" /></button>
      </div>
    </div>
    {feedError && <p className="location-alert" role="alert">{feedError}</p>}
    {tileError && <div className="location-alert" role="status"><span>{tr('배경 지도를 불러오지 못했어요. 키링 위치와 범위는 그대로 보여 드려요.', 'The background map did not load. Keyring locations and ranges are still shown.')}</span>
      <button type="button" onClick={() => { setTileError(false); setTileReload((count) => count + 1); }}>{tr('지도 다시 불러오기', 'Reload the map')}</button></div>}
    <div className="location-layout">
      <div className="map-frame">
        <div ref={container} className="location-canvas" role="region" aria-label={tr('키링 위치 지도', 'Keyring location map')} />
        <div className="map-layer-control" ref={layerControl}>
          <button type="button" className="map-layer-button" aria-expanded={layerOpen} aria-controls={layerPanelId} onClick={() => setLayerOpen((open) => !open)}>
            <MapIcon name="layers" />{tr('레이어', 'Layers')}</button>
          {layerOpen && <div className="map-layer-panel" id={layerPanelId} role="group" aria-label={tr('지도 레이어 설정', 'Map layer settings')}>
            <span className="map-layer-heading">{tr('배경', 'Background')}</span>
            <div className="map-background-options">
              {(['map', 'satellite'] as const).map((style) => <button key={style} type="button" className={`map-background-option bg-${style}`} aria-pressed={tileStyle === style} onClick={() => setTileStyle(style)}>
                <span className="map-background-thumb" aria-hidden="true" />{style === 'map' ? tr('지도', 'Map') : tr('위성', 'Satellite')}</button>)}
            </div>
            <span className="map-layer-heading">{tr('표시할 정보', 'Show on map')}</span>
            {overlayOptions.map(([key, icon, label]) => <label key={key} className="map-overlay-option">
              <input type="checkbox" checked={overlays[key]} onChange={(event) => { const on = event.currentTarget.checked; setOverlays((value) => ({ ...value, [key]: on })); }} />
              <i className={icon} aria-hidden="true" /><span>{label}</span></label>)}
          </div>}
        </div>
        <div className="map-corner-note"><span className="map-live-dot" />{tr('4초마다 새로고침', 'Refreshes every 4 s')}</div>
        <div className="map-legend"><span><i className="legend-pin" />{tr('GPS/통신망 위치', 'GPS / network location')}</span>
          {overlayOptions.filter(([key]) => overlays[key]).map(([key, icon, label]) => <span key={key}><i className={icon} />{label}</span>)}
          <span className="map-legend-hint">{tr('마우스 휠로 확대/축소', 'Scroll to zoom')}</span>
        </div>
      </div>
      <aside className="location-side" aria-label={tr('키링 위치 정보', 'Keyring location details')}>
        <div className="keyring-list-header"><h3>{user ? tr('연결된 키링', 'Connected keyrings') : tr('키링 목록', 'Keyrings')}</h3><span>{devices.length}</span></div>
        <div className="keyring-list" aria-label={tr('지도 키링 선택', 'Choose a keyring on the map')}>
          {devices.map((device, index) => <button key={device.deviceId} type="button" className="keyring-option" aria-pressed={selected?.deviceId === device.deviceId}
            onClick={() => focusDevice(device)}>
            <span className="keyring-number" style={{ color: colors[index % colors.length], backgroundColor: `${colors[index % colors.length]}14` }}>{index + 1}</span>
            <span className="keyring-option-copy"><strong>{device.label}</strong><span>{sourceName(device, user, tr)}</span></span>
            <span className="keyring-option-signal">{device.ble ? <><MapIcon name="signal" /><span>{device.ble.rssiDbm}</span></> : <MapIcon name="pin" />}</span>
          </button>)}
          {devices.length === 0 && <p className="location-empty" role="status">{feed.loading ? tr('키링 위치를 불러오고 있어요…', 'Loading keyring locations…') : tr('키링 위치가 들어오면 여기에 표시돼요.', 'Keyring locations appear here when they arrive.')}</p>}
        </div>
        {selected && <article className="location-detail" aria-label={tr('선택한 키링 위치 상세', 'Selected keyring details')}>
          <div className="location-detail-heading"><div><span className="map-overline">{tr('선택한 키링', 'Selected keyring')}</span><h3>{selected.label}</h3></div>
            <Badge tone={demo ? 'warning' : status === 'fresh' ? 'success' : 'warning'}>{demo ? simulatedLabel : status === 'fresh' ? tr('방금 받음', 'Just received') : status === 'future' ? tr('시각 확인 필요', 'Check the time') : tr('업데이트 기다리는 중', 'Waiting for an update')}</Badge></div>
          <div className="location-measurements"><div><span>{tr('블루투스 신호', 'Bluetooth signal')}</span><strong>{selected.ble?.rssiDbm ?? '-'}<small>dBm</small></strong><span>{signalLabel}{selected.ble ? sim(selected.ble.simulation) : ''}</span></div>
            <div><span>{tr('수신기와의 거리', 'Distance to receiver')}</span><strong>{selectedProximity ? meters(selectedProximity.distanceM) : '-'}</strong><span>{selectedProximity?.simulation ? tr('모의 수신기 기준 추정', 'estimated from a simulated receiver') : selectedProximity ? tr('수신기 기준 추정', 'estimated from the receiver') : tr('수신기 등록 전', 'no receiver registered')}</span></div></div>
          <dl className="location-facts"><dt>{tr('확인 방법', 'Source')}</dt><dd>{sourceName(selected, user, tr)}{selected.position && sim(selected.position.simulation)}</dd>
            <dt>{tr('수신기', 'Receiver')}</dt><dd>{selectedProximity?.gatewayLabel ?? selected.ble?.gatewayId ?? tr('확인 전', 'unknown')}</dd>
            {selectedTime && <><dt>{tr('마지막 확인', 'Last seen')}</dt><dd><Timestamp at={selectedTime} variant={user ? 'friendly' : 'precise'} /></dd></>}
            {selected.position && !demo && freshness(selected.position.observedAt, feed.now) !== 'fresh' && <><dt>{tr('위치 상태', 'Location status')}</dt><dd>{tr('마지막으로 받은 좌표예요. 받은 시각을 확인해 주세요.', 'This is the last coordinate received. Check when it arrived.')}</dd></>}
          </dl>
          <details className="location-coordinate-details" open={!user}><summary>{user ? tr('좌표 자세히 보기', 'Coordinate details') : tr('좌표와 수신 정보', 'Coordinates and reception')}</summary>
            <dl className="location-facts">
              {selected.position && <><dt>{tr('위도, 경도', 'Latitude, longitude')}</dt><dd className="map-coordinate">{selected.position.coordinates.lat.toFixed(6)}, {selected.position.coordinates.lon.toFixed(6)}</dd>
                {selected.position.accuracyM !== null && <><dt>{tr('오차 범위', 'Accuracy')}</dt><dd>{meters(selected.position.accuracyM)}</dd></>}
                <dt>{tr('위치 받은 시각', 'Location received')}</dt><dd><Timestamp at={selected.position.observedAt} /></dd></>}
              {selected.ble && <><dt>{tr('신호 받은 시각', 'Signal received')}</dt><dd><Timestamp at={selected.ble.observedAt} /></dd></>}
              {selectedProximity && <><dt>{tr('수신기 좌표', 'Receiver coordinates')}</dt><dd className="map-coordinate">{selectedProximity.center.lat.toFixed(6)}, {selectedProximity.center.lon.toFixed(6)}</dd>
                {selectedProximity.capped && <><dt>{tr('지도 표시 반경', 'Radius shown')}</dt><dd>{tr(`최대 ${meters(selectedProximity.radiusM)}까지 표시`, `capped at ${meters(selectedProximity.radiusM)}`)}</dd></>}
              </>}
            </dl>
          </details>
        </article>}
      </aside>
    </div>
    <p className="location-caption">{tr('핀은 GPS나 위치 서비스로 받은 좌표예요. 점선 원은 수신기를 중심으로 키링이 있을 만한 범위이고 옅은 실선 원은 위치 오차 범위예요.', 'The pin is the GPS or network location. The dashed circle is where the keyring likely is around its receiver, and the light solid circle is the location accuracy.')}</p>
    {!user && <details className="location-method"><summary>{tr('위치를 받는 방법과 거리 계산', 'How locations and distances are computed')}</summary>
      <div><p>{tr('위치와 블루투스 신호는 4초마다 새로 받고, 각 기록이 만들어진 시각을 그대로 보여 줘요. 모의 데이터는 배지로 구분해요.', 'Locations and Bluetooth signals refresh every 4 seconds, each with the time it was recorded. Simulated data carries a badge.')}</p>
        <p>{tr('추정 거리 = 10 ^ ((1 m 기준 RSSI - 현재 RSSI) / (10 x 경로 손실 계수)). 수신기 교정값과 주변 환경이 반경에 반영돼요.', 'Estimated distance = 10 ^ ((RSSI at 1 m - current RSSI) / (10 x path loss exponent)). Receiver calibration and surroundings shape the radius.')}</p>
        {selectedProximity && <p>{tr(`선택한 수신기: 1 m 기준 ${selectedProximity.referenceRssiDbm} dBm, 경로 손실 계수 ${selectedProximity.pathLossExponent}`, `Selected receiver: ${selectedProximity.referenceRssiDbm} dBm at 1 m, path loss exponent ${selectedProximity.pathLossExponent}`)}</p>}
        {!!feed.snapshot?.rejectedRecords && <p>{tr(`형식이 맞지 않는 기록 ${feed.snapshot.rejectedRecords}건은 빼고 올바른 기록만 표시해요.`, `${feed.snapshot.rejectedRecords} malformed records are left out.`)}</p>}
        <p>{tr('지도 배경은 설정된 지도 공급자(설정이 없거나 불러오지 못하면 OpenStreetMap), 위성 배경은 Esri World Imagery를 써요. 키링 식별자와 신호 값은 로컬 서버에서 처리해요.', 'The map background is the configured tile provider (OpenStreetMap when none is set or it fails to load) and the satellite background is Esri World Imagery. Keyring IDs and signal values stay on the local server.')}</p>
      </div>
    </details>}
  </div>;
}
