/**
 * R03 multi-application scenario on a real Mobius4 CSE (DOC-REV 2.0.0).
 *
 * Real: Mobius4 4.24.5 + PostgreSQL, AEs, ACPs, subscriptions, group fan-out, notifications,
 * la/ RETRIEVE, discovery, the web-dashboard server process, the automation AE process.
 * Emulated (simulation: true): the Raspberry Pi Gateway process and the two keyrings.
 *
 * node pc-mobius/scripts/run-multiapp-real.mjs [--screenshot] [--keep-database]
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { get, createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startMobius, freePort, repositoryRoot as root } from '../multiapp/mobius-launcher.mjs';
import { Onem2mHttp, discoveredPaths, payloadHash, toOneM2mTime } from '../multiapp/onem2m-http.mjs';
import { BINARY_SWITCH_CND, COMMAND_BUNDLE_TYPE, LABELS } from '../multiapp/topology.mjs';

const { reduceTimeline, summarizeCommand } = await import('../../web-dashboard/shared/index.ts');
const args = new Set(process.argv.slice(2));
const evidenceDate = '2026-11-19';
const run = randomBytes(3).toString('hex');
const ids = { gateway: `Cpbgw${run}`, operator: `Cpbop${run}`, guardian: `Cpbgd${run}`, automation: `Cpbau${run}` };
const rns = { gateway: 'pb-gateway-pi-01', operator: 'pb-operator-dashboard', guardian: 'pb-guardian-portal', automation: 'pb-automation' };
const householdId = 'household-demo'; const gatewayId = 'pi-01';
const keyringIds = ['keyring-A', 'keyring-B'];
const checks = []; const steps = []; const children = [];
const check = (id, name, ok, detail = {}) => { checks.push({ id, name, ...detail, status: ok ? 'PASS' : 'REVIEW' }); if (!ok) console.error(`REVIEW ${id} ${name} ${JSON.stringify(detail).slice(0, 400)}`); return ok; };
const step = (name, detail = {}) => { const entry = { name, at: new Date().toISOString(), ms: Date.now(), ...detail }; steps.push(entry); console.log(`- ${name}`); return entry; };
const sha256File = async (path) => createHash('sha256').update(await readFile(join(root, path))).digest('hex');

function spawnChild(label, scriptArgs, { env = {}, cwd = root } = {}) {
  const child = spawn(process.execPath, scriptArgs, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-30000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-30000); });
  const listeners = new Set(); const waiting = new Map(); let next = 1;
  child.on('message', (message) => { if (message?.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } for (const listener of listeners) listener(message); });
  const handle = {
    label, child, output: () => output,
    on: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
    once: (type, timeoutMs = 30000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} ${type} timeout: ${output.slice(-2000)}`)), timeoutMs);
      const off = handle.on((message) => { if (message?.type === type) { clearTimeout(timer); off(); resolve(message); } else if (message?.type === 'fatal') { clearTimeout(timer); off(); reject(new Error(`${label}: ${message.message}`)); } });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${label} exited ${code}: ${output.slice(-2000)}`)); });
    }),
    call: (message, timeoutMs = 15000) => new Promise((resolve, reject) => { const id = next++; const timer = setTimeout(() => reject(new Error(`${label} call timeout`)), timeoutMs); waiting.set(id, (reply) => { clearTimeout(timer); resolve(reply); }); child.send({ ...message, id }); }),
    stop: async () => { if (child.exitCode !== null) return; try { child.send({ type: 'stop' }); } catch { /* already gone */ } await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(8000)]); if (child.exitCode === null) child.kill(); },
  };
  children.push(handle);
  return handle;
}

/** Runner-side SSE observer: parses frames from the dashboard server like the browser hook. */
function openStream(url, headers = {}) {
  const events = []; const waiters = new Set(); let buffer = '';
  const request = get(url, { headers }, (response) => {
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      buffer += chunk; const frames = buffer.split('\n\n'); buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        if (!data) continue;
        events.push({ event: JSON.parse(data.slice(6)), arrivedMs: Date.now() });
        for (const waiter of waiters) waiter();
      }
    });
  });
  request.on('error', () => {});
  return {
    events, close: () => request.destroy(),
    waitFor: (predicate, timeoutMs = 10000) => new Promise((resolve, reject) => {
      const test = () => { const found = events.find(predicate); if (found) { waiters.delete(test); clearTimeout(timer); resolve(found); } };
      const timer = setTimeout(() => { waiters.delete(test); reject(new Error(`SSE wait timeout (${events.length} events)`)); }, timeoutMs);
      waiters.add(test); test();
    }),
  };
}

async function waitUntil(label, probe, timeoutMs = 10000, intervalMs = 100) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) { const value = await probe(); if (value) return value; await delay(intervalMs); }
  throw new Error(`${label} timeout`);
}

let cse; let dashboardUrl; let preview;
const report = { gateway: [], automation: [] };
try {
  cse = await startMobius({ label: 'multiapp', cseId: '/multiapp-cse' });
  step('real Mobius4 started', { cseVersion: cse.version, endpoint: 'loopback' });
  const runDir = join(cse.directory, 'apps'); await mkdir(runDir, { recursive: true });
  const cseConfig = { endpoint: cse.endpoint, cseBase: cse.cseBase, cseId: cse.cseId };
  const apps = { operator: ids.operator, guardian: ids.guardian, automation: ids.automation };
  const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const gatewayConfig = {
    cse: cseConfig, gateway: { aeId: ids.gateway, rn: rns.gateway, gatewayId, householdId, ownershipEpoch: 0 }, apps,
    keyrings: [{ deviceId: 'keyring-A', mac: '02:00:00:00:00:0A', battery: 82, rssi: -61 }, { deviceId: 'keyring-B', mac: '02:00:00:00:00:0B', battery: 64, rssi: -70 }],
    python: existsSync(python) ? { executable: python, script: join(root, 'pc-mobius/multiapp/gateway_model_bridge.py'), pythonPath: join(root, 'keyring/raspberry-pi-gateway/src') } : null,
    bleLatencyMs: [35, 70], simulation: true,
  };
  await writeFile(join(runDir, 'gateway.json'), JSON.stringify(gatewayConfig, null, 2));
  const gateway = spawnChild('gateway-emulator', [join(root, 'pc-mobius/multiapp/gateway-emulator.mjs'), join(runDir, 'gateway.json')]);
  gateway.on((message) => { if (['command-applied', 'command-rejected', 'error', 'warning'].includes(message?.type)) report.gateway.push({ ...message, observedMs: Date.now() }); });
  const gatewayReady = await gateway.once('ready', 60000);
  step('emulated Gateway registered and provisioned keyring resources', { modelImplementation: gatewayReady.modelImplementation, acps: Object.keys(gatewayReady.provisioning.acps) });

  await writeFile(join(runDir, 'automation.json'), JSON.stringify({ cse: cseConfig, automation: { aeId: ids.automation, rn: rns.automation }, apps, gatewayAeId: ids.gateway, householdId }, null, 2));
  const automation = spawnChild('automation-ae', [join(root, 'pc-mobius/multiapp/automation-ae.mjs'), join(runDir, 'automation.json')]);
  automation.on((message) => { if (message?.type === 'incident') report.automation.push({ ...message, observedMs: Date.now() }); });
  const automationReady = await automation.once('ready', 30000);
  step('automation AE registered, incidents container and subscriptions created', automationReady.discovery);

  const dashboardPort = await freePort();
  const liveConfig = {
    cse: cseConfig, simulation: true, gatewayAeId: ids.gateway, automationAeId: ids.automation,
    operator: { aeId: ids.operator, rn: rns.operator }, guardian: { aeId: ids.guardian, rn: rns.guardian, principalId: 'guardian-demo', householdId }, refreshMs: 0,
  };
  await writeFile(join(runDir, 'dashboard-live.json'), JSON.stringify(liveConfig, null, 2));
  const dashboard = spawnChild('web-dashboard-server', [join(root, 'web-dashboard/server/cli.ts')], { cwd: join(root, 'web-dashboard'), env: { DASHBOARD_SOURCE: 'cse-live', CSE_LIVE_CONFIG: join(runDir, 'dashboard-live.json'), DASHBOARD_PORT: String(dashboardPort), PORTAL_DEMO_STATE: join(runDir, 'portal-state.json') } });
  const dashboardReady = await dashboard.once('ready', 60000);
  dashboardUrl = dashboardReady.url;
  step('web-dashboard server registered operator and guardian AEs', { source: dashboardReady.source, subscriptions: dashboardReady.live?.subscriptions, keyrings: dashboardReady.live?.keyrings });
  check('C01', 'dashboard source is onem2m-cse-live with two subscriber AEs', dashboardReady.source === 'onem2m-cse-live' && dashboardReady.live?.apps?.operator === ids.operator && dashboardReady.live?.apps?.guardian === ids.guardian, { live: dashboardReady.live?.apps });
  check('C02', 'operator 5x2 + incidents, guardian 3x2 + incidents subscriptions', dashboardReady.live?.subscriptions === 5 * 2 + 1 + 3 * 2 + 1 && dashboardReady.live?.subscriptionsDenied.length === 0, { subscriptions: dashboardReady.live?.subscriptions, denied: dashboardReady.live?.subscriptionsDenied });

  const emit = async (params) => { const reply = await gateway.call({ type: 'emit', ...params }); if (reply.error) throw new Error(`gateway emit: ${reply.error}`); return reply; };
  const client = (name) => new Onem2mHttp({ endpoint: cse.endpoint, originator: ids[name] });
  const operator = client('operator'); const guardianAe = client('guardian'); const automationAe = client('automation');
  const sse = openStream(`${dashboardUrl}/events`);
  const source = async () => (await fetch(`${dashboardUrl}/api/source`)).json();
  const snapshot = async () => (await (await fetch(`${dashboardUrl}/api/portal/snapshot?role=guardian`)).json()).snapshot;
  const portal = async (path, body) => { const response = await fetch(`${dashboardUrl}/api/portal/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, role: 'guardian', idempotencyKey: randomUUID() }) }); return { status: response.status, body: await response.json() }; };

  // Discovery by label and by SDT containerDefinition (TS-0023).
  const byLabel = discoveredPaths((await operator.expect('GET', cse.cseBase, [2000], { query: { fu: 1, ty: 3, lbl: LABELS.keyring } })).payload);
  const bySdt = discoveredPaths((await operator.expect('GET', cse.cseBase, [2000], { query: { fu: 1, ty: 28, cnd: BINARY_SWITCH_CND } })).payload);
  check('C03', 'keyring discovery by label and binarySwitch cnd', byLabel.length === 2 && bySdt.length === 2, { byLabel, bySdt });

  // 1. Baseline telemetry from both emulated keyrings through the Gateway write path.
  const telemetry = [];
  for (const deviceId of keyringIds) telemetry.push((await emit({ deviceId, kind: 'telemetry' })).result);
  await sse.waitFor(({ event }) => event.type === 'gateway.telemetry' && event.currentRevision === telemetry[1].ri);
  check('C04', 'Gateway observation writes reach the operator SSE stream', telemetry.every((item) => sse.events.some(({ event }) => event.currentRevision === item.ri)), { writes: telemetry.map(({ container, ri, modelCheck }) => ({ container, ri, modelCheck })) });

  // 2. ACP least privilege, measured on the CSE with each AE's own originator.
  const root0 = `${cse.cseBase}/${rns.gateway}/keyring-A`;
  const probes = [
    ['guardian RETRIEVE raw observation', guardianAe, 'GET', `${root0}/observation/la`, undefined, undefined, 4103],
    ['automation RETRIEVE command', automationAe, 'GET', `${root0}/command/la`, undefined, undefined, 4103],
    ['automation SUBSCRIBE observation', automationAe, 'POST', `${root0}/observation`, { 'm2m:sub': { rn: 'probe', nu: [ids.automation], enc: { net: [3] } } }, 23, 4103],
    ['operator UPDATE switch', operator, 'PUT', `${root0}/switch`, { 'cod:binSh': { state: true } }, undefined, 4103],
    ['operator DELETE button container', operator, 'DELETE', `${root0}/button`, undefined, undefined, 4103],
    ['guardian RETRIEVE button la', guardianAe, 'GET', `${root0}/button/la`, undefined, undefined, [2000, 4004]],
    ['operator RETRIEVE observation la', operator, 'GET', `${root0}/observation/la`, undefined, undefined, 2000],
  ];
  const acpChecks = [];
  for (const [name, actor, method, path, body, ty, expected] of probes) {
    const result = await actor.request(method, path, { body, ty });
    const ok = Array.isArray(expected) ? expected.includes(result.rsc) : result.rsc === expected;
    acpChecks.push({ name, originator: actor.originator === ids.operator ? 'operator' : actor.originator === ids.guardian ? 'guardian' : 'automation', method, rsc: result.rsc, expected, status: ok ? 'PASS' : 'REVIEW' });
  }
  check('C05', 'ACP least-privilege probes', acpChecks.every((item) => item.status === 'PASS'), { probes: acpChecks.length });

  // 3. Button press: one Gateway write, three applications notified by the CSE.
  const press = step('keyring-A panic button press (emulated)');
  const pressWrite = (await emit({ deviceId: 'keyring-A', kind: 'button', buttonState: 'panic' })).result;
  const operatorButton = await sse.waitFor(({ event }) => event.currentRevision === pressWrite.ri);
  const automationIncident = await waitUntil('automation incident', () => report.automation.find((item) => item.sourceResource === pressWrite.ri), 10000, 20);
  const guardianButton = await waitUntil('guardian button notification', async () => (await source()).live?.guardian?.received?.find((item) => item.ri === pressWrite.ri), 10000, 50);
  const incidentAtOperator = await sse.waitFor(({ event }) => event.type === 'integration.receipt' && event.receipt.eventId === automationIncident.incidentId);
  const incidentAtGuardian = await waitUntil('guardian incident', async () => { const value = await snapshot(); return value.incidents.find((item) => item.incidentId === automationIncident.incidentId) ? { value, ms: Date.now() } : null; }, 10000, 50);
  const guardianIncidentArrival = (await source()).live.guardian.received.find((item) => item.ri === automationIncident.incidentRi);
  check('C06', 'one button write fans out to operator, guardian and automation AEs', Boolean(operatorButton && guardianButton && automationIncident), { buttonResource: pressWrite.ri });
  check('C07', 'automation incident fans out to operator and guardian without app-to-app calls', Boolean(incidentAtOperator && incidentAtGuardian && guardianIncidentArrival), { incidentId: automationIncident.incidentId, incidentEt: automationIncident.et });

  // 4. Guardian approves in the portal; the guardian AE publishes through a transient group.
  const consent = await portal('consents', { householdId, purpose: '버튼 사건 대응 보호 모드', scopes: ['bubble:command'], ttlSec: 3600 });
  const grant = await portal('grants', { consentId: consent.body.result.consentId, scopes: ['bubble:command'], ttlSec: 900 });
  const requested = await portal('commands/request', { householdId, deviceIds: keyringIds, desiredState: { state: true }, reason: automationIncident.incidentId, ttlSec: 40 });
  const approveStarted = step('guardian approves the command request', { requestId: requested.body.result?.requestId });
  const approved = await portal('commands/approve', { requestId: requested.body.result.requestId, grantId: grant.body.result.grantId });
  const approveEndedMs = Date.now();
  const publication = approved.body.cse;
  check('C08', 'guardian approval published by one group fopt CREATE to both command containers', approved.status < 300 && publication?.memberResults?.length === 2 && publication.memberResults.every((item) => item.rsc === 2001), { httpStatus: approved.status, publication: publication ? { groupPath: publication.groupPath, groupEt: publication.groupEt, memberResults: publication.memberResults } : approved.body });
  const commands = approved.body.result?.commands ?? [];

  // 5. Gateway receives command notifications, dispatches over emulated BLE, writes receipts and switch readback.
  const applied = await waitUntil('gateway applied', () => { const list = report.gateway.filter((item) => item.type === 'command-applied' && commands.some((command) => command.commandId === item.commandId)); return list.length === commands.length ? list : null; }, 15000, 20);
  const verifiedEvents = await Promise.all(commands.map((command) => sse.waitFor(({ event }) => event.type === 'command.ack' && event.receipt.commandId === command.commandId, 10000)));
  const timeline = reduceTimeline(sse.events.map(({ event }) => event));
  const perCommand = commands.map((command) => {
    const view = timeline.commands[command.commandId];
    const gatewayReport = applied.find((item) => item.commandId === command.commandId);
    const ack = verifiedEvents.find(({ event }) => event.receipt.commandId === command.commandId);
    const stage = (value) => (value?.status === 'complete' ? value.at : null);
    return {
      deviceId: command.deviceId, commandId: command.commandId, claimId: command.claimId, grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, deadline: command.deadline,
      payloadHash: payloadHash(command),
      preserved: {
        gatewayClaimId: gatewayReport.claimId === command.claimId, gatewayPayloadHash: gatewayReport.payloadHash === payloadHash(command), gatewayGrantRevision: gatewayReport.grantRevision === command.grantRevision,
        gatewayOwnershipEpoch: gatewayReport.ownershipEpoch === command.ownershipEpoch, gatewayDeadline: gatewayReport.deadline === command.deadline,
        ackPayloadHash: ack.event.receipt.payload.payloadHash === payloadHash(command), ackGrantRevision: ack.event.receipt.payload.grantRevision === command.grantRevision, ackOwnershipEpoch: ack.event.receipt.payload.ownershipEpoch === command.ownershipEpoch,
        dispatchClaimId: sse.events.some(({ event }) => event.type === 'command.dispatched' && event.receipt.commandId === command.commandId && event.receipt.payload.claimId === command.claimId && event.receipt.payload.deadline === command.deadline),
      },
      dashboardStages: view ? { accepted: stage(view.accepted), sent: stage(view.sent), applied: stage(view.applied), verified: stage(view.verified), summary: summarizeCommand(view) } : null,
      gateway: { creator: gatewayReport.creator, modelCheck: gatewayReport.modelCheck, notifiedAt: new Date(gatewayReport.notifiedMs).toISOString(), dispatchedAt: gatewayReport.dispatchedAt, deviceAcceptedAt: gatewayReport.applied.acceptedAt, deviceAppliedAt: gatewayReport.applied.appliedAt, readbackReceivedAt: gatewayReport.receiptReceivedAt, receiptConfirmedAt: new Date(gatewayReport.receiptWrite.confirmedMs).toISOString(), switchConfirmedAt: new Date(gatewayReport.switchConfirmedMs).toISOString(), switchState: gatewayReport.switchState },
      dashboardAckArrivedAt: new Date(ack.arrivedMs).toISOString(),
      durationsMs: {
        approveRequestToGatewayNotified: gatewayReport.notifiedMs - approveStarted.ms,
        gatewayNotifiedToDispatchRecord: Date.parse(gatewayReport.dispatchedAt) - gatewayReport.notifiedMs,
        dispatchToDeviceApplied: Date.parse(gatewayReport.applied.appliedAt) - Date.parse(gatewayReport.dispatchedAt),
        deviceAppliedToReceiptCreateStart: gatewayReport.receiptWrite.startedMs - Date.parse(gatewayReport.applied.appliedAt),
        receiptCreateStartToDashboardAck: ack.arrivedMs - gatewayReport.receiptWrite.startedMs,
        receiptCreateRoundTrip: gatewayReport.receiptWrite.acknowledgedMs - gatewayReport.receiptWrite.startedMs,
        approveRequestToDashboardVerified: ack.arrivedMs - approveStarted.ms,
      },
    };
  });
  const allPreserved = perCommand.every((item) => Object.values(item.preserved).every(Boolean));
  check('C09', 'claim, grantRevision, ownershipEpoch, deadline and payloadHash preserved Gateway to ACK', allPreserved, { perDevice: perCommand.map(({ deviceId, preserved }) => ({ deviceId, preserved })) });
  check('C10', 'dashboard timeline shows accepted, sent, applied and verified for both keyrings', perCommand.every((item) => item.dashboardStages && Object.values(item.dashboardStages).slice(0, 4).every(Boolean) && item.dashboardStages.summary.status === 'verified'), {});
  check('C11', 'switch readback equals desired state on both keyrings', perCommand.every((item) => item.gateway.switchState === true), {});
  const switches = await Promise.all(keyringIds.map(async (deviceId) => (await operator.expect('GET', `${cse.cseBase}/${rns.gateway}/${deviceId}/switch`, [2000])).payload['cod:binSh'].state));
  const confirm = await waitUntil('guardian transient confirmation', async () => { const list = (await source()).live.guardian.received.filter((item) => item.stream === 'switch-confirm'); return list.length >= 2 ? list : null; }, 8000, 50).catch(() => []);
  check('C12', 'guardian transient switch subscriptions (atr=state, nct=2, et=deadline) confirm both keyrings', confirm.length >= 2, { confirmations: confirm.length, operatorReadback: switches });

  const guardianRequest = await waitUntil('guardian request confirmation', async () => (await snapshot()).commandRequests.find((item) => item.requestId === requested.body.result.requestId && item.effectiveStatus === 'CONFIRMED_BY_CSE'), 8000, 50).catch(() => null);
  check('C19', 'guardian portal request shows CONFIRMED_BY_CSE from the guardian AE receipt subscriptions', Boolean(guardianRequest), { requestId: requested.body.result.requestId, centralStatus: guardianRequest?.status ?? null });

  // 6. Forged command from a non-guardian AE: allowed to CREATE by Mobius4's subscription rule, rejected by the Gateway creator check.
  const forged = { version: 1, type: COMMAND_BUNDLE_TYPE, requestId: 'forged', groupId: 'forged', commands: [{ command: { ...commands[1], commandId: `forged-${run}`, desiredState: { state: false } }, payloadHash: '0'.repeat(64) }] };
  const forgedWrite = await operator.request('POST', `${cse.cseBase}/${rns.gateway}/keyring-B/command`, { body: { 'm2m:cin': { rn: `forged-${run}`, con: forged, cr: null } }, ty: 4 });
  const rejected = await waitUntil('forged rejection', () => report.gateway.find((item) => item.type === 'command-rejected' && item.commandId === `forged-${run}`), 8000, 20);
  const reviewEvent = await sse.waitFor(({ event }) => event.type === 'receipt.review' && String(event.receipt.reason ?? '').includes('unexpected-creator'), 8000).catch(() => null);
  const keyringBState = (await operator.expect('GET', `${cse.cseBase}/${rns.gateway}/keyring-B/switch`, [2000])).payload['cod:binSh'].state;
  check('C13', 'forged command by operator AE rejected (UNAUTHORIZED_WRITER), keyring state unchanged', forgedWrite.rsc === 2001 && rejected.ackCode === 'UNAUTHORIZED_WRITER' && keyringBState === true && Boolean(reviewEvent), { forgedCreateRsc: forgedWrite.rsc, ackCode: rejected.ackCode, keyringBState, dashboardReview: reviewEvent?.event.receipt.reason ?? null });

  // 7. Low battery: automation writes a MAINTENANCE incident; guardian sees it.
  const batteryWrite = (await emit({ deviceId: 'keyring-B', kind: 'battery', battery: 12 })).result;
  const maintenance = await waitUntil('maintenance incident', () => report.automation.find((item) => item.sourceResource === batteryWrite.ri), 8000, 20);
  const maintenanceAtGuardian = await waitUntil('guardian maintenance', async () => (await snapshot()).incidents.find((item) => item.incidentId === maintenance.incidentId), 8000, 50);
  check('C14', 'low-battery reading raises a MAINTENANCE incident visible to the guardian', maintenance.kind === 'MAINTENANCE' && Boolean(maintenanceAtGuardian), { incidentId: maintenance.incidentId });

  // 8. Resync: the operator AE poa points at a closed port, one write is missed, reconnect re-reads la/.
  const ingressUrl = (await source()).live.notificationUrl;
  const closedPort = await freePort();
  await operator.expect('PUT', `${cse.cseBase}/${rns.operator}`, [2004], { body: { 'm2m:ae': { poa: [`http://127.0.0.1:${closedPort}/operator`] } } });
  const missedWrite = (await emit({ deviceId: 'keyring-B', kind: 'telemetry' })).result;
  await delay(1500);
  const missedBeforeReconnect = sse.events.some(({ event }) => event.currentRevision === missedWrite.ri);
  await operator.expect('PUT', `${cse.cseBase}/${rns.operator}`, [2004], { body: { 'm2m:ae': { poa: [`${ingressUrl}/operator`] } } });
  const lastSequence = sse.events.at(-1).event.sequence;
  sse.close();
  const reconnectStarted = Date.now();
  const resumed = openStream(`${dashboardUrl}/events`, { 'Last-Event-ID': String(lastSequence) });
  const recovered = await resumed.waitFor(({ event }) => event.currentRevision === missedWrite.ri, 10000).catch(() => null);
  const afterResync = await source();
  check('C15', 'missed notification recovered by la/ RETRIEVE on SSE reconnect', !missedBeforeReconnect && Boolean(recovered) && recovered.event.sequence === lastSequence + 1, { missedBeforeReconnect, recoveredSequence: recovered?.event.sequence ?? null, reconnectToRecoveredMs: recovered ? recovered.arrivedMs - reconnectStarted : null, resyncs: afterResync.live.resyncs.slice(-1) });

  // 9. Ring buffers (mni) and latest retrieval.
  const observationCnt = (await operator.expect('GET', `${cse.cseBase}/${rns.gateway}/keyring-B/observation`, [2000])).payload['m2m:cnt'];
  const commandCnt = (await operator.expect('GET', `${cse.cseBase}/${rns.gateway}/keyring-A/command`, [2000])).payload['m2m:cnt'];
  check('C16', 'telemetry and command containers carry mni / mia limits', observationCnt.mni === 100 && commandCnt.mni === 20 && commandCnt.mia === 900, { observation: { mni: observationCnt.mni, cni: observationCnt.cni }, command: { mni: commandCnt.mni, mia: commandCnt.mia, cni: commandCnt.cni } });

  // 10. Transient resources expire at the command deadline.
  const deadlineMs = Math.min(...commands.map((command) => Date.parse(command.deadline)));
  const groupBefore = await guardianAe.request('GET', publication.groupPath);
  const commandCin = await operator.request('GET', `${cse.cseBase}/${rns.gateway}/keyring-A/command/la`);
  const wait = Math.max(0, deadlineMs - Date.now() + 2500);
  step('waiting for command deadline to check transient expiry', { waitMs: wait });
  await delay(wait);
  const groupAfter = await guardianAe.request('GET', publication.groupPath);
  const commandAfter = await operator.request('GET', `${cse.cseBase}/${rns.gateway}/keyring-A/command/${commandCin.payload?.['m2m:cin']?.rn}`);
  const confirmAfter = await guardianAe.request('GET', publication.confirmations[0].path);
  // Replay of the approved bundle after its deadline: the CSE still accepts the fan-out until its cleanup sweep, the Gateway rejects with EXPIRED.
  const replay = await guardianAe.request('POST', `${publication.groupPath}/fopt`, { body: { 'm2m:cin': { rn: `replay-${run}`, cnf: 'application/json:0', con: commandCin.payload['m2m:cin'].con, cr: null } }, ty: 4 });
  const replayMembers = (replay.payload?.['m2m:agr']?.['m2m:rsp'] ?? []).map((item) => ({ member: item.fr, rsc: item.rsc }));
  const expiredRejections = await waitUntil('expired replay rejections', () => { const list = report.gateway.filter((item) => item.type === 'command-rejected' && item.ackCode === 'EXPIRED'); return list.length >= commands.length ? list : null; }, 8000, 20).catch(() => []);
  const statesAfterReplay = await Promise.all(keyringIds.map(async (deviceId) => (await operator.expect('GET', `${cse.cseBase}/${rns.gateway}/${deviceId}/switch`, [2000])).payload['cod:binSh'].state));
  const transient = {
    commandDeadline: new Date(deadlineMs).toISOString(), group: { path: publication.groupPath, et: groupBefore.payload?.['m2m:grp']?.et ?? null, beforeRsc: groupBefore.rsc, afterDeadlineRetrieveRsc: groupAfter.rsc },
    commandCin: { et: commandCin.payload?.['m2m:cin']?.et ?? null, ri: commandCin.payload?.['m2m:cin']?.ri ?? null, afterDeadlineRetrieveRsc: commandAfter.rsc },
    expiredReplay: { fanoutRsc: replay.rsc, members: replayMembers, gatewayAckCodes: expiredRejections.map((item) => ({ deviceId: item.deviceId, ackCode: item.ackCode })), switchStatesAfter: statesAfterReplay },
    confirmSubscription: { path: publication.confirmations[0].path, et: publication.confirmations[0].et, afterRsc: confirmAfter.rsc },
    incident: { et: automationIncident.et },
  };
  check('C17', 'transient group, command cin and confirm subscription carry et = command deadline', transient.group.et === toOneM2mTime(deadlineMs) && transient.commandCin.et === toOneM2mTime(deadlineMs) && transient.confirmSubscription.et === toOneM2mTime(deadlineMs), { groupEt: transient.group.et, cinEt: transient.commandCin.et, expected: toOneM2mTime(deadlineMs) });
  check('C18', 'expired command replay rejected at the Gateway (EXPIRED) with keyring state unchanged', expiredRejections.length >= commands.length && expiredRejections.every((item) => item.ackCode === 'EXPIRED') && statesAfterReplay.every((state) => state === true), { replayMembers, rejections: expiredRejections.length });
  steps.push({ name: 'post-deadline observation of transient resources', at: new Date().toISOString(), observed: { groupRetrieveRsc: groupAfter.rsc, commandRetrieveRsc: commandAfter.rsc, confirmRetrieveRsc: confirmAfter.rsc, replayFanoutRsc: replay.rsc } });

  // Optional screenshot of the operator command timeline on live data.
  let screenshot = null;
  if (args.has('--screenshot')) {
    try { screenshot = await captureScreenshots(dashboardUrl, resumed); } catch (error) { screenshot = { error: error.message }; }
  }

  const gatewayStats = await gateway.call({ type: 'stats' });
  const automationStats = await automation.call({ type: 'stats' });
  const finalSource = await source();
  const durations = {
    buttonWriteWithReadbackMs: pressWrite.durationMs,
    buttonCreateRoundTrip: pressWrite.acknowledgedMs - pressWrite.startedMs,
    buttonCreateStartToOperatorSse: operatorButton.arrivedMs - pressWrite.startedMs,
    buttonCreateStartToAutomationNotified: automationIncident.notifiedMs - pressWrite.startedMs,
    buttonCreateStartToGuardianNotified: Date.parse(guardianButton.receivedAt) - pressWrite.startedMs,
    automationNotifiedToIncidentWritten: automationIncident.incidentWrittenMs - automationIncident.notifiedMs,
    incidentWrittenToOperatorSse: incidentAtOperator.arrivedMs - automationIncident.incidentWrittenMs,
    incidentWrittenToGuardianNotified: Date.parse(guardianIncidentArrival.receivedAt) - automationIncident.incidentWrittenMs,
    approveHttpRoundTrip: approveEndedMs - approveStarted.ms,
    buttonToGuardianIncidentVisible: incidentAtGuardian.ms - press.ms,
    approveRequestToBothVerifiedAtDashboard: Math.max(...perCommand.map((item) => item.durationsMs.approveRequestToDashboardVerified)),
    automatedPathTotal: (incidentAtGuardian.ms - press.ms) + Math.max(...perCommand.map((item) => item.durationsMs.approveRequestToDashboardVerified)),
  };
  const status = checks.every((item) => item.status === 'PASS') ? 'PASS' : 'REVIEW';
  const evidence = {
    receiptId: 'multiapp-real-cse', contractId: 'privacy-bubble.r03-multiapp.v1', docRevision: '2.0.0', rubricIds: ['R03'], status, generatedAt: new Date().toISOString(),
    simulation: true,
    simulationScope: { keyrings: 'emulated (2, in-process firmware model)', gateway: 'emulated Pi Gateway process (Node) using bubble_gateway.model through the Python bridge', ble: 'emulated GATT write with 35-70 ms latency', cse: 'real', applications: 'real processes' },
    transport: 'actual-mobius4-loopback-http', cseVersion: cse.version, cseRevision: cse.revision, cseId: cse.cseId, postgres: cse.postgres, registrySHA256: cse.registrySHA256,
    hostCount: 1, hostDescription: 'single Windows PC, loopback only', physicalHardware: false,
    processes: { mobius4: 1, gatewayEmulator: 1, automationAe: 1, webDashboardServer: 1, runner: 1 },
    gatewayModel: gatewayReady.modelImplementation,
    applications: [
      { app: 'gateway (emulated)', aeId: ids.gateway, rn: rns.gateway, writes: gatewayStats.writes, subscriptions: keyringIds.length, notifications: gatewayStats.notifications },
      { app: 'operator dashboard', aeId: ids.operator, rn: rns.operator, process: 'web-dashboard/server/cli.ts', subscriptions: 11 },
      { app: 'guardian portal', aeId: ids.guardian, rn: rns.guardian, process: 'web-dashboard/server/cli.ts (separate AE)', subscriptions: 7 },
      { app: 'automation', aeId: ids.automation, rn: rns.automation, process: 'pc-mobius/multiapp/automation-ae.mjs', subscriptions: automationReady.discovery.subscriptions.length, incidents: automationStats.log.filter((item) => item.type === 'incident').length },
    ],
    oneM2MServiceFunctions: {
      subscriptionNotification: 'enc.net=[3], enc.chty=[4], nct=1 per container; nu = subscriber AE-ID resolved through AE poa',
      attributeCriteria: 'guardian transient subscription on cod:binSh with enc.atr=[state], nct=2 (modified attributes)',
      groupFanout: `transient <group> mt=3 et=deadline, one fopt CREATE → ${publication.memberResults.length} command containers`,
      discovery: { byLabel: byLabel.length, bySdtCnd: bySdt.length },
      latestRetrieval: 'la/ RETRIEVE on startup and SSE reconnect; createdAfter (cra) discovery for gaps',
      containerLimits: { observationMni: observationCnt.mni, commandMni: commandCnt.mni, commandMia: commandCnt.mia },
      expiration: 'command cin, command group and confirm subscription et = command deadline; incident cin et = +1 h',
      accessControl: 'per-stream ACPs; creator (cr) attribute checked by every consumer',
    },
    acpChecks,
    checks, steps,
    commands: perCommand,
    timingsMs: durations,
    incidents: { safety: { incidentId: automationIncident.incidentId, kind: 'SAFETY', et: automationIncident.et }, maintenance: { incidentId: maintenance.incidentId, kind: 'MAINTENANCE' } },
    negative: { forgedCommand: { createRsc: forgedWrite.rsc, gatewayAckCode: rejected.ackCode, keyringBState, dashboardReview: reviewEvent?.event.receipt.reason ?? null } },
    resync: { missedResource: missedWrite.ri, missedBeforeReconnect, recoveredSequence: recovered?.event.sequence ?? null, recoveredByResyncTotal: finalSource.live.recoveredByResync, lastResync: finalSource.live.resyncs.at(-1) },
    transient,
    dashboard: { source: finalSource.source, simulation: finalSource.simulation, lastSequence: finalSource.lastSequence, notifications: finalSource.live.notifications, unmatchedNotifications: finalSource.live.unmatchedNotifications, guardian: { incidents: finalSource.live.guardian.incidents, notifications: finalSource.live.guardian.notifications }, eventTypes: Object.fromEntries([...new Set(resumed.events.concat(sse.events).map(({ event }) => event.type))].map((type) => [type, sse.events.concat(resumed.events).filter(({ event }) => event.type === type).length])) },
    automation: { notifications: automationStats.notifications, decisions: automationStats.log.length },
    screenshot,
    limitations: [
      'keyrings and the Pi Gateway are emulated; physical BLE, radio range and power are covered by keyring/evidence receipts',
      'single host loopback HTTP without TLS; the MQTT and HTTPS mTLS bindings are covered by other receipts',
      'oneM2M creationTime has 1 s resolution, so the dashboard accepted stage is truncated to the second',
      'Mobius4 4.24.5 requires CREATE on the parent to create a <subscription>; subscriber AEs hold C+R+DISC and every consumer checks the cr attribute',
      'the guardian approval is issued by the in-process portal demo runtime (central claim, grantRevision, ownershipEpoch); central settlement of the native receipt stays on the existing central API path',
    ],
    sources: Object.fromEntries(await Promise.all(['pc-mobius/scripts/run-multiapp-real.mjs', 'pc-mobius/multiapp/gateway-emulator.mjs', 'pc-mobius/multiapp/automation-ae.mjs', 'pc-mobius/multiapp/topology.mjs', 'pc-mobius/multiapp/onem2m-http.mjs', 'pc-mobius/multiapp/gateway_model_bridge.py', 'web-dashboard/server/cse-live.ts', 'web-dashboard/shared/cse-notification.ts'].map(async (path) => [path, await sha256File(path)]))),
  };
  const output = join(root, 'docs/verification-evidence', evidenceDate, 'multiapp-real-cse.json');
  await mkdir(join(root, 'docs/verification-evidence', evidenceDate), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  resumed.close();
  console.log(JSON.stringify({ status, checks: checks.length, passed: checks.filter((item) => item.status === 'PASS').length, acpProbes: acpChecks.length, timingsMs: durations, receipt: 'docs/verification-evidence/2026-11-19/multiapp-real-cse.json' }, null, 2));
  if (status !== 'PASS') process.exitCode = 1;
} catch (error) {
  console.error(cse ? cse.sanitize(error.stack) : error.stack);
  for (const child of children) console.error(`--- ${child.label}\n${cse ? cse.sanitize(child.output().slice(-3000)) : ''}`);
  process.exitCode = 1;
} finally {
  for (const child of [...children].reverse()) await child.stop();
  await preview?.close?.();
  if (cse) await cse.stop({ dropDatabase: !args.has('--keep-database') });
}

/** Serve web-dashboard/dist with /api and /events proxied, then capture pages through Chrome DevTools Protocol. */
async function captureScreenshots(target, stream) {
  const dist = join(root, 'web-dashboard/dist');
  if (!existsSync(join(dist, 'index.html'))) throw new Error('web-dashboard/dist is missing; run npm --prefix web-dashboard run build first');
  const upstream = new URL(target);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://preview');
    if (url.pathname.startsWith('/api') || url.pathname === '/events') {
      const proxied = get({ hostname: upstream.hostname, port: upstream.port, path: `${url.pathname}${url.search}`, headers: request.headers }, (reply) => { response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response); });
      proxied.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.on('close', () => proxied.destroy());
      return;
    }
    const file = join(dist, url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, ''));
    try { const info = await stat(file); if (!info.isFile()) throw new Error(); response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }); response.end(await readFile(file)); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  preview = { close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }) };
  const previewUrl = `http://127.0.0.1:${server.address().port}`;
  const chromeCandidates = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'];
  const chrome = chromeCandidates.find((path) => existsSync(path));
  if (!chrome) throw new Error('Chrome or Edge not found');
  const port = await freePort();
  const profile = join(root, '.local/multiapp-cse/chrome-profile', run);
  await mkdir(profile, { recursive: true });
  const browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore', windowsHide: true });
  try {
    const version = await waitUntil('chrome devtools', async () => { try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; } }, 15000, 200);
    const pages = [['operator-commands-1440-light', '#/operator/commands', 1440, 1100], ['operator-overview-1440-light', '#/operator/overview', 1440, 1000], ['user-activity-390-light', '#/user/activity', 390, 1600]];
    const outputDir = join(root, 'web-dashboard/evidence/2026-11-19-live-cse');
    await mkdir(outputDir, { recursive: true });
    const captured = [];
    for (const [name, hash, width, height] of pages) {
      const created = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
      const socket = new WebSocket(created.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
      let nextId = 1; const pending = new Map();
      socket.onmessage = (message) => { const data = JSON.parse(message.data); if (data.id && pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); } };
      const send = (method, params = {}) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params })); });
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
      await send('Page.enable');
      await send('Page.navigate', { url: `${previewUrl}/${hash}` });
      await delay(4500);
      const metrics = await send('Page.getLayoutMetrics');
      const fullHeight = Math.min(4000, Math.max(height, Math.ceil(metrics.result?.cssContentSize?.height ?? height)));
      await send('Emulation.setDeviceMetricsOverride', { width, height: fullHeight, deviceScaleFactor: 1, mobile: width < 600 });
      await delay(500);
      const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = join(outputDir, `${name}.png`);
      await writeFile(file, Buffer.from(shot.result.data, 'base64'));
      captured.push({ name, hash, width, height: fullHeight, path: `web-dashboard/evidence/2026-11-19-live-cse/${name}.png`, sha256: createHash('sha256').update(Buffer.from(shot.result.data, 'base64')).digest('hex') });
      socket.close();
    }
    return { browser: version.Browser, sseEventsAtCapture: stream.events.length, captured };
  } finally { browser.kill(); }
}
