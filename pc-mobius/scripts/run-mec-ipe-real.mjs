/**
 * R15/R16 real run: two actual Mobius4 CSEs + MEC IPE + oneM2M-only policy consumer + local MEC sandbox simulator.
 * Trace: oneM2M request cin -> MEC subscription -> MEC notification -> oneM2M cin -> app/policy notification
 * -> geofence decision -> handover trigger, for Location (MEC013) and RNIS (MEC012).
 */
import { cp, mkdir, readFile, writeFile, symlink, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
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
import { MecPlatformClient, createMecFetch } from '../integration/src/mec-platform-client.mjs';
import { Onem2mHttpClient, parseContent } from '../integration/src/onem2m-http-client.mjs';
import { startMecSandboxSimulator } from '../integration/src/mec-sandbox-simulator.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const upstream = resolve(process.env.MOBIUS4_ROOT ?? join(root, '..', 'mobius4'));
const stamp = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const run = randomBytes(3).toString('hex');
const directory = join(root, '.local', 'mec-ipe-cse', stamp);
const source = join(root, '.local', 'mec-ipe-cse', 'source');
const evidenceDir = join(root, 'docs', 'verification-evidence', '2026-11-19');
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
async function waitFor(predicate, timeoutMs = 8000, label = 'condition') { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = await predicate(); if (value) return value; await delay(50); } throw new Error(`timeout: ${label}`); }
function sha256File(path) { return readFile(path).then((data) => createHash('sha256').update(data).digest('hex')); }

let ipe; let consumer; let simulator; let runtimeError = null;
try {
  // Two actual Mobius4 CSEs (edge-a hosts the MEC IPE, edge-b is the handover target).
  const edges = [];
  for (const label of ['a', 'b']) {
    const database = `bubble_mecipe_${stamp}_${label}`;
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

  // MEC sandbox simulator over HTTPS with a pinned local CA (same code path as MEC_CA_FILE on the sandbox).
  let tls = null; let caFile = null; let mecTransport = 'http';
  try {
    const tlsDir = join(directory, 'tls'); await mkdir(tlsDir, { recursive: true });
    const openssl = process.env.OPENSSL_BIN ?? 'openssl'; const cnf = join(tlsDir, 'req.cnf'); await writeFile(cnf, '[req]\ndistinguished_name=dn\n[dn]\n');
    caFile = join(tlsDir, 'ca.pem');
    execFileSync(openssl, ['req', '-config', cnf, '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=LocalMecSandboxCA', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', join(tlsDir, 'ca.key'), '-out', caFile], { windowsHide: true, stdio: 'ignore' });
    execFileSync(openssl, ['req', '-config', cnf, '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', join(tlsDir, 'server.key'), '-out', join(tlsDir, 'server.csr')], { windowsHide: true, stdio: 'ignore' });
    await writeFile(join(tlsDir, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n');
    execFileSync(openssl, ['x509', '-req', '-in', join(tlsDir, 'server.csr'), '-CA', caFile, '-CAkey', join(tlsDir, 'ca.key'), '-set_serial', '7', '-days', '1', '-extfile', join(tlsDir, 'server.ext'), '-out', join(tlsDir, 'server.pem')], { windowsHide: true, stdio: 'ignore' });
    tls = { key: await readFile(join(tlsDir, 'server.key')), cert: await readFile(join(tlsDir, 'server.pem')) }; mecTransport = 'https-pinned-local-ca';
  } catch { tls = null; caFile = null; }
  simulator = await startMecSandboxSimulator({ sandboxName: 'sbx-local', mep: 'mep1', locationVersion: 'v3', tls });
  step('mec-simulator', 'MEC_SANDBOX_SIMULATOR_STARTED', { platformRootPattern: '<origin>/sbx-local/mep1', transport: mecTransport, simulation: true });
  const unpinned = await new MecPlatformClient({ platformRoot: simulator.platformRoot, timeoutMs: 2000 }).discoverServices().then(() => 'ACCEPTED', (error) => error.code);
  if (tls) check('mec-tls-without-ca-is-refused', 'MEC_TRANSPORT_REVIEW', unpinned);

  // Policy state: consent -> grant -> approved zone policy with RNIS serving-cell corroboration.
  const store = await new IntegrationStore(join(directory, 'policy-state.json')).init();
  const policyService = new PolicyService({ store });
  const coordinator = new HandoverCoordinator({ store, policyService, drainBudgetMs: 100, attemptBudgetMs: 10000 });
  const relay = createServer((request, response) => { request.resume(); request.on('end', () => { response.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end(); }); });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening'); servers.push(relay);
  for (const edge of edges) coordinator.registerEdge({ ...edge, callbackUrl: `http://127.0.0.1:${relay.address().port}/${edge.edgeId}`, simulation: false, timeoutMs: 5000 });
  const reconciler = new MecPolicyReconciler({ store, policyService, handoverCoordinator: coordinator });
  const deviceId = `keyring-${run}`; const ueAddress = '10.100.0.1';
  const zoneB = { type: 'bbox', minLat: 43.737, minLon: 7.42, maxLat: 43.74, maxLon: 7.425 };
  const zoneA = { type: 'bbox', minLat: 43.732, minLon: 7.411, maxLat: 43.735, maxLon: 7.416 };
  const cellLocations = { 'cell-A': { lat: 43.7335, lon: 7.4135 }, 'cell-B': { lat: 43.7386, lon: 7.4224 } };
  const principal = { principalId: `guardian-${run}`, scopes: ['consent:write', 'grant:write', 'grant:revoke', 'policy:approve'] };
  const consent = await policyService.createConsent({ principal, subjectId: `household-${run}`, purpose: 'MEC IPE real-CSE verification', scopes: ['mec:location', 'mec:rnis'], ttlSec: 3600 });
  const grant = await policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['mec:location', 'mec:rnis'], ttlSec: 1800 });
  const policy = await policyService.approvePolicy({ principal, idempotencyKey: `mec-ipe-${run}`, policy: { grantId: grant.grantId, ueId: deviceId, targetEdgeId: 'edge-b', geofence: zoneB, servingCells: ['cell-B'], trigger: { kind: 'zone' }, services: ['Location', 'RNIS'] } });
  step('policy', 'POLICY_APPROVED', { policyId: policy.policyId, policyRevision: policy.revision, grantId: grant.grantId, grantRevision: grant.revision, targetEdgeId: 'edge-b', geofence: 'zone-B bbox', servingCells: ['cell-B'] });
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
  // Mobius4 4.24.5 answers 5000 when a non-admin originator sets acpi on a resource that has none
  // (acpi_update iterates the current, empty acpi). Provisioning binds the AE ACP as the CSE admin,
  // the same step handover-cse.mjs register() performs.
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

  // Shared AES-256-GCM key between IPE and policy consumer (precise coordinates stay off the CSE in clear).
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
  const platform = new MecPlatformClient({ platformRoot: simulator.platformRoot, fetchImpl: createMecFetch({ caFile }), timeoutMs: 4000, simulation: true, appInstanceId: `pb-mec-ipe-${run}` });
  ipe = new MecIpe({ cse: { endpoint: edgeA.endpoint, cseBase: '/Mobius', cseId: edgeA.cseId }, originator: ids.ipe, platform, consume: ['Location', 'RNIS'], requesters: { Location: [ids.app], RNIS: [ids.app] }, readers: [ids.app, ids.policy], cipher, authorize, leaseSec: 12, renewBeforeMs: 5000, renewCheckMs: 1000, cellLocations, simulation: true, trace: log });
  const started = await ipe.start();
  consumer = new MecOneM2mConsumer({ cse: { endpoint: edgeA.endpoint, cseBase: '/Mobius', cseId: edgeA.cseId }, originator: ids.policy, ipeOriginator: ids.ipe, cipher, reconciler, store, handoverCoordinator: coordinator, trace: log });
  await consumer.start(); await consumer.watchDevice({ deviceId, devicePath: deviceAe.path });
  for (const [rn, parent] of [['app-location', `${deviceAe.path}/location`], ['app-rnis', `${deviceAe.path}/rnis`], ['app-status', started.paths.status]]) check(`app-subscription-${rn}`, 2001, (await app.create(parent, 23, { 'm2m:sub': { rn, nu: [`${appUrl}/${rn}`], enc: { net: [3] }, nct: 1 } })).rsc);

  // MEC services discovered through oneM2M by the app (no MEC call from the app).
  const discovered = await app.retrieve(started.paths.services, { fu: 1, ty: 28 });
  const servicePaths = discovered.payload?.['m2m:uril'] ?? [];
  const serviceViews = [];
  for (const path of servicePaths) { const item = Object.values((await app.retrieve(path)).payload ?? {})[0] ?? {}; serviceViews.push({ path, mecApi: item.mecApi, serName: item.serName, state: item.state, apiVersion: item.apiVersion, consumed: item.consumed }); }
  step('guardian-app', 'APP_DISCOVERED_MEC_SERVICES_VIA_ONEM2M', { rsc: discovered.rsc, services: serviceViews.map(({ mecApi, serName, state, consumed }) => ({ mecApi, serName, state, consumed })) });
  check('app-discovers-mec-services-via-onem2m', true, serviceViews.filter((item) => item.state === 'ACTIVE').length >= 4 && serviceViews.some((item) => item.mecApi === 'MEC013' && item.consumed) && serviceViews.some((item) => item.mecApi === 'MEC012' && item.consumed));
  check('mec011-confirm-ready', 1, simulator.readyApps.length);
  const group = await app.retrieve(`${started.aePath}/mecServiceGroup`);
  check('mec-service-group-of-flexcontainers', { rsc: 2000, mt: 28, cnm: 4 }, { rsc: group.rsc, mt: group.payload?.['m2m:grp']?.mt, cnm: group.payload?.['m2m:grp']?.cnm });

  // ACP boundaries.
  check('acp-visitor-cannot-create-request', 4103, (await visitor.create(started.paths.Location, 4, { 'm2m:cin': { con: { op: 'subscribe', requestId: 'visitor-1', deviceAe: deviceId, ueAddress, type: 'periodic' } } })).rsc);
  check('acp-visitor-cannot-read-location', 4103, (await visitor.retrieve(`${deviceAe.path}/location`)).rsc);
  check('acp-app-cannot-read-request-container', 4103, (await app.retrieve(started.paths.Location)).rsc);
  // Mobius4 needs CREATE+RETRIEVE to subscribe and has no acod/chty, so consumers also check the cin creator.
  const forged = await app.create(`${deviceAe.path}/location`, 4, { 'm2m:cin': { cnf: 'application/json', con: { schema: 'pb.mec.location.v1', service: 'Location', deviceId, eventKey: 'forged-by-app', observedAt: new Date().toISOString() }, cr: null } });
  await waitFor(() => consumer.decisions.find((item) => item.eventKey === 'forged-by-app'), 5000, 'forged cin decision');
  check('observation-from-non-ipe-creator-is-ignored', { rsc: 2001, reason: 'creator-review' }, { rsc: forged.rsc, reason: consumer.decisions.find((item) => item.eventKey === 'forged-by-app')?.reason });

  const intent = { policyId: policy.policyId, grantId: grant.grantId, grantRevision: grant.revision, policyRevision: policy.revision };
  const requestState = (requestId) => ipe.store.list('ipeRequests').find((item) => item.requestId === requestId)?.state;
  const statusFor = (requestId, state) => appNotifications.find((item) => item.requestId === requestId && item.state === state);
  // A request stamped with an old grant revision is refused before any MEC call.
  await app.create(started.paths.Location, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'subscribe', requestId: `loc-stale-${run}`, deviceAe: deviceId, ueAddress, type: 'periodic', durationSec: 60, intent: { ...intent, grantRevision: grant.revision + 1 } }, cr: null } });
  await waitFor(() => statusFor(`loc-stale-${run}`, 'REJECTED'), 8000, 'stale grant revision rejection');
  check('request-with-other-grant-revision-rejected', 0, simulator.activeSubscriptions().length);

  // oneM2M -> MEC: RNIS (MEC012) and Location (MEC013) requests.
  const rnisId = `rnis-${run}`; const locationId = `loc-${run}`;
  await app.create(started.paths.RNIS, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'subscribe', requestId: rnisId, deviceAe: deviceId, ueAddress, type: 'cellChange', durationSec: 120, intent }, cr: null } });
  await app.create(started.paths.Location, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'subscribe', requestId: locationId, deviceAe: deviceId, ueAddress, type: 'periodic', periodSec: 2, durationSec: 120, intent }, cr: null } });
  await waitFor(() => requestState(rnisId) === 'ACTIVE' && requestState(locationId) === 'ACTIVE', 8000, 'MEC subscriptions active');
  await waitFor(() => statusFor(rnisId, 'ACTIVE') && statusFor(locationId, 'ACTIVE'), 5000, 'app status notifications');
  check('mec-subscriptions-created-from-onem2m-requests', ['Location:periodic', 'RNIS:cellChange'], simulator.activeSubscriptions().map((item) => `${item.service}:${item.type}`).sort());

  // MEC -> oneM2M: two reports in zone A, the RAN handover to cell-B, then reports inside zone B.
  const inside = { lat: 43.7385, lon: 7.4225, accuracyM: 8, zoneId: 'zone-B', accessPointId: 'ap-B1' };
  for (const position of [{ lat: 43.7335, lon: 7.4135, accuracyM: 8, zoneId: 'zone-A', accessPointId: 'ap-A1' }, { lat: 43.7336, lon: 7.4137, accuracyM: 8, zoneId: 'zone-A', accessPointId: 'ap-A1' }]) { await simulator.moveUe(ueAddress, position); await delay(2000); }
  await simulator.cellChange(ueAddress, { srcCellId: 'cell-A', trgCellId: 'cell-B', hoStatus: 'COMPLETED' });
  await waitFor(() => consumer.decisions.find((item) => item.service === 'RNIS'), 5000, 'RNIS policy decision');
  let handoverDecision = null; let reports = 0;
  while (!handoverDecision && Date.now() - placedAt < 70000) {
    const offset = (reports % 3) * 0.0001;
    await simulator.moveUe(ueAddress, { ...inside, lat: inside.lat + offset });
    reports += 1;
    await delay(2000);
    await ipe.idle(); await consumer.idle();
    handoverDecision = consumer.decisions.find((item) => item.service === 'Location' && item.triggerState === 'ACTIVE');
  }
  await ipe.idle(); await consumer.idle();
  const session = coordinator.status(deviceId);
  step('handover', 'HANDOVER_STATE', { ueId: deviceId, edgeId: session?.edgeId, epoch: session?.epoch, state: session?.state, previousEdgeId: session?.previousEdgeId ?? null });
  check('geofence-entry-triggers-handover-to-edge-b', { edgeId: 'edge-b', state: 'ACTIVE' }, { edgeId: session?.edgeId, state: session?.state });

  // Callback hygiene on the real path.
  const duplicate = await simulator.redeliver('Location');
  const stale = await simulator.redeliver('Location', { patch: (body) => { Object.values(body)[0].timeStamp = { seconds: Math.floor((Date.now() - 60000) / 1000), nanoSeconds: 0 }; return body; } });
  const future = await simulator.redeliver('Location', { patch: (body) => { Object.values(body)[0].timeStamp = { seconds: Math.floor((Date.now() + 10000) / 1000), nanoSeconds: 0 }; return body; } });
  const foreign = await simulator.redeliver('Location', { patch: (body) => { const value = Object.values(body)[0]; value.address = '10.100.0.99'; value.timeStamp = { seconds: Math.floor(Date.now() / 1000), nanoSeconds: 0 }; return body; } });
  await ipe.idle();
  const reviews = trace.filter((item) => item.step === 'MEC_CALLBACK_REVIEW' && item.service === 'Location').map((item) => item.status);
  check('mec-callback-duplicate-stale-future-binding', ['DUPLICATE', 'STALE', 'FUTURE', 'BINDING_REVIEW'], reviews.slice(-4));
  check('mec-callback-http-status', [204, 204, 204, 403], [duplicate.status, stale.status, future.status, foreign.status]);

  // Location cin readback: coarse loc on the CSE, precise point only as ciphertext.
  const latest = await app.retrieve(`${deviceAe.path}/location/la`);
  const latestCin = latest.payload?.['m2m:cin']; const latestCon = parseContent(latestCin?.con);
  check('location-cin-readback', { rsc: 2000, schema: 'pb.mec.location.v1', creator: ids.ipe, locType: 1, preciseAlgorithm: 'AES-256-GCM' }, { rsc: latest.rsc, schema: latestCon?.schema, creator: latestCin?.cr, locType: latestCin?.loc?.typ, preciseAlgorithm: latestCon?.precise?.algorithm });
  check('location-cin-carries-grant-and-policy-revision', intent, latestCon?.intent);
  check('ue-address-absent-from-cse-cin-and-ipe-state', [false, false], [JSON.stringify(latestCin ?? {}).includes(ueAddress), JSON.stringify(ipe.store.list('ipeRequests')).includes(ueAddress)]);

  // oneM2M geo-query: which devices are inside zone B now (container loc) and how many observations fall in zone B.
  const inZoneB = await consumer.devicesInZone(geofencePolygon(zoneB), { client: app });
  const inZoneA = await consumer.devicesInZone(geofencePolygon(zoneA), { client: app });
  const historyB = await consumer.devicesInZone(geofencePolygon(zoneB), { client: app, ty: 4 });
  step('guardian-app', 'GEO_QUERY', { zoneB: { rsc: inZoneB.rsc, devices: inZoneB.devices }, zoneA: { rsc: inZoneA.rsc, devices: inZoneA.devices }, zoneBObservationCins: historyB.uris.length });
  check('geo-query-zone-b-returns-device', [deviceAe.path.replace(/^\//, '')], inZoneB.devices);
  check('geo-query-zone-a-is-empty-after-move', [], inZoneA.devices);

  // RAN moves the UE back to cell-A: the network view resets the zone trigger.
  await simulator.cellChange(ueAddress, { srcCellId: 'cell-B', trgCellId: 'cell-A', hoStatus: 'COMPLETED' });
  await waitFor(() => consumer.decisions.filter((item) => item.service === 'RNIS').length >= 2, 5000, 'second RNIS decision');
  const rnisDecisions = consumer.decisions.filter((item) => item.service === 'RNIS').map((item) => item.reason);
  check('rnis-cell-change-feeds-policy', ['network-corroborates-target', 'network-cell-outside-target'], rnisDecisions);

  // Renewal before expiryDeadline (lease 12 s, renew 5 s before).
  const renewals = Object.fromEntries(ipe.store.list('ipeRequests').filter((item) => [rnisId, locationId].includes(item.requestId)).map((item) => [item.service, item.renewals]));
  check('mec-subscription-renewed-before-expiry', true, renewals.Location >= 1 && renewals.RNIS >= 1 && simulator.activeSubscriptions().every((item) => Date.parse(item.expiresAt) > Date.now()));

  // Teardown: request cin "unsubscribe" for RNIS, then the device AE deregisters (Location).
  const rnisCallback = simulator.lastCallback('RNIS');
  await app.create(started.paths.RNIS, 4, { 'm2m:cin': { cnf: 'application/json', con: { op: 'unsubscribe', requestId: rnisId }, cr: null } });
  await waitFor(() => requestState(rnisId) === 'DELETED', 8000, 'RNIS teardown');
  check('rnis-unsubscribe-deletes-mec-subscription', ['Location'], simulator.activeSubscriptions().map((item) => item.service));
  const late = await simulator.redeliver('RNIS', { callbackUrl: rnisCallback });
  await ipe.idle();
  check('late-rnis-callback-after-teardown-is-tombstoned', 'TOMBSTONE', trace.filter((item) => item.step === 'MEC_CALLBACK_REVIEW' && item.service === 'RNIS').at(-1)?.status, { httpStatus: late.status });
  check('device-ae-deregistration', 2002, (await device.remove(deviceAe.path)).rsc);
  await waitFor(() => requestState(locationId) === 'DELETED', 8000, 'Location teardown on AE deregistration');
  check('ae-deregistration-deletes-location-subscription', [], simulator.activeSubscriptions());
  await ipe.idle(); await consumer.idle();

  // Evidence.
  const flow = (service) => {
    const created = trace.find((item) => item.step === 'MEC_SUBSCRIPTION_CREATED' && item.service === service);
    const written = trace.find((item) => item.step === 'ONEM2M_OBSERVATION_WRITTEN' && item.service === service);
    const appSeen = trace.find((item) => item.step === 'APP_NOTIFICATION' && item.eventKey === written?.eventKey);
    const decision = trace.find((item) => item.step === 'POLICY_DECISION' && item.eventKey === written?.eventKey);
    const received = trace.find((item) => item.step === 'MEC_NOTIFICATION_RECEIVED' && item.service === service);
    return { mecNotificationReceived: received ? { mecSubscriptionId: received.mecSubscriptionId, notificationType: received.notificationType } : null, requestCin: trace.find((item) => item.step === 'ONEM2M_REQUEST_RECEIVED' && item.service === service && item.op === 'subscribe' && item.requestId === (service === 'Location' ? locationId : rnisId))?.requestRi ?? null, mecSubscriptionId: created?.mecSubscriptionId ?? null, mecApi: created?.mecApi ?? null, firstObservationCin: written?.cinRi ?? null, appNotified: Boolean(appSeen), policyDecision: decision ? { allowed: decision.allowed, reason: decision.reason, triggerState: decision.triggerState ?? null } : null };
  };
  const flows = { Location: flow('Location'), RNIS: flow('RNIS') };
  check('bidirectional-trace-complete', true, Object.values(flows).every((item) => item.requestCin && item.mecSubscriptionId && item.firstObservationCin && item.appNotified && item.policyDecision && item.mecNotificationReceived));
  const triggerStates = consumer.decisions.filter((item) => item.service === 'Location').map((item) => item.triggerState ?? item.reason);
  const cseVersion = JSON.parse(await readFile(join(upstream, 'package.json'), 'utf8')).version;
  const traceFile = join(evidenceDir, 'mec-ipe-real-cse-trace.jsonl');
  const shorten = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value.slice(0, 16) : value;
  const shortTrace = trace.filter((item) => !['CHECK'].includes(item.step)).map(({ seq, tMs, actor, step: name, ...rest }) => ({ seq, tMs, actor, step: name, ...Object.fromEntries(Object.entries(rest).filter(([key]) => !['at', 'catalogHash'].includes(key)).map(([key, value]) => [key, shorten(value)])) }));
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(traceFile, `${shortTrace.map((item) => JSON.stringify(item)).join('\n')}\n`);
  const receipt = {
    status: checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(), docRevision: '2.0.0', rubricIds: ['R15', 'R16'],
    simulation: { mec: true, ue: true, cse: false, hardware: false },
    transport: { onem2m: 'actual-mobius4-http-loopback', mec: `local-mec-sandbox-simulator-${mecTransport}`, mecTlsCaPinned: Boolean(tls) },
    cseVersion, cseSourceRevision: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: upstream, encoding: 'utf8', windowsHide: true }).stdout.trim() || null,
    postgres: (await pool.query('SELECT version()')).rows[0].version.split(',')[0],
    hostCount: 1, cseCount: edges.length, cseIds: edges.map((edge) => edge.cseId),
    mecSandbox: { real: false, platformRootPattern: '<MEC_BASE_URL>/<MEC_SANDBOX_NAME>/<MEC_MEP>', sandboxName: simulator.sandboxName, mep: simulator.mep, locationApiVersion: simulator.locationVersion, paths: ['/mec_service_mgmt/v1/services', '/mec_app_support/v2/applications/{id}/confirm_ready', '/location/v3/subscriptions/users', '/location/v3/queries/users', '/rni/v2/subscriptions'] },
    ipe: { aePath: started.aePath, aei: started.aei, representation: started.catalog.services.map(({ key, mecApi, representation, rsc, consumed }) => ({ key, mecApi, representation, rsc, consumed })), group: started.catalog.group, requestContainers: [started.paths.Location, started.paths.RNIS], statusContainer: started.paths.status },
    flows, triggerStates, handover: { triggerDecision: handoverDecision ? { cinRi: handoverDecision.cinRi, eventKey: handoverDecision.eventKey?.slice(0, 16), triggerState: handoverDecision.triggerState, handoverId: handoverDecision.handoverId } : null, initialEdgeId: 'edge-a', finalEdgeId: session?.edgeId ?? null, epoch: session?.epoch ?? null, decisionAtMs: handoverDecision ? Date.parse(handoverDecision.at) - placedAt : null, locationReportsInsideZone: reports },
    geoQuery: { zoneB: inZoneB.devices, zoneA: inZoneA.devices, zoneBObservationCins: historyB.uris.length, request: '?fu=1&ty=3&gmty=3&gsf=1&geom=<polygon>' },
    renewals, mecRequests: simulator.requests.reduce((acc, item) => { const key = `${item.method} ${item.path.replace(/sim-(loc|rnis)-\d+/, '{id}').replace(/applications\/[^/]+/, 'applications/{id}')}`; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}),
    mecNotificationsSent: simulator.notifications.length, appNotifications: appNotifications.length, policyDecisions: consumer.decisions.length,
    privacy: { preciseCoordinatesOnCse: 'AES-256-GCM ciphertext only', locPrecisionDecimals: 3, ueAddressInObservationCin: false, ueAddressInIpeState: 'AES-256-GCM sealed', requestCinReaders: 'IPE AE only (requesters hold CREATE)' },
    checks, caseCount: checks.length, passed: checks.filter((item) => item.status === 'PASS').length, failed: checks.filter((item) => item.status !== 'PASS').length,
    artifacts: { trace: 'docs/verification-evidence/2026-11-19/mec-ipe-real-cse-trace.jsonl', traceSHA256: await sha256File(traceFile), runtimeDirectory: `.local/mec-ipe-cse/${stamp}` },
    runnerSHA256: await sha256File(fileURLToPath(import.meta.url)),
    notes: 'MEC side is the local sandbox simulator (simulation true); oneM2M side is two actual Mobius4 processes with PostgreSQL/PostGIS on one host. Sandbox cutover: docs/rubric-work/R16-sandbox-cutover.md.',
  };
  await writeFile(join(evidenceDir, 'mec-ipe-real-cse.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  await writeFile(join(directory, 'full-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  console.log(JSON.stringify({ status: receipt.status, cases: receipt.caseCount, passed: receipt.passed, failed: receipt.failed, flows, handover: receipt.handover, geoQuery: receipt.geoQuery, renewals, failures: checks.filter((item) => item.status !== 'PASS') }, null, 2));
  if (receipt.status !== 'PASS') process.exitCode = 1;
} catch (error) { runtimeError = error; console.error(sanitized(error.stack)); process.exitCode = 1; }
finally {
  try { await consumer?.stop(); } catch { /* best effort */ }
  try { await ipe?.stop(); } catch { /* best effort */ }
  try { await simulator?.close(); } catch { /* best effort */ }
  for (const server of servers) { server.closeAllConnections?.(); await new Promise((resolveClose) => server.close(resolveClose)); }
  for (const child of children) if (child.exitCode === null) { child.kill(); await Promise.race([once(child, 'exit'), delay(5000)]); }
  for (const database of databases) { try { await pool.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`); } catch (error) { console.error(`drop ${database}: ${sanitized(error.message)}`); } }
  await pool.end();
  if (runtimeError && existsSync(directory)) await writeFile(join(directory, 'failure-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
}
