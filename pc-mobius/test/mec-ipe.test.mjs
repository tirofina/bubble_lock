import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeCse } from './support/fake-onem2m-cse.mjs';
import { startMecSandboxSimulator } from '../integration/src/mec-sandbox-simulator.mjs';
import { MecIpe, MEC_IPE_SPECIALIZATIONS, parseMecRequest } from '../integration/src/mec-ipe.mjs';
import { MecPlatformClient, classifyMecService, createMecFetch, mecSandboxConfig, normalizeMecNotification } from '../integration/src/mec-platform-client.mjs';
import { MecOneM2mConsumer, geofencePolygon } from '../integration/src/mec-onem2m-consumer.mjs';
import { Onem2mHttpClient, m2mTime, parseContent } from '../integration/src/onem2m-http-client.mjs';
import { MecCipher } from '../integration/src/mec-state.mjs';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { HandoverCoordinator } from '../integration/src/handover-coordinator.mjs';
import { MecPolicyReconciler } from '../integration/src/mec-adapter.mjs';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';

const exec = promisify(execFile);
async function waitFor(predicate, timeoutMs = 4000) { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = await predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); } throw new Error('waitFor timeout'); }
const zoneB = { type: 'bbox', minLat: 43.737, minLon: 7.42, maxLat: 43.74, maxLon: 7.425 };
const insideB = { lat: 43.7385, lon: 7.4225, accuracyM: 8, zoneId: 'zone-B', accessPointId: 'ap-B1' };
const ueAddress = '10.100.0.1';

async function fixture(t, { locationVersion = 'v3' } = {}) {
  let now = Date.now();
  const clock = () => now; const iso = () => new Date(now).toISOString();
  const sim = await startMecSandboxSimulator({ locationVersion, now: clock });
  const cse = await startFakeCse({ specializations: MEC_IPE_SPECIALIZATIONS });
  const ids = { ipe: 'Cmec-ipe-test', app: 'Capp-test', policy: 'Cpolicy-test', device: 'Ckeyring-test', other: 'Cother-test' };
  const client = (originator) => new Onem2mHttpClient({ endpoint: cse.endpoint, originator });
  const device = client(ids.device); const app = client(ids.app); const other = client(ids.other);
  const deviceAe = await device.registerAe({ rn: 'keyring-test', api: 'N.test.keyring' });
  for (const rn of ['location', 'rnis']) await device.ensure(deviceAe.path, 3, { 'm2m:cnt': { rn } });
  const store = await new IntegrationStore().init();
  const policyService = new PolicyService({ store, clock: iso });
  const principal = { principalId: 'guardian-test', scopes: ['consent:write', 'grant:write', 'grant:revoke', 'policy:approve'] };
  const consent = await policyService.createConsent({ principal, subjectId: 'home-test', purpose: 'ipe test', scopes: ['mec:location', 'mec:rnis'], ttlSec: 3600 });
  const grant = await policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['mec:location', 'mec:rnis'], ttlSec: 1800 });
  const policy = await policyService.approvePolicy({ principal, idempotencyKey: 'ipe-test', policy: { grantId: grant.grantId, ueId: 'keyring-test', targetEdgeId: 'edge-b', geofence: zoneB, servingCells: ['cell-B'], trigger: { kind: 'zone' } } });
  const coordinator = new HandoverCoordinator({ store, policyService, clock: iso });
  for (const edgeId of ['edge-a', 'edge-b']) coordinator.registerEdge({ edgeId, health: 'HEALTHY', load: 0 });
  await coordinator.handover({ ueId: 'keyring-test', targetEdgeId: 'edge-a', grantId: grant.grantId });
  const reconciler = new MecPolicyReconciler({ store, policyService, handoverCoordinator: coordinator, clock: iso });
  const cipher = new MecCipher({ store: { path: null }, encryptionKey: randomBytes(32).toString('base64') });
  const trace = [];
  const authorize = async ({ service, request }) => {
    const decision = policyService.evaluateGrant(request.intent?.grantId, { scope: service === 'Location' ? 'mec:location' : 'mec:rnis' });
    if (!decision.allowed) return { allowed: false, reason: `grant-${decision.reason}` };
    return decision.grant.revision === request.intent.grantRevision ? { allowed: true } : { allowed: false, reason: 'grant-revision-changed' };
  };
  const platform = new MecPlatformClient({ platformRoot: sim.platformRoot, simulation: true, appInstanceId: 'app-test' });
  const ipe = new MecIpe({ cse: { endpoint: cse.endpoint, cseId: cse.cseId }, originator: ids.ipe, platform, requesters: { Location: [ids.app], RNIS: [ids.app] }, readers: [ids.app, ids.policy], cipher, authorize, clock, leaseSec: 120, renewBeforeMs: 10000, renewCheckMs: 3600000, simulation: true, cellLocations: { 'cell-B': { lat: 43.7386, lon: 7.4224 } }, trace: (entry) => trace.push(entry) });
  const started = await ipe.start();
  const consumer = new MecOneM2mConsumer({ cse: { endpoint: cse.endpoint, cseId: cse.cseId }, originator: ids.policy, ipeOriginator: ids.ipe, cipher, reconciler, store, handoverCoordinator: coordinator, clock, trace: (entry) => trace.push(entry) });
  await consumer.start(); await consumer.watchDevice({ deviceId: 'keyring-test', devicePath: deviceAe.path });
  t.after(async () => { await consumer.stop(); await ipe.stop(); await sim.close(); await cse.close(); });
  const intent = { policyId: policy.policyId, grantId: grant.grantId, grantRevision: grant.revision, policyRevision: policy.revision };
  const settle = async () => { await ipe.idle(); await consumer.idle(); };
  const request = async (service, con, by = app) => { const result = await by.create(started.paths[service], 4, { 'm2m:cin': { cnf: 'application/json', con, cr: null } }); await waitFor(async () => { await settle(); return true; }); return result; };
  const statuses = () => cse.children(started.paths.status, 4).map((item) => item.attrs.con);
  const requestRecord = (requestId) => ipe.store.list('ipeRequests').find((item) => item.requestId === requestId);
  const reviews = () => trace.filter((item) => item.step === 'MEC_CALLBACK_REVIEW').map((item) => item.status);
  return { sim, cse, ids, device, deviceAe, app, other, store, policyService, principal, grant, policy, coordinator, consumer, ipe, started, intent, trace, request, settle, statuses, requestRecord, reviews, cipher, clock, advance(ms) { now += ms; } };
}

test('R16: sandbox settings come from MEC_BASE_URL, MEC_SANDBOX_NAME, MEC_MEP and MEC_CA_FILE', () => {
  const config = mecSandboxConfig({ MEC_BASE_URL: 'https://192.0.2.103/', MEC_SANDBOX_NAME: 'sbx-team', MEC_MEP: 'mep1', MEC_CA_FILE: 'C:/certs/k8s-ca.pem', MEC_SERVICES: 'Location, RNIS' });
  assert.equal(config.platformRoot, 'https://192.0.2.103/sbx-team/mep1');
  assert.deepEqual(config.consume, ['Location', 'RNIS']);
  assert.equal(config.caFile, 'C:/certs/k8s-ca.pem'); assert.equal(config.insecureTls, false);
  assert.equal(mecSandboxConfig({ MEC_PLATFORM_ROOT: 'https://edge.example/sbx/mep2/' }).platformRoot, 'https://edge.example/sbx/mep2');
  assert.equal(mecSandboxConfig({}).platformRoot, null);
  assert.equal(mecSandboxConfig({ MEC_BASE_URL: 'https://127.0.0.1:8443', MEC_INSECURE_TLS: '1' }).insecureTls, true);
});

test('R16: MEC011 catalog classification, endpoint rebasing and Location v2/v3 selection', async () => {
  assert.equal(classifyMecService({ serName: 'meep-loc-serv', transportInfo: { endpoint: { uris: ['https://h/sbx/mep1/location/v3/'] } } }).mecApi, 'MEC013');
  assert.equal(classifyMecService({ serName: 'RadioNetworkInformationService' }).key, 'RNIS');
  assert.equal(classifyMecService({ serName: 'vendor-x', serCategory: { name: 'RNI' } }).mecApi, 'MEC012');
  assert.equal(classifyMecService({ serName: 'vendor-y', transportInfo: { endPoint: { uris: ['https://h/sbx/mep1/wai/v2'] } } }).key, 'WAIS');
  const catalog = [{ serInstanceId: 'loc', serName: 'meep-loc-serv', state: 'ACTIVE', transportInfo: { endpoint: { uris: ['https://try-mec.example/sbx/mep1/location/v2/'] } } }];
  const platform = new MecPlatformClient({ platformRoot: 'https://192.0.2.103/sbx/mep1', fetchImpl: async () => new Response(JSON.stringify(catalog), { status: 200 }) });
  const discovered = await platform.discoverServices();
  assert.equal(discovered.services[0].endpoint, 'https://192.0.2.103/sbx/mep1/location/v2');
  assert.equal(discovered.services[0].endpointRebased, true);
  platform.bind(discovered.services);
  assert.equal(platform.locationVersionFor(), 'v2');
  assert.equal(platform.collectionUrl('Location', 'periodic'), 'https://192.0.2.103/sbx/mep1/location/v2/subscriptions/periodic');
  assert.equal(new MecPlatformClient({ platformRoot: 'https://h/sbx/mep1' }).collectionUrl('Location', 'userTracking'), 'https://h/sbx/mep1/location/v3/subscriptions/users');
  assert.throws(() => platform.resourceUrl('Location', 'periodic', 'https://evil.example/sbx/mep1/location/v2/subscriptions/periodic/1'), /MEC_ENDPOINT_REVIEW/);
});

test('R15/R16: MEC013 v2/v3 and MEC012 notifications normalize to one record', () => {
  const v3 = normalizeMecNotification('Location', { userLocationPeriodicNotification: { notificationType: 'UserLocationPeriodicNotification', address: ueAddress, currentLocation: { latitude: [43.7], longitude: [7.4], accuracy: 5 }, timeStamp: { seconds: 1700000000, nanoSeconds: 5e8 }, _links: { subscription: { href: 'https://h/sub/1' } } } });
  assert.deepEqual([v3.address, v3.location, v3.observedAt, v3.subscriptionHref], [ueAddress, { lat: 43.7, lon: 7.4, accuracyM: 5 }, '2023-11-14T22:13:20.500Z', 'https://h/sub/1']);
  const v2 = normalizeMecNotification('Location', { subscriptionNotification: { terminalLocation: [{ address: ueAddress, currentLocation: { latitude: 43.7, longitude: 7.4, accuracy: 9, timestamp: { seconds: 1700000000 } } }] } });
  assert.deepEqual(v2.location, { lat: 43.7, lon: 7.4, accuracyM: 9 });
  const zonal = normalizeMecNotification('Location', { zonalPresenceNotification: { address: ueAddress, zoneId: 'zone01', currentAccessPointId: 'ap1', timestamp: { seconds: 1700000000 } } });
  assert.equal(zonal.location, null); assert.equal(zonal.accessPointId, 'ap1');
  const cell = normalizeMecNotification('RNIS', { notificationType: 'CellChangeNotification', associateId: [{ type: 1, value: ueAddress }], hoStatus: 3, srcEcgi: { cellId: 'A' }, trgEcgi: [{ cellId: 'B' }], timeStamp: { seconds: 1700000000 } });
  assert.deepEqual([cell.address, cell.hoStatus, cell.srcCellId, cell.trgCellId], [ueAddress, 'COMPLETED', 'A', 'B']);
  assert.throws(() => normalizeMecNotification('Location', { cellChangeNotification: {} }), /MEC_BINDING_REVIEW/);
  assert.throws(() => normalizeMecNotification('RNIS', { userLocationEventNotification: {} }), /MEC_BINDING_REVIEW/);
  assert.throws(() => parseMecRequest('Location', { op: 'subscribe', requestId: 'r1', deviceAe: 'k', ueAddress, durationSec: 999999 }), /request-duration/);
  assert.equal(parseMecRequest('RNIS', { op: 'subscribe', requestId: 'r2', deviceAe: 'k', ueAddress }).type, 'cellChange');
  assert.equal(m2mTime(Date.parse('2026-11-19T01:02:03.456Z')), '20261119T010203');
  assert.deepEqual(geofencePolygon(zoneB)[0][0], [7.42, 43.737]);
});

test('R16: TLS to the sandbox uses a pinned CA file; an unpinned client is refused', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-mec-tls-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const openssl = process.env.OPENSSL_BIN ?? 'openssl'; const cnf = join(directory, 'req.cnf'); await writeFile(cnf, '[req]\ndistinguished_name=dn\n[dn]\n');
  try {
    await exec(openssl, ['req', '-config', cnf, '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=TestMecCA', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', join(directory, 'ca.key'), '-out', join(directory, 'ca.pem')], { windowsHide: true });
    await exec(openssl, ['req', '-config', cnf, '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', join(directory, 'server.key'), '-out', join(directory, 'server.csr')], { windowsHide: true });
    await writeFile(join(directory, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n');
    await exec(openssl, ['x509', '-req', '-in', join(directory, 'server.csr'), '-CA', join(directory, 'ca.pem'), '-CAkey', join(directory, 'ca.key'), '-set_serial', '3', '-days', '1', '-extfile', join(directory, 'server.ext'), '-out', join(directory, 'server.pem')], { windowsHide: true });
  } catch { t.skip('openssl unavailable'); return; }
  const sim = await startMecSandboxSimulator({ tls: { key: await readFile(join(directory, 'server.key')), cert: await readFile(join(directory, 'server.pem')) } });
  t.after(() => sim.close());
  const pinned = new MecPlatformClient({ platformRoot: sim.platformRoot, fetchImpl: createMecFetch({ caFile: join(directory, 'ca.pem') }) });
  assert.equal((await pinned.discoverServices()).services.length, 4);
  await assert.rejects(new MecPlatformClient({ platformRoot: sim.platformRoot }).discoverServices(), /MEC_TRANSPORT_REVIEW/);
  const created = await pinned.createSubscription('RNIS', 'cellChange', { address: ueAddress, callbackUrl: 'https://127.0.0.1:1/cb', expiresAtMs: Date.now() + 60000 });
  assert.match(created.subscriptionId, /^sim-rnis-/);
  assert.equal((await pinned.deleteSubscription('RNIS', 'cellChange', created.resourceUrl)).status, 204);
});

test('R16: IPE publishes MEC services, turns request cin into MEC subscriptions and MEC notifications into cin', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.started.catalog.services.map((item) => [item.key, item.mecApi, item.representation, item.consumed]), [['Location', 'MEC013', 'flexContainer', true], ['RNIS', 'MEC012', 'flexContainer', true], ['WAIS', 'MEC028', 'flexContainer', false], ['AppSupport', 'MEC011', 'flexContainer', false]]);
  assert.equal(f.started.catalog.group.members, 4);
  assert.equal(f.sim.readyApps[0].appInstanceId, 'app-test');
  const flex = (await f.app.retrieve(`${f.started.paths.services}/Location`)).payload['mec:mecSvc'];
  assert.equal(flex.state, 'ACTIVE'); assert.equal(flex.apiVersion, 'v3');

  await f.request('Location', { op: 'subscribe', requestId: 'loc-x', deviceAe: 'keyring-test', ueAddress, intent: f.intent }, f.other);
  await f.request('Location', { op: 'subscribe', requestId: 'bad' });
  await f.request('Location', { op: 'subscribe', requestId: 'stale-rev', deviceAe: 'keyring-test', ueAddress, intent: { ...f.intent, grantRevision: 9 } });
  assert.deepEqual(f.statuses().map((item) => item.reason), ['requester-not-authorized', 'request-device', 'grant-revision-changed']);
  assert.equal(f.sim.activeSubscriptions().length, 0);

  await f.request('RNIS', { op: 'subscribe', requestId: 'rnis-1', deviceAe: 'keyring-test', ueAddress, durationSec: 600, intent: f.intent });
  await f.request('Location', { op: 'subscribe', requestId: 'loc-1', deviceAe: 'keyring-test', ueAddress, type: 'periodic', periodSec: 2, durationSec: 600, intent: f.intent });
  await f.request('Location', { op: 'subscribe', requestId: 'loc-1', deviceAe: 'keyring-test', ueAddress, type: 'periodic', durationSec: 600, intent: f.intent });
  assert.deepEqual(f.sim.activeSubscriptions().map((item) => `${item.service}:${item.type}`), ['RNIS:cellChange', 'Location:periodic']);
  assert.deepEqual(f.statuses().slice(-3).map((item) => item.state), ['ACTIVE', 'ACTIVE', 'DUPLICATE']);
  assert.ok(f.cse.children('/Mobius/keyring-test', 23).some((item) => item.rn === 'mec-ipe-watch'));

  await f.sim.cellChange(ueAddress, { srcCellId: 'cell-A', trgCellId: 'cell-B' }); await f.settle();
  const rnisCin = f.cse.children('/Mobius/keyring-test/rnis', 4).at(-1);
  assert.equal(rnisCin.attrs.con.trgCellId, 'cell-B'); assert.equal(rnisCin.attrs.cr, f.ids.ipe); assert.equal(rnisCin.attrs.loc.crd, '[7.422,43.739]');
  assert.equal(f.consumer.decisions.at(-1).reason, 'network-corroborates-target');

  await f.sim.moveUe(ueAddress, insideB); await f.settle();
  const locationCin = f.cse.children('/Mobius/keyring-test/location', 4).at(-1);
  const con = locationCin.attrs.con;
  assert.equal(locationCin.attrs.loc.crd, '[7.423,43.739]');
  assert.equal(con.precise.algorithm, 'AES-256-GCM'); assert.equal(JSON.stringify(con).includes(ueAddress), false); assert.equal(JSON.stringify(con).includes('43.7385'), false);
  assert.deepEqual(f.cipher.open(con.precise, `keyring-test:${con.eventKey}`), { lat: 43.7385, lon: 7.4225, accuracyM: 8 });
  assert.deepEqual(con.intent, f.intent);
  assert.equal(f.consumer.decisions.at(-1).reason, 'location-health-accepted');
  assert.equal(f.cse.resources.get('Mobius/keyring-test/location').attrs.loc.crd, '[7.423,43.739]');
  assert.deepEqual((await f.consumer.devicesInZone(geofencePolygon(zoneB))).devices, ['Mobius/keyring-test']);

  await f.sim.redeliver('Location');
  const shift = (offsetMs, address) => (body) => { const value = Object.values(body)[0]; value.timeStamp = { seconds: Math.floor((f.clock() + offsetMs) / 1000), nanoSeconds: 0 }; if (address) value.address = address; return body; };
  await f.sim.redeliver('Location', { patch: shift(-60000) });
  await f.sim.redeliver('Location', { patch: shift(10000) });
  await f.sim.redeliver('Location', { patch: shift(-5000) });
  const foreign = await f.sim.redeliver('Location', { patch: shift(0, '10.100.0.99') });
  await f.settle();
  assert.deepEqual(f.reviews(), ['DUPLICATE', 'STALE', 'FUTURE', 'OUT_OF_ORDER', 'BINDING_REVIEW']);
  assert.equal(foreign.status, 403);
});

test('R15: geofence dwell through oneM2M drives the handover trigger; RNIS cell outside target resets it', async (t) => {
  const f = await fixture(t);
  await f.request('RNIS', { op: 'subscribe', requestId: 'rnis-1', deviceAe: 'keyring-test', ueAddress, durationSec: 600, intent: f.intent });
  await f.request('Location', { op: 'subscribe', requestId: 'loc-1', deviceAe: 'keyring-test', ueAddress, durationSec: 600, intent: f.intent });
  await f.sim.moveUe(ueAddress, insideB); await f.settle();
  assert.equal(f.consumer.decisions.at(-1).reason, 'health-review');
  await f.sim.cellChange(ueAddress, { srcCellId: 'cell-A', trgCellId: 'cell-B' }); await f.settle();
  f.advance(31000);
  for (const step of [0, 5000, 5000]) { f.advance(step); await f.sim.moveUe(ueAddress, insideB); await f.settle(); }
  assert.equal(f.consumer.decisions.at(-1).triggerState, 'ACTIVE');
  assert.deepEqual([f.coordinator.status('keyring-test').edgeId, f.coordinator.status('keyring-test').epoch], ['edge-b', 2]);
  await f.sim.cellChange(ueAddress, { srcCellId: 'cell-B', trgCellId: 'cell-A' }); await f.settle();
  assert.equal(f.consumer.decisions.at(-1).reason, 'network-cell-outside-target');
  await f.app.create('/Mobius/keyring-test/location', 4, { 'm2m:cin': { con: { schema: 'pb.mec.location.v1', service: 'Location', deviceId: 'keyring-test', eventKey: 'forged' }, cr: null } }); await f.settle();
  assert.equal(f.consumer.decisions.at(-1).reason, 'creator-review');
});

test('R16: renewal before expiryDeadline, recreation after provider loss, and teardown on unsubscribe, cin delete, AE deletion and revocation', async (t) => {
  const f = await fixture(t);
  await f.request('RNIS', { op: 'subscribe', requestId: 'rnis-1', deviceAe: 'keyring-test', ueAddress, durationSec: 600, intent: f.intent });
  await f.request('Location', { op: 'subscribe', requestId: 'loc-1', deviceAe: 'keyring-test', ueAddress, durationSec: 600, intent: f.intent });
  f.advance(115000); await f.ipe.renewDue();
  assert.deepEqual(f.ipe.store.list('ipeRequests').filter((item) => item.state === 'ACTIVE').map((item) => item.renewals), [1, 1]);
  assert.ok(f.sim.activeSubscriptions().every((item) => item.updates === 1 && Date.parse(item.expiresAt) > f.clock() + 100000));
  const locationRecord = f.requestRecord('loc-1');
  f.sim.subscriptions.delete(new URL(locationRecord.resourceUrl).pathname);
  await f.ipe.renew(locationRecord.key, { force: true });
  assert.equal(f.trace.filter((item) => item.step === 'MEC_SUBSCRIPTION_RECREATED').length, 1);
  assert.notEqual(f.requestRecord('loc-1').mecSubscriptionId, locationRecord.mecSubscriptionId);

  const oldRnis = f.ipe.secret(f.requestRecord('rnis-1')).callbackUrl;
  assert.equal(JSON.stringify(f.ipe.store.list('ipeRequests')).includes(ueAddress), false);
  await f.request('RNIS', { op: 'unsubscribe', requestId: 'rnis-1' });
  assert.equal(f.requestRecord('rnis-1').state, 'DELETED');
  assert.deepEqual(f.sim.activeSubscriptions().map((item) => item.service), ['Location']);
  const late = await fetch(oldRnis, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notificationType: 'CellChangeNotification', associateId: [{ type: 'UE_IPv4_ADDRESS', value: ueAddress }], hoStatus: 'COMPLETED', trgEcgi: [{ cellId: 'cell-B' }], timeStamp: { seconds: Math.floor(f.clock() / 1000) } }) });
  assert.equal(late.status, 204); await f.settle();
  assert.equal(f.reviews().at(-1), 'TOMBSTONE');

  const admin = new Onem2mHttpClient({ endpoint: f.cse.endpoint, originator: 'CAdmin' });
  await f.request('RNIS', { op: 'subscribe', requestId: 'rnis-2', deviceAe: 'keyring-test', ueAddress, durationSec: 600, intent: f.intent });
  const requestCin = f.cse.children(f.started.paths.RNIS, 4).find((item) => parseContent(item.attrs.con)?.requestId === 'rnis-2');
  await admin.remove(`/${requestCin.path}`); await waitFor(async () => { await f.settle(); return f.requestRecord('rnis-2').state === 'DELETED'; });
  assert.equal(f.requestRecord('rnis-2').reason, 'request-deleted');

  await f.policyService.revokeGrant({ principal: f.principal, grantId: f.grant.grantId });
  await f.sim.moveUe(ueAddress, insideB); await f.settle();
  assert.equal(f.requestRecord('loc-1').state, 'DELETED'); assert.equal(f.requestRecord('loc-1').reason, 'grant-grant-status');
  assert.equal(f.sim.activeSubscriptions().length, 0);
});

test('R16: device AE deregistration tears down every MEC subscription for that device', async (t) => {
  const f = await fixture(t);
  await f.request('RNIS', { op: 'subscribe', requestId: 'rnis-1', deviceAe: 'keyring-test', ueAddress, durationSec: 600, intent: f.intent });
  await f.request('Location', { op: 'subscribe', requestId: 'loc-1', deviceAe: 'keyring-test', ueAddress, durationSec: 600, intent: f.intent });
  assert.equal(f.sim.activeSubscriptions().length, 2);
  assert.equal((await f.device.remove(f.deviceAe.path)).rsc, 2002);
  await waitFor(async () => { await f.settle(); return f.sim.activeSubscriptions().length === 0; });
  assert.deepEqual(f.ipe.store.list('ipeRequests').map((item) => item.reason), ['device-deregistered', 'device-deregistered']);
});

test('R15: MEC013 v2 zonal presence without coordinates is completed by the MEC013 user query', async (t) => {
  const f = await fixture(t, { locationVersion: 'v2' });
  assert.equal(f.started.catalog.services.find((item) => item.key === 'Location').apiVersion, 'v2');
  await f.request('Location', { op: 'subscribe', requestId: 'loc-v2', deviceAe: 'keyring-test', ueAddress, type: 'userTracking', durationSec: 600, intent: f.intent });
  assert.deepEqual(f.sim.activeSubscriptions().map((item) => item.type), ['userTracking']);
  await f.sim.moveUe(ueAddress, insideB); await f.settle();
  const con = f.cse.children('/Mobius/keyring-test/location', 4).at(-1).attrs.con;
  assert.equal(con.locationSource, 'MEC013-query'); assert.equal(con.zoneId, 'zone-B');
  assert.ok(f.sim.requests.some((item) => item.path.endsWith('/location/v2/queries/users')));
});

test('R16: flexContainer publication falls back to container+cin on a CSE without the specialization', async (t) => {
  const sim = await startMecSandboxSimulator(); const cse = await startFakeCse();
  const ipe = new MecIpe({ cse: { endpoint: cse.endpoint }, originator: 'Cmec-ipe-plain', platform: new MecPlatformClient({ platformRoot: sim.platformRoot }), cipher: new MecCipher({ store: { path: null } }) });
  t.after(async () => { await ipe.stop(); await sim.close(); await cse.close(); });
  const started = await ipe.start();
  assert.ok(started.catalog.services.every((item) => item.representation === 'container' && item.rsc === 2001));
  assert.equal(cse.children(`${started.paths.services}/Location`, 4)[0].attrs.con.mecApi, 'MEC013');
});

test('R16: run-mec-ipe --discover-only reads the catalog from the env-configured sandbox', async (t) => {
  const sim = await startMecSandboxSimulator({ sandboxName: 'sbx-cutover', mep: 'mep2', locationVersion: 'v2' }); t.after(() => sim.close());
  const script = fileURLToPath(new URL('../scripts/run-mec-ipe.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, '--discover-only'], { env: { ...process.env, MEC_BASE_URL: sim.origin, MEC_SANDBOX_NAME: 'sbx-cutover', MEC_MEP: 'mep2', MEC_SIMULATION: '1' }, windowsHide: true });
  let output = ''; child.stdout.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(code, 0);
  const result = JSON.parse(output);
  assert.equal(result.locationApiVersion, 'v2');
  assert.deepEqual(result.services.map((item) => item.mecApi), ['MEC013', 'MEC012', 'MEC028', 'MEC011']);
  await rm(result.receipt, { force: true });
});

test('R16: runtime keeps the direct MEC path by default and disables it behind core.mec.path=onem2m', async () => {
  const direct = await createIntegrationRuntime({ core: { retention: { autoPrune: false } } });
  assert.equal(direct.mecPath, 'direct'); assert.ok(direct.api.mecSubscriptions);
  await direct.close();
  const bridged = await createIntegrationRuntime({ core: { mec: { path: 'onem2m' }, retention: { autoPrune: false } } });
  assert.equal(bridged.mecPath, 'onem2m'); assert.equal(bridged.api.mecSubscriptions, null);
  await bridged.close();
  await assert.rejects(createIntegrationRuntime({ core: { mec: { path: 'other' } } }), /direct or onem2m/);
});
