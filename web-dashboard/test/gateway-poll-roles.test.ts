import assert from 'node:assert/strict';
import test from 'node:test';
import { startGatewayPollSource } from '../server/cse-gateway-poll.ts';
import type { CseLiveConfig } from '../server/cse-live.ts';

const ADMIN = 'CAdmin-should-never-appear';
const base = '/Mobius';
const obs = 'bubble-household-1/gateway-1/observations';

function cin(ri: string, ct: string) {
  return { 'm2m:cin': { ri, rn: ri, pi: 'p', ty: 4, ct, lt: ct, st: 1, cr: 'gateway-1', con: { deviceId: 'keyring-x', gatewayId: 'gateway-1', battery: 80, rssi: -60, state: true, receivedAt: '2026-11-20T10:00:00Z' } } };
}

test('gateway poll with role bindings reads the timeline as operator and the guardian view as guardian, never as admin', async () => {
  const seen: { origin: string; path: string }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init.headers);
    const origin = headers.get('X-M2M-Origin') ?? '';
    seen.push({ origin, path: url.pathname });
    const rqi = headers.get('X-M2M-RI') ?? '';
    const reply = (rsc: number, body: unknown) => new Response(JSON.stringify(body), { status: rsc === 4103 ? 403 : 200, headers: { 'X-M2M-RI': rqi, 'X-M2M-RSC': String(rsc) } });
    if (origin === 'Cpb-dash-visitor') return reply(4103, {});
    if (url.searchParams.get('fu') === '1') return reply(2000, { 'm2m:uril': [`${base}/${obs}/cin-1`] });
    return reply(2000, cin('cin-1', '20261120T100000'));
  }) as typeof fetch;
  const binding = (role: string) => ({ originator: `Cpb-dash-${role}`, endpoint: 'https://cse.example:8443/onem2m', cert: '', key: '', ca: '' });
  const config: CseLiveConfig = {
    layout: 'gateway-container', cse: { endpoint: 'https://cse.example:8443/onem2m', cseBase: base, cseId: '/bubble-cse' }, simulation: false,
    gatewayAeId: 'gateway-1', automationAeId: 'automation', operator: { aeId: ADMIN, rn: 'admin' }, gatewayReader: ADMIN,
    paths: { observations: obs }, pollMs: 60000, roles: { operator: binding('operator'), guardian: binding('guardian') },
  } as CseLiveConfig;
  const source = await startGatewayPollSource(config, { fetchImpl });
  try {
    assert.ok(seen.length > 0);
    assert.equal(seen.some((item) => item.origin === ADMIN), false, 'admin originator is never sent');
    assert.ok(seen.some((item) => item.origin === 'Cpb-dash-operator'));
    assert.ok(seen.some((item) => item.origin === 'Cpb-dash-guardian'));
    assert.equal(source.events.length, 1, 'one timeline record from the operator read');
    const overlay = source.guardianOverlay.apply({ principal: { role: 'guardian', principalId: 'g' }, households: [{ householdId: 'h' }], devices: [], notifications: [] }) as { devices: { deviceId: string }[] };
    assert.deepEqual(overlay.devices.map((device) => device.deviceId), ['keyring-x'], 'guardian view from the guardian read');
    const described = source.describe() as { originators: Record<string, { originator: string; lastRsc: number }> };
    assert.equal(described.originators['operator']?.originator, 'Cpb-dash-operator');
    assert.equal(described.originators['guardian']?.lastRsc, 2000);
  } finally { await source.close(); }
});

test('a role binding denied with 4103 is reported and its view stays empty', async () => {
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const rqi = headers.get('X-M2M-RI') ?? '';
    const origin = headers.get('X-M2M-Origin') ?? '';
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (origin === 'Cpb-dash-guardian') return new Response('{}', { status: 403, headers: { 'X-M2M-RI': rqi, 'X-M2M-RSC': '4103' } });
    if (url.searchParams.get('fu') === '1') return new Response(JSON.stringify({ 'm2m:uril': [] }), { status: 200, headers: { 'X-M2M-RI': rqi, 'X-M2M-RSC': '2000' } });
    return new Response('{}', { status: 404, headers: { 'X-M2M-RI': rqi, 'X-M2M-RSC': '4004' } });
  }) as typeof fetch;
  const binding = (role: string) => ({ originator: `Cpb-dash-${role}`, endpoint: 'https://cse.example:8443/onem2m', cert: '', key: '', ca: '' });
  const source = await startGatewayPollSource({
    layout: 'gateway-container', cse: { endpoint: 'https://cse.example:8443/onem2m', cseBase: base, cseId: '/bubble-cse' }, simulation: false,
    gatewayAeId: 'gateway-1', automationAeId: 'automation', operator: { aeId: 'Cpb-dash-operator', rn: 'dash-operator' },
    paths: { observations: obs }, pollMs: 60000, roles: { operator: binding('operator'), guardian: binding('guardian') },
  } as CseLiveConfig, { fetchImpl });
  try {
    const described = source.describe() as { originators: Record<string, { lastRsc: number; accessDenied: string[] }> };
    assert.equal(described.originators['guardian']?.lastRsc, 4103);
    assert.ok(described.originators['guardian']!.accessDenied.length > 0);
    const overlay = source.guardianOverlay.apply({ principal: { role: 'guardian', principalId: 'g' }, households: [{ householdId: 'h' }], devices: [], notifications: [] }) as { devices: unknown[] };
    assert.equal(overlay.devices.length, 0);
  } finally { await source.close(); }
});

test('two PANIC presses inside one observation give two ordered panic events', async () => {
  const cins = [{ ri: 'cin-1', ct: '20261120T100000', presses: [3, 1] }];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const rqi = new Headers(init.headers).get('X-M2M-RI') ?? '';
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'X-M2M-RI': rqi, 'X-M2M-RSC': '2000' } });
    if (url.searchParams.get('fu') === '1') return reply({ 'm2m:uril': cins.map((item) => `${base}/${obs}/${item.ri}`) });
    const item = url.pathname.endsWith('/la') ? cins[cins.length - 1] : cins.find((entry) => url.pathname.endsWith(`/${entry.ri}`));
    if (!item) return new Response('{}', { status: 404, headers: { 'X-M2M-RI': rqi, 'X-M2M-RSC': '4004' } });
    return reply({ 'm2m:cin': { ri: item.ri, rn: item.ri, pi: 'p', ty: 4, ct: item.ct, lt: item.ct, st: 1, cr: 'gateway-1',
      con: { deviceId: 'keyring-x', gatewayId: 'gateway-1', battery: 80, rssi: -60, state: false, buttonState: 'released', sensorValues: { buttonPresses: item.presses } } } });
  }) as typeof fetch;
  const source = await startGatewayPollSource({
    layout: 'gateway-container', cse: { endpoint: 'https://cse.example:8443/onem2m', cseBase: base, cseId: '/bubble-cse' }, simulation: false,
    gatewayAeId: 'gateway-1', automationAeId: 'automation', operator: { aeId: 'Cpb-dash-operator', rn: 'dash-operator' },
    paths: { observations: obs }, pollMs: 60000,
  } as CseLiveConfig, { fetchImpl });
  try {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    source.guardianOverlay.onPanic(async (event) => { order.push(`start:${event.key}`); if (order.length === 1) await gate; order.push(`end:${event.key}`); });
    cins.push({ ri: 'cin-2', ct: '20261120T100003', presses: [3, 3] });
    await source.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ['start:cin-2'], 'the second event waits for the first');
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ['start:cin-2', 'end:cin-2', 'start:cin-2:1', 'end:cin-2:1']);
  } finally { await source.close(); }
});

test('a MEC013 location cin becomes the keyring position (loc.crd is [lon,lat])', async () => {
  const { mecLocationFix } = await import('../server/cse-gateway-poll.ts');
  const fix = mecLocationFix({ con: { observedAt: '2026-11-20T10:47:48.000Z', accuracyM: null, simulation: false }, loc: { typ: 1, crd: '[7.418,43.737]' } }, 'keyring-x', 'Spare keyring');
  assert.deepEqual(fix, { deviceId: 'keyring-x', label: 'Spare keyring', ble: null, position: { coordinates: { lat: 43.737, lon: 7.418 }, source: 'mec', observedAt: '2026-11-20T10:47:48.000Z', accuracyM: null, simulation: false } });
  assert.equal(mecLocationFix({ con: { observedAt: '2026-11-20T10:47:48.000Z' }, loc: { crd: '[200,43]' } }, 'k', 'k'), null, 'out-of-range longitude');
  assert.equal(mecLocationFix({ con: {}, loc: { crd: '[7.4,43.7]' } }, 'k', 'k'), null, 'no observedAt');
  assert.equal(mecLocationFix({ con: { observedAt: '2026-11-20T10:47:48.000Z' }, loc: { crd: '[7.4,43.7]' } }, 'k', 'k', true)?.position?.simulation, true, 'sandbox UE fix is marked simulated');
});
