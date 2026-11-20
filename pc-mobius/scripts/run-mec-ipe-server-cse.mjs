/**
 * End-to-end run: the oneM2M MEC IPE running as a MEC application in the ETSI MEC Sandbox (sandbox
 * `dayofcare`, pod pb-ipe-mep1 on mep1) attached to the team's server CSE (Mobius4 /bubble-cse in Docker on
 * the same VM) through the nginx mTLS originator-binding route https://<SERVER_DOMAIN>:8443/onem2m.
 *
 * Preconditions (see deploy/mec-sandbox/README.md, "Connecting the IPE to the server CSE"):
 *   deploy/mec-sandbox/ipe/provision-server-cse.sh  device container bubble-household-1/resident-relay
 *   deploy/mec-sandbox/ipe/attach-server-cse.sh     secret, hostAlias and ONEM2M_* settings in pb-ipe-mep*
 *
 * The requester (Cguardian-app), the orchestrator (Cpb-orchestrator) and the dashboard guardian reader
 * (Cpb-dash-guardian) act through PB_CSE_RELAY, the server owner's LAN relay where the CSE takes
 * X-M2M-Origin as sent (admin-side path, PC and pod CIDR only). The IPE itself only uses its mTLS route.
 * A listener on the PC (PB_LISTENER_HOST:PB_LISTENER_PORT, an origin the CSE allows for notifications)
 * receives the guardian's location/rnis notifications, the request status and the IPE lifecycle.
 *
 * Environment: PB_CSE_RELAY (http://192.168.0.103:17599), MEC_BASE_URL (https://192.168.0.103),
 * MEC_SANDBOX_NAME (dayofcare), MEC_CA_FILE (.local/mec-sandbox/ca.pem), PB_LISTENER_HOST (192.168.0.106),
 * PB_LISTENER_PORT (18096), PB_STEP_MS (2500), PB_VM_SSH, PB_VM_KEY, PB_VM_KNOWN_HOSTS (pod logs).
 * Writes docs/verification-evidence/2026-11-20/mec-ipe-server-cse.json and mec-ipe-server-cse-trace.jsonl.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { approvalHash } from '../integration/src/integration-utils.mjs';
import { IPE_LIFECYCLE_SCHEMA, IPE_OWNERSHIP_SCHEMA } from '../integration/src/mec-ipe-relocatable.mjs';
import { createMecFetch } from '../integration/src/mec-platform-client.mjs';
import { m2mTime, parseContent } from '../integration/src/onem2m-http-client.mjs';
const SERVER_DOMAIN = process.env.SERVER_DOMAIN ?? '<SERVER_DOMAIN>';

const root = fileURLToPath(new URL('../..', import.meta.url));
const env = process.env;
const relayBase = (env.PB_CSE_RELAY ?? 'http://192.168.0.103:17599').replace(/\/+$/, '');
const mecBase = (env.MEC_BASE_URL ?? 'https://192.168.0.103').replace(/\/+$/, '');
const sandboxName = env.MEC_SANDBOX_NAME ?? 'dayofcare';
const caFile = resolve(root, env.MEC_CA_FILE ?? '.local/mec-sandbox/ca.pem');
const listenerHost = env.PB_LISTENER_HOST ?? '192.168.0.106';
const listenerPort = Number(env.PB_LISTENER_PORT ?? 18096);
const stepMs = Number(env.PB_STEP_MS ?? 2500);
const vmSsh = env.PB_VM_SSH ?? 'mec@192.168.0.103';
const vmKey = env.PB_VM_KEY ?? join(homedir(), 'VMs', 'mec-sandbox', 'id_ed25519');
const vmKnownHosts = env.PB_VM_KNOWN_HOSTS ?? join(homedir(), 'VMs', 'mec-sandbox', 'known_hosts');
const evidenceDir = join(root, 'docs', 'verification-evidence', '2026-11-20');
const ids = { requester: 'Cguardian-app', orchestrator: 'Cpb-orchestrator', guardian: 'Cpb-dash-guardian', ipe: 'Cpb-mec-ipe' };
const ipeAe = 'Mobius/pb-mec-ipe';
const household = 'bubble-household-1'; const deviceRef = `${household}/resident-relay`; const devicePath = `Mobius/${deviceRef}`;
const instance = { name: 'pb-ipe-mep1', id: '0d0c0a00-0000-4000-8000-0000000001a1', mep: 'mep1', nodePort: 31881 };
const ue = 'resident-relay';
// Home door down Boulevard de Belgique to the last point inside home-district (OSM coordinates, scenario day-of-care).
const trail = [[7.417915, 43.736945], [7.417894, 43.736678], [7.417596, 43.736644], [7.417302, 43.736479], [7.417082, 43.736212], [7.416868, 43.735937], [7.416715, 43.735715], [7.416551, 43.735538], [7.41646, 43.735358], [7.416365, 43.735125], [7.416308, 43.734946], [7.416266, 43.734679]];

const stamp = `${Date.now()}_${randomBytes(3).toString('hex')}`;
const t0 = Date.now(); const trace = []; const checks = [];
const log = (entry) => { trace.push({ seq: trace.length + 1, tMs: Date.now() - t0, ...entry }); };
const step = (actor, name, details = {}) => log({ at: new Date().toISOString(), actor, step: name, ...details });
const check = (name, expected, actual, details = {}) => { const status = approvalHash(expected ?? null) === approvalHash(actual ?? null) ? 'PASS' : 'FAIL'; checks.push({ name, status, expected, actual, ...details }); step('verifier', 'CHECK', { name, status, expected, actual }); console.log(`${status} ${name}`); return status === 'PASS'; };
async function waitFor(predicate, timeoutMs, label) { const until = Date.now() + timeoutMs; while (Date.now() < until) { const value = await predicate(); if (value) return value; await delay(250); } throw new Error(`timeout: ${label}`); }
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// oneM2M requests of the requester, orchestrator and guardian through the relay (plain HTTP on the LAN).
let rqi = 0;
async function m2m(originator, method, path, { ty, body, query } = {}) {
  if (!/^Mobius(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(path)) throw new Error(`path ${path}`);
  const url = new URL(`${relayBase}/${path}`);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
  const ri = `pb-e2e-${stamp}-${++rqi}`;
  const response = await fetch(url, { method, headers: { 'X-M2M-Origin': originator, 'X-M2M-RI': ri, 'X-M2M-RVI': '4', accept: 'application/json', ...(body ? { 'content-type': `application/json${ty ? `;ty=${ty}` : ''}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(8000) });
  const text = await response.text(); let payload = null; try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  return { status: response.status, rsc: Number(response.headers.get('x-m2m-rsc')), payload, ri };
}

// Sandbox control plane and MEC APIs through the ingress with the pinned lab CA.
const mecFetch = createMecFetch({ caFile });
const sandbox = async (method, path, body, expected = [200, 201, 204]) => {
  const response = await mecFetch(`${mecBase}/${sandboxName}${path}`, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!expected.includes(response.status)) throw Object.assign(new Error(`sandbox ${method} ${path} ${response.status} ${String(text).slice(0, 200)}`), { status: response.status });
  return { status: response.status, data };
};
const moveUe = async (coordinates) => (await sandbox('POST', `/gis/v1/geodata/${ue}`, { assetName: ue, assetType: 'UE', subType: 'UE', location: { type: 'Point', coordinates } })).status;
const sighting = async () => { const users = (await sandbox('GET', `/${instance.mep}/location/v3/queries/users`)).data?.userList?.user ?? []; const user = users.find((item) => item.address === ue); return user ? { accessPointId: user.accessPointId, zoneId: user.zoneId } : null; };
const useSsh = env.PB_VM_SSH !== '' && existsSync(vmKey);
const ssh = (command, timeoutMs = 30000) => { if (!useSsh) return null; const result = spawnSync('ssh', ['-i', vmKey, '-o', `UserKnownHostsFile=${vmKnownHosts}`, '-o', 'BatchMode=yes', vmSsh, command], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true }); return result.status === 0 ? result.stdout : null; };
const podInfo = () => { const out = ssh(`kubectl -n ${sandboxName} get pods -l meepAppId=${instance.id} --sort-by=.metadata.creationTimestamp -o json`); if (!out) return null; try { const pod = JSON.parse(out).items?.filter((item) => !item.metadata.deletionTimestamp).at(-1); if (!pod) return null; const main = pod.spec.containers.find((item) => item.name === instance.name); return { name: pod.metadata.name, phase: pod.status.phase, createdAt: pod.metadata.creationTimestamp, image: pod.status.containerStatuses?.find((item) => item.name === instance.name)?.imageID ?? null, hostAliases: pod.spec.hostAliases ?? [], env: Object.fromEntries((main?.env ?? []).filter((item) => /^ONEM2M_|^MEC_IPE_/.test(item.name)).map((item) => [item.name, item.value])), secretVolume: pod.spec.volumes?.find((item) => item.secret)?.secret?.secretName ?? null }; } catch { return null; } };
const podLogs = (pod) => { const out = ssh(`kubectl -n ${sandboxName} logs ${pod} -c ${instance.name} 2>/dev/null`, 60000) ?? ''; return out.split('\n').filter((line) => line.trim()).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean); };

// Listener for the CSE notifications (guardian reader, request status, IPE lifecycle).
const received = { location: [], rnis: [], status: [], lifecycle: [], verifications: [], other: [] };
const listener = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  let body = null; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = null; }
  const signal = body?.['m2m:sgn']; const kind = request.url.split('/').filter(Boolean).at(-1);
  response.writeHead(200, { 'X-M2M-RSC': '2000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end();
  if (!signal) return;
  const base = { arrivedAt: Date.now(), origin: request.headers['x-m2m-origin'] ?? null, from: request.socket.remoteAddress, sur: signal.sur ?? null, route: request.url };
  if (signal.vrq) { received.verifications.push(base); step('listener', 'VERIFICATION_REQUEST', { route: request.url, origin: base.origin }); return; }
  if (signal.sud) { step('listener', 'SUBSCRIPTION_DELETED', { route: request.url }); return; }
  const cin = signal.nev?.rep?.['m2m:cin']; const con = parseContent(cin?.con);
  const entry = { ...base, net: signal.nev?.net ?? null, cinRi: cin?.ri ?? null, cinRn: cin?.rn ?? null, creator: cin?.cr ?? null, loc: cin?.loc ?? null, con };
  (received[kind] ?? received.other).push(entry);
  if (kind === 'location') { step('listener', 'GUARDIAN_LOCATION_NOTIFICATION', { cinRi: entry.cinRi, creator: entry.creator, origin: entry.origin, loc: entry.loc?.crd ?? null, observedAt: con?.observedAt ?? null, accessPointId: con?.accessPointId ?? null, zoneId: con?.zoneId ?? null, servedBy: con?.servedBy ?? null }); if (received.location.length === 1) console.log(`FIRST_LOCATION_CIN ri=${entry.cinRi} path=/${devicePath}/location/${entry.cinRn}`); }
  else if (kind === 'rnis') step('listener', 'GUARDIAN_RNIS_NOTIFICATION', { cinRi: entry.cinRi, creator: entry.creator, srcCellId: con?.srcCellId ?? null, trgCellId: con?.trgCellId ?? null, hoStatus: con?.hoStatus ?? null, loc: entry.loc?.crd ?? null });
  else if (kind === 'status') step('listener', 'REQUEST_STATUS', { requestId: con?.requestId ?? null, state: con?.state ?? null, service: con?.service ?? null, mecSubscriptionId: con?.mecSubscriptionId ?? null, providerStatus: con?.providerStatus ?? null, reason: con?.reason ?? null, expiresAt: con?.expiresAt ?? null });
  else if (kind === 'lifecycle') step('listener', 'IPE_LIFECYCLE', { event: con?.event ?? null, mep: con?.mep ?? null, epoch: con?.epoch ?? null, creator: entry.creator, schemaOk: con?.schema === IPE_LIFECYCLE_SCHEMA });
});

let mobilityWasActive = null; let tookControl = false; let runtimeError = null;
const subscriptions = []; const teardown = {}; const requests = {}; const mecSide = {};
try {
  listener.listen(listenerPort, '0.0.0.0'); await once(listener, 'listening');
  const nu = (kind) => `http://${listenerHost}:${listenerPort}/${kind}`;
  step('runner', 'LISTENER_STARTED', { url: `http://${listenerHost}:${listenerPort}` });

  // ---- Preflight: sandbox, IPE pod, IPE AE on the server CSE, idle UE.
  const active = (await sandbox('GET', '/sandbox-ctrl/v1/active')).data;
  check('sandbox-scenario-active', 'day-of-care', active?.name);
  const pod = podInfo();
  step('vm', 'IPE_POD', pod ?? { available: false });
  check('ipe-pod-attached-to-server-cse', { phase: 'Running', cse: `https://${SERVER_DOMAIN}:8443/onem2m`, cseId: '/bubble-cse', hostAlias: SERVER_DOMAIN, secret: 'pb-ipe-server-cse' }, { phase: pod?.phase ?? null, cse: pod?.env?.ONEM2M_CSE_URL ?? null, cseId: pod?.env?.ONEM2M_CSE_ID ?? null, hostAlias: pod?.hostAliases?.[0]?.hostnames?.[0] ?? null, secret: pod?.secretVolume ?? null });
  const ready = pod ? podLogs(pod.name).find((item) => item.step === 'IPE_POD_READY') : null;
  check('ipe-registered-on-server-cse-via-mtls', '/Mobius/pb-mec-ipe', ready?.aePath ?? null);
  check('ipe-lifecycle-readable-by-orchestrator', 2000, (await m2m(ids.orchestrator, 'GET', `${ipeAe}/lifecycle`)).rsc);
  const ueSnapshot = async () => JSON.stringify(((await sandbox('GET', '/gis/v1/geodata?assetType=UE&excludePath=true')).data?.geoDataAssets ?? []).find((asset) => asset.assetName === ue)?.location?.coordinates ?? null);
  const before = await ueSnapshot(); await delay(6000);
  if (before !== await ueSnapshot()) throw Object.assign(new Error('SANDBOX_IN_USE: resident-relay moved during the 6 s idle check'), { code: 'SANDBOX_IN_USE' });
  tookControl = true;
  const automation = (await sandbox('GET', '/gis/v1/automation')).data?.states ?? [];
  mobilityWasActive = Boolean(automation.find((item) => item.type === 'MOBILITY')?.active);
  if (!mobilityWasActive) await sandbox('POST', '/gis/v1/automation/MOBILITY?run=true');
  await moveUe(trail[0]);
  const home = await waitFor(async () => { const seen = await sighting(); return seen?.accessPointId === 'home-wifi' ? seen : null; }, 30000, 'resident on home-wifi');
  step('mec-sandbox', 'AUTOMATION', { mobility: true, mobilityWasActive, resident: home });

  // ---- Subscriptions on the server CSE with nu at the PC listener.
  const subscribe = async (originator, parent, rn, kind, net = [3]) => {
    const created = await m2m(originator, 'POST', parent, { ty: 23, body: { 'm2m:sub': { rn, nu: [nu(kind)], enc: { net }, nct: 1, et: m2mTime(Date.now() + 30 * 60 * 1000) } } });
    const entry = { originator, path: `/${parent}/${rn}`, rsc: created.rsc, kind };
    subscriptions.push(entry); step('runner', 'SUBSCRIPTION', entry);
    return entry;
  };
  const suffix = stamp.slice(-6);
  const guardianLocation = await subscribe(ids.guardian, `${devicePath}/location`, `dash-guardian-e2e-${suffix}`, 'location');
  const guardianRnis = await subscribe(ids.guardian, `${devicePath}/rnis`, `dash-guardian-e2e-${suffix}`, 'rnis');
  check('guardian-reader-subscribes-location-and-rnis', [2001, 2001], [guardianLocation.rsc, guardianRnis.rsc]);
  check('requester-subscribes-request-status', 2001, (await subscribe(ids.requester, `${ipeAe}/requestStatus`, `app-status-e2e-${suffix}`, 'status')).rsc);
  check('orchestrator-subscribes-ipe-lifecycle', 2001, (await subscribe(ids.orchestrator, `${ipeAe}/lifecycle`, `orch-lifecycle-e2e-${suffix}`, 'lifecycle')).rsc);

  // ---- Ownership: the orchestrator names the mep1 instance as owner (next epoch).
  const latest = await m2m(ids.orchestrator, 'GET', `${ipeAe}/ownership/la`);
  const previousEpoch = latest.rsc === 2000 ? parseContent(latest.payload?.['m2m:cin']?.con)?.epoch ?? 0 : 0;
  const epoch = previousEpoch + 1;
  const ownership = await m2m(ids.orchestrator, 'POST', `${ipeAe}/ownership`, { ty: 4, body: { 'm2m:cin': { cnf: 'application/json', con: { schema: IPE_OWNERSHIP_SCHEMA, epoch, owner: instance.id, mep: instance.mep, decisionId: `server-cse-e2e-${suffix}`, reason: 'server-cse-end-to-end', at: new Date().toISOString() }, lbl: ['pb:mec-ipe-ownership', `pb:epoch:${epoch}`], cr: null } } });
  step('orchestrator', 'OWNERSHIP_WRITTEN', { epoch, previousEpoch, rsc: ownership.rsc, cinRi: ownership.payload?.['m2m:cin']?.ri ?? null });
  const resumed = await waitFor(() => received.lifecycle.find((item) => item.con?.event === 'RESUMED' && item.con?.epoch === epoch), 30000, 'IPE RESUMED').catch(() => null);
  check('ipe-owner-of-epoch', { owner: true, epoch, creator: ids.ipe }, { owner: Boolean(resumed?.con?.owner), epoch: resumed?.con?.epoch ?? null, creator: resumed?.creator ?? null });

  // ---- Requests: Location periodic and RNIS cell change for the resident's relay phone.
  const requestIds = { location: `loc-periodic-${suffix}`, rnis: `rnis-${suffix}` };
  const writeRequest = async (service, con) => { const created = await m2m(ids.requester, 'POST', `${ipeAe}/${service === 'Location' ? 'locationRequests' : 'rnisRequests'}`, { ty: 4, body: { 'm2m:cin': { cnf: 'application/json', con, cr: null } } }); step('guardian-app', 'REQUEST_WRITTEN', { service, requestId: con.requestId, op: con.op, rsc: created.rsc, requestRi: created.payload?.['m2m:cin']?.ri ?? null }); return created; };
  const locationRequest = await writeRequest('Location', { op: 'subscribe', requestId: requestIds.location, deviceAe: deviceRef, ueAddress: ue, type: 'periodic', periodSec: 3, durationSec: 900 });
  const rnisRequest = await writeRequest('RNIS', { op: 'subscribe', requestId: requestIds.rnis, deviceAe: deviceRef, ueAddress: ue, type: 'cellChange', durationSec: 900 });
  const activeStatus = (requestId) => received.status.find((item) => item.con?.requestId === requestId && item.con?.state === 'ACTIVE');
  await waitFor(() => activeStatus(requestIds.location) && activeStatus(requestIds.rnis), 30000, 'requests ACTIVE').catch(() => null);
  requests.location = { requestId: requestIds.location, requestRi: locationRequest.payload?.['m2m:cin']?.ri ?? null, rsc: locationRequest.rsc, type: 'periodic', periodSec: 3, mecApi: 'MEC013', mecSubscriptionId: activeStatus(requestIds.location)?.con?.mecSubscriptionId ?? null };
  requests.rnis = { requestId: requestIds.rnis, requestRi: rnisRequest.payload?.['m2m:cin']?.ri ?? null, rsc: rnisRequest.rsc, type: 'cellChange', mecApi: 'MEC012', mecSubscriptionId: activeStatus(requestIds.rnis)?.con?.mecSubscriptionId ?? null };
  check('requests-become-mec-subscriptions', { location: 'ACTIVE', rnis: 'ACTIVE' }, { location: activeStatus(requestIds.location)?.con?.state ?? null, rnis: activeStatus(requestIds.rnis)?.con?.state ?? null }, { mecSubscriptionIds: { location: requests.location.mecSubscriptionId, rnis: requests.rnis.mecSubscriptionId } });
  const listIds = async (path) => { const data = (await sandbox('GET', path)).data ?? {}; const links = data.notificationSubscriptionList?.subscription ?? data._links?.subscription ?? []; return links.map((item) => String(item.href ?? '').split('/').at(-1)); };
  mecSide.afterCreate = { location: await listIds(`/${instance.mep}/location/v3/subscriptions/users`), rnis: await listIds(`/${instance.mep}/rni/v2/subscriptions`) };
  check('mec-subscriptions-listed-on-mep1', [true, true], [mecSide.afterCreate.location.includes(String(requests.location.mecSubscriptionId)), mecSide.afterCreate.rnis.includes(String(requests.rnis.mecSubscriptionId))]);

  // ---- First observation at home, then the walk down Boulevard de Belgique and back (home-district, mep1).
  const firstLocation = await waitFor(() => received.location[0], 30000, 'first location notification').catch(() => null);
  check('first-location-cin-notified-to-guardian', { creator: ids.ipe, schema: 'pb.mec.location.v1', deviceId: deviceRef }, { creator: firstLocation?.creator ?? null, schema: firstLocation?.con?.schema ?? null, deviceId: firstLocation?.con?.deviceId ?? null });
  const walk = [];
  for (const index of [...trail.keys()].slice(1)) { walk.push({ index, status: await moveUe(trail[index]), at: new Date().toISOString() }); step('mec-sandbox', 'UE_MOVED', { ue, index, status: walk.at(-1).status }); await delay(stepMs); }
  const far = await sighting(); step('mec-sandbox', 'UE_SIGHTING', { index: trail.length - 1, ...far });
  await delay(8000);
  for (const index of [...trail.keys()].reverse().slice(1)) { walk.push({ index, status: await moveUe(trail[index]), at: new Date().toISOString() }); step('mec-sandbox', 'UE_MOVED', { ue, index, status: walk.at(-1).status }); await delay(stepMs); }
  const back = await waitFor(async () => { const seen = await sighting(); return seen?.accessPointId === 'home-wifi' ? seen : null; }, 30000, 'resident back on home-wifi').catch(() => null);
  step('mec-sandbox', 'UE_SIGHTING', { index: 0, ...(back ?? {}) });
  // Renewals: lease 60 s, renewal 15 s before expiry; wait for two per request.
  const renewed = (requestId) => received.status.filter((item) => item.con?.requestId === requestId && item.con?.state === 'RENEWED').length;
  await waitFor(() => renewed(requestIds.location) >= 2 && renewed(requestIds.rnis) >= 2, 120000, 'two renewals per request').catch(() => null);
  const accessPoints = [...new Set(received.location.map((item) => item.con?.accessPointId).filter(Boolean))];
  check('location-observations-follow-the-walk', true, received.location.length >= 5 && accessPoints.length >= 2, { observations: received.location.length, accessPoints });
  check('rnis-cell-change-cin-notified-to-guardian', true, received.rnis.length >= 1 && received.rnis.every((item) => item.creator === ids.ipe), { cellChanges: received.rnis.map((item) => `${item.con?.srcCellId ?? ''}->${item.con?.trgCellId ?? ''}`) });
  check('renewals-per-request-at-least-2', { location: true, rnis: true }, { location: renewed(requestIds.location) >= 2, rnis: renewed(requestIds.rnis) >= 2 }, { location: renewed(requestIds.location), rnis: renewed(requestIds.rnis) });

  // ---- Read-back on the server CSE as the guardian reader.
  const la = await m2m(ids.guardian, 'GET', `${devicePath}/location/la`);
  const container = await m2m(ids.guardian, 'GET', `${devicePath}/location`);
  check('latest-location-cin-readable-by-guardian', { rsc: 2000, creator: ids.ipe }, { rsc: la.rsc, creator: la.payload?.['m2m:cin']?.cr ?? null }, { cni: container.payload?.['m2m:cnt']?.cni ?? null, containerLoc: container.payload?.['m2m:cnt']?.loc?.crd ?? null });

  // ---- Teardown: unsubscribe both requests, delete the run's oneM2M subscriptions.
  await writeRequest('Location', { op: 'unsubscribe', requestId: requestIds.location });
  await writeRequest('RNIS', { op: 'unsubscribe', requestId: requestIds.rnis });
  const deleted = (requestId) => received.status.find((item) => item.con?.requestId === requestId && item.con?.state === 'DELETED');
  await waitFor(() => deleted(requestIds.location) && deleted(requestIds.rnis), 30000, 'requests DELETED').catch(() => null);
  teardown.mecDelete = { location: deleted(requestIds.location)?.con?.providerStatus ?? null, rnis: deleted(requestIds.rnis)?.con?.providerStatus ?? null };
  check('unsubscribe-deletes-mec-subscriptions', { location: 204, rnis: 204 }, teardown.mecDelete);
  mecSide.afterDelete = { location: await listIds(`/${instance.mep}/location/v3/subscriptions/users`), rnis: await listIds(`/${instance.mep}/rni/v2/subscriptions`) };
  check('mec-subscriptions-gone-on-mep1', [false, false], [mecSide.afterDelete.location.includes(String(requests.location.mecSubscriptionId)), mecSide.afterDelete.rnis.includes(String(requests.rnis.mecSubscriptionId))]);
  await delay(1500);
  teardown.onem2mSubscriptions = [];
  for (const entry of subscriptions.filter((item) => item.rsc === 2001)) teardown.onem2mSubscriptions.push({ path: entry.path, rsc: (await m2m(entry.originator, 'DELETE', entry.path.slice(1))).rsc });
  check('run-subscriptions-deleted', subscriptions.filter((item) => item.rsc === 2001).map(() => 2002), teardown.onem2mSubscriptions.map((item) => item.rsc));
} catch (error) {
  runtimeError = error; console.error(error.stack);
} finally {
  if (tookControl) { try { await moveUe(trail[0]); await delay(4000); } catch { /* best effort */ } }
  try { if (mobilityWasActive === false) await sandbox('POST', '/gis/v1/automation/MOBILITY?run=false'); } catch { /* best effort */ }
  if (tookControl) step('mec-sandbox', 'UE_RESTORED', { ue, at: trail[0], mobilityRestoredTo: mobilityWasActive });
  listener.closeAllConnections?.(); await new Promise((done) => listener.close(done));
}

// ---- Pod log merge, receipt and trace.
const pod = podInfo();
const ipeLog = pod ? podLogs(pod.name).filter((item) => Date.parse(item.at ?? 0) >= t0 - 1000) : [];
for (const { at, actor, step: name, ...rest } of ipeLog) log({ at: at ?? null, actor: `ipe@${instance.mep}`, step: name ?? 'POD_LOG', ...rest });
trace.sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0) || a.seq - b.seq).forEach((item, index) => { item.seq = index + 1; item.tMs = Date.parse(item.at ?? 0) - t0; });
const ipeSteps = (name) => ipeLog.filter((item) => item.step === name);
const redact = (value) => JSON.parse(JSON.stringify(value).replace(/\/(mec|mec011|ams|onem2m)\/(Location\/|RNIS\/)?[A-Za-z0-9_-]{43}/g, '/$1/$2<route-token>'));
const shorten = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value.slice(0, 16) : value;
const shortTrace = trace.filter((item) => item.step !== 'CHECK').map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'catalogHash').map(([key, value]) => [key, shorten(value)])));
await mkdir(evidenceDir, { recursive: true });
const traceFile = join(evidenceDir, 'mec-ipe-server-cse-trace.jsonl');
await writeFile(traceFile, `${shortTrace.map((item) => JSON.stringify(redact(item))).join('\n')}\n`);
const firstLocation = received.location[0] ?? null; const firstRnis = received.rnis[0] ?? null;
const receipt = {
  status: !runtimeError && checks.length && checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
  generatedAt: new Date().toISOString(), docRevision: '2.0.0', rubricIds: ['R15', 'R16'],
  simulation: { mec: false, ue: 'sandbox-scenario', cse: false },
  transport: {
    cse: 'https mTLS via nginx originator binding',
    ipeRoute: 'https://<SERVER_DOMAIN>:8443/onem2m/Mobius (pod hostAlias <SERVER_DOMAIN> -> 192.168.0.103; SNI and Host <SERVER_DOMAIN>; client certificate CN pb-mec-ipe, EKU clientAuth; server trust bundle from the server deployment; nginx sets X-M2M-Origin Cpb-mec-ipe)',
    requesterPath: `${relayBase} (server owner LAN relay, CSE takes X-M2M-Origin as sent; PC and pod CIDR only; used here for Cguardian-app, Cpb-orchestrator and Cpb-dash-guardian)`,
    notificationsFromCse: `CSE notification allowlist: http://192.168.0.103:31881 (IPE NodePort) and http://${listenerHost}:${listenerPort} (this run's listener)`,
    mec: `${mecBase}/${sandboxName}/${instance.mep} through the sandbox ingress with the pinned lab CA`,
  },
  hosts: [
    { host: 'pc', address: listenerHost, os: 'Windows 11', roles: ['run driver', `notification listener :${listenerPort}`, 'requester Cguardian-app, orchestrator Cpb-orchestrator and dashboard reader Cpb-dash-guardian through the relay'] },
    { host: 'vm mec-sandbox', address: new URL(mecBase).hostname, os: 'Ubuntu 22.04 (single-node kubeadm)', roles: [`ETSI MEC Sandbox STF_685, sandbox ${sandboxName} (scenario day-of-care)`, `IPE pod ${instance.name} on ${instance.mep}`, 'server CSE Mobius4 /bubble-cse (Docker compose project bubblelock-nocert) behind nginx :8443'] },
  ],
  cse: { cseId: '/bubble-cse', base: '/Mobius', implementation: 'Mobius4 (CSEBase lbl Mobius4)', owner: 'server stack bubblelock-nocert (not modified by this run)' },
  provisioning: {
    script: 'deploy/mec-sandbox/ipe/provision-server-cse.sh (docker exec inside the cse container, admin originator from that container environment)',
    acp: { path: `/Mobius/${household}/resident-relay-mec-access`, privileges: [{ originator: '[admin]', acop: 63 }, { originator: ids.ipe, acop: 7 }, { originator: ids.guardian, acop: 50 }, { originator: 'Cpb-dash-operator', acop: 34 }] },
    containers: [`/${devicePath}`, `/${devicePath}/location`, `/${devicePath}/rnis`],
    ipeOwnResources: 'AE /Mobius/pb-mec-ipe with mec-requests-acp (requesters Cguardian-app acop 1), mec-catalog-acp (readers Cguardian-app, Cpb-orchestrator, Cpb-dash-guardian, Cpb-dash-operator acop 35), mec-orchestration-acp (Cpb-orchestrator acop 35), created by the IPE through its mTLS route',
    householdAeUnchanged: true,
  },
  ipe: { pod: pod ? { name: pod.name, image: pod.image, hostAliases: pod.hostAliases, env: pod.env, secretVolume: pod.secretVolume } : null, ae: '/Mobius/pb-mec-ipe', aei: ipeSteps('IPE_AE_REGISTERED')[0]?.aei ?? 'Cpb-mec-ipe', appInstanceId: instance.id, mep: instance.mep, nodePort: instance.nodePort, attach: 'deploy/mec-sandbox/ipe/attach-server-cse.sh' },
  requests,
  observations: {
    location: received.location.length, rnis: received.rnis.length,
    firstLocationCin: firstLocation ? { ri: firstLocation.cinRi, path: `/${devicePath}/location/${firstLocation.cinRn}`, creator: firstLocation.creator, observedAt: firstLocation.con?.observedAt ?? null, accessPointId: firstLocation.con?.accessPointId ?? null, loc: firstLocation.loc?.crd ?? null } : null,
    firstRnisCin: firstRnis ? { ri: firstRnis.cinRi, path: `/${devicePath}/rnis/${firstRnis.cinRn}`, creator: firstRnis.creator, srcCellId: firstRnis.con?.srcCellId ?? null, trgCellId: firstRnis.con?.trgCellId ?? null, hoStatus: firstRnis.con?.hoStatus ?? null } : null,
    accessPoints: [...new Set(received.location.map((item) => item.con?.accessPointId).filter(Boolean))],
    cellChanges: received.rnis.map((item) => `${item.con?.srcCellId ?? ''}->${item.con?.trgCellId ?? ''}`),
    ipeWrites: ipeSteps('ONEM2M_OBSERVATION_WRITTEN').length,
    deviceWatch: ipeSteps('DEVICE_WATCH_REVIEW').map((item) => ({ devicePath: item.devicePath, rsc: item.rsc })),
  },
  notificationToListener: { method: `subscription by ${ids.guardian} (dashboard guardian reader) through the relay; nu http://${listenerHost}:${listenerPort}`, received: received.location.length + received.rnis.length > 0 ? 'yes' : 'no', location: received.location.length, rnis: received.rnis.length, fromOrigin: [...new Set([...received.location, ...received.rnis].map((item) => item.origin))], verificationRequests: received.verifications.length },
  subscriptions: subscriptions.map(({ originator, path, rsc }) => ({ originator, path, rsc })),
  mecSubscriptions: { location: requests.location?.mecSubscriptionId ?? null, rnis: requests.rnis?.mecSubscriptionId ?? null, listedAfterCreate: mecSide.afterCreate ? { location: mecSide.afterCreate.location.includes(String(requests.location?.mecSubscriptionId)), rnis: mecSide.afterCreate.rnis.includes(String(requests.rnis?.mecSubscriptionId)) } : null, listedAfterDelete: mecSide.afterDelete ? { location: mecSide.afterDelete.location.includes(String(requests.location?.mecSubscriptionId)), rnis: mecSide.afterDelete.rnis.includes(String(requests.rnis?.mecSubscriptionId)) } : null },
  renewals: { location: received.status.filter((item) => item.con?.requestId === requests.location?.requestId && item.con?.state === 'RENEWED').length, rnis: received.status.filter((item) => item.con?.requestId === requests.rnis?.requestId && item.con?.state === 'RENEWED').length, leaseSec: 60, renewBeforeSec: 15 },
  teardown,
  restore: { ue, position: trail[0], mobilityAutomation: mobilityWasActive },
  checks, caseCount: checks.length, passed: checks.filter((item) => item.status === 'PASS').length, failed: checks.filter((item) => item.status !== 'PASS').length,
  error: runtimeError ? { code: runtimeError.code ?? null, message: String(runtimeError.message).slice(0, 300) } : null,
  artifacts: { trace: 'docs/verification-evidence/2026-11-20/mec-ipe-server-cse-trace.jsonl', traceSHA256: sha256(await readFile(traceFile)), traceEntries: shortTrace.length, podLogs: useSsh ? `kubectl logs of ${pod?.name ?? instance.name} merged into the trace (actor ipe@${instance.mep})` : 'not collected' },
  runnerSHA256: sha256(await readFile(fileURLToPath(import.meta.url))),
  secrets: 'none: no certificate, key, admin originator or password is in this receipt or the trace',
};
await writeFile(join(evidenceDir, 'mec-ipe-server-cse.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ status: receipt.status, cases: receipt.caseCount, passed: receipt.passed, failed: receipt.failed, observations: receipt.observations, notification: receipt.notificationToListener, renewals: receipt.renewals, teardown, failures: checks.filter((item) => item.status !== 'PASS') }, null, 2));
if (receipt.status !== 'PASS') process.exitCode = 1;
