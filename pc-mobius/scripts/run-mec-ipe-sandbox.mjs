/**
 * R13/R15/R16 real run against the ETSI MEC Sandbox (STF_685) on a separate VM.
 * oneM2M side: two actual Mobius4 CSEs on the PC. MEC side: the sandbox's MEC011, MEC013 v3 and
 * MEC012 over HTTPS through the k8s ingress, with the ingress CA pinned (no TLS bypass).
 * Trace: oneM2M request cin -> MEC subscription -> sandbox notification -> oneM2M cin -> app/policy
 * notification -> geofence decision -> handover trigger, for Location (MEC013) and RNIS (MEC012).
 * UE movement comes from the sandbox GIS engine (location update + MOBILITY automation), so the
 * sandbox itself reassigns the POA and emits the cell change.
 *
 * Environment: MEC_BASE_URL (default https://192.0.2.103), MEC_SANDBOX_NAME (bubble), MEC_MEP (mep1),
 * MEC_CA_FILE (.local/mec-sandbox/ca.pem), MEC_CALLBACK_HOST (192.0.2.106), MEC_IPE_LISTEN_PORT (18092),
 * MEC_UE (33633442878), MEC_SCENARIO (dep-opt-b), MEC_SANDBOX_REVISION (informational).
 */
import { cp, mkdir, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { HandoverCoordinator } from '../integration/src/handover-coordinator.mjs';
import { MecPolicyReconciler } from '../integration/src/mec-adapter.mjs';
import { MecCipher } from '../integration/src/mec-state.mjs';
import { MecIpe, MEC_IPE_SPECIALIZATIONS } from '../integration/src/mec-ipe.mjs';
import { MecOneM2mConsumer, geofencePolygon } from '../integration/src/mec-onem2m-consumer.mjs';
import { MecPlatformClient, MecPlatformError, createMecFetch } from '../integration/src/mec-platform-client.mjs';
import { Onem2mHttpClient, parseContent } from '../integration/src/onem2m-http-client.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const env = process.env;
const upstream = resolve(env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
const mecBase = (env.MEC_BASE_URL ?? 'https://192.0.2.103').replace(/\/+$/, '');
const sandboxName = env.MEC_SANDBOX_NAME ?? 'bubble';
const mep = env.MEC_MEP ?? 'mep1';
const caFile = resolve(root, env.MEC_CA_FILE ?? '.local/mec-sandbox/ca.pem');
const callbackHost = env.MEC_CALLBACK_HOST ?? '192.0.2.106';
const listenPort = Number(env.MEC_IPE_LISTEN_PORT ?? 18092);
const ueAddress = env.MEC_UE ?? '33633442878';
const scenarioName = env.MEC_SCENARIO ?? 'dep-opt-b';
const sandboxRoot = `${mecBase}/${sandboxName}`;
const platformRoot = `${sandboxRoot}/${mep}`;
const stamp = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const run = randomBytes(3).toString('hex');
const directory = join(root, '.local', 'mec-ipe-sandbox', stamp);
const source = join(root, '.local', 'mec-ipe-sandbox', 'source');
const evidenceDir = join(root, 'docs', 'verification-evidence', '2026-11-20');
await mkdir(directory, { recursive: true });
await cp(upstream, source, { recursive: true, filter: (path) => !['node_modules', '.git', 'logs'].includes(basename(path)) });
try { await lstat(join(source, 'node_modules')); } catch { await symlink(join(upstream, 'node_modules'), join(source, 'node_modules'), 'junction'); }
const prepared = spawnSync(process.execPath, [join(root, 'pc-mobius/scripts/prepare-specialization.mjs'), '--mobius-root', upstream, '--config-dir', join(source, 'config')], { cwd: root, encoding: 'utf8', windowsHide: true });
if (prepared.status !== 0) throw new Error(`specialization registry: ${prepared.stderr}`);
const registryPath = join(source, 'config', 'specializations.json');
const registry = JSON.parse(await readFile(registryPath, 'utf8'));
await writeFile(registryPath, `${JSON.stringify({ ...registry, ...MEC_IPE_SPECIALIZATIONS }, null, 2)}\n`);
const preload = join(directory, 'loopback-only.cjs');
await writeFile(preload, "const net = require('node:net'); const original = net.Server.prototype.listen; net.Server.prototype.listen = function(...args) { if (typeof args[0] === 'number' && typeof args[1] !== 'string') args.splice(1,0,'127.0.0.1'); return original.apply(this,args); };\n");
const connection = JSON.parse(await readFile(join(root, '.local/postgres/connection.json'), 'utf8'));
const pool = new pg.Pool({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database });
const children = []; const databases = []; const secrets = [connection.password]; const servers = [];
const t0 = Date.now(); const trace = []; const checks = [];
const log = (entry) => { trace.push({ seq: trace.length + 1, tMs: Date.now() - t0, ...entry }); };
const step = (actor, name, details = {}) => log({ at: new Date().toISOString(), actor, step: name, ...details });
const check = (name, expected, actual, details = {}) => { const status = approvalHash(expected ?? null) === approvalHash(actual ?? null) ? 'PASS' : 'FAIL'; checks.push({ name, status, expected, actual, ...details }); step('verifier', 'CHECK', { name, status, expected, actual }); return status === 'PASS'; };
const sanitized = (value) => { let text = String(value); for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[secret]'); return text; };
async function freePort() { const probe = netServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise((resolveClose) => probe.close(resolveClose)); return port; }
async function waitFor(predicate, timeoutMs = 8000, label = 'condition') { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = await predicate(); if (value) return value; await delay(100); } throw new Error(`timeout: ${label}`); }
function sha256File(path) { return readFile(path).then((data) => createHash('sha256').update(data).digest('hex')); }

// Sandbox control plane (sandbox-ctrl, GIS) through the same pinned-CA transport.
const mecFetch = createMecFetch({ caFile });
const sandbox = async (method, path, body, expected = [200, 201, 204]) => {
  const response = await mecFetch(`${sandboxRoot}${path}`, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!expected.includes(response.status)) throw Object.assign(new Error(`sandbox ${method} ${path} ${response.status}`), { status: response.status });
  return { status: response.status, data };
};
const moveUe = async (coordinates) => (await sandbox('POST', `/gis/v1/geodata/${ueAddress}`, { assetName: ueAddress, assetType: 'UE', subType: 'UE', location: { type: 'Point', coordinates } })).status;

let ipe; let consumer; let runtimeError = null; const rawSamples = [];
let appInstance = null; let registeredService = null; let mobilityWasActive = null; let homeCoordinates = null;
try {
  // MEC side first: the active scenario, POA geography and the IPE's application instance.
  const active = (await sandbox('GET', '/sandbox-ctrl/v1/active')).data;
  check('sandbox-scenario-active', scenarioName, active?.name);
  const poaCells = {}; const poaZone = {};
  for (const domain of active.deployment?.domains ?? []) for (const zone of domain.zones ?? []) for (const nl of zone.networkLocations ?? []) {
    const cellId = nl.poa4GConfig?.cellId ?? nl.poa5GConfig?.cellId ?? null;
    if (cellId) { poaCells[nl.name] = cellId; poaZone[nl.name] = zone.name; }
  }
  const poas = (await sandbox('GET', '/gis/v1/geodata?assetType=POA&excludePath=true')).data?.geoDataAssets ?? [];
  const cellLocations = {}; const zoneBoxes = {};
  for (const poa of poas) {
    const [lon, lat] = poa.location?.coordinates ?? [];
    const cellId = poaCells[poa.assetName]; const zone = poaZone[poa.assetName];
    if (!cellId || !Number.isFinite(lat)) continue;
    cellLocations[cellId] = { lat, lon };
    const box = zoneBoxes[zone] ?? { minLat: lat, maxLat: lat, minLon: lon, maxLon: lon };
    zoneBoxes[zone] = { minLat: Math.min(box.minLat, lat), maxLat: Math.max(box.maxLat, lat), minLon: Math.min(box.minLon, lon), maxLon: Math.max(box.maxLon, lon) };
  }
  const margin = 0.0005;
  const bbox = (zone) => ({ type: 'bbox', minLat: zoneBoxes[zone].minLat - margin, minLon: zoneBoxes[zone].minLon - margin, maxLat: zoneBoxes[zone].maxLat + margin, maxLon: zoneBoxes[zone].maxLon + margin });
  const homeZone = bbox('zone1'); const schoolZone = bbox('zone2');
  const schoolCells = Object.entries(poaZone).filter(([, zone]) => zone === 'zone2').map(([name]) => poaCells[name]);
  const schoolPoa = 'zon2-poa-4g-3';
  const schoolPoint = poas.find((poa) => poa.assetName === schoolPoa)?.location?.coordinates;
  const ueGeo = (await sandbox('GET', `/gis/v1/geodata/${ueAddress}?excludePath=true`)).data;
  homeCoordinates = ueGeo?.location?.coordinates ?? null;
  step('mec-sandbox', 'SANDBOX_TOPOLOGY', { scenario: active.name, zones: Object.keys(zoneBoxes), schoolPoa, schoolCellId: poaCells[schoolPoa], homeZone, schoolZone, schoolCells, ue: { ref: approvalHash(ueAddress).slice(0, 16), poaInRange: ueGeo?.poaInRange ?? null } });
  const automation = (await sandbox('GET', '/gis/v1/automation')).data?.states ?? [];
  mobilityWasActive = Boolean(automation.find((item) => item.type === 'MOBILITY')?.active);
  // MOBILITY automation runs for the whole session: it first re-aligns the UE's POA with its current
  // location (its baseline ticks), and later turns every location change into a POA/cell change.
  if (!mobilityWasActive) await sandbox('POST', '/gis/v1/automation/MOBILITY?run=true');
  await delay(4000);
  step('mec-sandbox', 'MOBILITY_AUTOMATION', { active: true, wasActive: mobilityWasActive });
  appInstance = (await sandbox('POST', '/sandbox-ctrl/v1/applications', { name: `pb-onem2m-ipe-${run}`, nodeName: mep, type: 'USER' }, [200, 201])).data;
  step('mec-sandbox', 'MEC_APP_INSTANCE_CREATED', { appInstanceId: appInstance?.id, name: appInstance?.name, nodeName: appInstance?.nodeName });
  const unpinned = await new MecPlatformClient({ platformRoot, timeoutMs: 4000 }).discoverServices().then(() => 'ACCEPTED', (error) => error.code);
  check('mec-tls-without-ca-is-refused', 'MEC_TRANSPORT_REVIEW', unpinned);

  // Two actual Mobius4 CSEs (edge-a hosts the MEC IPE, edge-b is the handover target).
  const edges = [];
  for (const label of ['a', 'b']) {
    const database = `bubble_mecsbx_${stamp}_${label}`;
    await pool.query(`CREATE DATABASE "${database}"`); databases.push(database);
    const db = new pg.Client({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database });
    await db.connect(); await db.query('CREATE EXTENSION IF NOT EXISTS postgis'); await db.end();
    const port = await freePort(); const admin = `S${randomBytes(11).toString('hex')}`; secrets.push(admin);
    const edgeId = `edge-${label}`;
    const config = { http: { port }, https: { enabled: false }, db: { host: connection.host, port: connection.port, user: connection.user, pw: connection.password, name: database }, cse: { admin, cse_id: `/${edgeId}`, csebase_rn: 'Mobius', cse_type: 1, subscription_verification: true, poa: [`http://127.0.0.1:${port}`] }, mqtt: { enabled: false }, logging: { level: 'error', file: { enabled: false } }, security: { rateLimit: { enabled: false } } };
    let diagnostic = '';
    const child = spawn(process.execPath, ['--require', preload, 'mobius4.js'], { cwd: source, env: { ...process.env, NODE_ENV: 'production', NODE_CONFIG: JSON.stringify(config) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }); children.push(child);
    child.stdout.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); }); child.stderr.on('data', (chunk) => { diagnostic = (diagnostic + chunk).slice(-64000); });
    await new Promise((resolveReady, reject) => { const timeout = setTimeout(() => reject(new Error(`CSE start: ${sanitized(diagnostic)}`)), 30000); child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`CSE exit ${code}: ${sanitized(diagnostic)}`)); }); child.on('message', (message) => { if (message === 'ready') { clearTimeout(timeout); resolveReady(); } }); });
    edges.push({ edgeId, endpoint: `http://127.0.0.1:${port}`, cseId: `/${edgeId}`, cseBase: '/Mobius', originator: admin });
    step('runner', 'CSE_STARTED', { edgeId, cseId: `/${edgeId}`, port });
  }
  const [edgeA] = edges;

  // Policy state: consent -> grant -> approved school-zone policy with RNIS serving-cell corroboration.
  const store = await new IntegrationStore(join(directory, 'policy-state.json')).init();
  const policyService = new PolicyService({ store });
  const coordinator = new HandoverCoordinator({ store, policyService, drainBudgetMs: 100, attemptBudgetMs: 10000 });
  const relay = createServer((request, response) => { request.resume(); request.on('end', () => { response.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end(); }); });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening'); servers.push(relay);
  for (const edge of edges) coordinator.registerEdge({ ...edge, callbackUrl: `http://127.0.0.1:${relay.address().port}/${edge.edgeId}`, simulation: false, timeoutMs: 5000 });
  const reconciler = new MecPolicyReconciler({ store, policyService, handoverCoordinator: coordinator });
  const deviceId = `keyring-${run}`;
  const principal = { principalId: `guardian-${run}`, scopes: ['consent:write', 'grant:write', 'grant:revoke', 'policy:approve'] };
  const consent = await policyService.createConsent({ principal, subjectId: `household-${run}`, purpose: 'MEC IPE ETSI MEC Sandbox verification', scopes: ['mec:location', 'mec:rnis'], ttlSec: 3600 });
  const grant = await policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['mec:location', 'mec:rnis'], ttlSec: 1800 });
  const policy = await policyService.approvePolicy({ principal, idempotencyKey: `mec-sbx-${run}`, policy: { grantId: grant.grantId, ueId: deviceId, targetEdgeId: 'edge-b', geofence: schoolZone, servingCells: schoolCells, trigger: { kind: 'zone' }, services: ['Location', 'RNIS'] } });
  step('policy', 'POLICY_APPROVED', { policyId: policy.policyId, policyRevision: policy.revision, grantId: grant.grantId, grantRevision: grant.revision, targetEdgeId: 'edge-b', geofence: 'sandbox zone2 POA bbox', servingCells: schoolCells });
  await coordinator.registerManifest(deviceId, { aeName: `${deviceId}-relay`, requireCallbackVerification: false, resources: [{ logicalId: 'observations', ty: 3, body: { 'm2m:cnt': { rn: 'observations' } } }] });
  const placed = await coordinator.handover({ ueId: deviceId, targetEdgeId: 'edge-a', grantId: grant.grantId });
  if (placed.state !== 'ACTIVE') throw new Error(`initial placement ${placed.phase} ${placed.reviewReason}`);
  step('handover', 'INITIAL_PLACEMENT', { ueId: deviceId, edgeId: placed.edgeId, epoch: placed.epoch });
  const placedAt = Date.now();

  // AE identities on edge-a.
  const ids = { ipe: `Cmec-ipe-${run}`, app: `Capp-${run}`, policy: `Cpolicy-${run}`, device: `C${deviceId}`, visitor: `Cvisitor-${run}` };
  const client = (originator) => new Onem2mHttpClient({ endpoint: edgeA.endpoint, cseBase: '/Mobius', originator });
  const device = client(ids.device); const app = client(ids.app); const visitor = client(ids.visitor);
  const deviceAe = await device.registerAe({ rn: deviceId, api: 'N.privacy.bubble.keyring', poa: [] });
  const ownerOnly = { acr: [{ acor: [ids.device], acop: 63 }] };
  const deviceAcp = await device.ensure(deviceAe.path, 1, { 'm2m:acp': { rn: 'device-acp', pv: { acr: [{ acor: [ids.device], acop: 63 }, { acor: [ids.ipe], acop: 3 }, { acor: [ids.app, ids.policy], acop: 34 }] }, pvs: ownerOnly } });
  const observationAcp = await device.ensure(deviceAe.path, 1, { 'm2m:acp': { rn: 'observation-acp', pv: { acr: [{ acor: [ids.device], acop: 63 }, { acor: [ids.ipe], acop: 7 }, { acor: [ids.app, ids.policy], acop: 35 }] }, pvs: ownerOnly } });
  for (const rn of ['location', 'rnis']) await device.ensure(deviceAe.path, 3, { 'm2m:cnt': { rn, acpi: [observationAcp.ri], mni: 500, lbl: [`pb:${rn}`] } });
  // Mobius4 4.24.5 answers 5000 when a non-admin sets acpi on a resource without one; provisioning binds it as admin.
  const selfBinding = await device.update(deviceAe.path, { 'm2m:ae': { acpi: [deviceAcp.ri] } });
  const provisioning = new Onem2mHttpClient({ endpoint: edgeA.endpoint, cseBase: '/Mobius', originator: edgeA.originator });
  check('device-ae-acpi-bound-by-provisioning', 2004, selfBinding.rsc === 2004 ? 2004 : (await provisioning.update(deviceAe.path, { 'm2m:ae': { acpi: [deviceAcp.ri] } })).rsc, { selfBindingRsc: selfBinding.rsc });
  step('device', 'DEVICE_AE_REGISTERED', { aePath: deviceAe.path, aei: deviceAe.aei, containers: ['location', 'rnis'] });
  await visitor.registerAe({ rn: `visitor-${run}`, api: 'N.privacy.bubble.visitor', poa: [] });

  // Guardian app AE: receives oneM2M notifications only.
  const appNotifications = [];
  const appReceiver = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
    const signal = body?.['m2m:sgn'];
    if (signal && !signal.vrq) {
      const cin = signal.nev?.rep?.['m2m:cin']; const con = parseContent(cin?.con);
      const entry = { sur: signal.sur, cinRi: cin?.ri ?? null, schema: con?.schema ?? null, state: con?.state ?? null, requestId: con?.requestId ?? null, eventKey: con?.eventKey ?? null, loc: cin?.loc ?? null, hasPrecise: Boolean(con?.precise), origin: request.headers['x-m2m-origin'] ?? null };
      appNotifications.push(entry); step('guardian-app', 'APP_NOTIFICATION', entry);
    }
    response.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end();
  });
  appReceiver.listen(0, '127.0.0.1'); await once(appReceiver, 'listening'); servers.push(appReceiver);
  const appUrl = `http://127.0.0.1:${appReceiver.address().port}`;
  await app.registerAe({ rn: `guardian-app-${run}`, api: 'N.privacy.bubble.guardian-app', poa: [appUrl] });

  const cipher = new MecCipher({ store: { path: null }, encryptionKey: randomBytes(32).toString('base64') }); await cipher.ready;
  const authorize = async ({ service, request }) => {
    const intent = request.intent;
    if (!intent) return { allowed: false, reason: 'intent-required' };
    const decision = policyService.evaluateGrant(intent.grantId, { scope: service === 'Location' ? 'mec:location' : 'mec:rnis' });
    if (!decision.allowed) return { allowed: false, reason: `grant-${decision.reason}` };
    if (decision.grant.revision !== intent.grantRevision) return { allowed: false, reason: 'grant-revision-changed' };
    const current = store.get('policies', intent.policyId);
    if (!current || current.status !== 'APPROVED' || current.policy.grantId !== intent.grantId || current.policy.ueId !== (request.deviceAe ?? request.deviceId) || (current.policy.services && !current.policy.services.includes(service))) return { allowed: false, reason: 'policy-binding' };
    return { allowed: true };
  };
  const platform = new MecPlatformClient({ platformRoot, fetchImpl: mecFetch, timeoutMs: 8000, simulation: false, appInstanceId: appInstance?.id ?? null, locationVersion: 'v3' });
  ipe = new MecIpe({ cse: { endpoint: edgeA.endpoint, cseBase: '/Mobius', cseId: edgeA.cseId }, originator: ids.ipe, platform, consume: ['Location', 'RNIS'], requesters: { Location: [ids.app], RNIS: [ids.app] }, readers: [ids.app, ids.policy], cipher, authorize, listen: { host: '0.0.0.0', port: listenPort }, publicBaseUrl: `http://${callbackHost}:${listenPort}`, onem2mBaseUrl: `http://127.0.0.1:${listenPort}`, leaseSec: 20, renewBeforeMs: 8000, renewCheckMs: 1000, cellLocations, simulation: false, trace: log });
  // Keep the last raw sandbox notification per service for the replay checks below.
  const lastRaw = {};
  const onMecNotification = ipe.onMecNotification.bind(ipe);
  ipe.onMecNotification = async (service, token, payload) => { lastRaw[service] = { token, payload: structuredClone(payload) }; if (rawSamples.filter((item) => item.service === service).length < 6) rawSamples.push({ service, receivedAt: new Date().toISOString(), payload: structuredClone(payload) }); return onMecNotification(service, token, payload); };
  const started = await ipe.start();
  consumer = new MecOneM2mConsumer({ cse: { endpoint: edgeA.endpoint, cseBase: '/Mobius', cseId: edgeA.cseId }, originator: ids.policy, ipeOriginator: ids.ipe, cipher, reconciler, store, handoverCoordinator: coordinator, trace: log });
  await consumer.start(); await consumer.watchDevice({ deviceId, devicePath: deviceAe.path });
  for (const [rn, parent] of [['app-location', `${deviceAe.path}/location`], ['app-rnis', `${deviceAe.path}/rnis`], ['app-status', started.paths.status]]) check(`app-subscription-${rn}`, 2001, (await app.create(parent, 23, { 'm2m:sub': { rn, nu: [`${appUrl}/${rn}`], enc: { net: [3] }, nct: 1 } })).rsc);

  // MEC011: confirm_ready for the IPE's app instance, then the IPE advertises itself as a MEC service.
  const ready = trace.find((item) => item.step === 'MEC011_CONFIRM_READY' || item.step === 'MEC011_CONFIRM_READY_REVIEW');
  check('mec011-confirm-ready', true, ready?.step === 'MEC011_CONFIRM_READY' && [200, 204].includes(ready.status), { httpStatus: ready?.status ?? null, reason: ready?.reason ?? null });
  try {
    const service = { serName: `pb-onem2m-ipe-${run}`, serCategory: { href: 'https://www.onem2m.org', id: 'onem2m-ipe', name: 'oneM2M IPE', version: 'v1' }, version: '1.0.0', state: 'ACTIVE', transportInfo: { id: `pb-ipe-${run}`, name: 'oneM2M HTTP binding (Mobius4)', type: 'REST_HTTP', protocol: 'HTTP', version: '1.1', endpoint: { uris: [`http://${callbackHost}:${listenPort}/`] }, security: {} }, serializer: 'JSON', scopeOfLocality: 'MEC_HOST', consumedLocalOnly: true, isLocal: true };
    const response = await platform.request('POST', `${platformRoot}/mec_service_mgmt/v1/applications/${appInstance.id}/services`, service, [200, 201]);
    registeredService = response.data;
    const visible = await platform.request('GET', `${platformRoot}/mec_service_mgmt/v1/services?ser_name=${encodeURIComponent(service.serName)}`);
    step('mec-ipe', 'MEC011_SERVICE_REGISTERED', { serInstanceId: registeredService?.serInstanceId, serName: service.serName, httpStatus: response.status, visibleInCatalog: Array.isArray(visible.data) ? visible.data.length : null });
    check('mec011-ipe-service-registered-and-visible', { status: 201, visible: 1 }, { status: response.status, visible: Array.isArray(visible.data) ? visible.data.length : null });
  } catch (error) { check('mec011-ipe-service-registered-and-visible', { status: 201, visible: 1 }, { error: error.code ?? error.message, status: error.status ?? null }); }

  // MEC services discovered through oneM2M by the app (no MEC call from the app).
  const discovered = await app.retrieve(started.paths.services, { fu: 1, ty: 28 });
  const servicePaths = discovered.payload?.['m2m:uril'] ?? [];
  const serviceViews = [];
  for (const path of servicePaths) { const item = Object.values((await app.retrieve(path)).payload ?? {})[0] ?? {}; serviceViews.push({ path, mecApi: item.mecApi, serName: item.serName, state: item.state, apiVersion: item.apiVersion, consumed: item.consumed, simulation: item.simulation }); }
  step('guardian-app', 'APP_DISCOVERED_MEC_SERVICES_VIA_ONEM2M', { rsc: discovered.rsc, services: serviceViews.map(({ mecApi, serName, state, consumed }) => ({ mecApi, serName, state, consumed })) });
  check('app-discovers-sandbox-mec-services-via-onem2m', true, serviceViews.filter((item) => item.state === 'ACTIVE').length >= 4 && serviceViews.some((item) => item.mecApi === 'MEC013' && item.consumed) && serviceViews.some((item) => item.mecApi === 'MEC012' && item.consumed) && serviceViews.every((item) => item.simulation === false));
  const group = await app.retrieve(`${started.aePath}/mecServiceGroup`);
  const flexMembers = started.catalog.services.filter((item) => item.representation === 'flexContainer').length;
  check('mec-service-group-of-flexcontainers', { rsc: 2000, mt: 28, cnm: flexMembers }, { rsc: group.rsc, mt: group.payload?.['m2m:grp']?.mt, cnm: group.payload?.['m2m:grp']?.cnm });

  // ACP boundaries.
  check('acp-visitor-cannot-create-request', 4103, (await visitor.create(started.paths.Location, 4, { 'm2m:cin': { con: { op: 'subscribe', requestId: 'visitor-1', deviceAe: deviceId, ueAddress, type: 'periodic' } } })).rsc);
  check('acp-visitor-cannot-read-location', 4103, (await visitor.retrieve(`${deviceAe.path}/location`)).rsc);
  check('acp-app-cannot-read-request-container', 4103, (await app.retrieve(started.paths.Location)).rsc);

  const intent = { policyId: policy.policyId, grantId: grant.grantId, grantRevision: grant.revision, policyRevision: policy.revision };
  const requestState = (requestId) => ipe.store.list('ipeRequests').find((item) => item.requestId === requestId)?.state;
  const requestRecord = (requestId) => ipe.store.list('ipeRequests').find((item) => item.requestId === requestId);
  const statusFor = (requestId, state) => appNotifications.find((item) => item.requestId === requestId && item.state === state);
  const ours = async () => {
    const mine = new Set(ipe.store.list('ipeRequests').map((item) => item.resourceUrl).filter(Boolean));
    const location = await platform.listSubscriptions('Location', 'periodic'); const rnis = await platform.listSubscriptions('RNIS', 'cellChange');
    return [...location, ...rnis].map((item) => item.href).filter((href) => mine.has(href)).map((href) => (href.includes('/rni/') ? 'RNIS' : 'Location')).sort();
  };
  // A request stamped with an old grant revision is refused before any MEC call.
  await app.create(started.paths.Location, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'subscribe', requestId: `loc-stale-${run}`, deviceAe: deviceId, ueAddress, type: 'periodic', durationSec: 60, intent: { ...intent, grantRevision: grant.revision + 1 } }, cr: null } });
  await waitFor(() => statusFor(`loc-stale-${run}`, 'REJECTED'), 8000, 'stale grant revision rejection');
  check('request-with-other-grant-revision-rejected', [], await ours());

  // oneM2M -> MEC: RNIS cell change (MEC012), Location periodic and user event (MEC013 v3).
  const rnisId = `rnis-${run}`; const locationId = `loc-${run}`; const trackingId = `trk-${run}`;
  await app.create(started.paths.RNIS, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'subscribe', requestId: rnisId, deviceAe: deviceId, ueAddress, type: 'cellChange', durationSec: 300, intent }, cr: null } });
  await app.create(started.paths.Location, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'subscribe', requestId: locationId, deviceAe: deviceId, ueAddress, type: 'periodic', periodSec: 2, durationSec: 300, intent }, cr: null } });
  await app.create(started.paths.Location, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'subscribe', requestId: trackingId, deviceAe: deviceId, ueAddress, type: 'userTracking', durationSec: 300, intent }, cr: null } });
  await waitFor(() => [rnisId, locationId, trackingId].every((id) => requestState(id) === 'ACTIVE'), 15000, 'MEC subscriptions active');
  await waitFor(() => statusFor(rnisId, 'ACTIVE') && statusFor(locationId, 'ACTIVE') && statusFor(trackingId, 'ACTIVE'), 8000, 'app status notifications');
  check('sandbox-subscriptions-created-from-onem2m-requests', ['Location', 'Location', 'RNIS'], await ours());
  step('mec-sandbox', 'SANDBOX_SUBSCRIPTIONS', Object.fromEntries([rnisId, locationId, trackingId].map((id) => [id, requestRecord(id)?.mecSubscriptionId])));

  // Home reports first, then the sandbox moves the UE to the school POA (GIS + MOBILITY automation).
  await waitFor(() => trace.find((item) => item.step === 'ONEM2M_OBSERVATION_WRITTEN' && item.requestId === locationId), 20000, 'first home observation');
  // Counters are taken before the GIS POST: the sandbox emits the cell change while that POST is in flight.
  const movedAt = Date.now(); const movedSeq = trace.length; const rnisBefore = consumer.decisions.filter((item) => item.service === 'RNIS').length;
  step('mec-sandbox', 'UE_MOVED', { to: schoolPoa, status: await moveUe(schoolPoint), automation: 'MOBILITY' });
  await waitFor(() => consumer.decisions.filter((item) => item.service === 'RNIS').length > rnisBefore, 30000, 'RNIS policy decision from sandbox cell change');
  let handoverDecision = null;
  while (!handoverDecision && Date.now() - movedAt < 90000) {
    await delay(2000); await ipe.idle(); await consumer.idle();
    handoverDecision = consumer.decisions.find((item) => item.service === 'Location' && item.triggerState === 'ACTIVE');
  }
  await ipe.idle(); await consumer.idle();
  const session = coordinator.status(deviceId);
  step('handover', 'HANDOVER_STATE', { ueId: deviceId, edgeId: session?.edgeId, epoch: session?.epoch, state: session?.state, previousEdgeId: session?.previousEdgeId ?? null });
  check('geofence-entry-triggers-handover-to-edge-b', { edgeId: 'edge-b', state: 'ACTIVE' }, { edgeId: session?.edgeId, state: session?.state });
  const zoneEvent = trace.slice(movedSeq).find((item) => item.step === 'ONEM2M_OBSERVATION_WRITTEN' && item.requestId === trackingId && item.event === 'ENTERING_AREA_EVENT');
  check('sandbox-zone-entry-event-written-with-queried-location', { zoneId: 'zone2', event: 'ENTERING_AREA_EVENT', locationSource: 'MEC013-query' }, { zoneId: zoneEvent?.zoneId ?? null, event: zoneEvent?.event ?? null, locationSource: zoneEvent?.locationSource ?? null });

  // Callback hygiene: replay real sandbox payloads at the IPE callback (duplicate, stale, future, foreign UE).
  const replay = async (service, patch = (body) => body, token = lastRaw[service]?.token) => {
    const body = patch(structuredClone(lastRaw[service].payload));
    const response = await fetch(`http://127.0.0.1:${listenPort}/mec/${service}/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return response.status;
  };
  const shift = (offsetMs) => (body) => { const value = Object.values(body)[0]; value.timeStamp = { seconds: Math.floor((Date.now() + offsetMs) / 1000), nanoSeconds: 0 }; return body; };
  await ipe.idle();
  const periodicToken = lastRaw.Location?.token;
  const before = trace.length;
  const replayStatus = [await replay('Location'), await replay('Location', shift(-60000)), await replay('Location', shift(10000)), await replay('Location', (body) => { const value = Object.values(body)[0]; value.address = '33638580933'; value.timeStamp = { seconds: Math.floor(Date.now() / 1000), nanoSeconds: 0 }; return body; })];
  await ipe.idle();
  const reviews = trace.slice(before).filter((item) => item.step === 'MEC_CALLBACK_REVIEW' && item.service === 'Location').map((item) => item.status);
  check('replayed-sandbox-callback-duplicate-stale-future-binding', ['DUPLICATE', 'STALE', 'FUTURE', 'BINDING_REVIEW'], reviews.filter((status) => ['DUPLICATE', 'STALE', 'FUTURE', 'BINDING_REVIEW'].includes(status)).slice(0, 4));
  check('replayed-sandbox-callback-http-status', [204, 204, 204, 403], replayStatus, { tokenKnown: Boolean(periodicToken) });

  // Location cin readback: coarse loc on the CSE, precise point only as ciphertext.
  const latest = await app.retrieve(`${deviceAe.path}/location/la`);
  const latestCin = latest.payload?.['m2m:cin']; const latestCon = parseContent(latestCin?.con);
  check('location-cin-readback', { rsc: 2000, schema: 'pb.mec.location.v1', creator: ids.ipe, locType: 1, preciseAlgorithm: 'AES-256-GCM', simulation: false }, { rsc: latest.rsc, schema: latestCon?.schema, creator: latestCin?.cr, locType: latestCin?.loc?.typ, preciseAlgorithm: latestCon?.precise?.algorithm, simulation: latestCon?.simulation });
  check('location-cin-carries-grant-and-policy-revision', intent, latestCon?.intent);
  check('ue-address-absent-from-cse-cin-and-ipe-state', [false, false], [JSON.stringify(latestCin ?? {}).includes(ueAddress), JSON.stringify(ipe.store.list('ipeRequests')).includes(ueAddress)]);

  // oneM2M geo-query: which devices are inside the school zone now.
  const inSchool = await consumer.devicesInZone(geofencePolygon(schoolZone), { client: app });
  const inHome = await consumer.devicesInZone(geofencePolygon(homeZone), { client: app });
  const historySchool = await consumer.devicesInZone(geofencePolygon(schoolZone), { client: app, ty: 4 });
  step('guardian-app', 'GEO_QUERY', { school: { rsc: inSchool.rsc, devices: inSchool.devices }, home: { rsc: inHome.rsc, devices: inHome.devices }, schoolObservationCins: historySchool.uris.length });
  check('geo-query-school-zone-returns-device', [deviceAe.path.replace(/^\//, '')], inSchool.devices);
  check('geo-query-home-zone-is-empty-after-move', [], inHome.devices);

  // Renewal before expiryDeadline (lease 20 s, renew 8 s before) is a PUT on the sandbox resource.
  await waitFor(() => [rnisId, locationId].every((id) => (requestRecord(id)?.renewals ?? 0) >= 1), 30000, 'renewals');
  const renewals = Object.fromEntries([rnisId, locationId, trackingId].map((id) => [id.split('-')[0], requestRecord(id)?.renewals ?? 0]));
  check('sandbox-subscription-renewed-by-put', true, renewals.rnis >= 1 && renewals.loc >= 1 && trace.filter((item) => item.step === 'MEC_SUBSCRIPTION_RENEWED').every((item) => [200, 204].includes(item.httpStatus)));
  check('no-renew-review-on-sandbox', 0, trace.filter((item) => item.step === 'MEC_SUBSCRIPTION_RENEW_REVIEW').length);

  // The UE returns home: the sandbox emits the reverse cell change, the network view leaves the target.
  step('mec-sandbox', 'UE_MOVED', { to: 'home', status: await moveUe(homeCoordinates) });
  await waitFor(() => consumer.decisions.filter((item) => item.service === 'RNIS').length >= rnisBefore + 2, 30000, 'second RNIS decision');
  const rnisDecisions = consumer.decisions.filter((item) => item.service === 'RNIS').slice(rnisBefore).map((item) => item.reason);
  const cellChanges = trace.slice(movedSeq).filter((item) => item.step === 'ONEM2M_OBSERVATION_WRITTEN' && item.service === 'RNIS').map((item) => `${item.srcCellId}->${item.trgCellId}`);
  check('sandbox-rnis-cell-change-feeds-policy', ['network-corroborates-target', 'network-cell-outside-target'], [rnisDecisions[0], rnisDecisions.at(-1)], { cellChanges });

  // Teardown: request cin "unsubscribe" for RNIS, then the device AE deregisters (both Location subscriptions).
  const rnisToken = lastRaw.RNIS?.token;
  await app.create(started.paths.RNIS, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'unsubscribe', requestId: rnisId }, cr: null } });
  await waitFor(() => requestState(rnisId) === 'DELETED', 10000, 'RNIS teardown');
  check('rnis-unsubscribe-deletes-sandbox-subscription', ['Location', 'Location'], await ours());
  const late = rnisToken ? await replay('RNIS', (body) => body, rnisToken) : null;
  await ipe.idle();
  check('late-rnis-callback-after-teardown-is-tombstoned', 'TOMBSTONE', trace.filter((item) => item.step === 'MEC_CALLBACK_REVIEW' && item.service === 'RNIS').at(-1)?.status, { httpStatus: late });
  check('device-ae-deregistration', 2002, (await device.remove(deviceAe.path)).rsc);
  await waitFor(() => requestState(locationId) === 'DELETED' && requestState(trackingId) === 'DELETED', 10000, 'Location teardown on AE deregistration');
  check('ae-deregistration-deletes-sandbox-location-subscriptions', [], await ours());
  const teardown = trace.filter((item) => item.step === 'MEC_SUBSCRIPTION_DELETED').map(({ service, requestId, reason, providerStatus }) => ({ service, request: requestId.split('-')[0], reason, providerStatus }));
  check('sandbox-delete-status', [204, 204, 204], teardown.map((item) => item.providerStatus));
  await ipe.idle(); await consumer.idle();

  // Evidence.
  const flow = (service, requestId) => {
    const created = trace.find((item) => item.step === 'MEC_SUBSCRIPTION_CREATED' && item.requestId === requestId);
    const written = trace.find((item) => item.step === 'ONEM2M_OBSERVATION_WRITTEN' && item.requestId === requestId);
    const appSeen = trace.find((item) => item.step === 'APP_NOTIFICATION' && item.eventKey === written?.eventKey);
    const decision = trace.find((item) => item.step === 'POLICY_DECISION' && item.eventKey === written?.eventKey);
    const received = trace.find((item) => item.step === 'MEC_NOTIFICATION_RECEIVED' && item.requestId === requestId);
    return { requestCin: trace.find((item) => item.step === 'ONEM2M_REQUEST_RECEIVED' && item.op === 'subscribe' && item.requestId === requestId)?.requestRi ?? null, mecApi: created?.mecApi ?? null, type: created?.type ?? null, mecSubscriptionId: created?.mecSubscriptionId ?? null, mecNotificationReceived: received ? { notificationType: received.notificationType } : null, firstObservationCin: written?.cinRi ?? null, appNotified: Boolean(appSeen), policyDecision: decision ? { allowed: decision.allowed, reason: decision.reason, triggerState: decision.triggerState ?? null } : null };
  };
  const flows = { Location: flow('Location', locationId), LocationUserEvent: flow('Location', trackingId), RNIS: flow('RNIS', rnisId) };
  check('bidirectional-trace-complete', true, [flows.Location, flows.RNIS].every((item) => item.requestCin && item.mecSubscriptionId && item.firstObservationCin && item.appNotified && item.policyDecision && item.mecNotificationReceived));
  const notifications = trace.filter((item) => item.step === 'MEC_NOTIFICATION_RECEIVED').reduce((acc, item) => { acc[item.notificationType] = (acc[item.notificationType] ?? 0) + 1; return acc; }, {});
  const triggerStates = consumer.decisions.filter((item) => item.service === 'Location').map((item) => item.triggerState ?? item.reason);
  const cseVersion = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version;
  await mkdir(join(evidenceDir, 'mec-sandbox-raw'), { recursive: true });
  const redact = (value) => JSON.parse(JSON.stringify(value).replace(/\/mec\/(Location|RNIS)\/[A-Za-z0-9_-]{43}/g, '/mec/$1/<route-token>'));
  await writeFile(join(evidenceDir, 'mec-sandbox-raw', 'notifications.json'), `${JSON.stringify(redact(rawSamples), null, 2)}\n`);
  const traceFile = join(evidenceDir, 'mec-ipe-sandbox-trace.jsonl');
  const shorten = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value.slice(0, 16) : value;
  const shortTrace = trace.filter((item) => !['CHECK'].includes(item.step)).map(({ seq, tMs, actor, step: name, ...rest }) => ({ seq, tMs, actor, step: name, ...Object.fromEntries(Object.entries(rest).filter(([key]) => !['at', 'catalogHash'].includes(key)).map(([key, value]) => [key, shorten(value)])) }));
  await writeFile(traceFile, `${shortTrace.map((item) => JSON.stringify(redact(item))).join('\n')}\n`);
  const receipt = {
    status: checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(), docRevision: '2.0.0', rubricIds: ['R13', 'R15', 'R16'],
    simulation: { mec: false, ue: 'sandbox-scenario', cse: false, hardware: false },
    transport: { onem2m: 'actual-mobius4-http-loopback', mec: 'https-k8s-ingress-ca', mecTlsCaPinned: true, mecCallbacks: 'http, sandbox pod -> PC LAN (node SNAT)' },
    mecSandbox: { real: true, implementation: 'ETSI MEC Sandbox STF_685 (local kubeadm install on VirtualBox VM)', revision: env.MEC_SANDBOX_REVISION ?? null, host: new URL(mecBase).host, sandboxName, mep, scenario: active.name, locationApiVersion: 'v3', catalogHash: started.catalog.catalogHash, caSHA256: await sha256File(caFile), appInstanceId: appInstance?.id ?? null, ipeServiceInstanceId: registeredService?.serInstanceId ?? null, paths: ['/mec_service_mgmt/v1/services', '/mec_service_mgmt/v1/applications/{id}/services', '/mec_app_support/v2/applications/{id}/confirm_ready', '/location/v3/subscriptions/users', '/location/v3/queries/users', '/rni/v2/subscriptions', '/sandbox-ctrl/v1/applications', '/gis/v1/geodata/{ue}', '/gis/v1/automation/MOBILITY'], ue: { ref: approvalHash(ueAddress).slice(0, 16), schoolPoa, schoolCellId: poaCells[schoolPoa] } },
    cseVersion, cseSourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout.trim() || null,
    postgres: (await pool.query('SELECT version()')).rows[0].version.split(',')[0],
    hostCount: { pc: 1, vm: 1 }, cseCount: edges.length, cseIds: edges.map((edge) => edge.cseId),
    ipe: { aePath: started.aePath, aei: started.aei, representation: started.catalog.services.map(({ key, mecApi, representation, rsc, consumed, state }) => ({ key, mecApi, state, representation, rsc, consumed })), group: started.catalog.group, requestContainers: [started.paths.Location, started.paths.RNIS], statusContainer: started.paths.status },
    flows, notifications, triggerStates,
    handover: { triggerDecision: handoverDecision ? { cinRi: handoverDecision.cinRi, eventKey: handoverDecision.eventKey?.slice(0, 16), triggerState: handoverDecision.triggerState, handoverId: handoverDecision.handoverId } : null, initialEdgeId: 'edge-a', finalEdgeId: session?.edgeId ?? null, epoch: session?.epoch ?? null, decisionAfterMoveMs: handoverDecision ? Date.parse(handoverDecision.at) - movedAt : null, decisionAfterPlacementMs: handoverDecision ? Date.parse(handoverDecision.at) - placedAt : null },
    geoQuery: { school: inSchool.devices, home: inHome.devices, schoolObservationCins: historySchool.uris.length, request: '?fu=1&ty=3&gmty=3&gsf=1&geom=<polygon>' },
    renewals, teardown, appNotifications: appNotifications.length, policyDecisions: consumer.decisions.length,
    privacy: { preciseCoordinatesOnCse: 'AES-256-GCM ciphertext only', locPrecisionDecimals: 3, ueAddressInObservationCin: false, ueAddressInIpeState: 'AES-256-GCM sealed', requestCinReaders: 'IPE AE only (requesters hold CREATE)' },
    checks, caseCount: checks.length, passed: checks.filter((item) => item.status === 'PASS').length, failed: checks.filter((item) => item.status !== 'PASS').length,
    artifacts: { trace: 'docs/verification-evidence/2026-11-20/mec-ipe-sandbox-trace.jsonl', traceSHA256: await sha256File(traceFile), rawNotifications: 'docs/verification-evidence/2026-11-20/mec-sandbox-raw/notifications.json', runtimeDirectory: `.local/mec-ipe-sandbox/${stamp}` },
    runnerSHA256: await sha256File(fileURLToPath(import.meta.url)),
    notes: 'MEC side is the ETSI MEC Sandbox (STF_685) on a separate VM; UE movement is driven through the sandbox GIS engine with MOBILITY automation, so the POA change and the RNIS cell change come from the sandbox. oneM2M side is two actual Mobius4 processes with PostgreSQL/PostGIS on the PC.',
  };
  await writeFile(join(evidenceDir, 'mec-ipe-sandbox.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(join(directory, 'full-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  console.log(JSON.stringify({ status: receipt.status, cases: receipt.caseCount, passed: receipt.passed, failed: receipt.failed, flows, notifications, handover: receipt.handover, geoQuery: receipt.geoQuery, renewals, teardown, failures: checks.filter((item) => item.status !== 'PASS') }, null, 2));
  if (receipt.status !== 'PASS') process.exitCode = 1;
} catch (error) { runtimeError = error; console.error(sanitized(error.stack)); console.error(JSON.stringify(checks.filter((item) => item.status !== 'PASS'), null, 2)); process.exitCode = 1; }
finally {
  try { await consumer?.stop(); } catch { /* best effort */ }
  try { await ipe?.stop({ teardown: true }); } catch { /* best effort */ }
  // Leave the UE at home with its POA re-aligned (automation still on), then restore the automation state.
  try { if (homeCoordinates) { await moveUe(homeCoordinates); await delay(3000); } } catch { /* best effort */ }
  try { if (mobilityWasActive === false) await sandbox('POST', '/gis/v1/automation/MOBILITY?run=false'); } catch { /* best effort */ }
  try { if (registeredService?.serInstanceId && appInstance?.id) await sandbox('DELETE', `/${mep}/mec_service_mgmt/v1/applications/${appInstance.id}/services/${registeredService.serInstanceId}`, undefined, [200, 204, 404]); } catch { /* best effort */ }
  try { if (appInstance?.id) await sandbox('DELETE', `/sandbox-ctrl/v1/applications/${appInstance.id}`, undefined, [200, 204, 404]); } catch { /* best effort */ }
  for (const server of servers) { server.closeAllConnections?.(); await new Promise((resolveClose) => server.close(resolveClose)); }
  for (const child of children) if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), delay(5000)]); }
  for (const database of databases) { try { await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); } catch (error) { console.error(`drop ${database}: ${sanitized(error.message)}`); } }
  await pool.end();
  if (runtimeError && existsSync(directory)) { await writeFile(join(directory, 'failure-trace.json'), `${JSON.stringify(trace, null, 2)}\n`); await writeFile(join(directory, 'failure-raw.json'), `${JSON.stringify(rawSamples, null, 2)}\n`); }
}
export { MecPlatformError };
