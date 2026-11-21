/**
 * Live recording environment for the demo video (DOC-REV 2.0.0): one command starts a real Mobius4 CSE,
 * seeds the AEs and resources, and starts the web-dashboard server against it (DASHBOARD_SOURCE=cse-live).
 *
 *   MOBIUS4_ROOT=<mobius4> node pc-mobius/scripts/run-video-live.mjs [--port=4174] [--start=park|home|walk|alert] [--delegation-sec=600]
 *   then: npm --prefix web-dashboard run dev  (http://127.0.0.1:5173/?lang=en#/user/overview)
 *
 * Real: Mobius4 4.24.5 + PostgreSQL, every AE registration, ACP, container, subscription, notification and
 * contentInstance below, the web-dashboard server with its operator and guardian AEs.
 * Emulated (simulation: true, labelled): Raspberry Pi Gateway and keyrings A and B (multiapp gateway-emulator),
 * the MEC IPE location writer (pb.mec.location.v1 zone records of the dayofcare story), the routine model and the
 * triage runtime, which write the values of the R17 receipt docs/verification-evidence/2026-11-20/anomaly-triage.json
 * (run 3, case C4) instead of calling an LLM. The guardian share approval, its draftHash and approvalHash checks and the
 * lease are computed live by this runtime with the PC-MOBIUS approvalHash digest.
 *
 * Story steps (also from the dashboard: POST /api/portal/alerts/replay {"step": ...}):
 *   reset, home, walk, park, alert, panic, telemetry
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startMobius, repositoryRoot as root } from '../multiapp/mobius-launcher.mjs';
import { Onem2mHttp, normalizeSid, payloadHash, startNotificationServer, toOneM2mTime } from '../multiapp/onem2m-http.mjs';
import { startAutomation } from '../multiapp/automation-ae.mjs';
import { encodeBinarySwitch } from '../src/sdt-adapter.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...value] = arg.replace(/^--/, '').split('='); return [key, value.join('=') || true]; }));
const dashboardPort = Number(args.port ?? process.env.DASHBOARD_PORT ?? 4174);
const startStep = String(args.start ?? 'park');
const run = randomBytes(3).toString('hex');
const story = JSON.parse(await readFile(join(root, 'web-dashboard/fixtures/guardian-alert-story.json'), 'utf8'));
const places = JSON.parse(await readFile(join(root, 'web-dashboard/fixtures/dayofcare-places.json'), 'utf8')).places;
const variant = story.variants.claude;
const RESIDENT = story.residentId; const GUARDIAN = story.guardianId; const DEVICE = story.deviceId;
const householdId = 'household-demo'; const gatewayId = 'pi-01';
const ids = {
  gateway: `Cpbgw${run}`, operator: `Cpbop${run}`, guardian: `Cpbgd${run}`, automation: `Cpbau${run}`, visitor: `Cpbvs${run}`,
  resident: `Cpbrs${run}`, ipe: `Cpbipe${run}`, routine: `Cpbrt${run}`, triage: `Cpbtr${run}`,
};
const rns = { gateway: 'pb-gateway-pi-01', operator: 'pb-operator-dashboard', guardian: 'pb-guardian-portal', automation: 'pb-automation', visitor: 'pb-caregiver-app', resident: 'pb-resident-r1', ipe: 'pb-mec-ipe', routine: 'pb-routine', triage: 'pb-triage' };
const FEEDS = ['alerts', 'triageLog', 'guardianInbox', 'approvals', 'incidents', 'leases', 'audit', 'location'];
const log = (step, detail = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), step, ...detail }));
const children = [];
let cse = null; let automation = null; let ingress = null; let control = null; let stopping = false;

function spawnChild(label, scriptArgs, { env = {}, cwd = root } = {}) {
  const child = spawn(process.execPath, scriptArgs, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  let output = ''; child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-20000); }); child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-20000); });
  const waiting = new Map(); let next = 1; const listeners = new Set();
  child.on('message', (message) => { if (message?.id && waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); } for (const listener of listeners) listener(message); });
  const handle = {
    label, child, output: () => output,
    once: (type, timeoutMs) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} ${type} timeout: ${output.slice(-1500)}`)), timeoutMs);
      const listener = (message) => { if (message?.type === type) { clearTimeout(timer); listeners.delete(listener); resolve(message); } else if (message?.type === 'fatal') { clearTimeout(timer); reject(new Error(`${label}: ${message.message}`)); } };
      listeners.add(listener); child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`${label} exited ${code}: ${output.slice(-1500)}`)); });
    }),
    call: (message, timeoutMs = 15000) => new Promise((resolve, reject) => { const id = next++; const timer = setTimeout(() => reject(new Error(`${label} call timeout`)), timeoutMs); waiting.set(id, (reply) => { clearTimeout(timer); resolve(reply); }); child.send({ ...message, id }); }),
    stop: async () => { if (child.exitCode !== null) return; try { child.send({ type: 'stop' }); } catch { /* gone */ } await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(8000)]); if (child.exitCode === null) child.kill(); },
  };
  children.push(handle);
  return handle;
}

async function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of [...children].reverse()) await child.stop().catch(() => {});
  await automation?.close().catch(() => {});
  await ingress?.close().catch(() => {});
  control?.close();
  await cse?.stop({ dropDatabase: !args.keep }).catch(() => {});
  process.exit(code);
}
process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

try {
  cse = await startMobius({ label: 'video', cseId: '/video-cse' });
  log('MOBIUS4_STARTED', { version: cse.version, revision: cse.revision, endpoint: cse.endpoint, database: 'run database (dropped on exit)' });
  const runDir = join(cse.directory, 'apps'); await mkdir(runDir, { recursive: true });
  const cseConfig = { endpoint: cse.endpoint, cseBase: cse.cseBase, cseId: cse.cseId };
  const apps = { operator: ids.operator, guardian: ids.guardian, automation: ids.automation };

  // Emulated Raspberry Pi Gateway and keyrings (same process and model bridge as the R03 multiapp run).
  const python = join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await writeFile(join(runDir, 'gateway.json'), JSON.stringify({
    cse: cseConfig, gateway: { aeId: ids.gateway, rn: rns.gateway, gatewayId, householdId, ownershipEpoch: 0 }, apps,
    keyrings: [{ deviceId: 'keyring-A', mac: '02:00:00:00:00:0A', battery: 82, rssi: -61 }, { deviceId: 'keyring-B', mac: '02:00:00:00:00:0B', battery: 64, rssi: -70 }],
    python: existsSync(python) ? { executable: python, script: join(root, 'pc-mobius/multiapp/gateway_model_bridge.py'), pythonPath: join(root, 'keyring/raspberry-pi-gateway/src') } : null,
    bleLatencyMs: [35, 70], simulation: true,
  }, null, 2));
  const gateway = spawnChild('gateway-emulator', [join(root, 'pc-mobius/multiapp/gateway-emulator.mjs'), join(runDir, 'gateway.json')]);
  const gatewayReady = await gateway.once('ready', 60000);
  log('GATEWAY_EMULATOR_READY', { keyrings: Object.keys(gatewayReady.provisioning.resources), model: gatewayReady.modelImplementation, simulation: true });

  // Automation AE in-process: keyring button notifications -> incidents (R03); PANIC also escalates the resident incident.
  const panicWaiters = new Map();
  automation = await startAutomation({ cse: cseConfig, automation: { aeId: ids.automation, rn: rns.automation }, apps, gatewayAeId: ids.gateway, householdId }, { report: (entry) => { panicWaiters.get(entry.sourceResource)?.(entry); } });
  log('AUTOMATION_AE_READY', automation.discovery);

  // Resident AE, its ACP and the R17 feed containers (alerts, triageLog, guardianInbox, approvals, incidents, leases, audit, location).
  const client = (name) => new Onem2mHttp({ endpoint: cse.endpoint, originator: ids[name] });
  const resident = client('resident'); const ipe = client('ipe'); const routine = client('routine'); const triage = client('triage'); const incidentWriter = client('automation');
  const decisions = new Map(); const drafts = new Map();
  ingress = await startNotificationServer({ cseId: cse.cseId, creators: { triage: [ids.triage] }, onNotify: async ({ sgn }) => {
    const cin = sgn.nev?.rep?.['m2m:cin']; if (!cin) return;
    if (normalizeSid(sgn.sur, cse.cseBase) !== `${paths.approvals}/sub-triage`) return;
    try { await onApprovalRecord(cin); } catch (error) { log('TRIAGE_RUNTIME_REVIEW', { error: error.message }); }
  } });
  for (const name of ['resident', 'ipe', 'routine', 'triage', 'visitor']) await client(name).registerAe(cse.cseBase, { rn: rns[name], api: `Npb.${name}`, poa: [`${ingress.url}/${name}`], lbl: [`pb-app-${name}`, ...(name === 'visitor' ? ['pb-caregiver'] : [])] });
  const aePath = `${cse.cseBase}/${rns.resident}`;
  const readers = [ids.ipe, ids.routine, ids.triage, ids.automation, ids.guardian, ids.operator];
  const acp = await resident.ensure(aePath, 1, { 'm2m:acp': { rn: 'resident-acp', pv: { acr: [{ acor: [ids.resident], acop: 63 }, { acor: readers, acop: 35 }] }, pvs: { acr: [{ acor: [ids.resident], acop: 63 }] } } });
  const acpi = [acp.payload['m2m:acp'].ri];
  // Each feed container carries acpi; the AE itself keeps the CSE default (Mobius4 answers 5000 to an AE acpi self-update).
  const paths = {};
  for (const name of FEEDS) paths[name] = (await resident.ensure(aePath, 3, { 'm2m:cnt': { rn: name, mni: name === 'location' ? 200 : 100, acpi, lbl: ['pb-guardian-feed', `pb-feed-${name}`, `pb-resident-${RESIDENT}`, `pb-household-${householdId}`] } })).path;
  await triage.request('DELETE', `${paths.approvals}/sub-triage`);
  await triage.expect('POST', paths.approvals, [2001], { ty: 23, body: { 'm2m:sub': { rn: 'sub-triage', nu: [ids.triage], su: ids.triage, enc: { net: [3], chty: [4] }, nct: 1 } } });
  log('RESIDENT_FEED_PROVISIONED', { ae: aePath, containers: FEEDS, acp: 'resident 63; ipe, routine, triage, automation, guardian portal, operator dashboard 35 (C+R+DISC)', visitorAe: `${cse.cseBase}/${rns.visitor}` });

  const write = async (http, container, con, rn) => (await http.expect('POST', paths[container], [2001], { ty: 4, body: { 'm2m:cin': { ...(rn ? { rn } : {}), cnf: 'application/json:0', con, cr: null } } })).payload['m2m:cin'];
  let alertCount = 0; let open = null;

  /** MEC IPE zone record (pb.mec.location.v1, coarse loc only), as written by the relocatable IPE with servedBy. */
  async function zone(key, place) {
    const status = story.status[key]; const point = places[place];
    const con = { schema: 'pb.mec.location.v1', service: 'Location', mecApi: 'MEC013', deviceId: DEVICE, zoneId: status.zoneId, accessPointId: status.accessPointId,
      servedBy: { mep: status.mep, appInstanceId: status.mep === 'mep1' ? '0d0c0a00-0000-4000-8000-0000000001a1' : '0d0c0a00-0000-4000-8000-0000000001a2', epoch: status.mep === 'mep1' ? 1 : 2 },
      localTime: status.localTime, observedAt: new Date().toISOString(), locationSource: 'MEC013-notification', locPrecisionDecimals: 3, simulation: true,
      relay: { gatewayId: story.location.ble.gatewayId, rssiDbm: story.location.ble.rssiDbm, referenceRssiDbm: story.location.ble.referenceRssiDbm, pathLossExponent: story.location.ble.pathLossExponent, simulation: true } };
    const created = await ipe.expect('POST', paths.location, [2001], { ty: 4, body: { 'm2m:cin': { cnf: 'application/json:0', con, cr: null, loc: { typ: 1, crd: JSON.stringify([Math.round(point.lon * 1000) / 1000, Math.round(point.lat * 1000) / 1000]) } } } });
    return created.payload['m2m:cin'].ri;
  }

  /** Triage runtime: guardian share request -> least-privilege draft and hash; guardian review of that exact hash -> decision and lease. */
  async function onApprovalRecord(cin) {
    const con = typeof cin.con === 'string' ? JSON.parse(cin.con) : cin.con;
    if (cin.cr !== ids.guardian) return;
    if (con?.type === 'SHARE_REQUEST' && open && (con.incidentId === open.incidentId || con.alertId === open.alertId)) {
      const policy = { runId: open.runId, householdId: 'household-r1', recipientId: GUARDIAN, deviceId: DEVICE, purpose: con.purpose, durationMinutes: Math.min(5, con.durationMinutes), incidentId: open.incidentId, alertId: open.alertId, requestedBy: con.guardianId, requestId: con.requestId };
      const findings = [...(con.guardianId === GUARDIAN ? [] : [`recipient ${con.guardianId} is not the household guardian`]), ...(['wandering-check', 'emergency-rescue'].includes(con.purpose) ? [] : ['purpose has no consent grant'])];
      const draftHash = payloadHash(policy); const approvalRequestId = `approval-${draftHash.slice(0, 16)}`; const draftId = `lease-draft-${draftHash.slice(0, 16)}`;
      drafts.set(approvalRequestId, { draftId, draftHash, policy, findings });
      const request = { type: 'APPROVAL_REQUEST', approvalRequestId, runId: open.runId, draftId, draftHash, lease: policy, findings, explanation: variant.triage.explanation, requestedLocal: variant.triage.decidedLocal };
      await write(triage, 'approvals', { ...request, payloadHash: payloadHash(request) }, approvalRequestId);
      log('APPROVAL_REQUEST', { approvalRequestId, draftHash, purpose: policy.purpose });
    } else if (con?.type === 'GUARDIAN_REVIEW') {
      const draft = drafts.get(con.approvalRequestId);
      if (!draft || decisions.has(con.approvalRequestId)) return;
      if (con.reviewedDraftHash !== draft.draftHash || payloadHash(draft.policy) !== draft.draftHash) { log('GUARDIAN_REVIEW_REJECTED', { reason: 'APPROVAL_DRAFT_MISMATCH', approvalRequestId: con.approvalRequestId }); return; }
      const decision = con.decision === 'APPROVE' && draft.findings.length === 0 ? 'APPROVE' : 'REJECT';
      const decidedAt = new Date().toISOString(); const nonce = randomBytes(16).toString('hex');
      // Same fields as McpTriageWorkflow.guardianDecide.
      const approvalHash = payloadHash({ runId: draft.policy.runId, approvalRequestId: con.approvalRequestId, draftId: draft.draftId, draftHash: draft.draftHash, guardianId: GUARDIAN, decision, grantId: 'grant-triage-r1', grantRevision: 1, decidedAt, nonce });
      decisions.set(con.approvalRequestId, approvalHash);
      await write(triage, 'approvals', { type: 'GUARDIAN_DECISION', approvalRequestId: con.approvalRequestId, decision, draftHash: draft.draftHash, approvalHash, guardianId: GUARDIAN, decidedLocal: variant.triage.decidedLocal }, `decision-${con.approvalRequestId.slice(9)}`);
      if (decision !== 'APPROVE') return;
      // applyApprovedLease: only with the guardian hash bound to this exact draft hash.
      if (decisions.get(con.approvalRequestId) !== approvalHash) return;
      const lease = { type: 'LOCATION_LEASE', leaseId: `location-${approvalHash.slice(0, 32)}`, runId: draft.policy.runId, recipientId: GUARDIAN, purpose: draft.policy.purpose, deviceIds: [DEVICE], incidentId: draft.policy.incidentId, expiresAt: new Date(Date.now() + draft.policy.durationMinutes * 60000).toISOString(), draftHash: draft.draftHash, approvalRequestId: con.approvalRequestId, approvalHash };
      await write(triage, 'leases', { ...lease, payloadHash: payloadHash(lease) }, `lease-${approvalHash.slice(0, 16)}`);
      log('LEASE_APPLIED', { leaseId: lease.leaseId, approvalHash, expiresAt: lease.expiresAt });
    }
  }

  const steps = {
    async reset() { open = null; await write(triage, 'guardianInbox', { type: 'STORY_RESET', at: new Date().toISOString() }); return { location: await zone('home', 'home') }; },
    async home() { return { location: await zone('home', 'home') }; },
    async walk() { return { location: await zone('walk', 'parkGate') }; },
    async park() { return { location: await zone('park', 'fork') }; },
    async telemetry() { const writes = []; for (const deviceId of ['keyring-A', 'keyring-B']) writes.push((await gateway.call({ type: 'emit', deviceId, kind: 'telemetry' })).result?.ri); return { writes }; },
    async alert() {
      if (open) return { open: open.incidentId };
      alertCount += 1; const suffix = `${run}-${alertCount}`;
      const alertId = `${variant.alert.alertId}-${suffix}`; const incidentId = `incident-${alertId}`; const runId = `${variant.triage.runId}-${suffix}`;
      const { alertId: _alert, segment, dwellSec, reversals, minutesAfterSunset, distanceHomeM, ...alert } = variant.alert;
      await write(routine, 'alerts', { alertId, residentId: RESIDENT, ...alert, segment: { name: segment, kind: 'path' }, features: { dwellSec, reversals, minutesAfterSunset, distanceHomeM }, modelVersion: 'routine-model replay of R17 run 3', sourceReceipt: 'docs/verification-evidence/2026-11-20/anomaly-triage.json#C4-fork-dusk' }, alertId);
      const triageId = `triage-${suffix}`;
      await write(triage, 'triageLog', { type: 'TRIAGE_DECISION', triageId, runId, alertId, alertKind: variant.alert.kind, severity: variant.triage.severity, action: variant.triage.action, explanation: variant.triage.explanation, checked: variant.triage.checked, decidedLocal: variant.triage.decidedLocal, agent: variant.agent, sourceReceipt: 'anomaly-triage.json run 3 C4 (LLM output replayed, no LLM call in this run)' }, triageId);
      await write(triage, 'incidents', { type: 'INCIDENT_OPENED', incidentId, cause: variant.alert.kind, alertId, triageId, severity: variant.triage.severity, openedLocal: variant.noticeLocal }, `open-${suffix}`);
      await write(triage, 'guardianInbox', { type: 'TRIAGE_NOTICE', triageId, incidentId, alertId, severity: variant.triage.severity, action: variant.triage.action, explanation: variant.triage.explanation, alertKind: variant.alert.kind, sentLocal: variant.noticeLocal }, `notice-${suffix}`);
      const readCalls = Object.entries(variant.toolsByServer).flatMap(([serverId, tools]) => tools.filter((tool) => !['submitTriage', 'appendTriageEvidence'].includes(tool)).map((tool) => ({ serverId, tool })));
      const evidence = { runId, alertId, incidentId, readCalls, steps: [{ step: 'readAlert' }, { step: 'submitTriage' }, { step: 'appendTriageEvidence' }], lease: null, sourceReceipt: 'docs/verification-evidence/2026-11-20/anomaly-triage.json', receiptEvidenceHash: variant.evidenceHash };
      await write(triage, 'audit', { type: 'TRIAGE_EVIDENCE', evidenceId: `evidence-${suffix}`, evidenceHash: payloadHash(evidence), evidence, agent: variant.agent }, `evidence-${suffix}`);
      open = { alertId, incidentId, runId, noticeMs: Date.now() };
      return { alertId, incidentId };
    },
    async panic() {
      // Real chain: emulated keyring PANIC -> Gateway write -> CSE notification -> automation AE incident -> escalation of the open resident incident.
      const press = (await gateway.call({ type: 'emit', deviceId: 'keyring-A', kind: 'button', buttonState: 'panic' })).result;
      const automationIncident = automation.log.find((entry) => entry.sourceResource === press.ri) ?? await new Promise((resolve) => { panicWaiters.set(press.ri, resolve); setTimeout(() => resolve(automation.log.find((entry) => entry.sourceResource === press.ri) ?? null), 8000).unref(); });
      if (!open) return { button: press.ri, automationIncident: automationIncident?.incidentId ?? null, escalated: null };
      await write(incidentWriter, 'incidents', { type: 'INCIDENT_ESCALATED', incidentId: open.incidentId, cause: 'PANIC', panicLocal: variant.panic.panicLocal, leadTimeSec: variant.panic.leadTimeSec, measuredWallSec: Math.round((Date.now() - open.noticeMs) / 1000), buttonResource: press.ri, automationIncident: automationIncident?.incidentId ?? null });
      await write(incidentWriter, 'guardianInbox', { type: 'ESCALATION', incidentId: open.incidentId, cause: 'PANIC', sentLocal: variant.panic.panicLocal });
      const escalated = open.incidentId; open = { ...open, escalated: true };
      return { button: press.ri, automationIncident: automationIncident?.incidentId ?? null, escalated };
    },
  };

  control = createServer(async (request, response) => {
    const send = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      if (request.method === 'GET') { send(200, { run, cse: { version: cse.version, cseId: cse.cseId }, open, steps: Object.keys(steps) }); return; }
      if (new URL(request.url ?? '/', 'http://control').pathname === '/shutdown') { send(200, { stopping: true }); setTimeout(() => void shutdown(0), 100); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const { step } = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!steps[step]) { send(400, { message: `step: ${Object.keys(steps).join(', ')}` }); return; }
      const result = await steps[step](); log('STORY_STEP', { step, ...result }); send(200, { step, ...result });
    } catch (error) { send(500, { message: error.message }); }
  });
  await new Promise((resolve) => control.listen(0, '127.0.0.1', resolve));
  const controlUrl = `http://127.0.0.1:${control.address().port}/step`;

  // Caregiver living room group (R04/R06/R07): central AE, light and fan member AEs with binarySwitch flexContainers,
  // member ACPs, macp and ACK containers on the same Mobius4, as in pc-mobius/scripts/run-group-command-real.mjs.
  const admin = new Onem2mHttp({ endpoint: cse.endpoint, originator: cse.admin });
  const adminAe = async (rn, api) => { const originator = `C${rn.replace(/[^A-Za-z0-9]/g, '')}${run}`; const made = await new Onem2mHttp({ endpoint: cse.endpoint, originator }).registerAe(cse.cseBase, { rn, api, poa: [], lbl: ['pb-simulation'] }); return { path: made.path, aei: made.aei ?? originator }; };
  const adminAcp = async (parent, rn, rules) => (await admin.ensure(parent, 1, { 'm2m:acp': { rn, pv: { acr: [{ acor: [cse.admin], acop: 63 }, ...rules] }, pvs: { acr: [{ acor: [cse.admin], acop: 63 }] } } })).payload['m2m:acp'].ri;
  const central = await adminAe('pb-central-living-room', 'N.privacy.bubble.central');
  const centralAcp = await adminAcp(central.path, 'central-acp', [{ acor: [central.aei], acop: 63 }]);
  await admin.request('PUT', central.path, { body: { 'm2m:ae': { acpi: [centralAcp] } } });
  const macp = await adminAcp(central.path, 'household-macp', [{ acor: [central.aei], acop: 6 }]);
  const groupAudit = (await admin.ensure(central.path, 3, { 'm2m:cnt': { rn: 'groupCommands', mni: 10, acpi: [centralAcp] } })).path;
  const memberResources = {}; const ackContainers = {};
  for (const [deviceId, rn] of [['living-room-light', 'lr-light'], ['living-room-fan', 'lr-fan']]) {
    const device = await adminAe(rn, 'N.privacy.bubble.emulated-appliance');
    const deviceAcp = await adminAcp(device.path, 'device-acp', [{ acor: [central.aei], acop: 34 }]);
    await admin.request('PUT', device.path, { body: { 'm2m:ae': { acpi: [deviceAcp] } } });
    const switchAcp = await adminAcp(device.path, 'switch-acp', [{ acor: [central.aei], acop: 39 }]);
    const ackAcp = await adminAcp(device.path, 'ack-acp', [{ acor: [central.aei], acop: 3 }]);
    memberResources[deviceId] = (await admin.ensure(device.path, 28, encodeBinarySwitch({ rn: 'binarySwitch', state: false, acpi: [switchAcp], lbl: [`pb-device:${deviceId}`, 'pb-simulation'] }, { operation: 'CREATE' }))).path;
    ackContainers[deviceId] = (await admin.ensure(device.path, 3, { 'm2m:cnt': { rn: 'commandAcks', mni: 1, acpi: [ackAcp] } })).path;
  }
  const coreConfig = { livingRoom: { delegationSec: Number(args['delegation-sec'] ?? 600), storyExpiryLocal: '16:00', cse: { cseId: cse.cseId, version: cse.version },
    groupCommand: { cse: { endpoint: cse.endpoint, cseBase: cse.cseBase, originator: central.aei, timeoutMs: 8000 }, groupParent: central.path, memberResources, ackContainers, auditContainer: groupAudit, macp: [macp], acpi: [centralAcp] } } };
  await writeFile(join(runDir, 'portal-core.json'), JSON.stringify(coreConfig, null, 2));
  log('LIVING_ROOM_GROUP_PROVISIONED', { central: central.path, members: memberResources, macp: 'central acop 6 (RETRIEVE, UPDATE)', simulation: 'devices emulated' });

  // web-dashboard server against the same CSE (operator and guardian AEs, keyring and resident feed subscriptions).
  const liveConfig = {
    cse: cseConfig, simulation: true, gatewayAeId: ids.gateway, automationAeId: ids.automation, refreshMs: 3000,
    operator: { aeId: ids.operator, rn: rns.operator }, guardian: { aeId: ids.guardian, rn: rns.guardian, principalId: GUARDIAN, householdId },
    residents: { label: 'pb-guardian-feed', residentId: RESIDENT, writers: { routine: [ids.routine], triage: [ids.triage], incident: [ids.automation], guardianDecider: [ids.triage], resident: [ids.ipe] } },
  };
  await writeFile(join(runDir, 'dashboard-live.json'), JSON.stringify(liveConfig, null, 2));
  const dashboard = spawnChild('web-dashboard-server', [join(root, 'web-dashboard/server/cli.ts')], { cwd: join(root, 'web-dashboard'), env: {
    DASHBOARD_SOURCE: 'cse-live', CSE_LIVE_CONFIG: join(runDir, 'dashboard-live.json'), DASHBOARD_PORT: String(dashboardPort), PORTAL_DEMO_STATE: join(runDir, 'portal-state.json'),
    ALERT_SOURCE: 'cse-live', ALERT_STORY_CONTROL_URL: controlUrl, PORTAL_CORE_CONFIG: join(runDir, 'portal-core.json'),
  } });
  const ready = await dashboard.once('ready', 60000);
  log('DASHBOARD_READY', { url: ready.url, source: ready.source, subscriptions: ready.live?.subscriptions, keyrings: ready.live?.keyrings, denied: ready.live?.subscriptionsDenied });

  await steps.reset(); await steps.telemetry();
  const order = ['home', 'walk', 'park', 'alert'];
  for (const step of order.slice(1, order.indexOf(startStep) + 1)) { await steps[step](); await delay(300); }
  log('READY', {
    cse: `Mobius4 ${cse.version} (${cse.cseId}) at ${cse.endpoint}`, dashboardApi: ready.url, storyControl: controlUrl, start: startStep,
    open: { family: 'http://127.0.0.1:5173/?lang=en#/user/overview (npm --prefix web-dashboard run dev)', operator: 'http://127.0.0.1:5173/?lang=en#/operator/services' },
    steps: `curl -X POST -H "Content-Type: application/json" -d '{"step":"alert"}' ${ready.url}/api/portal/alerts/replay   (reset, home, walk, park, alert, panic, telemetry)`,
  });
  console.log(`Ctrl+C (or POST ${controlUrl.replace(/step$/, 'shutdown')}) stops the dashboard, the emulators and Mobius4 and drops the run database.`);
} catch (error) {
  console.error(cse?.sanitize ? cse.sanitize(error.stack ?? error) : error);
  for (const child of children) console.error(`--- ${child.label}\n${child.output().slice(-3000)}`);
  await shutdown(1);
}
