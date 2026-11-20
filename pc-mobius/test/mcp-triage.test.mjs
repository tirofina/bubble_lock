import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { PolicyService } from '../integration/src/policy-service.mjs';
import { PortalService } from '../integration/src/portal-service.mjs';
import { LocationPrivacyService } from '../integration/src/location-privacy.mjs';
import { MecCipher } from '../integration/src/mec-state.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';
import { McpTriageWorkflow } from '../integration/src/mcp-orchestrator.mjs';
import { MCP_TRIAGE_CONTRACT } from '../integration/src/mcp-schema.mjs';
import { issueAgentTokens, startAgentMcpServers } from '../integration/src/mcp-agent-tools.mjs';
import { createTriageToolHandlers, explanationFindings, locationRecord, resumeTriageAfterApproval, scriptedTriage, seedTriageAuthority } from '../integration/src/mcp-triage-tools.mjs';
import { DwellThresholdBaseline, RoutineDetector, recentStops, solarTimes, trainRoutineProfile } from '../integration/src/routine-model.mjs';
import { DEV_MAP_BUBBLE, dayofcareDefinition, evaluationCases, routineMapOf, trainingDays } from '../integration/src/routine-scenarios.mjs';

const map = routineMapOf(DEV_MAP_BUBBLE);
const profile = trainRoutineProfile({ map, days: trainingDays(DEV_MAP_BUBBLE) });
const cases = Object.fromEntries(evaluationCases(DEV_MAP_BUBBLE).map((entry) => [entry.caseId, entry]));

/** Replay one case on the 20 s grid; stops at the first alert when untilAlert is set. */
function replay(entry, { untilAlert = false, onSample = null } = {}) {
  const detector = new RoutineDetector({ map, profile }); const base5 = new DwellThresholdBaseline({ map, thresholdSec: 300 }); const base10 = new DwellThresholdBaseline({ map, thresholdSec: 600 });
  const byTime = new Map(entry.samples.map((sample) => [sample.t, sample])); const alerts = []; let b5 = null; let b10 = null; let last = null;
  for (let t = entry.startMs; t <= entry.endMs; t += 20000) {
    for (const state of entry.devices.filter((item) => item.t <= t && item.t > t - 20000 || (t === entry.startMs && item.t <= t))) detector.observeDevice(state);
    const sample = byTime.get(t);
    if (sample) { detector.observe(sample); base5.observe(sample); base10.observe(sample); last = sample; onSample?.(sample); }
    const result = detector.evaluate(t); alerts.push(...result.alerts.map((alert) => ({ ...alert, t })));
    b5 ??= base5.evaluate(t); b10 ??= base10.evaluate(t);
    if (untilAlert && alerts.length) break;
  }
  return { alerts, base5: b5, base10: b10, last, detector };
}

test('routine profile is learned from seven synthetic normal days', () => {
  assert.equal(profile.days, 7); assert.equal(profile.synthetic, true);
  assert.ok(profile.corridor.s13, 'south loop used on two days belongs to the corridor');
  assert.equal(profile.corridor.s15, undefined, 'north branch is outside the corridor');
  assert.ok(profile.dwell.s05.p95 >= 600, 'bench rest is a usual stop');
  assert.ok(profile.return.p50Min > 17 * 60 && profile.return.p50Min < 17 * 60 + 20);
  const sun = solarTimes({ date: '2026-11-20', lat: map.home.lat, lon: map.home.lon, tzOffsetMin: 60 });
  assert.ok(sun.sunsetLocalMin > 16 * 60 + 50 && sun.sunsetLocalMin < 17 * 60 + 10, `sunset ${sun.sunsetLocalMin}`);
});

test('routine model alerts match the labelled cases; a single dwell threshold trades false alarms for late alerts', () => {
  const results = Object.fromEntries(Object.entries(cases).map(([caseId, entry]) => [caseId, replay(entry)]));
  for (const caseId of ['C1-normal-walk', 'C2-longer-loop', 'C3-bench-rest']) assert.deepEqual(results[caseId].alerts.map((alert) => alert.kind), [], caseId);
  const fork = results['C4-fork-dusk'];
  assert.equal(fork.alerts[0].kind, 'WANDERING'); assert.ok(fork.alerts[0].t < cases['C4-fork-dusk'].panicMs, 'alert precedes PANIC');
  assert.ok(fork.alerts[0].features.offCorridorSec > 0 && fork.alerts[0].features.minutesAfterSunset > 0);
  assert.equal(results['C5-tunnel-gap'].alerts[0].kind, 'SIGNAL_GAP');
  assert.equal(results['C6-keyring-home'].alerts[0].kind, 'DEVICE_SEPARATION');
  assert.ok(results['C3-bench-rest'].base5, 'five-minute baseline alerts on the usual bench rest');
  assert.ok(results['C5-tunnel-gap'].base5, 'five-minute baseline counts the signal gap as dwell');
  assert.equal(results['C6-keyring-home'].base5, null, 'dwell baseline has no device context');
  assert.ok(Date.parse(results['C4-fork-dusk'].base10.detectedAt) > cases['C4-fork-dusk'].panicMs, 'ten-minute baseline alerts after PANIC');
  const again = replay(cases['C4-fork-dusk']);
  assert.equal(again.alerts[0].score, fork.alerts[0].score, 'replay of the same samples gives the same score');
});

test('dayofcare trail adapter builds an out-and-back walk definition with six labelled cases', () => {
  const points = Array.from({ length: 30 }, (_, index) => ({ index, lon: 7.417915 - index * 0.0001, lat: 43.736945 - index * 0.00015 }));
  const definition = dayofcareDefinition({ sandboxName: 'dayofcare', scenario: 'day-of-care', residentTrail: { points }, ues: [{ id: 'resident-relay' }], meps: [{ name: 'mep1' }, { name: 'mep2' }], places: { home: { radiusM: 40 } } });
  assert.equal(definition.ue, 'resident-relay'); assert.deepEqual(definition.meps, ['mep1', 'mep2']); assert.equal(definition.cases.length, 6);
  for (const route of Object.values(definition.routes)) for (const node of route) assert.ok(definition.nodes[node], node);
  const trailMap = routineMapOf(definition); const days = trainingDays(definition);
  assert.equal(days.length, 7); assert.ok(days.every((day) => day.synthetic));
  const trailProfile = trainRoutineProfile({ map: trailMap, days });
  assert.ok(trailProfile.dwell.d11.p95 >= 900, 'south bench rest is a usual stop on the trail');
  const story = evaluationCases(definition).find((entry) => entry.caseId === 'C4-fork-dusk');
  assert.ok(story.panicMs > story.deviationStartMs);
  assert.throws(() => dayofcareDefinition({ residentTrail: { points: points.slice(0, 10) } }), /30 points/);
});

function memoryCse() {
  const containers = new Map(); let sequence = 0;
  return { containers,
    async readCon(path) { const index = path.lastIndexOf('/'); return structuredClone(containers.get(path.slice(0, index))?.find((entry) => entry.rn === path.slice(index + 1))?.con ?? null); },
    async latestCon(container) { return structuredClone(containers.get(container)?.at(-1)?.con ?? null); },
    async listChildren(container) { return (containers.get(container) ?? []).map((entry) => ({ rn: entry.rn, path: `${container}/${entry.rn}` })); },
    async createCin(container, con, { rn } = {}) { const name = rn ?? `cin-${(sequence += 1)}`; const list = containers.get(container) ?? []; if (list.some((entry) => entry.rn === name)) throw new Error('duplicate rn'); list.push({ rn: name, con: structuredClone(con) }); containers.set(container, list); return { path: `${container}/${name}`, ri: name, payloadHash: approvalHash(con) }; } };
}
const paths = Object.fromEntries(['alerts', 'location', 'rnis', 'routine', 'keyringState', 'keyringEvents', 'triageLog', 'guardianInbox', 'approvals', 'incidents', 'leases', 'audit'].map((name) => [name, `/Mobius/pb-resident/evening/${name}`]));

async function rpcSession(endpoint, token) {
  let sessionId = null; let id = 0; let version = null;
  const post = async (message) => {
    const response = await fetch(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'MCP-Session-Id': sessionId } : {}), ...(version ? { 'MCP-Protocol-Version': version } : {}) }, body: JSON.stringify(message) });
    if (message.method === 'initialize') sessionId = response.headers.get('mcp-session-id');
    return response.status === 202 ? null : response.json();
  };
  version = (await post({ jsonrpc: '2.0', id: ++id, method: 'initialize', params: { protocolVersion: MCP_TRIAGE_CONTRACT.protocolVersion, capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).result.protocolVersion;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { call: async (name, input) => (await post({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: input } })).result };
}

async function triageRuntime(t, caseId) {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-triage-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await new IntegrationStore(join(directory, 'state.json')).init(); const policyService = new PolicyService({ store });
  const portalService = new PortalService({ store, policyService }); const cipher = new MecCipher({ store: { path: null }, encryptionKey: randomBytes(32).toString('base64') });
  const privacy = new LocationPrivacyService({ store, policyService, portalService, cipher });
  const authority = await seedTriageAuthority({ store, policyService, portalService, householdId: 'household-r1', guardianId: 'guardian-daughter', deviceId: 'resident-ue', keyringId: 'keyring-k1' });
  const cse = memoryCse(); const entry = cases[caseId]; const precise = new Map();
  await cse.createCin(paths.routine, { type: 'ROUTINE_PROFILE', profile }, { rn: 'profile-1' });
  for (const state of entry.devices.slice(0, 2)) await cse.createCin(paths.keyringState, { ...state, t: new Date(state.t).toISOString() });
  const result = replay(entry, { untilAlert: true, onSample: (sample) => { const record = locationRecord({ map, profile, sample, zoneId: 'zone2', accessPointId: 'poa-1' }); precise.set(record.rn, sample); cse.containers.set(paths.location, [...(cse.containers.get(paths.location) ?? []), { rn: record.rn, con: record.con }]); } });
  const alert = result.alerts[0]; const alertId = `alert-${caseId}`;
  await cse.createCin(paths.alerts, { alertId, ...alert }, { rn: alertId });
  const reference = await privacy.seal({ payload: { lat: result.last.lat, lon: result.last.lon, accuracyM: 5 }, deviceId: 'resident-ue', householdId: 'household-r1', observedAt: new Date(result.last.t).toISOString(), sourceType: 'MEC013_QUERY' });
  const workflow = new McpTriageWorkflow({ store, policyService });
  const ue = { lat: result.last.lat + 0.0006, lon: result.last.lon - 0.0002, zoneId: 'zone2', accessPointId: 'poa-2' };
  const mec = { locate: async () => ue, zone: async (zoneId) => ({ zoneId, numberOfAccessPoints: 7, numberOfUnserviceableAccessPoints: 0, numberOfUsers: 3 }), cell: async () => ({ cellId: '2222222' }) };
  const scene = { caseId, map, profile, corridor: new Set(Object.keys(profile.corridor)), nowMs: () => alert.t + 30000, lastFix: () => result.last, ueAddress: 'ue-1', intervalSec: 20,
    stops: (fromMs, toMs) => recentStops(result.detector.samples, map, { fromMs, toMs, params: profile.params }) };
  const task = { householdId: 'household-r1', residentId: 'resident-r1', deviceId: 'resident-ue', keyringId: 'keyring-k1', alertId, alertKind: alert.kind, guardianId: 'guardian-daughter', caseId, paths, alertPath: `${paths.alerts}/${alertId}`, leaseGrants: authority.leaseGrants };
  const run = await workflow.createRun({ guardian: authority.guardian, task, grantId: authority.triageGrant.grantId, agentPrincipalId: 'agent-triage', idempotencyKey: `triage-${alertId}` });
  const handlers = createTriageToolHandlers({ workflow, oneM2M: cse, mec, privacy, scene, guardianPrincipal: authority.guardian });
  const { tokens, byServer } = issueAgentTokens({ runId: run.runId, agentPrincipalId: 'agent-triage', contract: MCP_TRIAGE_CONTRACT });
  const servers = await startAgentMcpServers({ store, workflow, handlers, tokens, contract: MCP_TRIAGE_CONTRACT }); t.after(() => servers.close());
  const sessions = { oneM2M: await rpcSession(servers.endpoints.oneM2M, byServer.oneM2M), MEC: await rpcSession(servers.endpoints.MEC, byServer.MEC), Audit: await rpcSession(servers.endpoints.Audit, byServer.Audit) };
  const outputs = [];
  const raw = async (serverId, name, input) => { const value = await sessions[serverId].call(name, input); outputs.push(JSON.stringify(value)); return value; };
  const call = async (serverId, name, input) => { const value = await raw(serverId, name, input); if (value.isError) throw Object.assign(new Error(value.content[0].text), { reason: value.content[0].text.split(':')[0] }); return value.structuredContent; };
  return { store, workflow, privacy, authority, cse, run, call, raw, outputs, alert, alertId, reference, result, task };
}

test('R17 triage: wandering at dusk becomes an emergency lease that applies only with the guardian approvalHash', async (t) => {
  const f = await triageRuntime(t, 'C4-fork-dusk');
  assert.equal(f.alert.kind, 'WANDERING');
  const outcome = await scriptedTriage({ call: f.call, runId: f.run.runId, alertId: f.alertId, keyringId: 'keyring-k1', deviceId: 'resident-ue', guardianId: 'guardian-daughter' });
  assert.equal(outcome.triage.action, 'emergencyLease'); assert.equal(outcome.triage.guardianNotified, true); assert.equal(outcome.pending, true);
  assert.equal(f.cse.containers.get(paths.guardianInbox).length, 1); assert.equal(f.cse.containers.get(paths.approvals)[0].con.type, 'APPROVAL_REQUEST');
  assert.equal(outcome.alert.minimumAction, 'checkIn', 'a wandering alert always reaches the guardian');
  const history = await f.call('oneM2M', 'readRecentHistory', { minutes: 20 });
  assert.ok(history.stops.some((stop) => stop.reversals >= 1 && stop.minutes >= 1), 'stop episodes carry the back-and-forth at the fork');
  const early = await f.raw('oneM2M', 'applyApprovedLease', { draftId: outcome.draft.draftId, approvalHash: 'a'.repeat(64) });
  assert.match(early.content[0].text, /^APPROVAL_PENDING/);
  const evidenceEarly = await f.raw('Audit', 'appendTriageEvidence', { runId: f.run.runId, summary: 'too early' });
  assert.match(evidenceEarly.content[0].text, /^APPROVAL_PENDING/);
  const decision = await f.workflow.guardianDecide({ guardian: f.authority.guardian, runId: f.run.runId, approvalRequestId: outcome.request.approvalRequestId, reviewedDraftHash: outcome.draft.draftHash });
  const tampered = `${decision.approvalHash.slice(0, -1)}${decision.approvalHash.at(-1) === '0' ? '1' : '0'}`;
  assert.match((await f.raw('oneM2M', 'applyApprovedLease', { draftId: outcome.draft.draftId, approvalHash: tampered })).content[0].text, /^APPROVAL_HASH_MISMATCH/);
  assert.match((await f.raw('oneM2M', 'applyApprovedLease', { draftId: outcome.draft.draftId, approvalHash: outcome.draft.draftHash })).content[0].text, /^APPROVAL_HASH_MISMATCH/);
  const resumed = await resumeTriageAfterApproval({ call: f.call, runId: f.run.runId });
  assert.equal(resumed.applied.status, 'APPLIED'); assert.equal(resumed.evidence.status, 'COMPLETED');
  const lease = f.store.get('locationLeases', resumed.applied.leaseId);
  assert.ok(Date.parse(lease.expiresAt) - Date.parse(lease.createdAt) <= 300000, 'lease lasts at most five minutes');
  const opened = await f.privacy.open(f.reference, { principal: f.authority.guardian, leaseId: lease.leaseId, purpose: lease.purpose, incidentId: lease.incidentId, deviceId: 'resident-ue' });
  assert.equal(opened.payload.lat, f.result.last.lat, 'guardian opens the precise point under the lease');
  assert.throws(() => f.privacy.leaseFor({ principalId: 'agent-triage', scopes: ['bubble:read'] }, 'resident-ue'), /portal:read/);
  const precise = String(f.result.last.lat);
  assert.equal(f.outputs.some((text) => text.includes(precise)), false, 'no tool output carries the precise latitude');
  const run = f.workflow.getRun(f.run.runId);
  assert.equal(run.status, 'COMPLETED');
  assert.deepEqual(run.approvalChecks.map((entry) => `${entry.result}:${entry.reason}`), ['REJECTED:APPROVAL_PENDING', 'REJECTED:APPROVAL_HASH_MISMATCH', 'REJECTED:APPROVAL_HASH_MISMATCH', 'ACCEPTED:APPROVAL_HASH_MATCH']);
  assert.deepEqual(run.readCalls.map((entry) => entry.tool), ['readAlert', 'readRecentHistory', 'readRoutineProfile', 'queryUeLocation', 'readRecentHistory']);
});

test('R17 triage: a signal gap with network progress is observed; routing, budget and explanation reviews hold on the server', async (t) => {
  const f = await triageRuntime(t, 'C5-tunnel-gap');
  assert.equal(f.alert.kind, 'SIGNAL_GAP');
  const early = await f.raw('oneM2M', 'submitTriage', { alertId: f.alertId, severity: 'info', action: 'observe', explanation: 'location updates paused in the underpass', checked: [] });
  assert.match(early.content[0].text, /^ROUTE_ORDER/);
  await f.call('oneM2M', 'readAlert', { alertId: f.alertId });
  const leaky = await f.raw('oneM2M', 'submitTriage', { alertId: f.alertId, severity: 'info', action: 'observe', explanation: 'She is at 43.7442, 7.4293 and still moving along the loop.', checked: ['readAlert'] });
  assert.match(leaky.content[0].text, /^EXPLANATION_PRIVACY/);
  assert.deepEqual(explanationFindings('Since 17:03 off her usual loop, 6 min at the hill fork'), []);
  const mismatch = await f.raw('oneM2M', 'submitTriage', { alertId: f.alertId, severity: 'urgent', action: 'observe', explanation: 'Location updates paused in the underpass; she keeps walking.', checked: ['readAlert'] });
  assert.match(mismatch.content[0].text, /^ACTION_SEVERITY/);
  const cell = await f.call('MEC', 'queryServingCell', { minutes: 15 }); assert.equal(cell.cellId, '2222222');
  const ue = await f.call('MEC', 'queryUeLocation', {}); assert.equal(ue.grid.decimals, 3); assert.ok(ue.movedSinceLastFixM > 30);
  const triage = await f.call('oneM2M', 'submitTriage', { alertId: f.alertId, severity: 'info', action: 'observe', explanation: 'Location updates paused in the underpass; the network still serves her and she moved on along her usual route.', checked: ['readAlert', 'queryServingCell', 'queryUeLocation'] });
  assert.equal(triage.guardianNotified, false); assert.equal(triage.nextStep, 'appendTriageEvidence');
  assert.equal(f.cse.containers.get(paths.guardianInbox), undefined, 'observe writes no guardian notice');
  assert.match((await f.raw('oneM2M', 'draftLocationLease', { recipientId: 'guardian-daughter', purpose: 'wandering-check', durationMinutes: 5, deviceId: 'resident-ue' })).content[0].text, /^ROUTE_ACTION/);
  for (let index = 0; index < 11; index += 1) await f.call('oneM2M', 'readRoutineProfile', {});
  assert.match((await f.raw('oneM2M', 'readRoutineProfile', {})).content[0].text, /^ROUTE_BUDGET/);
  const view = await f.call('Audit', 'readExecution', { runId: f.run.runId });
  assert.equal(view.nextStep, 'appendTriageEvidence'); assert.equal(view.readCalls, 14);
  assert.equal((await f.call('Audit', 'appendTriageEvidence', { runId: f.run.runId, summary: 'gap observed' })).status, 'COMPLETED');
  assert.equal(f.store.list('portalIncidents').length, 0);
});

test('R17 triage: a keyring left at home has a server-side checkIn floor that the agent cannot lower', async (t) => {
  const f = await triageRuntime(t, 'C6-keyring-home');
  assert.equal(f.alert.kind, 'DEVICE_SEPARATION');
  const alert = await f.call('oneM2M', 'readAlert', { alertId: f.alertId });
  assert.equal(alert.minimumAction, 'checkIn'); assert.match(alert.minimumActionReason, /PANIC button/);
  const lowered = await f.raw('oneM2M', 'submitTriage', { alertId: f.alertId, severity: 'watch', action: 'observe', explanation: 'Keyring at home while she walks her usual route; rechecking soon.', checked: ['readAlert'] });
  assert.match(lowered.content[0].text, /^ACTION_FLOOR/);
  const triage = await f.call('oneM2M', 'submitTriage', { alertId: f.alertId, severity: 'watch', action: 'checkIn', explanation: 'Her keyring is at home while she walks her usual route; please call her.', checked: ['readAlert'] });
  assert.equal(triage.guardianNotified, true);
  assert.equal(f.cse.containers.get(paths.guardianInbox)[0].con.alertKind, 'DEVICE_SEPARATION');
});
