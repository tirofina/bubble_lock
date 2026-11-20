import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { get } from 'node:http';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { createLiveEventLog } from '../shared/cse-notification.ts';
import type { ContentInstance, CseBinding } from '../shared/cse-notification.ts';
import { ACTION_FLOOR, cardState, reduceGuardianAlerts, reduceGuardianRecords, residentStatusOf } from '../shared/guardian-alert.ts';
import type { AlertCard, FeedContainer } from '../shared/guardian-alert.ts';
import { parseDashboardEvent, validateDashboardEvent } from '../shared/index.ts';
import type { DashboardEvent, GuardianAlertRecord } from '../shared/index.ts';
import { approvalHash, createAlertReplay } from '../server/guardian-alerts.ts';
import { startReplayServer } from '../server/sse.ts';
import { parseLocationSnapshot } from '../shared/location.ts';

const ROOT = '/Mobius/pb-resident-run1/ev-c4';
const WRITERS = { routine: ['Croutine-run1'], triage: ['Ctriage-run1'], incident: ['Cincident-run1'], guardianDecider: ['Cguardian-run1'], resident: ['Cresident-run1'], guardian: ['Cpb-guardian-portal'] };
const bind = (container: FeedContainer): CseBinding => ({ stream: 'alert-feed', containerPath: `${ROOT}/${container}`, deviceId: null, gatewayId: null, expectedCreator: 'Ctriage-run1', feed: { container, residentId: 'resident-r1', writers: WRITERS } });
let ri = 0;
const cin = (con: unknown, cr: string, ct = '20261120T081320'): ContentInstance => { ri += 1; return { ri: `ri${ri}`, rn: `cin${ri}`, ct, cr, con }; };
const policy = { runId: 'triage-run-1', householdId: 'household-r1', recipientId: 'guardian-daughter', deviceId: 'resident-ue', purpose: 'wandering-check', durationMinutes: 5, incidentId: 'incident-alert-c4', grantId: 'grant-1', triageId: 'triage-1', alertId: 'alert-c4' };
const draftHash = approvalHash(policy);
// Content shapes as written by pc-mobius run-anomaly-triage.mjs and mcp-triage-tools.mjs.
const runnerRecords: [FeedContainer, unknown, string][] = [
  ['alerts', { alertId: 'alert-c4', residentId: 'resident-r1', kind: 'WANDERING', score: 0.476, severityHint: 'watch', detectedAt: '2026-11-20T16:13:20.000Z', detectedLocal: '17:13:20', startedLocal: '17:09', segment: { name: 'east branch at the trail fork', kind: 'path' }, features: { dwellSec: 220, reversals: 1, minutesAfterSunset: 11.2, distanceHomeM: 448, components: {} } }, 'Croutine-run1'],
  ['triageLog', { type: 'TRIAGE_DECISION', triageId: 'triage-1', runId: 'triage-run-1', alertId: 'alert-c4', alertKind: 'WANDERING', severity: 'urgent', action: 'emergencyLease', explanation: 'Since 17:09 stopped on her usual route; about 4 min at the main footway going back and forth after sunset (17:02). She is usually home by 17:24.', checked: ['readAlert', 'readRecentHistory'], decidedLocal: '17:13:20' }, 'Ctriage-run1'],
  // The notice can arrive before the incident record (separate containers and subscriptions).
  ['guardianInbox', { type: 'TRIAGE_NOTICE', triageId: 'triage-1', incidentId: 'incident-alert-c4', severity: 'urgent', action: 'emergencyLease', explanation: 'Since 17:09 stopped on her usual route.', alertKind: 'WANDERING', sentLocal: '17:13:20' }, 'Ctriage-run1'],
  ['incidents', { type: 'INCIDENT_OPENED', incidentId: 'incident-alert-c4', cause: 'WANDERING', alertId: 'alert-c4', triageId: 'triage-1', severity: 'urgent', openedLocal: '17:13:20' }, 'Ctriage-run1'],
  ['approvals', { type: 'APPROVAL_REQUEST', approvalRequestId: 'approval-1', runId: 'triage-run-1', draftId: 'lease-draft-1', draftHash, lease: policy, findings: [], explanation: 'x', requestedLocal: '17:13:20', payloadHash: 'f'.repeat(64) }, 'Ctriage-run1'],
];
function feedEvents(records = runnerRecords) {
  const log = createLiveEventLog({ simulation: true, roleScope: ['guardian'] });
  for (const [container, con, cr] of records) log.append(bind(container), cin(con, cr), '2026-11-20T08:13:21.000Z');
  return log;
}

test('maps resident feed contentInstances to guardian.alert events that pass the event schema', () => {
  // Given / When
  const log = feedEvents();
  // Then
  assert.deepEqual(log.events.map((event) => event.type), Array(5).fill('guardian.alert'));
  for (const event of log.events) assert.equal(validateDashboardEvent(event).valid, true);
  const records = log.events.map((event) => (event.type === 'guardian.alert' ? event.receipt.recordType : null));
  assert.deepEqual(records, ['ROUTINE_ALERT', 'TRIAGE_DECISION', 'TRIAGE_NOTICE', 'INCIDENT_OPENED', 'APPROVAL_REQUEST']);
  const alert = log.events[0];
  assert.equal(alert?.type === 'guardian.alert' ? alert.receipt.alert?.segment : null, 'east branch at the trail fork');
  assert.equal(alert?.resourceUri.startsWith(`${ROOT}/alerts/`), true);
  assert.doesNotMatch(JSON.stringify(log.events), /43\.73|7\.41/, 'no coordinates in the guardian feed');
});

test('turns a feed record from the wrong writer or with a broken body into REVIEW', () => {
  // Given
  const log = createLiveEventLog({ simulation: true, roleScope: ['guardian'] });
  // When: the guardian portal AE writes a triage decision, and the triage AE writes an approval without a hash.
  const [forged] = log.append(bind('triageLog'), cin(runnerRecords[1]![1], 'Cpb-guardian-portal'), '2026-11-20T08:13:22.000Z');
  const [broken] = log.append(bind('approvals'), cin({ type: 'APPROVAL_REQUEST', approvalRequestId: 'a', draftId: 'd', lease: policy }, 'Ctriage-run1'), '2026-11-20T08:13:22.000Z');
  // Then
  assert.equal(forged?.type, 'receipt.review');
  assert.match(String(forged?.receipt && 'reason' in forged.receipt ? forged.receipt.reason : ''), /unexpected-creator:Cpb-guardian-portal:TRIAGE_DECISION/);
  assert.equal(broken?.type, 'receipt.review');
  assert.match(String(broken?.receipt && 'reason' in broken.receipt ? broken.receipt.reason : ''), /alert-feed-schema:approvals/);
});

test('folds the feed into one card: new, approved, dismissed and escalated states', () => {
  // Given: the alert, the triage notice and the lease draft (records out of container order)
  const base = feedEvents().events.flatMap((event) => (event.type === 'guardian.alert' ? [event.receipt] : []));
  const at = '2026-11-20T08:14:00.000Z';
  const rec = (recordType: GuardianAlertRecord['recordType'], fields: Partial<GuardianAlertRecord>): GuardianAlertRecord => ({ contractId: 'privacy-bubble.guardian-alert.v1', docRevision: '2.0.0', recordType, recordId: `${recordType}-${at}`, timestamp: at, residentId: 'resident-r1', ...fields } as GuardianAlertRecord);
  // When / Then: new
  const fresh = reduceGuardianRecords(base);
  assert.equal(fresh.cards.length, 1);
  const card = fresh.cards[0]!;
  assert.equal(card.state, 'new');
  assert.equal(card.incidentId, 'incident-alert-c4');
  assert.equal(card.alertId, 'alert-c4');
  assert.equal(card.kind, 'WANDERING');
  assert.equal(card.severity, 'urgent');
  assert.equal(card.draft?.draftHash, draftHash);
  assert.equal(card.notified, true);
  // approved
  const decision = rec('GUARDIAN_DECISION', { decision: { approvalRequestId: 'approval-1', decision: 'APPROVE', draftHash, approvalHash: 'a'.repeat(64) } });
  const lease = rec('LOCATION_LEASE', { incidentId: 'incident-alert-c4', lease: { leaseId: 'location-1', purpose: 'wandering-check', recipientId: 'guardian-daughter', expiresAt: '2026-11-20T08:19:00.000Z' } });
  const approved = reduceGuardianRecords([...base, decision, lease]).cards[0]!;
  assert.equal(approved.state, 'approved');
  assert.equal(approved.lease?.leaseId, 'location-1');
  // dismissed
  const dismissed = reduceGuardianRecords([...base, rec('GUARDIAN_FEEDBACK', { alertId: 'alert-c4', feedback: { kind: 'ALERT_OK', guardianId: 'guardian-daughter', learn: true, mode: 'solo', reason: 'guardian dismissed the alert as OK' } })]).cards[0]!;
  assert.equal(dismissed.state, 'dismissed');
  // escalated: PANIC on the open incident stays the same card
  const escalated = reduceGuardianRecords([...base, decision, rec('INCIDENT_ESCALATED', { incidentId: 'incident-alert-c4', escalation: { cause: 'PANIC', panicLocal: '17:18:00', leadTimeSec: 279 } }), rec('ESCALATION_NOTICE', { incidentId: 'incident-alert-c4', escalation: { cause: 'PANIC' } })]);
  assert.equal(escalated.cards.length, 1, 'escalation, not a new incident');
  assert.equal(escalated.cards[0]?.state, 'escalated');
  assert.equal(escalated.cards[0]?.escalation?.leadTimeSec, 279);
  assert.equal(cardState({ escalation: null, feedback: null, decision: null }), 'new');
  // PANIC without an open incident is a new incident card
  const panic = reduceGuardianRecords([rec('INCIDENT_OPENED', { incidentId: 'incident-panic-1', escalation: { cause: 'PANIC', panicLocal: '17:18:00' } }), rec('PANIC_NOTICE', { incidentId: 'incident-panic-1', escalation: { cause: 'PANIC' } })]);
  assert.equal(panic.cards.length, 1);
  assert.equal(panic.cards[0]?.kind, 'PANIC');
  assert.equal(panic.cards[0]?.state, 'new');
});

test('replay feed carries simulation true fixture-replay events and applies the lease only after the exact draft hash', async () => {
  // Given
  const replay = createAlertReplay({ variant: 'scripted', start: 'alert' });
  assert.equal(replay.guardian.events.every((event) => event.source === 'fixture-replay' && event.simulation === true), true);
  const card = reduceGuardianAlerts(replay.guardian.events).cards.find((item) => item.notified)!;
  assert.equal(card.draft?.draftHash, approvalHash(card.draft?.policy));
  assert.match(card.explanation ?? '', /Since 17:09 stopped on her usual route/);
  // When
  const result = await replay.review(card, { decision: 'APPROVE', reviewedDraftHash: card.draft!.draftHash, requestResource: null });
  // Then
  const after = reduceGuardianAlerts(replay.guardian.events).cards.find((item) => item.key === card.key)!;
  assert.equal(after.state, 'approved');
  assert.equal(after.lease?.approvalHash, result['approvalHash']);
  assert.equal(after.evidence?.approvalHash, result['approvalHash']);
  assert.deepEqual(Object.keys(after.evidence?.toolsByServer ?? {}), ['oneM2M', 'MEC', 'Audit']);
  for (const event of replay.guardian.events) parseDashboardEvent(event);
});

async function call(base: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}
function sse(t: TestContext, url: string) {
  return new Promise<readonly DashboardEvent[]>((resolve, reject) => {
    let text = '';
    const request = get(url, { signal: AbortSignal.timeout(5000) }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        if (!text.includes(': replay-complete\n\n')) return;
        resolve(text.split('\n\n').filter((frame) => frame.startsWith('id: ')).map((frame) => parseDashboardEvent(JSON.parse(frame.split('\n').find((line) => line.startsWith('data: '))!.slice(6)))));
      });
    });
    request.on('error', reject);
    t.after(() => request.destroy());
  });
}

test('guardian portal HTTP flow: draft hash check, lease-gated map, PANIC escalation, It is fine feedback', { timeout: 15000 }, async (t) => {
  // Given
  const service = await startReplayServer({ port: 0, alerts: { source: 'replay', variant: 'scripted', start: 'alert' } });
  t.after(service.close);
  const initial = await call(service.url, '/api/portal/alerts');
  const card = initial.body['view'].cards.find((item: AlertCard) => item.notified);
  assert.equal(card.state, 'new');
  assert.equal((await call(service.url, `/api/portal/alerts/location?incidentId=${card.incidentId}`)).status, 403, 'no location before approval');
  // When: a hash that is not the stored draft hash
  const tampered = await call(service.url, '/api/portal/alerts/decide', { approvalRequestId: card.draft.approvalRequestId, reviewedDraftHash: `${card.draft.draftHash.slice(0, -1)}0`, decision: 'APPROVE' });
  // Then
  assert.equal(tampered.status, 409);
  assert.equal(tampered.body['error'], 'APPROVAL_DRAFT_MISMATCH');
  // When: the exact draft hash
  const approved = await call(service.url, '/api/portal/alerts/decide', { approvalRequestId: card.draft.approvalRequestId, reviewedDraftHash: card.draft.draftHash, decision: 'APPROVE' });
  assert.equal(approved.status, 200);
  assert.match(String(approved.body['approvalHash']), /^[a-f0-9]{64}$/);
  const location = await call(service.url, `/api/portal/alerts/location?incidentId=${card.incidentId}&lang=en`);
  assert.equal(location.status, 200);
  const snapshot = parseLocationSnapshot(location.body);
  assert.ok(snapshot.devices[0]?.position?.accuracyM, 'network accuracy circle');
  assert.ok(snapshot.devices[0]?.ble, 'BLE proximity circle');
  assert.equal((await call(service.url, '/api/portal/alerts/decide', { approvalRequestId: card.draft.approvalRequestId, reviewedDraftHash: card.draft.draftHash, decision: 'APPROVE' })).status, 409, 'one decision per draft');
  // When: PANIC arrives for the open incident
  assert.equal((await call(service.url, '/api/portal/alerts/replay', { step: 'panic' })).status, 200);
  const escalated = (await call(service.url, '/api/portal/alerts')).body['view'].cards.filter((item: AlertCard) => item.notified);
  assert.equal(escalated.length, 1);
  assert.equal(escalated[0].state, 'escalated');
  assert.equal(escalated[0].incidentId, card.incidentId);
  assert.equal((await call(service.url, '/api/portal/alerts/dismiss', { key: card.key })).status, 409, 'PANIC alerts are not dismissed');
  // When: a fresh story and "It's fine"
  await call(service.url, '/api/portal/alerts/replay', { step: 'reset' });
  await call(service.url, '/api/portal/alerts/replay', { step: 'alert' });
  const again = (await call(service.url, '/api/portal/alerts')).body['view'].cards.find((item: AlertCard) => item.notified);
  const dismissed = await call(service.url, '/api/portal/alerts/dismiss', { key: again.key });
  assert.equal(dismissed.status, 200);
  assert.deepEqual(dismissed.body['learning'], { learn: true, mode: 'solo', reason: 'guardian dismissed the alert as OK' });
  assert.equal((await call(service.url, '/api/portal/alerts')).body['view'].cards.find((item: AlertCard) => item.notified).state, 'dismissed');
  // Then: both role feeds stream the same contract
  const events = await sse(t, `${service.url}/api/portal/alerts/events`);
  assert.equal(events.every((event) => event.type === 'guardian.alert'), true);
  assert.deepEqual(events.map((event) => event.sequence), events.map((_, index) => index + 1));
  const operator = await sse(t, `${service.url}/api/alerts/events?lastSequence=3`);
  assert.equal(operator[0]?.sequence, 4);
  const relocation = await call(service.url, '/api/relocation');
  assert.equal(relocation.body['source'], 'receipt-replay');
  assert.equal(relocation.body['from'].mep, 'mep1');
  assert.equal(relocation.body['to'].mep, 'mep2');
  assert.equal(relocation.body['steps'].find((step: { key: string; ms: number }) => step.key === 'resubscribe').ms, 497);
});

test('rejects guardian alert requests from a non-local origin in demo mode', { timeout: 5000 }, async (t) => {
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  const response = await fetch(`${service.url}/api/portal/alerts/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(response.status, 403);
});

test('derives At Home, Moving and In Park from coarse zone records without coordinates', () => {
  // Given: MEC IPE observations (pb.mec.location.v1) and an R17 location sample
  const ipe = (zoneId: string | null, accessPointId: string, mep: string) => ({ schema: 'pb.mec.location.v1', service: 'Location', zoneId, accessPointId, servedBy: { mep, appInstanceId: 'x', epoch: 1 } });
  // When / Then
  assert.deepEqual(residentStatusOf(ipe('home-district', 'home-wifi', 'mep1')), { state: 'AT_HOME', place: 'home' });
  assert.deepEqual(residentStatusOf(ipe('home-district', 'moneghetti-4g-macro', 'mep1')), { state: 'MOVING', place: 'home-district' });
  assert.deepEqual(residentStatusOf(ipe(null, 'park-5g-entrance', 'mep2')), { state: 'IN_PARK', place: 'park-district' });
  assert.deepEqual(residentStatusOf({ schema: 'pb.location.sample.v1', segment: 'east branch at the trail fork', zoneId: 'park-district' }), { state: 'IN_PARK', place: 'park-district' });
  const log = createLiveEventLog({ simulation: true, roleScope: ['guardian'] });
  const [event] = log.append(bind('location'), cin({ ...ipe('park-district', 'park-5g-fork', 'mep2'), precise: { payloadRef: 'r' } }, 'Cresident-run1'), '2026-11-20T08:13:21.000Z');
  assert.equal(event?.type === 'guardian.alert' ? event.receipt.status?.state : null, 'IN_PARK');
  assert.doesNotMatch(JSON.stringify(event), /payloadRef|"lat"|"lon"/);
});

test('minimum action table matches the triage contract action floor', async () => {
  const contract = JSON.parse(await readFile(new URL('../../pc-mobius/contracts/mcp-triage-tools.v1.json', import.meta.url), 'utf8')) as { workflow: { actionFloor: Record<string, { minimumAction: string }> } };
  assert.deepEqual(ACTION_FLOOR, Object.fromEntries(Object.entries(contract.workflow.actionFloor).map(([kind, value]) => [kind, value.minimumAction])));
});

test('Claude receipt replay: guardian share request becomes a server draft and needs its exact hash', { timeout: 15000 }, async (t) => {
  // Given: the default replay (Claude run 3: checkIn, no agent draft)
  const service = await startReplayServer({ port: 0 });
  t.after(service.close);
  const view = (await call(service.url, '/api/portal/alerts')).body['view'];
  const card = view.cards.find((item: AlertCard) => item.notified) as AlertCard;
  assert.equal(card.action, 'checkIn');
  assert.equal(card.minimumAction, 'checkIn');
  assert.equal(card.draft, null);
  assert.match(card.explanation ?? '', /^Since 17:09 she has stood at the trail fork/);
  assert.equal(view.status.state, 'IN_PARK');
  // When: "Share location 5 min (Emergency Rescue)"
  const shared = await call(service.url, '/api/portal/alerts/share', { key: card.key, purpose: 'emergency-rescue', durationMinutes: 5 });
  // Then: the server returns its draft, whose hash covers the exact policy
  assert.equal(shared.status, 200);
  const draft = shared.body['draft'];
  assert.equal(draft.purpose, 'emergency-rescue');
  assert.equal(draft.durationMinutes, 5);
  assert.equal(draft.recipientId, 'guardian-daughter');
  assert.equal(draft.draftHash, approvalHash(draft.policy));
  assert.equal((await call(service.url, '/api/portal/alerts/decide', { approvalRequestId: draft.approvalRequestId, reviewedDraftHash: 'b'.repeat(64), decision: 'APPROVE' })).status, 409);
  const approved = await call(service.url, '/api/portal/alerts/decide', { approvalRequestId: draft.approvalRequestId, reviewedDraftHash: draft.draftHash, decision: 'APPROVE' });
  assert.equal(approved.status, 200);
  const after = (await call(service.url, '/api/portal/alerts')).body['view'].cards.find((item: AlertCard) => item.notified) as AlertCard;
  assert.equal(after.state, 'approved');
  assert.equal(after.lease?.purpose, 'emergency-rescue');
  assert.equal(after.decision?.approvalHash, approved.body['approvalHash']);
  const location = parseLocationSnapshot((await call(service.url, `/api/portal/alerts/location?incidentId=${after.incidentId}`)).body);
  assert.deepEqual(location.devices[0]?.position?.coordinates, { lat: 43.733392, lon: 7.415336 }, 'dayofcare trail fork');
});
