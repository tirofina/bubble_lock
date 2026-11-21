import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { get } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import type { TestContext } from 'node:test';
import {
  createLiveEventLog, isoToOneM2mTime, mapContentInstance, normalizeStructuredId, oneM2mTimeToIso, parseNotification,
} from '../shared/cse-notification.ts';
import type { ContentInstance, CseBinding } from '../shared/cse-notification.ts';
import { reduceTimeline, validateDashboardEvent } from '../shared/index.ts';
import type { DashboardEvent } from '../shared/index.ts';
import { commandPayloadHash, createGuardianOverlay, startCseLiveSource } from '../server/cse-live.ts';
import { startReplayServer } from '../server/sse.ts';

const GATEWAY = 'Cgateway01';
const GUARDIAN = 'Cguardian01';
const AUTOMATION = 'Cautomation01';
const ROOT = '/Mobius/pb-gateway-pi-01/keyring-A';
const bind = (stream: CseBinding['stream'], expectedCreator = GATEWAY): CseBinding => ({ stream, containerPath: `${ROOT}/${stream}`, deviceId: 'keyring-A', gatewayId: 'pi-01', expectedCreator });
const command = {
  version: 1 as const, gatewayId: 'pi-01', deviceId: 'keyring-A', commandId: 'portal-0123456789abcdef', claimId: 'claim-7f1c',
  desiredState: { state: true }, issuedAt: '2026-11-19T01:00:00.000Z', deadline: '2026-11-19T01:05:00.000Z', grantRevision: 3, ownershipEpoch: 2,
};
const hash = commandPayloadHash(command);
function observationCin(sequence: number, ri: string, ct = '20261119T010000', extra: Record<string, unknown> = {}, cr = GATEWAY): ContentInstance {
  return { ri, rn: `gw-${ri}`, ct, cr, con: { version: 1, gatewayId: 'pi-01', deviceId: 'keyring-A', bootId: 'emu-1', sequence, observedAt: '2026-11-19T01:00:00.100Z', receivedAt: '2026-11-19T01:00:00.120Z', rssi: -61, battery: 81.6, buttonState: 'released', sensorValues: { batteryAlert: false }, state: false, firmwareRevision: 'emulated-keyring-0.1.0', timestampSource: 'gateway-received', ...extra } };
}
const bundleCin: ContentInstance = {
  ri: 'cmdri1', rn: 'cmd-r1', ct: '20261119T010001', cr: GUARDIAN,
  con: { version: 1, type: 'privacy-bubble.command-bundle', requestId: 'request-1', groupId: 'cmd-r1', commands: [{ command, payloadHash: hash }, { command: { ...command, deviceId: 'keyring-B', commandId: 'portal-other' }, payloadHash: '0'.repeat(64) }] },
};
const dispatchCin: ContentInstance = {
  ri: 'rcpt1', rn: 'gw-d1', ct: '20261119T010001', cr: GATEWAY,
  con: { version: 1, type: 'privacy-bubble.gateway-dispatch', gatewayId: 'pi-01', deviceId: 'keyring-A', commandId: command.commandId, claimId: command.claimId, payloadHash: hash, grantRevision: 3, ownershipEpoch: 2, deadline: command.deadline, dispatchedAt: '2026-11-19T01:00:01.300Z', transport: 'ble-gatt-emulated', simulation: true, command },
};
const nativeReceipt = {
  version: 1, gatewayId: 'pi-01', deviceId: 'keyring-A', commandId: command.commandId, payloadHash: hash, status: 'APPLIED', ackCode: 'APPLIED',
  acceptedAt: '2026-11-19T01:00:01.310Z', appliedAt: '2026-11-19T01:00:01.360Z', receivedAt: '2026-11-19T01:00:01.370Z', readback: { state: true },
  firmwareRevision: 'emulated-keyring-0.1.0', ownershipEpoch: 2, grantRevision: 3, timestampSource: 'gateway-estimated', detail: 'emulated keyring (simulation)', bootId: 'emu-1',
};
const receiptCin: ContentInstance = { ri: 'rcpt2', rn: 'gw-r1', ct: '20261119T010001', cr: GATEWAY, con: nativeReceipt };

test('maps a Gateway observation notification to gateway.telemetry with the CSE resource identity', () => {
  // Given
  const log = createLiveEventLog({ simulation: true });
  // When
  const [event] = log.append(bind('observation'), observationCin(41, 'obs41'), '2026-11-19T01:00:00.200Z');
  // Then
  assert.ok(event);
  assert.equal(event.type, 'gateway.telemetry');
  assert.equal(event.source, 'onem2m-cse-live');
  assert.equal(event.simulation, true);
  assert.equal(event.sequence, 1);
  assert.equal(event.currentRevision, 'obs41');
  assert.equal(event.resourceUri, `${ROOT}/observation/gw-obs41`);
  assert.equal(event.receipt?.status, 'APPLIED');
  if (event.type !== 'gateway.telemetry') throw new Error('type');
  assert.equal(event.receipt.dedupKey, 'keyring-A:observation:41');
  assert.deepEqual(event.receipt.payload && 'batteryPct' in event.receipt.payload ? [event.receipt.payload.batteryPct, event.receipt.payload.rssiDbm] : null, [82, -61]);
  assert.equal(validateDashboardEvent(event).valid, true);
});

test('turns a contentInstance from another writer into REVIEW instead of telemetry', () => {
  // Given / When
  const [draft] = mapContentInstance(bind('button'), observationCin(1, 'fake', undefined, { buttonState: 'panic' }, 'Coperator01'));
  // Then
  assert.equal(draft?.type, 'receipt.review');
  assert.equal(draft?.receipt && 'reason' in draft.receipt ? draft.receipt.reason : null, 'unexpected-creator:Coperator01');
});

test('keeps claim, grant revision, ownership epoch, deadline and payload hash across accepted, dispatched and ACK', () => {
  // Given
  const log = createLiveEventLog({ simulation: true });
  // When
  const accepted = log.append(bind('command', GUARDIAN), bundleCin, '2026-11-19T01:00:01.100Z');
  const dispatched = log.append(bind('receipt'), dispatchCin, '2026-11-19T01:00:01.320Z');
  const ack = log.append(bind('receipt'), receiptCin, '2026-11-19T01:00:01.400Z');
  // Then
  assert.equal(accepted.length, 1, 'only the bundle entry for this container device');
  const [acceptance] = accepted;
  assert.equal(acceptance?.type === 'command.accepted' ? acceptance.acceptance.acceptedAt : null, '2026-11-19T01:00:01.000Z');
  assert.equal(acceptance?.type === 'command.accepted' ? acceptance.acceptance.label : null, 'oneM2M CSE contentInstance creationTime');
  const [sent] = dispatched;
  assert.equal(sent?.type, 'command.dispatched');
  const sentPayload = sent?.type === 'command.dispatched' ? sent.receipt.payload : undefined;
  assert.deepEqual(sentPayload, command);
  const [verified] = ack;
  if (verified?.type !== 'command.ack') throw new Error('ack type');
  const payload = verified.receipt.payload;
  assert.ok(payload && 'ackState' in payload);
  assert.equal(payload.ackState, 'READBACK_VERIFIED');
  assert.equal(payload.payloadHash, hash);
  assert.equal(payload.grantRevision, 3);
  assert.equal(payload.ownershipEpoch, 2);
  assert.equal(payload.gatewayReceipt?.payloadHash, hash);
  const timeline = reduceTimeline(log.events);
  const stages = timeline.commands[command.commandId];
  assert.ok(stages);
  assert.deepEqual([stages.accepted, stages.sent, stages.applied, stages.verified].map((stage) => stage.status === 'complete' ? stage.at : null),
    ['2026-11-19T01:00:01.000Z', '2026-11-19T01:00:01.300Z', '2026-11-19T01:00:01.360Z', '2026-11-19T01:00:01.370Z']);
});

test('maps rejected native receipts to REVIEW and automation incidents to integration records', () => {
  // Given
  const rejected: ContentInstance = { ...receiptCin, ri: 'rej', con: { ...nativeReceipt, status: 'REJECTED', ackCode: 'UNAUTHORIZED_WRITER', acceptedAt: null, appliedAt: null, readback: null, timestampSource: 'unavailable' } };
  const incident: ContentInstance = { ri: 'inc1', rn: 'incident-1', ct: '20261119T010002', cr: AUTOMATION, con: { version: 1, type: 'privacy-bubble.automation-incident', incidentId: 'incident-1', householdId: 'household-demo', deviceId: 'keyring-A', kind: 'SAFETY', severity: 'HIGH', message: '키링 비상 버튼이 눌렸어요.', sourceResource: 'btn1' } };
  const log = createLiveEventLog({ simulation: true });
  // When
  const [review] = log.append(bind('receipt'), rejected, '2026-11-19T01:00:02.000Z');
  const [record] = log.append({ stream: 'incident', containerPath: '/Mobius/pb-automation/incidents', deviceId: null, gatewayId: null, expectedCreator: AUTOMATION }, incident, '2026-11-19T01:00:02.100Z');
  // Then
  assert.equal(review?.type, 'receipt.review');
  assert.match(review?.receipt && 'reason' in review.receipt ? String(review.receipt.reason) : '', /native-receipt:REJECTED:UNAUTHORIZED_WRITER/);
  assert.equal(record?.type, 'integration.receipt');
  assert.equal(record?.type === 'integration.receipt' ? record.receipt.type : null, 'AUTOMATION_INCIDENT_OPENED');
});

test('deduplicates a notification and a later la/ RETRIEVE of the same contentInstance', () => {
  // Given
  const log = createLiveEventLog({ simulation: false });
  const cin = observationCin(7, 'same');
  // When
  const first = log.append(bind('observation'), cin, '2026-11-19T01:00:00.200Z');
  const second = log.append(bind('observation'), cin, '2026-11-19T01:00:05.000Z');
  const next = log.append(bind('observation'), observationCin(8, 'next'), '2026-11-19T01:00:06.000Z');
  // Then
  assert.equal(first.length, 1);
  assert.equal(second.length, 0);
  assert.deepEqual(log.events.map((event) => event.sequence), [1, 2]);
  assert.equal(next[0]?.simulation, false);
});

test('rejects acceptance labels that do not match their source', () => {
  // Given
  const base = { schemaVersion: '1.0.0', type: 'command.accepted', sequence: 1, resourceUri: '/Mobius/x', currentRevision: null, receivedAt: '2026-11-19T01:00:00.000Z', roleScope: ['operator'], receipt: null };
  const live = { ...base, simulation: false, source: 'onem2m-cse-live', acceptance: { commandId: 'c', groupId: 'g', acceptedAt: '2026-11-19T01:00:00.000Z', label: 'oneM2M CSE contentInstance creationTime' } };
  // When / Then
  assert.equal(validateDashboardEvent(live).valid, true);
  assert.equal(validateDashboardEvent({ ...live, source: 'fixture-replay', simulation: true }).valid, false);
  assert.equal(validateDashboardEvent({ ...live, acceptance: { ...live.acceptance, label: 'SIMULATED API acceptance; not a CORE receipt' } }).valid, false);
});

test('parses notification envelopes and oneM2M timestamps', () => {
  // Given / When
  const parsed = parseNotification({ 'm2m:sgn': { sur: 'Mobius/pb-gateway-pi-01/keyring-A/button/sub-operator', nev: { net: 3, rep: { 'm2m:cin': observationCin(1, 'a') } } } });
  // Then
  assert.equal(parsed?.net, 3);
  assert.equal(parsed?.cin?.ri, 'a');
  assert.equal(parseNotification({ 'm2m:sgn': { vrq: true, sur: 'x' } })?.verification, true);
  assert.equal(normalizeStructuredId('/multiapp-cse/Mobius/a/b'), '/Mobius/a/b');
  assert.equal(oneM2mTimeToIso('20261119T010203'), '2026-11-19T01:02:03.000Z');
  assert.equal(isoToOneM2mTime('2026-11-19T01:02:03.456Z'), '20261119T010203');
});

test('merges guardian incidents and notifications only into the guardian snapshot of the same household', () => {
  // Given
  const overlay = createGuardianOverlay({ principalId: 'guardian-demo', householdId: 'household-demo' });
  overlay.ingest({ stream: 'incident', containerPath: '/Mobius/pb-automation/incidents', deviceId: null, gatewayId: null, expectedCreator: AUTOMATION },
    { ri: 'inc1', rn: 'incident-1', ct: '20261119T010002', cr: AUTOMATION, con: { incidentId: 'incident-1', householdId: 'household-demo', deviceId: 'keyring-A', kind: 'SAFETY', message: '키링 비상 버튼이 눌렸어요.' } });
  overlay.ingest(bind('receipt'), receiptCin);
  const request = { requestId: 'request-1', status: 'QUEUED', effectiveStatus: 'QUEUED', commands: [command] };
  const pending = { ...request, requestId: 'request-2', commands: [{ ...command, commandId: 'portal-unconfirmed' }] };
  const snapshot = { principal: { role: 'guardian' }, households: [{ householdId: 'household-demo' }], incidents: [], notifications: [], commandRequests: [request, pending] };
  // When
  const merged = overlay.apply(snapshot) as typeof snapshot;
  const visitor = overlay.apply({ ...snapshot, principal: { role: 'visitor' } }) as typeof snapshot;
  // Then
  assert.equal(merged.incidents.length, 1);
  assert.equal(merged.notifications.length, 2);
  assert.deepEqual(merged.commandRequests.map((item) => [item.status, item.effectiveStatus]), [['QUEUED', 'CONFIRMED_BY_CSE'], ['QUEUED', 'QUEUED']]);
  assert.equal(visitor.incidents.length, 0);
});

/** Minimal in-memory CSE answering only the primitives the live source sends. */
function fakeCse(t: TestContext) {
  const cins = new Map<string, ContentInstance[]>();
  const subscriptions: { path: string; body: unknown; origin: string }[] = [];
  const requests: string[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer);
    const url = new URL(request.url ?? '/', 'http://cse');
    const origin = String(request.headers['x-m2m-origin']);
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const reply = (rsc: number, body: unknown = null) => { response.writeHead(rsc >= 4000 ? 404 : 200, { 'Content-Type': 'application/json', 'X-M2M-RSC': String(rsc), 'X-M2M-RI': String(request.headers['x-m2m-ri']) }); response.end(body === null ? '' : JSON.stringify(body)); };
    const path = url.pathname;
    if (request.method === 'POST' && path === '/Mobius') return reply(2001, { 'm2m:ae': { aei: origin } });
    if (request.method === 'DELETE') return reply(4004);
    if (request.method === 'POST' && String(request.headers['content-type']).includes('ty=23')) { subscriptions.push({ path, body: JSON.parse(Buffer.concat(chunks).toString()), origin }); return reply(2001, { 'm2m:sub': {} }); }
    if (request.method === 'GET' && path === '/Mobius' && url.searchParams.get('lbl') === 'pb-keyring') return reply(2000, { 'm2m:uril': ['Mobius/pb-gateway-pi-01/keyring-A'] });
    if (request.method === 'GET' && path === '/Mobius') return reply(2000, { 'm2m:uril': [] });
    if (request.method === 'GET' && path === ROOT) return reply(2000, { 'm2m:cnt': { rn: 'keyring-A', lbl: ['pb-keyring', 'pb-device-keyring-A', 'pb-gateway-pi-01', 'pb-household-household-demo'] } });
    if (request.method === 'GET' && path.endsWith('/la')) { const list = cins.get(path.slice(0, -3)) ?? []; const last = list.at(-1); return last ? reply(2000, { 'm2m:cin': last }) : reply(4004); }
    if (request.method === 'GET' && url.searchParams.get('fu') === '1') { const list = cins.get(path) ?? []; const after = url.searchParams.get('cra') ?? ''; return reply(2000, { 'm2m:uril': list.filter((cin) => cin.ct > after).map((cin) => `Mobius${path.slice('/Mobius'.length)}/${cin.rn}`) }); }
    if (request.method === 'GET') { const parent = path.slice(0, path.lastIndexOf('/')); const found = (cins.get(parent) ?? []).find((cin) => `${parent}/${cin.rn}` === path); return found ? reply(2000, { 'm2m:cin': found }) : reply(4004); }
    return reply(4000);
  });
  server.listen(0, '127.0.0.1');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return {
    ready: once(server, 'listening'), cins, subscriptions, requests,
    endpoint: () => { const address = server.address(); if (!address || typeof address === 'string') throw new Error('address'); return `http://127.0.0.1:${address.port}`; },
    add(container: string, cin: ContentInstance) { cins.set(container, [...(cins.get(container) ?? []), cin]); },
  };
}

const liveConfig = (endpoint: string) => ({
  cse: { endpoint, cseBase: '/Mobius', cseId: '/test-cse' }, simulation: true, gatewayAeId: GATEWAY, automationAeId: AUTOMATION,
  operator: { aeId: 'Coperator01', rn: 'pb-operator' }, guardian: { aeId: GUARDIAN, rn: 'pb-guardian', principalId: 'guardian-demo', householdId: 'household-demo' },
});

function readSse(t: TestContext, url: string, headers: Record<string, string>, until: (events: DashboardEvent[]) => boolean) {
  return new Promise<DashboardEvent[]>((resolve, reject) => {
    let buffer = ''; const events: DashboardEvent[] = [];
    const request = get(url, { headers, signal: AbortSignal.timeout(8000) }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        const frames = buffer.split('\n\n'); buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const data = frame.split('\n').find((line) => line.startsWith('data: '));
          if (data) { const result = validateDashboardEvent(data.slice(6)); if (!result.valid) { reject(new Error(result.error)); return; } events.push(result.event); }
        }
        if (until(events)) resolve(events);
      });
    });
    request.on('error', (error) => { if (error.name !== 'AbortError') reject(error); });
    t.after(() => request.destroy());
  });
}

test('registers two AEs with their own subscriptions and pushes CSE notifications to SSE clients', { timeout: 15000 }, async (t) => {
  // Given
  const cse = fakeCse(t); await cse.ready;
  const service = await startReplayServer({ port: 0, cseLive: liveConfig(cse.endpoint()) });
  t.after(service.close);
  const live = service.live; assert.ok(live);
  const ingress = String((live.describe() as Record<string, unknown>)['notificationUrl']);
  const streamed = readSse(t, `${service.url}/events`, {}, (events) => events.some((event) => event.type === 'gateway.telemetry'));
  // When
  const notify = (app: string, origin: string) => fetch(`${ingress}/${app}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-M2M-Origin': origin, 'X-M2M-RI': 'n1' },
    body: JSON.stringify({ 'm2m:sgn': { sur: 'Mobius/pb-gateway-pi-01/keyring-A/observation/sub-operator', nev: { net: 3, rep: { 'm2m:cin': observationCin(3, 'live3') } } } }) });
  const spoofed = await notify('operator', '/other-cse');
  const accepted = await notify('operator', '/test-cse');
  const verify = (app: string, cr: string) => fetch(`${ingress}/${app}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-M2M-Origin': '/test-cse', 'X-M2M-RI': `v-${cr}` }, body: JSON.stringify({ 'm2m:sgn': { vrq: true, cr } }) });
  const trustedVerification = await verify('operator', 'Coperator01');
  const foreignVerification = await verify('operator', GUARDIAN);
  const events = await streamed;
  // Then
  assert.equal(spoofed.status, 403);
  assert.equal(accepted.headers.get('X-M2M-RSC'), '2000');
  assert.equal(trustedVerification.headers.get('X-M2M-RSC'), '2000');
  assert.equal(foreignVerification.headers.get('X-M2M-RSC'), '4101');
  assert.equal(events.at(-1)?.currentRevision, 'live3');
  const operatorSubs = cse.subscriptions.filter((item) => item.origin === 'Coperator01').map((item) => item.path).sort();
  const guardianSubs = cse.subscriptions.filter((item) => item.origin === GUARDIAN).map((item) => item.path).sort();
  assert.deepEqual(operatorSubs, ['battery', 'button', 'command', 'observation', 'receipt'].map((stream) => `${ROOT}/${stream}`));
  assert.deepEqual(guardianSubs, ['battery', 'button', 'receipt'].map((stream) => `${ROOT}/${stream}`));
  const body = cse.subscriptions[0]?.body as { 'm2m:sub': { enc: unknown; nct: number; nu: string[] } };
  assert.deepEqual(body['m2m:sub'].enc, { net: [3], chty: [4] });
  assert.equal(body['m2m:sub'].nct, 1);
  const source = await (await fetch(`${service.url}/api/source`)).json() as { source: string; simulation: boolean };
  assert.equal(source.source, 'onem2m-cse-live');
});

test('re-reads la/ and createdAfter children when a client reconnects after missed notifications', { timeout: 15000 }, async (t) => {
  // Given
  const cse = fakeCse(t); await cse.ready;
  cse.add(`${ROOT}/observation`, observationCin(1, 'first', '20261119T010000'));
  const service = await startReplayServer({ port: 0, cseLive: liveConfig(cse.endpoint()) });
  t.after(service.close);
  const live = service.live; assert.ok(live);
  assert.deepEqual(live.events.map((event) => event.currentRevision), ['first'], 'startup la/ RETRIEVE');
  // Two contentInstances whose notifications never arrived.
  cse.add(`${ROOT}/observation`, observationCin(2, 'missed', '20261119T010005'));
  cse.add(`${ROOT}/observation`, observationCin(3, 'latest', '20261119T010006'));
  // When
  const events = await readSse(t, `${service.url}/events`, { 'Last-Event-ID': '1' }, (items) => items.some((event) => event.currentRevision === 'latest'));
  // Then
  assert.deepEqual(events.map((event) => [event.sequence, event.currentRevision]), [[2, 'missed'], [3, 'latest']]);
  assert.ok(cse.requests.some((line) => line.startsWith(`GET ${ROOT}/observation/la`)));
  assert.ok(cse.requests.some((line) => line.includes('cra=20261119T005959')));
  assert.ok('recoveredByResync' in live.stats);
  assert.deepEqual(live.stats.recoveredByResync, ['first', 'missed', 'latest'].map((ri) => `${ROOT}/observation/gw-${ri}`), 'startup la/ plus reconnect recovery');
});
