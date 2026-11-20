import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import story from '../fixtures/guardian-alert-story.json' with { type: 'json' };
import places from '../fixtures/dayofcare-places.json' with { type: 'json' };
import { ContractError, parseDashboardEvent } from '../shared/validation.ts';
import { activeLease, compactRecord, GUARDIAN_ALERT_CONTRACT, reduceGuardianAlerts } from '../shared/guardian-alert.ts';
import type { AlertCard, Loose } from '../shared/guardian-alert.ts';
import type { DashboardEvent, GuardianAlertRecord, GuardianRecordType, SourceMode } from '../shared/types.ts';
import type { LocationSnapshot } from '../shared/location.ts';

/**
 * Guardian alert card service (R17 on the family portal): one SSE feed per role with the `guardian.alert` event type,
 * guardian review of the exact lease draft hash, "It's fine" feedback for the place-memory learning gate, the lease-gated
 * location, and the operator's MEC IPE relocation summary from the R13 receipt.
 */
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable((value as Record<string, unknown>)[key])]));
  return value;
}
/** Same digest as PC-MOBIUS approvalHash (sha256 over key-sorted JSON). */
export function approvalHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

export interface AlertFeed {
  readonly source: SourceMode;
  readonly simulation: boolean;
  readonly events: readonly DashboardEvent[];
  readonly lastSequence: number;
  subscribe(listener: (event: DashboardEvent) => void): () => void;
}
export interface LearningOutcome { readonly learn: boolean; readonly mode: string | null; readonly reason: string }
export type ReplayStep = 'reset' | 'home' | 'walk' | 'park' | 'alert' | 'panic';
export const REPLAY_STEPS: readonly ReplayStep[] = ['reset', 'home', 'walk', 'park', 'alert', 'panic'];
export interface ShareInput { readonly requestId: string; readonly purpose: 'wandering-check' | 'emergency-rescue'; readonly durationMinutes: number; readonly container: string | null }
export interface ReviewInput { readonly decision: 'APPROVE' | 'REJECT'; readonly reviewedDraftHash: string; readonly requestResource: string | null }
export interface AlertBackend {
  readonly mode: 'replay' | 'live';
  readonly guardianId: string;
  readonly guardian: AlertFeed;
  readonly operator: AlertFeed;
  review(card: AlertCard, input: ReviewInput): Promise<Record<string, unknown>>;
  feedback(card: AlertCard, learning: LearningOutcome, requestResource: string | null): Promise<Record<string, unknown>>;
  location(card: AlertCard, lang: 'ko' | 'en'): Promise<LocationSnapshot | null>;
  /** Guardian asks for a share; the triage runtime answers with an APPROVAL_REQUEST draft carrying input.requestId. */
  requestShare(card: AlertCard, input: ShareInput): Promise<void>;
  replay?(step: ReplayStep): { appended: number };
  describe(): Record<string, unknown>;
}

/** Event log fed with already-mapped records (replay). The live CSE source uses createLiveEventLog instead. */
export function createRecordLog(options: { source: SourceMode; simulation: boolean; roleScope: readonly string[] }) {
  const events: DashboardEvent[] = [];
  const listeners = new Set<(event: DashboardEvent) => void>();
  let sequence = 0;
  return {
    source: options.source,
    simulation: options.simulation,
    append(value: GuardianAlertRecord, resourceUri: string): DashboardEvent {
      const event = parseDashboardEvent({ schemaVersion: '1.0.0', sequence: sequence + 1, resourceUri, currentRevision: value.recordId, receivedAt: new Date().toISOString(), roleScope: [...options.roleScope], simulation: options.simulation, source: options.source, type: 'guardian.alert', receipt: value, acceptance: null });
      sequence = event.sequence; events.push(event);
      for (const listener of listeners) listener(event);
      return event;
    },
    get events(): readonly DashboardEvent[] { return events; },
    get lastSequence() { return sequence; },
    subscribe(listener: (event: DashboardEvent) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

interface Variant {
  readonly provenance: string; readonly agent: string; readonly incidentId: string; readonly noticeLocal: string; readonly evidenceHash: string | null;
  readonly alert: { readonly alertId: string; readonly kind: string; readonly score: number; readonly severityHint: string; readonly detectedLocal: string; readonly startedLocal: string; readonly segment: string; readonly dwellSec: number; readonly reversals: number; readonly minutesAfterSunset: number; readonly distanceHomeM: number };
  readonly triage: { readonly runId: string; readonly severity: 'info' | 'watch' | 'urgent'; readonly action: 'observe' | 'checkIn' | 'emergencyLease'; readonly explanation: string; readonly checked: readonly string[]; readonly decidedLocal: string };
  readonly draft: { readonly approvalRequestId: string; readonly draftId: string; readonly requestedLocal: string; readonly policy: { readonly purpose: string; readonly durationMinutes: number; readonly recipientId: string; readonly deviceId: string } & Readonly<Record<string, unknown>> } | null;
  readonly toolsByServer: Readonly<Record<string, readonly string[]>>;
  readonly panic: { readonly panicLocal: string; readonly leadTimeSec: number };
}
export function storyVariant(name: string): { name: 'scripted' | 'claude'; variant: Variant } {
  if (name !== 'scripted' && name !== 'claude') throw new TypeError('ALERT_REPLAY_VARIANT 값은 scripted 또는 claude로 지정하세요.');
  return { name, variant: story.variants[name] as Variant };
}

/** Lease-gated location of the resident's keyring as a LocationSnapshot (the existing map draws both circles). */
export function storyLocation(lang: 'ko' | 'en', now = Date.now(), demo = true, placeKey: keyof typeof places.places = 'fork'): LocationSnapshot {
  const at = new Date(now - 2000).toISOString();
  const { position, ble } = story.location;
  const place = places.places[placeKey];
  return {
    schemaVersion: '1.0.0', mode: demo ? 'demo' : 'live', source: demo ? 'demo-fixture' : 'portal-api', simulation: true, updatedAt: new Date(now).toISOString(), rejectedRecords: 0, caughtUp: true,
    devices: [{ deviceId: story.deviceId, label: story.labels.device[lang], position: { coordinates: { lat: place.lat, lon: place.lon }, source: 'mec', observedAt: at, accuracyM: position.accuracyM, simulation: true }, ble: { gatewayId: ble.gatewayId, rssiDbm: ble.rssiDbm, observedAt: at, simulation: true } }],
    gateways: [{ gatewayId: ble.gatewayId, label: story.labels.relay[lang], position: { lat: place.lat, lon: place.lon }, simulation: true, referenceRssiDbm: ble.referenceRssiDbm, pathLossExponent: ble.pathLossExponent }],
  };
}

/** Lease draft the triage runtime builds for a guardian share request (same fields as draftLocationLease). */
export function shareDraftPolicy(card: AlertCard, input: ShareInput, guardianId: string, deviceId: string) {
  return { runId: card.runId, householdId: 'household-r1', recipientId: guardianId, deviceId, purpose: input.purpose, durationMinutes: input.durationMinutes, incidentId: card.incidentId, alertId: card.alertId, requestedBy: guardianId, requestId: input.requestId };
}
/** Guardian decision hash, the same fields as McpTriageWorkflow.guardianDecide. */
export function decisionHash(input: { runId: string | null; approvalRequestId: string; draftId: string; draftHash: string; guardianId: string; decision: string; decidedAt: string; nonce: string }) {
  return approvalHash(input);
}

/** Replay of the R17 C4 story for recording without the sandbox; every event is simulation true and fixture-replay. */
export function createAlertReplay(options: { variant?: string; start?: string } = {}): AlertBackend {
  const { name, variant } = storyVariant(options.variant ?? 'claude');
  const log = createRecordLog({ source: 'fixture-replay', simulation: true, roleScope: ['guardian', 'operator'] });
  let counter = 0; let panicCount = 0;
  const residentId = story.residentId;
  const append = (recordType: GuardianRecordType, container: string, fields: Loose<GuardianAlertRecord> = {}) => {
    counter += 1;
    const recordId = `replay-${String(counter).padStart(4, '0')}-${recordType.toLowerCase().replaceAll('_', '-')}`;
    const value = compactRecord({ contractId: GUARDIAN_ALERT_CONTRACT, docRevision: '2.0.0', recordType, recordId, timestamp: new Date().toISOString(), residentId, creator: 'replay', ...fields });
    return log.append(value, `/replay/${residentId}/${container}/${recordId}`);
  };
  const view = () => reduceGuardianAlerts(log.events);
  const openCard = () => view().cards.find((card) => card.notified && card.state !== 'escalated' && card.kind !== 'PANIC') ?? null;
  const status = (key: 'home' | 'walk' | 'park') => { const item = story.status[key]; append('RESIDENT_STATUS', 'location', { localTime: item.localTime, status: { state: item.state as 'AT_HOME', place: item.place } }); return 1; };
  const steps: Record<ReplayStep, () => number> = {
    reset: () => { append('REPLAY_RESET', 'replay', { provenance: variant.provenance }); return 1 + steps.home(); },
    home: () => status('home'),
    walk: () => status('walk'),
    park: () => status('park'),
    alert: () => {
      if (view().cards.some((card) => card.alertId === variant.alert.alertId)) return 0;
      const { alertId, ...alert } = variant.alert; const { runId, decidedLocal, ...triage } = variant.triage;
      const before = log.lastSequence;
      if (view().status?.state !== 'IN_PARK') status('park');
      append('ROUTINE_ALERT', 'alerts', { alertId, localTime: alert.detectedLocal, provenance: variant.provenance, alert: { kind: alert.kind, score: alert.score, severityHint: alert.severityHint, detectedLocal: alert.detectedLocal, startedLocal: alert.startedLocal, segment: alert.segment, dwellSec: alert.dwellSec, reversals: alert.reversals, minutesAfterSunset: alert.minutesAfterSunset, distanceHomeM: alert.distanceHomeM } });
      append('TRIAGE_DECISION', 'triageLog', { alertId, runId, localTime: decidedLocal, triage: { severity: triage.severity, action: triage.action, explanation: triage.explanation, checked: triage.checked, decidedLocal, agent: variant.agent } });
      append('INCIDENT_OPENED', 'incidents', { alertId, incidentId: variant.incidentId, runId, localTime: variant.noticeLocal });
      append('TRIAGE_NOTICE', 'guardianInbox', { incidentId: variant.incidentId, localTime: variant.noticeLocal, triage: { severity: triage.severity, action: triage.action, explanation: triage.explanation, checked: [] } });
      if (variant.draft) {
        const { policy } = variant.draft;
        append('APPROVAL_REQUEST', 'approvals', { runId, alertId, incidentId: variant.incidentId, localTime: variant.draft.requestedLocal, provenance: variant.provenance, draft: {
          approvalRequestId: variant.draft.approvalRequestId, draftId: variant.draft.draftId, draftHash: approvalHash(policy), purpose: policy.purpose as 'wandering-check', durationMinutes: policy.durationMinutes,
          recipientId: policy.recipientId, deviceId: policy.deviceId, findings: [], policy,
        } });
      } else {
        append('TRIAGE_EVIDENCE', 'audit', { runId, alertId, incidentId: variant.incidentId, provenance: variant.provenance, evidence: { evidenceHash: variant.evidenceHash ?? approvalHash({ runId, alertId, tools: variant.toolsByServer }), agent: variant.agent, approvalHash: null, toolsByServer: variant.toolsByServer } });
      }
      return log.lastSequence - before;
    },
    panic: () => {
      const open = openCard();
      if (open?.incidentId) {
        append('INCIDENT_ESCALATED', 'incidents', { incidentId: open.incidentId, localTime: variant.panic.panicLocal, escalation: { cause: 'PANIC', panicLocal: variant.panic.panicLocal, leadTimeSec: variant.panic.leadTimeSec } });
        append('ESCALATION_NOTICE', 'guardianInbox', { incidentId: open.incidentId, localTime: variant.panic.panicLocal, escalation: { cause: 'PANIC' } });
        return 2;
      }
      panicCount += 1; const incidentId = `incident-panic-replay-${panicCount}`;
      append('INCIDENT_OPENED', 'incidents', { incidentId, localTime: variant.panic.panicLocal, escalation: { cause: 'PANIC', panicLocal: variant.panic.panicLocal } });
      append('PANIC_NOTICE', 'guardianInbox', { incidentId, localTime: variant.panic.panicLocal, escalation: { cause: 'PANIC' } });
      return 2;
    },
  };
  const start = options.start ?? 'alert';
  if (!['home', 'walk', 'park', 'alert'].includes(start)) throw new TypeError('ALERT_REPLAY_START 값은 home, walk, park, alert 중 하나로 지정하세요.');
  steps.reset();
  if (start !== 'home') steps.walk();
  if (start === 'park' || start === 'alert') steps.park();
  if (start === 'alert') steps.alert();
  return {
    mode: 'replay', guardianId: story.guardianId, guardian: log, operator: log,
    async requestShare(card, input) {
      // Server (triage runtime) step: build the least-privilege draft for the guardian's own request and hash it.
      append('SHARE_REQUEST', 'approvals', { alertId: card.alertId ?? undefined, incidentId: card.incidentId ?? undefined, share: { requestId: input.requestId, purpose: input.purpose, durationMinutes: input.durationMinutes, guardianId: story.guardianId } });
      const policy = shareDraftPolicy(card, input, story.guardianId, story.deviceId);
      const draftHash = approvalHash(policy);
      append('APPROVAL_REQUEST', 'approvals', { runId: card.runId ?? undefined, alertId: card.alertId ?? undefined, incidentId: card.incidentId ?? undefined, draft: {
        approvalRequestId: `approval-${draftHash.slice(0, 16)}`, draftId: `lease-draft-${draftHash.slice(0, 16)}`, draftHash, purpose: input.purpose, durationMinutes: input.durationMinutes, recipientId: story.guardianId, deviceId: story.deviceId, findings: [], policy,
      } });
    },
    async review(card, input) {
      const draft = card.draft!;
      const decidedAt = new Date().toISOString(); const nonce = randomBytes(16).toString('hex');
      const hash = decisionHash({ runId: card.runId, approvalRequestId: draft.approvalRequestId, draftId: draft.draftId, draftHash: draft.draftHash, guardianId: story.guardianId, decision: input.decision, decidedAt, nonce });
      append('GUARDIAN_DECISION', 'approvals', { runId: card.runId ?? undefined, decision: { approvalRequestId: draft.approvalRequestId, decision: input.decision, draftHash: draft.draftHash, approvalHash: hash, decidedBy: story.guardianId } });
      if (input.decision !== 'APPROVE') return { decision: input.decision, approvalHash: hash, lease: null };
      // Server step after the decision: the lease applies only with the guardian hash bound to this exact draft hash.
      const stored = reduceGuardianAlerts(log.events).cards.find((item) => item.draft?.approvalRequestId === draft.approvalRequestId);
      if (!stored?.decision || stored.decision.approvalHash !== hash || stored.decision.draftHash !== approvalHash(stored.draft?.policy)) throw new ContractError('APPROVAL_HASH_MISMATCH');
      const expiresAt = new Date(Date.now() + draft.durationMinutes * 60000).toISOString();
      const lease = { leaseId: `location-${hash.slice(0, 32)}`, purpose: draft.purpose as 'wandering-check', recipientId: draft.recipientId, expiresAt, durationMinutes: draft.durationMinutes, approvalHash: hash, draftHash: draft.draftHash };
      append('LOCATION_LEASE', 'leases', { runId: card.runId ?? undefined, incidentId: card.incidentId ?? undefined, lease });
      if (variant.draft) append('TRIAGE_EVIDENCE', 'audit', { runId: card.runId ?? undefined, alertId: card.alertId ?? undefined, incidentId: card.incidentId ?? undefined, provenance: variant.provenance,
        evidence: { evidenceHash: approvalHash({ runId: card.runId, alertId: card.alertId, toolsByServer: variant.toolsByServer, draftHash: draft.draftHash, approvalHash: hash, leaseId: lease.leaseId }), agent: variant.agent, approvalHash: hash, toolsByServer: variant.toolsByServer } });
      return { decision: input.decision, approvalHash: hash, lease };
    },
    async feedback(card, learning) {
      append('GUARDIAN_FEEDBACK', 'approvals', { alertId: card.alertId ?? undefined, incidentId: card.incidentId ?? undefined, feedback: { kind: 'ALERT_OK', guardianId: story.guardianId, learn: learning.learn, mode: learning.mode, reason: learning.reason.slice(0, 160) } });
      return { learning };
    },
    async location(card, lang) { return activeLease(card) ? storyLocation(lang) : null; },
    replay(step) { return { appended: steps[step]() }; },
    describe() { return { mode: 'replay', variant: name, provenance: variant.provenance, steps: REPLAY_STEPS, lastSequence: log.lastSequence }; },
  };
}


function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!String(request.headers['content-type']).startsWith('application/json')) throw new ContractError('JSON 요청 형식을 사용해 주세요.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) { const bytes = Buffer.from(chunk as Buffer); size += bytes.length; if (size > 16384) throw new ContractError('요청 크기를 확인해 주세요.'); chunks.push(bytes); }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!record(value)) throw new ContractError('요청 형식을 확인해 주세요.');
  return value;
}
function resumeCursor(request: IncomingMessage, url: URL): number {
  const header = request.headers['last-event-id'];
  if (Array.isArray(header)) throw new ContractError('Last-Event-ID must be singular');
  const value = header ?? url.searchParams.get('lastSequence');
  if (value === undefined || value === null) return 0;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ContractError('Resume cursor must be a nonnegative safe integer');
  return Number(value);
}

/** Same SSE framing and cursor rules as /events (id = stream sequence, replay-complete comment, heartbeat). */
export function writeEventStream(request: IncomingMessage, response: ServerResponse, url: URL, feed: AlertFeed): void {
  let cursor: number;
  try { cursor = resumeCursor(request, url); } catch (error) { json(response, 400, { error: 'invalid_cursor', message: error instanceof Error ? error.message : 'cursor' }); return; }
  if (cursor > feed.lastSequence) { json(response, 409, { error: 'resync_required', lastSequence: feed.lastSequence }); return; }
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  response.write('retry: 3000\n: connected\n\n');
  let written = cursor;
  const write = (event: DashboardEvent) => { if (event.sequence <= written || response.destroyed) return; written = event.sequence; response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`); };
  const pending: DashboardEvent[] = []; let backlogDone = false;
  const unsubscribe = feed.subscribe((event) => { if (backlogDone) write(event); else pending.push(event); });
  for (const event of feed.events) write(event);
  backlogDone = true; for (const event of pending) write(event);
  response.write(': replay-complete\n\n');
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000); heartbeat.unref();
  response.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
}

/** Place-memory learning gate (pc-mobius place-memory.mjs learningDecision) for a guardian "It's fine". */
export async function guardianOkLearning(card: AlertCard): Promise<LearningOutcome> {
  const module = await import(new URL('../../pc-mobius/integration/src/place-memory.mjs', import.meta.url).href) as { learningDecision(input: { accompanied: boolean; guardianAlerts: number; guardianDismissedOk: boolean; panic: boolean }): LearningOutcome };
  return module.learningDecision({ accompanied: false, guardianAlerts: card.notified ? 1 : 0, guardianDismissedOk: true, panic: card.state === 'escalated' || card.kind === 'PANIC' });
}

const RELOCATION_RECEIPT = new URL('../../docs/verification-evidence/2026-11-20/mec-day-of-care.json', import.meta.url);
/** Operator relocation row from the R13 receipt (replayed, never presented as live). */
export async function relocationSummary(file: URL = RELOCATION_RECEIPT): Promise<Record<string, unknown>> {
  const bytes = await readFile(file);
  const receipt = JSON.parse(bytes.toString('utf8')) as Record<string, any>;
  const metrics = receipt['metrics'] ?? {}; const relocation = metrics.relocation ?? {}; const preplacement = metrics.preplacement ?? {}; const gap = metrics.observationGap ?? {}; const notes = metrics.notifications ?? {};
  const decision = (receipt['decisions'] ?? []).find((item: Record<string, unknown>) => item['kind'] === 'relocation') ?? {};
  const instance = (mep: string) => receipt['ipe']?.instances?.[mep] ?? {};
  const host = (mep: string) => (receipt['meps'] ?? []).find((item: Record<string, unknown>) => item['mep'] === mep) ?? {};
  const triggerAt = relocation.trigger?.writtenAt ?? null; const triggerMs = Date.parse(triggerAt ?? '');
  const plus = (ms: unknown) => (Number.isFinite(triggerMs) && typeof ms === 'number' ? new Date(triggerMs + ms).toISOString() : null);
  return {
    source: 'receipt-replay', simulation: receipt['simulation'] ?? null,
    receipt: { path: 'docs/verification-evidence/2026-11-20/mec-day-of-care.json', status: receipt['status'], generatedAt: receipt['generatedAt'], checks: `${receipt['passed']}/${receipt['caseCount']}`, sha256: createHash('sha256').update(bytes).digest('hex'), sandbox: receipt['sandbox']?.name ?? null },
    from: { mep: 'mep1', edge: 'Edge-A', zone: host('mep1')['zone'] ?? null, appInstanceId: instance('mep1').appInstanceId ?? null },
    to: { mep: 'mep2', edge: 'Edge-B', zone: host('mep2')['zone'] ?? null, appInstanceId: instance('mep2').appInstanceId ?? null },
    storyTime: (receipt['storyTimeline'] ?? []).find((item: Record<string, unknown>) => String(item['title']).includes('park-district'))?.storyTime ?? null,
    steps: [
      { key: 'preplacement', at: preplacement.addRequestedAt ?? null, ms: preplacement.readyAfterAddMs ?? null, detail: preplacement.trigger?.accessPointId ?? null },
      { key: 'trigger', at: triggerAt, ms: relocation.zoneEntryToTriggerMs ?? null, detail: relocation.trigger?.mobilityStatus ?? null },
      { key: 'decision', at: plus(relocation.decisionMs), ms: relocation.decisionMs ?? null, detail: `epoch ${relocation.ownershipEpoch ?? '?'}`, eligibilityMs: relocation.eligibilityEvaluationMs ?? decision.evaluationMs ?? null },
      { key: 'drain', at: null, ms: relocation.drainMsInPod ?? null, detail: `${(relocation.drainedRequests ?? []).length}` },
      { key: 'resubscribe', at: plus((relocation.decisionMs ?? 0) + (relocation.decisionToResumedMs ?? 0)), ms: relocation.resumeMsInPod ?? null, detail: `${(relocation.resumedRequests ?? []).length}` },
      { key: 'firstObservation', at: plus((relocation.decisionMs ?? 0) + (relocation.decisionToFirstMep2ObservationMs ?? 0)), ms: relocation.decisionToFirstMep2ObservationMs ?? null, detail: 'mep2' },
    ],
    gap: { arrivalGapMs: gap.arrivalGapMs ?? null, sourceGapMs: gap.periodicSourceGapMs ?? null, periodMs: gap.measuredPeriodMs ?? null, missedReports: gap.missedPeriodicReports ?? null, duplicates: notes.duplicates ?? null, interleavedAfterCutover: notes.interleavedAfterCutover ?? null },
    candidates: (decision.candidates ?? []).map((item: Record<string, unknown>) => ({ mep: item['mep'], eligible: item['eligible'], reasons: item['reasons'] })),
  };
}

export interface PortalAuthorizer {
  authorizePortal(request: IncomingMessage, response: ServerResponse, mutation: boolean): Promise<{ principalId: string } | null>;
}

function cardFor(backend: AlertBackend, key: string | null): AlertCard | null {
  if (!key) return null;
  return reduceGuardianAlerts(backend.guardian.events).cards.find((card) => [card.key, card.incidentId, card.alertId, card.draft?.approvalRequestId].includes(key)) ?? null;
}
/** Container path (sibling of a record's container) in the resident evening feed of this card, e.g. .../ev-c4/approvals. */
function feedContainer(backend: AlertBackend, card: AlertCard, container: string): string | null {
  for (const event of backend.guardian.events) {
    if (event.type !== 'guardian.alert' || !event.receipt.oneM2MResource) continue;
    const item = event.receipt;
    const linked = (item.incidentId && item.incidentId === card.incidentId) || (item.alertId && item.alertId === card.alertId)
      || (item.draft && item.draft.approvalRequestId === card.draft?.approvalRequestId);
    if (linked) { const parts = item.oneM2MResource!.split('/'); parts.splice(-2, 2, container); return parts.join('/'); }
  }
  return null;
}

/** Routes under /api/portal/alerts (guardian) and /api/alerts, /api/relocation (operator). */
export function createAlertRoutes(backend: AlertBackend, options: { allowReplayControl?: boolean; storyControlUrl?: string } = {}) {
  return {
    backend,
    async handlePortal(request: IncomingMessage, response: ServerResponse, url: URL, auth: PortalAuthorizer): Promise<void> {
      const action = url.pathname.slice('/api/portal/alerts'.length).replace(/^\//, '');
      const mutation = request.method === 'POST';
      const identity = await auth.authorizePortal(request, response, mutation);
      if (!identity) return;
      if (identity.principalId !== 'demo-guardian' && identity.principalId !== backend.guardianId) { json(response, 403, { message: '이 가족의 보호자 계정으로 로그인해 주세요.' }); return; }
      try {
        if (request.method === 'GET' && action === 'events') { writeEventStream(request, response, url, backend.guardian); return; }
        if (request.method === 'GET' && action === '') { json(response, 200, { mode: backend.mode, source: backend.guardian.source, simulation: backend.guardian.simulation, view: reduceGuardianAlerts(backend.guardian.events), backend: backend.describe() }); return; }
        if (request.method === 'GET' && action === 'location') {
          const card = cardFor(backend, url.searchParams.get('incidentId'));
          const snapshot = card ? await backend.location(card, url.searchParams.get('lang') === 'en' ? 'en' : 'ko') : null;
          if (!snapshot) { json(response, 403, { message: '보호자가 승인한 위치 공유가 열려 있을 때만 위치를 보여 드려요.' }); return; }
          json(response, 200, snapshot); return;
        }
        if (!mutation) { json(response, 405, { message: '이 경로의 요청 방식을 확인해 주세요.' }); return; }
        const input = await readBody(request);
        if (action === 'replay') {
          const step = String(input['step']) as ReplayStep;
          if (options.allowReplayControl && !backend.replay && options.storyControlUrl) {
            // Live recording: the story runtime (pc-mobius/scripts/run-video-live.mjs) writes the step into the CSE.
            const forwarded = await fetch(options.storyControlUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ step: input['step'] }), signal: AbortSignal.timeout(15000) });
            json(response, forwarded.status, { mode: 'live', ...(await forwarded.json() as Record<string, unknown>) }); return;
          }
          if (!backend.replay || !options.allowReplayControl) { json(response, 404, { message: '재생 모드에서만 쓸 수 있어요.' }); return; }
          if (!REPLAY_STEPS.includes(step)) { json(response, 400, { message: `step: ${REPLAY_STEPS.join(', ')}` }); return; }
          json(response, 200, { step, ...backend.replay(step), lastSequence: backend.guardian.lastSequence }); return;
        }
        if (action === 'decide') {
          const card = cardFor(backend, typeof input['approvalRequestId'] === 'string' ? input['approvalRequestId'] : null);
          const decision = input['decision'] === 'REJECT' ? 'REJECT' : input['decision'] === 'APPROVE' ? 'APPROVE' : null;
          const reviewed = typeof input['reviewedDraftHash'] === 'string' ? input['reviewedDraftHash'] : '';
          if (!card?.draft || !decision) { json(response, 404, { message: '승인할 위치 공유 초안을 찾지 못했어요.' }); return; }
          if (card.decision) { json(response, 409, { error: 'ALREADY_DECIDED', decision: card.decision }); return; }
          // The guardian approves the exact draft: the reviewed hash must be the stored one, and the stored one must be the hash of the draft.
          if (reviewed !== card.draft.draftHash) { json(response, 409, { error: 'APPROVAL_DRAFT_MISMATCH', message: '화면의 초안과 저장된 초안이 달라요. 새로고침해 주세요.' }); return; }
          if (approvalHash(card.draft.policy) !== card.draft.draftHash) { json(response, 409, { error: 'DRAFT_HASH_INVALID', message: '초안 hash를 확인해야 해요.' }); return; }
          if (decision === 'APPROVE' && card.draft.findings.length > 0) { json(response, 409, { error: 'DRAFT_FINDINGS', findings: card.draft.findings }); return; }
          if (card.draft.recipientId !== backend.guardianId) { json(response, 403, { error: 'RECIPIENT_MISMATCH', message: '이 공유를 받을 보호자만 승인할 수 있어요.' }); return; }
          json(response, 200, { mode: backend.mode, ...(await backend.review(card, { decision, reviewedDraftHash: reviewed, requestResource: feedContainer(backend, card, 'approvals') })) }); return;
        }
        if (action === 'share') {
          // "Share location 5 min (Emergency Rescue)": the guardian asks, the triage runtime drafts and hashes, the guardian then approves that exact hash.
          const card = cardFor(backend, typeof input['key'] === 'string' ? input['key'] : null);
          if (!card?.notified) { json(response, 404, { message: '알림을 찾지 못했어요.' }); return; }
          if (card.decision) { json(response, 409, { error: 'ALREADY_DECIDED', decision: card.decision }); return; }
          if (card.draft) { json(response, 200, { mode: backend.mode, draft: card.draft, source: 'agent-draft' }); return; }
          const purpose = input['purpose'] === 'wandering-check' ? 'wandering-check' : 'emergency-rescue';
          const durationMinutes = Math.max(1, Math.min(5, Number.isInteger(input['durationMinutes']) ? input['durationMinutes'] as number : 5));
          const requestId = `share-${randomBytes(8).toString('hex')}`;
          await backend.requestShare(card, { requestId, purpose, durationMinutes, container: feedContainer(backend, card, 'approvals') });
          for (const until = Date.now() + 10000; Date.now() < until; await new Promise((resolve) => setTimeout(resolve, 100))) {
            const drafted = reduceGuardianAlerts(backend.guardian.events).cards.find((item) => item.draft?.policy['requestId'] === requestId);
            if (drafted?.draft) { json(response, 200, { mode: backend.mode, draft: drafted.draft, source: 'guardian-request' }); return; }
          }
          json(response, 504, { error: 'DRAFT_TIMEOUT', message: '공유 초안이 아직 도착하지 않았어요. 잠시 후 다시 눌러 주세요.' }); return;
        }
        if (action === 'dismiss') {
          const card = cardFor(backend, typeof input['key'] === 'string' ? input['key'] : null);
          if (!card) { json(response, 404, { message: '알림을 찾지 못했어요.' }); return; }
          if (card.feedback) { json(response, 409, { error: 'ALREADY_DISMISSED' }); return; }
          if (card.state === 'escalated' || card.kind === 'PANIC') { json(response, 409, { error: 'PANIC_OPEN', message: '도움 요청 버튼이 눌린 알림은 괜찮음으로 닫을 수 없어요.' }); return; }
          const learning = await guardianOkLearning(card);
          json(response, 200, { mode: backend.mode, ...(await backend.feedback(card, learning, feedContainer(backend, card, 'approvals'))) }); return;
        }
        json(response, 404, { message: '요청 경로를 확인해 주세요.' });
      } catch (error) {
        if (!response.headersSent) json(response, error instanceof ContractError || error instanceof SyntaxError ? 400 : 502, { message: error instanceof Error ? error.message : '요청을 처리하지 못했어요.' });
      }
    },
    async handleOperator(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
      if (url.pathname === '/api/alerts/events') { writeEventStream(request, response, url, backend.operator); return true; }
      if (url.pathname === '/api/relocation') {
        try { json(response, 200, await relocationSummary()); } catch { json(response, 503, { message: '재배치 기록 파일을 확인하세요.' }); }
        return true;
      }
      return false;
    },
  };
}
export type AlertRoutes = ReturnType<typeof createAlertRoutes>;
