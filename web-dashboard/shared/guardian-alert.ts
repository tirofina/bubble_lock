import type { DashboardEvent, GuardianAlertRecord, GuardianRecordType, TriageAction, TriageSeverity } from './types.ts';

/**
 * Guardian alert feed (R17 anomaly triage) for the family portal and the operator console.
 * Pure functions: resident AE contentInstances (alerts, triageLog, guardianInbox, approvals, incidents, leases,
 * audit, location) become `guardian.alert` records, and the records fold into one card per incident.
 */
export const GUARDIAN_ALERT_CONTRACT = 'privacy-bubble.guardian-alert.v1' as const;
export const FEED_CONTAINERS = ['alerts', 'triageLog', 'guardianInbox', 'approvals', 'incidents', 'leases', 'audit', 'location'] as const;
export type FeedContainer = typeof FEED_CONTAINERS[number];
/** Which AE may write which record: the consumer checks the creator (cr) like every other live stream. */
export type FeedWriter = 'routine' | 'triage' | 'incident' | 'guardianDecider' | 'guardian' | 'resident';

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
const text = (value: unknown, max = 512): string | undefined => (typeof value === 'string' && value.trim().length > 0 ? value.slice(0, max) : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const hex64 = (value: unknown): string | undefined => (typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined);
const hhmm = (value: unknown): string | undefined => {
  const match = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?/.exec(value) : null;
  return match ? match[0] : undefined;
};
const iso = (value: unknown): string | undefined => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined);
const strings = (value: unknown, max = 16): string[] => (Array.isArray(value) ? value.flatMap((item) => { const value = text(item, 96); return value ? [value] : []; }).slice(0, max) : []);
const purpose = (value: unknown): 'wandering-check' | 'emergency-rescue' | undefined => (value === 'wandering-check' || value === 'emergency-rescue' ? value : undefined);
/** Builder input: optional fields may be undefined and are dropped by compact (exactOptionalPropertyTypes). */
export type Loose<T> = T extends readonly (infer U)[] ? readonly U[] : T extends object ? { [K in keyof T]?: Loose<T[K]> | undefined } : T;
function compact<T>(value: T): T {
  if (!record(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, record(item) && key !== 'policy' ? compact(item) : item])) as T;
}
export function compactRecord(value: Loose<GuardianAlertRecord>): GuardianAlertRecord { return compact(value) as GuardianAlertRecord; }

/** Tool to MCP server for the write steps of the triage contract (readCalls already carry their server). */
const STEP_SERVER: Readonly<Record<string, string>> = {
  readAlert: 'oneM2M', submitTriage: 'oneM2M', draftLocationLease: 'oneM2M', requestGuardianApproval: 'oneM2M', applyApprovedLease: 'oneM2M', appendTriageEvidence: 'Audit',
};
export function toolsByServer(readCalls: unknown, steps: unknown): Record<string, string[]> {
  const result: Record<string, string[]> = { oneM2M: [], MEC: [], Audit: [] };
  const add = (server: string, tool: string) => { const list = result[server] ?? (result[server] = []); if (!list.includes(tool)) list.push(tool); };
  for (const call of Array.isArray(readCalls) ? readCalls : []) if (record(call) && text(call['serverId'], 16) && text(call['tool'], 64)) add(String(call['serverId']), String(call['tool']));
  for (const step of Array.isArray(steps) ? steps : []) {
    const name = record(step) ? text(step['step'], 64) : text(step, 64);
    if (name && STEP_SERVER[name]) add(STEP_SERVER[name]!, name);
  }
  return result;
}

export interface FeedMeta {
  readonly recordId: string;
  readonly timestamp: string;
  readonly residentId: string;
  readonly creator?: string;
  readonly oneM2MResource?: string;
}
export interface MappedRecord { readonly record: GuardianAlertRecord; readonly writer: FeedWriter }

export type ResidentState = 'AT_HOME' | 'MOVING' | 'IN_PARK';
/**
 * Coarse zone of a location record to the family overview status (no coordinates):
 * home Wi-Fi or the home segment is At Home, park-district (Edge-B, mep2) is In Park, anything else is Moving.
 * Accepts the MEC IPE observation (pb.mec.location.v1) and the R17 location sample (pb.location.sample.v1).
 */
export function residentStatusOf(con: unknown): { state: ResidentState; place: string | undefined } | null {
  if (!record(con) || !['pb.location.sample.v1', 'pb.mec.location.v1'].includes(String(con['schema']))) return null;
  const zone = text(con['zoneId'], 64); const accessPoint = text(con['accessPointId'], 64);
  const servedBy = record(con['servedBy']) ? text(con['servedBy']['mep'], 16) : undefined;
  if (con['segment'] === 'home' || accessPoint === 'home-wifi') return { state: 'AT_HOME', place: 'home' };
  if (zone === 'park-district' || (!zone && servedBy === 'mep2')) return { state: 'IN_PARK', place: zone ?? 'park-district' };
  return { state: 'MOVING', place: zone ?? text(con['segment'], 120) };
}

/** Minimum triage action per alert kind (pc-mobius/contracts/mcp-triage-tools.v1.json workflow.actionFloor). */
export const ACTION_FLOOR: Readonly<Record<string, TriageAction>> = { WANDERING: 'checkIn', DEVICE_SEPARATION: 'checkIn' };
export const minimumActionOf = (kind: string): TriageAction => ACTION_FLOOR[kind] ?? 'observe';

/**
 * One contentInstance body from a resident feed container to a guardian record. Unknown shapes return null and
 * the caller turns them into a REVIEW record; precise coordinates are never copied (only names and times).
 */
export function guardianRecordFromContent(container: FeedContainer, con: unknown, meta: FeedMeta): MappedRecord | null {
  if (!record(con)) return null;
  const base = { contractId: GUARDIAN_ALERT_CONTRACT, docRevision: '2.0.0' as const, recordId: meta.recordId, timestamp: meta.timestamp, residentId: text(con['residentId'], 128) ?? meta.residentId, ...(meta.creator ? { creator: meta.creator } : {}), ...(meta.oneM2MResource ? { oneM2MResource: meta.oneM2MResource } : {}) };
  const make = (recordType: GuardianRecordType, writer: FeedWriter, fields: Loose<GuardianAlertRecord>): MappedRecord => ({ writer, record: compactRecord({ ...base, recordType, ...fields }) });
  const type = con['type'];
  switch (container) {
    case 'alerts': {
      const alertId = text(con['alertId'], 128); const kind = text(con['kind'], 64); const score = num(con['score']);
      if (!alertId || !kind || score === undefined || !hhmm(con['detectedLocal'])) return null;
      const features = record(con['features']) ? con['features'] : {};
      const segment = record(con['segment']) ? text(con['segment']['name'], 120) : text(features['segment'], 120);
      return make('ROUTINE_ALERT', 'routine', { alertId, localTime: hhmm(con['detectedLocal']), alert: compact({
        kind, score: Math.max(0, Math.min(1, score)), severityHint: text(con['severityHint'], 32), detectedLocal: hhmm(con['detectedLocal'])!, startedLocal: hhmm(con['startedLocal']), segment,
        dwellSec: num(features['dwellSec']), reversals: Number.isInteger(features['reversals']) ? features['reversals'] as number : undefined, minutesAfterSunset: num(features['minutesAfterSunset']), distanceHomeM: num(features['distanceHomeM']),
      }) });
    }
    case 'triageLog': {
      if (type !== 'TRIAGE_DECISION' || !['info', 'watch', 'urgent'].includes(String(con['severity'])) || !['observe', 'checkIn', 'emergencyLease'].includes(String(con['action'])) || !text(con['explanation'], 280)) return null;
      return make('TRIAGE_DECISION', 'triage', { alertId: text(con['alertId'], 128), runId: text(con['runId'], 128), localTime: hhmm(con['decidedLocal']), triage: compact({
        severity: con['severity'] as TriageSeverity, action: con['action'] as TriageAction, explanation: text(con['explanation'], 280)!, checked: strings(con['checked']), decidedLocal: hhmm(con['decidedLocal']), agent: text(con['agent'], 120),
      }) });
    }
    case 'guardianInbox': {
      const incidentId = text(con['incidentId'], 128); if (!incidentId) return null;
      if (type === 'TRIAGE_NOTICE') {
        if (!['info', 'watch', 'urgent'].includes(String(con['severity'])) || !['observe', 'checkIn', 'emergencyLease'].includes(String(con['action'])) || !text(con['explanation'], 280)) return null;
        return make('TRIAGE_NOTICE', 'triage', { incidentId, alertId: text(con['alertId'], 128), localTime: hhmm(con['sentLocal']), triage: { severity: con['severity'] as TriageSeverity, action: con['action'] as TriageAction, explanation: text(con['explanation'], 280)!, checked: [] } });
      }
      if (type === 'ESCALATION') return make('ESCALATION_NOTICE', 'incident', { incidentId, localTime: hhmm(con['sentLocal']), escalation: { cause: text(con['cause'], 64) ?? 'PANIC' } });
      if (type === 'PANIC_NOTICE') return make('PANIC_NOTICE', 'incident', { incidentId, localTime: hhmm(con['sentLocal']), escalation: { cause: 'PANIC' } });
      return null;
    }
    case 'incidents': {
      const incidentId = text(con['incidentId'], 128); if (!incidentId) return null;
      if (type === 'INCIDENT_OPENED') {
        const panic = con['cause'] === 'PANIC';
        return make('INCIDENT_OPENED', panic ? 'incident' : 'triage', { incidentId, alertId: text(con['alertId'], 128), localTime: hhmm(con['openedLocal'] ?? con['panicLocal']), ...(panic ? { escalation: compact({ cause: 'PANIC', panicLocal: hhmm(con['panicLocal']) }) } : {}) });
      }
      if (type === 'INCIDENT_ESCALATED') return make('INCIDENT_ESCALATED', 'incident', { incidentId, localTime: hhmm(con['panicLocal']), escalation: compact({ cause: text(con['cause'], 64) ?? 'PANIC', panicLocal: hhmm(con['panicLocal']), leadTimeSec: Number.isInteger(con['leadTimeSec']) ? con['leadTimeSec'] as number : con['leadTimeSec'] === null ? null : undefined }) });
      return null;
    }
    case 'approvals': {
      if (type === 'APPROVAL_REQUEST') {
        const lease = record(con['lease']) ? con['lease'] : null;
        const approvalRequestId = text(con['approvalRequestId'], 128); const draftId = text(con['draftId'], 128); const draftHash = hex64(con['draftHash']);
        if (!lease || !approvalRequestId || !draftId || !draftHash || !purpose(lease['purpose']) || !Number.isInteger(lease['durationMinutes']) || !text(lease['recipientId'], 128)) return null;
        return make('APPROVAL_REQUEST', 'triage', { runId: text(con['runId'], 128), alertId: text(lease['alertId'], 128), incidentId: text(lease['incidentId'], 128), localTime: hhmm(con['requestedLocal']), draft: compact({
          approvalRequestId, draftId, draftHash, purpose: purpose(lease['purpose'])!, durationMinutes: Math.max(1, Math.min(5, lease['durationMinutes'] as number)), recipientId: text(lease['recipientId'], 128)!,
          deviceId: text(lease['deviceId'], 128), findings: strings(con['findings']), policy: lease,
        }) });
      }
      if (type === 'GUARDIAN_DECISION' || type === 'GUARDIAN_REVIEW') {
        const approvalRequestId = text(con['approvalRequestId'], 128); const draftHash = hex64(con['draftHash'] ?? con['reviewedDraftHash']);
        if (!approvalRequestId || !draftHash || !['APPROVE', 'REJECT'].includes(String(con['decision']))) return null;
        return make(type, type === 'GUARDIAN_DECISION' ? 'guardianDecider' : 'guardian', { localTime: hhmm(con['decidedLocal'] ?? con['reviewedLocal']), decision: compact({
          approvalRequestId, decision: con['decision'] as 'APPROVE' | 'REJECT', draftHash, approvalHash: hex64(con['approvalHash']), decidedBy: text(con['guardianId'] ?? con['decidedBy'], 128),
        }) });
      }
      if (type === 'SHARE_REQUEST') {
        const requestId = text(con['requestId'], 128);
        if (!requestId || !purpose(con['purpose']) || !Number.isInteger(con['durationMinutes']) || !text(con['guardianId'], 128)) return null;
        return make('SHARE_REQUEST', 'guardian', { alertId: text(con['alertId'], 128), incidentId: text(con['incidentId'], 128), share: { requestId, purpose: purpose(con['purpose'])!, durationMinutes: Math.max(1, Math.min(5, con['durationMinutes'] as number)), guardianId: text(con['guardianId'], 128)! } });
      }
      if (type === 'GUARDIAN_FEEDBACK') {
        if (con['feedback'] !== 'ALERT_OK' || typeof con['learn'] !== 'boolean' || !text(con['guardianId'], 128) || !text(con['reason'], 160)) return null;
        return make('GUARDIAN_FEEDBACK', 'guardian', { alertId: text(con['alertId'], 128), incidentId: text(con['incidentId'], 128), feedback: { kind: 'ALERT_OK', guardianId: text(con['guardianId'], 128)!, learn: con['learn'] as boolean, mode: text(con['mode'], 32) ?? null, reason: text(con['reason'], 160)! } });
      }
      return null;
    }
    case 'leases': {
      if (type !== 'LOCATION_LEASE' || !text(con['leaseId'], 128) || !purpose(con['purpose']) || !text(con['recipientId'], 128) || !iso(con['expiresAt'])) return null;
      return make('LOCATION_LEASE', 'triage', { runId: text(con['runId'], 128), incidentId: text(con['incidentId'], 128), lease: compact({
        leaseId: text(con['leaseId'], 128)!, purpose: purpose(con['purpose'])!, recipientId: text(con['recipientId'], 128)!, expiresAt: iso(con['expiresAt'])!, approvalHash: hex64(con['approvalHash']), draftHash: hex64(con['draftHash']),
      }) });
    }
    case 'audit': {
      const evidence = record(con['evidence']) ? con['evidence'] : null;
      if (type !== 'TRIAGE_EVIDENCE' || !evidence || !hex64(con['evidenceHash'])) return null;
      const lease = record(evidence['lease']) ? evidence['lease'] : null;
      return make('TRIAGE_EVIDENCE', 'triage', { runId: text(evidence['runId'], 128), alertId: text(evidence['alertId'], 128), incidentId: text(evidence['incidentId'], 128), evidence: compact({
        evidenceHash: hex64(con['evidenceHash'])!, agent: text(con['agent'], 120), approvalHash: lease ? hex64(lease['approvalHash']) ?? null : null, toolsByServer: toolsByServer(evidence['readCalls'], evidence['steps']),
      }) });
    }
    case 'location': {
      const status = residentStatusOf(con); if (!status) return null;
      return make('RESIDENT_STATUS', 'resident', { localTime: hhmm(con['localTime']), status: compact({ state: status.state, place: status.place }) });
    }
  }
}

export type CardState = 'new' | 'approved' | 'dismissed' | 'escalated';
export interface AlertCard {
  readonly key: string;
  readonly residentId: string;
  readonly incidentId: string | null;
  readonly alertId: string | null;
  readonly runId: string | null;
  readonly kind: string;
  /** Server product rule for the alert kind (contract actionFloor); the agent may choose a higher action. */
  readonly minimumAction: TriageAction;
  readonly share: { readonly requestId: string; readonly purpose: string; readonly at: string } | null;
  readonly severity: TriageSeverity | null;
  readonly action: TriageAction | null;
  readonly explanation: string | null;
  readonly checked: readonly string[];
  readonly agent: string | null;
  readonly segment: string | null;
  readonly startedLocal: string | null;
  readonly detectedLocal: string | null;
  /** First guardian-facing record time (notice or incident). */
  readonly alertedAt: string | null;
  readonly alertedLocal: string | null;
  readonly notified: boolean;
  readonly draft: NonNullable<GuardianAlertRecord['draft']> | null;
  readonly review: { readonly at: string; readonly draftHash: string } | null;
  readonly decision: (NonNullable<GuardianAlertRecord['decision']> & { readonly at: string; readonly localTime: string | null }) | null;
  readonly lease: NonNullable<GuardianAlertRecord['lease']> | null;
  readonly escalation: { readonly at: string; readonly cause: string; readonly panicLocal: string | null; readonly leadTimeSec: number | null } | null;
  readonly feedback: (NonNullable<GuardianAlertRecord['feedback']> & { readonly at: string }) | null;
  readonly evidence: NonNullable<GuardianAlertRecord['evidence']> | null;
  readonly records: number;
  readonly state: CardState;
}
export interface GuardianAlertView {
  readonly cards: readonly AlertCard[];
  readonly status: { readonly state: ResidentState; readonly place: string | null; readonly localTime: string | null; readonly at: string } | null;
  readonly lastSequence: number;
}
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export function cardState(card: Pick<AlertCard, 'escalation' | 'feedback' | 'decision'>): CardState {
  if (card.escalation) return 'escalated';
  if (card.feedback) return 'dismissed';
  if (card.decision?.decision === 'APPROVE') return 'approved';
  return 'new';
}

/** Records from replay or CSE notifications in stream order; containers may interleave, so links merge both ways. */
export function reduceGuardianRecords(records: readonly GuardianAlertRecord[], lastSequence = 0): GuardianAlertView {
  let cards: Mutable<AlertCard>[] = [];
  let status: Mutable<NonNullable<GuardianAlertView['status']>> | null = null;
  const byAlert = new Map<string, Mutable<AlertCard>>(); const byIncident = new Map<string, Mutable<AlertCard>>();
  const byApproval = new Map<string, Mutable<AlertCard>>(); const byRun = new Map<string, Mutable<AlertCard>>();
  const create = (item: GuardianAlertRecord): Mutable<AlertCard> => {
    const card: Mutable<AlertCard> = { key: item.incidentId ?? item.alertId ?? item.recordId, residentId: item.residentId, incidentId: null, alertId: null, runId: null, kind: 'ALERT', severity: null, action: null, explanation: null, checked: [], agent: null,
      segment: null, startedLocal: null, detectedLocal: null, alertedAt: null, alertedLocal: null, notified: false, minimumAction: 'observe', share: null, draft: null, review: null, decision: null, lease: null, escalation: null, feedback: null, evidence: null, records: 0, state: 'new' };
    cards.push(card); return card;
  };
  const merge = (into: Mutable<AlertCard>, from: Mutable<AlertCard>) => {
    if (into === from) return into;
    for (const [key, value] of Object.entries(from) as [keyof AlertCard, unknown][]) {
      const current = into[key];
      if ((current === null || (Array.isArray(current) && current.length === 0) || (key === 'kind' && current === 'ALERT')) && value !== null) (into as Record<string, unknown>)[key] = value;
    }
    into.notified = into.notified || from.notified; into.records += from.records;
    cards = cards.filter((card) => card !== from);
    for (const index of [byAlert, byIncident, byApproval, byRun]) for (const [key, card] of index) if (card === from) index.set(key, into);
    return into;
  };
  const link = (card: Mutable<AlertCard>, item: GuardianAlertRecord) => {
    let target = card;
    if (item.alertId) { const known = byAlert.get(item.alertId); if (known) target = merge(known, target); target.alertId ??= item.alertId; byAlert.set(item.alertId, target); }
    if (item.incidentId) { const known = byIncident.get(item.incidentId); if (known) target = merge(known, target); target.incidentId ??= item.incidentId; target.key = item.incidentId; byIncident.set(item.incidentId, target); }
    if (item.runId) { const known = byRun.get(item.runId); if (known) target = merge(known, target); target.runId ??= item.runId; byRun.set(item.runId, target); }
    if (item.draft) byApproval.set(item.draft.approvalRequestId, target);
    return target;
  };
  const find = (item: GuardianAlertRecord) => (item.decision && byApproval.get(item.decision.approvalRequestId))
    || (item.incidentId && byIncident.get(item.incidentId)) || (item.alertId && byAlert.get(item.alertId)) || (item.runId && byRun.get(item.runId)) || null;
  for (const item of records) {
    if (item.recordType === 'REPLAY_RESET') { cards = []; status = null; byAlert.clear(); byIncident.clear(); byApproval.clear(); byRun.clear(); continue; }
    if (item.recordType === 'RESIDENT_STATUS') { if (item.status) status = { state: item.status.state, place: item.status.place ?? null, localTime: item.localTime ?? null, at: item.timestamp }; continue; }
    if (item.recordType === 'GUARDIAN_DECISION' || item.recordType === 'GUARDIAN_REVIEW') {
      const card = find(item); if (!card || !item.decision) continue; card.records += 1;
      if (item.recordType === 'GUARDIAN_REVIEW') card.review = { at: item.timestamp, draftHash: item.decision.draftHash };
      else card.decision = { ...item.decision, at: item.timestamp, localTime: item.localTime ?? null };
      continue;
    }
    // PANIC without an open incident is a new incident; with an open one it escalates that same card.
    const card = link(find(item) ?? create(item), item); card.records += 1;
    const guardianFacing = () => { if (!card.alertedAt) { card.alertedAt = item.timestamp; card.alertedLocal = item.localTime ?? null; } card.notified = true; };
    switch (item.recordType) {
      case 'ROUTINE_ALERT': if (item.alert) Object.assign(card, { kind: item.alert.kind, segment: item.alert.segment ?? card.segment, startedLocal: item.alert.startedLocal ?? null, detectedLocal: item.alert.detectedLocal }); break;
      case 'TRIAGE_DECISION': if (item.triage) Object.assign(card, { severity: item.triage.severity, action: item.triage.action, explanation: item.triage.explanation, checked: item.triage.checked, agent: item.triage.agent ?? card.agent }); break;
      case 'TRIAGE_NOTICE': if (item.triage) { card.severity ??= item.triage.severity; card.action ??= item.triage.action; card.explanation ??= item.triage.explanation; } guardianFacing(); break;
      case 'INCIDENT_OPENED': guardianFacing(); if (item.escalation?.cause === 'PANIC') { card.kind = 'PANIC'; card.severity = 'urgent'; card.detectedLocal ??= item.escalation.panicLocal ?? item.localTime ?? null; } break;
      case 'PANIC_NOTICE': guardianFacing(); if (card.kind === 'ALERT') { card.kind = 'PANIC'; card.severity = 'urgent'; } break;
      case 'APPROVAL_REQUEST': if (item.draft) card.draft = item.draft; break;
      case 'LOCATION_LEASE': if (item.lease) card.lease = item.lease; break;
      case 'INCIDENT_ESCALATED': case 'ESCALATION_NOTICE':
        if (card.kind !== 'PANIC') card.escalation = { at: card.escalation?.at ?? item.timestamp, cause: item.escalation?.cause ?? 'PANIC', panicLocal: item.escalation?.panicLocal ?? card.escalation?.panicLocal ?? item.localTime ?? null, leadTimeSec: item.escalation?.leadTimeSec ?? card.escalation?.leadTimeSec ?? null };
        break;
      case 'TRIAGE_EVIDENCE': if (item.evidence) { card.evidence = item.evidence; card.agent ??= item.evidence.agent ?? null; } break;
      case 'GUARDIAN_FEEDBACK': if (item.feedback) card.feedback = { ...item.feedback, at: item.timestamp }; break;
      case 'SHARE_REQUEST': if (item.share) card.share = { requestId: item.share.requestId, purpose: item.share.purpose, at: item.timestamp }; break;
    }
  }
  for (const card of cards) { card.state = cardState(card); card.minimumAction = minimumActionOf(card.kind); }
  return { cards, status, lastSequence };
}

export function reduceGuardianAlerts(events: readonly DashboardEvent[]): GuardianAlertView {
  const records = events.flatMap((event) => (event.type === 'guardian.alert' ? [event.receipt] : []));
  return reduceGuardianRecords(records, events.at(-1)?.sequence ?? 0);
}

/** Lease that is still open for this card at `now`. */
export function activeLease(card: Pick<AlertCard, 'lease'>, now = Date.now()) {
  return card.lease && Date.parse(card.lease.expiresAt) > now ? card.lease : null;
}
