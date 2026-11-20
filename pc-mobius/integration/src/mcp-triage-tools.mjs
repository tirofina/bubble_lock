import { approvalHash } from './integration-utils.mjs';
import { MCP_TRIAGE_CONTRACT, toolReview } from './mcp-schema.mjs';
import { McpTriageWorkflow } from './mcp-orchestrator.mjs';
import { haversineM, summarizeProfile } from './routine-model.mjs';
import { parseContent } from './onem2m-http-client.mjs';

const TRIAGE = MCP_TRIAGE_CONTRACT.workflow;
const grid3 = (value) => Math.round(value * 1000) / 1000;
const round10 = (value) => Math.round(value / 10) * 10;
/** Coordinate-like numbers (three or more decimals) are refused in guardian-facing text; place names and times are used instead. */
export const COORDINATE_PATTERN = /\d{1,3}\.\d{3,}/;
export function explanationFindings(text) {
  const findings = [];
  if (COORDINATE_PATTERN.test(text)) findings.push('explanation contains a coordinate-like number');
  if (/\b(lat|lon|latitude|longitude)\b/i.test(text)) findings.push('explanation names coordinates');
  return findings;
}
const ACTION_SEVERITY = { observe: ['info', 'watch'], checkIn: ['watch', 'urgent'], emergencyLease: ['urgent'] };
/** Product rule per alert kind: the agent may raise the action above the floor, the server refuses anything below it. */
export const actionFloor = (kind) => TRIAGE.actionFloor?.[kind] ?? { minimumAction: 'observe', reason: null };
const actionRank = (action) => TRIAGE.actionOrder.indexOf(action);

/** Least-privilege findings for a lease draft against the run task; the guardian step approves only drafts without findings. */
export function leaseFindings(draft, task) {
  const findings = [];
  if (draft.recipientId !== task.guardianId) findings.push(`recipient ${draft.recipientId} is not the household guardian ${task.guardianId}`);
  if (draft.deviceId !== task.deviceId) findings.push(`device ${draft.deviceId} differs from the alert device ${task.deviceId}`);
  if (!task.leaseGrants[draft.purpose]) findings.push(`purpose ${draft.purpose} has no guardian consent grant`);
  if (draft.durationMinutes > task.maxLeaseMinutes) findings.push(`duration ${draft.durationMinutes} min exceeds ${task.maxLeaseMinutes} min`);
  return findings;
}

/**
 * Handlers for the triage profile. `scene` is the server-side view of the evening (map, profile, corridor, scenario
 * clock, last precise fix, UE binding); precise coordinates stay inside this boundary and never reach a tool output.
 */
export function createTriageToolHandlers({ workflow, oneM2M, mec, privacy, scene, guardianPrincipal, clock = workflow.clock }) {
  if (!(workflow instanceof McpTriageWorkflow) || !oneM2M || !mec || !privacy || !scene) throw new Error('MCP triage workflow, adapters, privacy service and scene required');
  const now = () => clock();
  const local = (ms) => scene.map.localTime(ms, true);
  const nowLocal = () => local(scene.nowMs());
  const read = async (context, serverId, tool, input, output) => { await workflow.recordRead(context, { serverId, tool, input, output }); return output; };
  const bind = (context, scope, tool) => { const { run, grant } = workflow.current(context.runId, { scope }); workflow.route(run, tool); if (run.task.caseId !== scene.caseId) throw toolReview('SCENE_BINDING', 'Run is bound to a different evening'); return { run, grant }; };
  const locationRows = async (run, minutes) => {
    const toMs = scene.nowMs(); const fromMs = toMs - minutes * 60000;
    const rows = [];
    for (const entry of await oneM2M.listChildren(run.task.paths.location)) {
      const ms = Number(/^s(\d+)$/.exec(entry.rn)?.[1]) * 1000;
      if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
      const con = await oneM2M.readCon(entry.path); if (con) rows.push({ ms, con });
    }
    return { fromMs, toMs, rows: rows.sort((a, b) => a.ms - b.ms) };
  };
  return {
    oneM2M: {
      async readAlert(input, context) {
        const { run } = bind(context, 'bubble:read', 'readAlert');
        if (input.alertId !== run.task.alertId) throw toolReview('ALERT_BINDING', `Run is bound to alert ${run.task.alertId}`);
        const alert = await oneM2M.readCon(run.task.alertPath);
        if (!alert || alert.alertId !== run.task.alertId) throw toolReview('ALERT_RECORD', 'Alert contentInstance on the CSE required');
        const f = alert.features ?? {};
        const pick = (keys) => Object.fromEntries(keys.filter((key) => f[key] !== undefined && f[key] !== null).map((key) => [key, f[key]]));
        const output = { alertId: alert.alertId, kind: alert.kind, score: alert.score, severityHint: alert.severityHint, detectedLocal: alert.detectedLocal, startedLocal: alert.startedLocal, nowLocal: nowLocal(),
          segment: { name: alert.segment?.name ?? 'unknown', kind: alert.segment?.kind ?? 'unknown' },
          features: { ...pick(['dwellSec', 'dwellRefSec', 'dwellRatio', 'reversals', 'speedMps', 'corridorDistanceM', 'offCorridorSec', 'offCorridorSince', 'stopSince', 'minutesAfterSunset', 'sunsetLocal', 'minutesPastUsualReturn', 'distanceHomeM', 'gapSec', 'gapRefSec', 'lastSampleAt']), components: f.components, ...(f.keyring ? { keyring: f.keyring } : {}),
            ...(f.place ? { place: { label: f.place.label, familiarity: f.place.familiarity, distanceBand: f.place.distanceBand, coldStart: f.place.coldStart === true } } : {}), ...(f.trigger ? { trigger: f.trigger } : {}), ...(f.accompanied ? { accompanied: true } : {}) },
          modelVersion: alert.modelVersion, profileHash: alert.profileHash, alertRecordPath: run.task.alertPath,
          minimumAction: actionFloor(alert.kind).minimumAction, ...(actionFloor(alert.kind).reason ? { minimumActionReason: actionFloor(alert.kind).reason.slice(0, 160) } : {}) };
        await workflow.checkpoint(context, 'readAlert', { input, output, update: (state) => { state.alert = { kind: alert.kind, score: alert.score, alertHash: approvalHash(alert) }; } });
        return read(context, 'oneM2M', 'readAlert', input, output);
      },
      async readRecentHistory(input, context) {
        const { run } = bind(context, 'bubble:read', 'readRecentHistory');
        const { fromMs, toMs, rows } = await locationRows(run, input.minutes);
        const segments = []; const gaps = [];
        for (const [index, row] of rows.entries()) {
          const name = row.con.segment ?? 'unknown'; const last = segments.at(-1);
          if (last && last.segment === name && last.onCorridor === (row.con.onCorridor === true)) { last.toMs = row.ms; last.samples += 1; }
          else segments.push({ segment: name, kind: row.con.segmentKind ?? 'path', fromMs: row.ms, toMs: row.ms, onCorridor: row.con.onCorridor === true, samples: 1 });
          if (index && row.ms - rows[index - 1].ms > 2 * (scene.intervalSec ?? 20) * 1000) gaps.push({ fromLocal: local(rows[index - 1].ms), toLocal: local(row.ms), seconds: (row.ms - rows[index - 1].ms) / 1000 });
        }
        if (rows.length && toMs - rows.at(-1).ms > 2 * (scene.intervalSec ?? 20) * 1000) gaps.push({ fromLocal: local(rows.at(-1).ms), toLocal: local(toMs), seconds: Math.round((toMs - rows.at(-1).ms) / 1000) });
        const output = { fromLocal: local(fromMs), toLocal: local(toMs), samples: rows.length,
          segments: segments.slice(-24).map((entry) => ({ segment: entry.segment, kind: entry.kind, fromLocal: local(entry.fromMs), toLocal: local(entry.toMs), minutes: Math.round((entry.toMs - entry.fromMs) / 6000) / 10, onCorridor: entry.onCorridor, samples: entry.samples })),
          stops: (scene.stops?.(fromMs, toMs) ?? []).slice(-12).map((stop) => ({ place: stop.place, fromLocal: local(stop.fromMs), toLocal: local(stop.toMs), minutes: Math.round((stop.toMs - stop.fromMs) / 6000) / 10, reversals: stop.reversals, withinM: stop.withinM })),
          gaps: gaps.slice(-12), recentGrid: rows.slice(-6).map((row) => ({ localTime: local(row.ms), lat: grid3(row.con.grid?.lat ?? 0), lon: grid3(row.con.grid?.lon ?? 0) })), precision: 'grid-3-decimals' };
        return read(context, 'oneM2M', 'readRecentHistory', input, output);
      },
      async readRoutineProfile(input, context) {
        const { run } = bind(context, 'bubble:read', 'readRoutineProfile');
        // The routine container holds the segment profile (profile-*), the sealed place memory (memory-*, ciphertext) and
        // its label summary (summary-*); this tool reads the profile and the summary only.
        const children = await oneM2M.listChildren(run.task.paths.routine);
        const profileEntry = children.filter((entry) => entry.rn.startsWith('profile')).at(-1); const summaryEntry = children.filter((entry) => entry.rn.startsWith('summary')).at(-1);
        const record = profileEntry ? await oneM2M.readCon(profileEntry.path) : await oneM2M.latestCon(run.task.paths.routine);
        const placeSummary = summaryEntry ? (await oneM2M.readCon(summaryEntry.path))?.summary : null;
        if (!record?.profile?.profileHash) throw toolReview('PROFILE_RECORD', 'Routine profile contentInstance required');
        const summary = summarizeProfile(record.profile, scene.map);
        const sunset = scene.map.sunset(scene.nowMs());
        const label = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;
        const output = { modelVersion: summary.modelVersion, days: summary.days, synthetic: summary.synthetic, profileHash: summary.profileHash, usualDeparture: summary.usualDeparture, usualReturn: summary.usualReturn, latestUsualReturn: summary.latestUsualReturn,
          sunsetLocal: label(sunset.sunsetLocalMin), walkingSpeedMps: summary.walkingSpeedMps,
          corridor: [...new Map(summary.corridor.map((entry) => [entry.segment, entry])).values()].slice(0, 48), usualStops: summary.usualStops.slice(0, 16), usualSignalGaps: summary.usualSignalGaps.slice(0, 16),
          ...(placeSummary ? { places: { soloDays: placeSummary.soloDays, accompaniedDays: placeSummary.accompaniedDays, coldStart: placeSummary.coldStart, corridorCells: placeSummary.corridorCells,
            items: placeSummary.places.slice(0, 16).map(({ label, familiarity, visits, usualTimeBand, dwellP50Min, guardianMarkedOk, distanceBand }) => ({ label, familiarity, visits, usualTimeBand, dwellP50Min, guardianMarkedOk, distanceBand })) } } : {}) };
        return read(context, 'oneM2M', 'readRoutineProfile', input, output);
      },
      async readDeviceState(input, context) {
        const { run } = bind(context, 'bubble:read', 'readDeviceState');
        if (input.deviceId !== run.task.keyringId) throw toolReview('DEVICE_BINDING', `Run is bound to keyring ${run.task.keyringId}`);
        const state = await oneM2M.latestCon(run.task.paths.keyringState); const event = await oneM2M.latestCon(run.task.paths.keyringEvents);
        if (!state) throw toolReview('DEVICE_STATE', 'Keyring state contentInstance required');
        const output = { deviceId: run.task.keyringId, battery: state.battery, bleSeenBy: state.bleSeenBy, bleLastSeenLocal: scene.map.localTime(Date.parse(state.t), true), button: state.button ?? 'idle',
          ...(event?.type === 'PANIC' ? { lastPanicLocal: scene.map.localTime(Date.parse(event.t), true) } : {}), stateRecordPath: `${run.task.paths.keyringState}/la` };
        return read(context, 'oneM2M', 'readDeviceState', input, output);
      },
      async submitTriage(input, context) {
        const { run } = bind(context, 'bubble:command', 'submitTriage');
        if (input.alertId !== run.task.alertId) throw toolReview('ALERT_BINDING', `Run is bound to alert ${run.task.alertId}`);
        const findings = explanationFindings(input.explanation);
        if (findings.length) throw toolReview('EXPLANATION_PRIVACY', `${findings.join('; ')}; use times and place names`);
        if (!ACTION_SEVERITY[input.action].includes(input.severity)) throw toolReview('ACTION_SEVERITY', `action ${input.action} takes severity ${ACTION_SEVERITY[input.action].join(' or ')}`);
        const floor = actionFloor(run.task.alertKind);
        if (actionRank(input.action) < actionRank(floor.minimumAction)) throw toolReview('ACTION_FLOOR', `alert kind ${run.task.alertKind} requires at least ${floor.minimumAction}: ${floor.reason}`);
        const triageId = `triage-${context.operationKey.slice(0, 16)}`; const at = scene.nowMs();
        const triage = { type: 'TRIAGE_DECISION', triageId, runId: run.runId, alertId: run.task.alertId, alertKind: run.task.alertKind, severity: input.severity, action: input.action, explanation: input.explanation, checked: input.checked, recheckMinutes: input.recheckMinutes ?? null,
          decidedAt: new Date(at).toISOString(), decidedLocal: local(at), agentPrincipalId: run.agentPrincipalId, grantRevision: run.grantRevision };
        const record = await oneM2M.createCin(run.task.paths.triageLog, triage, { rn: triageId });
        let incident = null; let inbox = null;
        if (input.action !== 'observe') {
          const open = workflow.store.list('portalIncidents').find((entry) => entry.householdId === run.task.householdId && entry.deviceId === run.task.deviceId && entry.status === 'OPEN');
          incident = open ?? { incidentId: `incident-${run.task.alertId}`.slice(0, 96), householdId: run.task.householdId, deviceId: run.task.deviceId, status: 'OPEN', source: 'ROUTINE_TRIAGE', alertId: run.task.alertId, openedAt: new Date(at).toISOString(), caseId: run.task.caseId };
          if (!open) { await workflow.store.put('portalIncidents', incident.incidentId, incident); await oneM2M.createCin(run.task.paths.incidents, { type: 'INCIDENT_OPENED', incidentId: incident.incidentId, cause: run.task.alertKind, alertId: run.task.alertId, triageId, severity: input.severity, openedLocal: local(at) }, { rn: `open-${triageId.slice(7)}` }); }
          inbox = await oneM2M.createCin(run.task.paths.guardianInbox, { type: 'TRIAGE_NOTICE', triageId, incidentId: incident.incidentId, severity: input.severity, action: input.action, explanation: input.explanation, alertKind: run.task.alertKind, sentLocal: local(at) }, { rn: `notice-${triageId.slice(7)}` });
        }
        const nextStep = input.action === 'emergencyLease' ? 'draftLocationLease' : 'appendTriageEvidence';
        const output = { triageId, alertId: run.task.alertId, severity: input.severity, action: input.action, guardianNotified: Boolean(inbox), ...(incident ? { incidentId: incident.incidentId } : {}), triageRecordPath: record.path, ...(inbox ? { inboxRecordPath: inbox.path } : {}), nextStep };
        await workflow.checkpoint(context, 'submitTriage', { input, output, update: (state) => { state.triage = { ...triage, recordPath: record.path, payloadHash: record.payloadHash }; state.incident = incident ? { incidentId: incident.incidentId, status: 'OPEN' } : null; } });
        return output;
      },
      async draftLocationLease(input, context) {
        const { run } = bind(context, 'bubble:command', 'draftLocationLease');
        const draft = { runId: run.runId, householdId: run.task.householdId, recipientId: input.recipientId, deviceId: input.deviceId, purpose: input.purpose, durationMinutes: input.durationMinutes,
          incidentId: run.incident?.incidentId ?? null, grantId: run.task.leaseGrants[input.purpose] ?? null, triageId: run.triage.triageId, alertId: run.task.alertId };
        const findings = leaseFindings(draft, run.task); const draftHash = approvalHash(draft); const draftId = `lease-draft-${context.operationKey.slice(0, 16)}`;
        const output = { draftId, draftHash, recipientId: draft.recipientId, purpose: draft.purpose, durationMinutes: draft.durationMinutes, deviceId: draft.deviceId, leastPrivilege: { withinTask: findings.length === 0, findings }, status: 'DRAFT' };
        await workflow.checkpoint(context, 'draftLocationLease', { input, output, update: (state) => {
          for (const entry of Object.values(state.drafts)) entry.superseded = true;
          state.drafts[draftId] = { draftId, draftHash, policy: draft, findings, createdAt: now(), invocation: context.invocation, superseded: false };
          delete state.steps.requestGuardianApproval;
        } });
        return output;
      },
      async requestGuardianApproval(input, context) {
        const { run } = bind(context, 'bubble:command', 'requestGuardianApproval');
        const draft = run.drafts[input.draftId];
        if (!draft || draft.superseded) throw toolReview('DRAFT_REQUIRED', 'Current draftId returned by draftLocationLease required');
        if (input.draftHash !== draft.draftHash) throw toolReview('DRAFT_HASH_MISMATCH', 'draftHash must equal the stored draft hash');
        const approvalRequestId = `approval-${context.operationKey.slice(0, 16)}`;
        const con = { type: 'APPROVAL_REQUEST', approvalRequestId, runId: run.runId, draftId: draft.draftId, draftHash: draft.draftHash, lease: draft.policy, findings: draft.findings, explanation: run.triage.explanation, requestedLocal: nowLocal() };
        const record = await oneM2M.createCin(run.task.paths.approvals, { ...con, payloadHash: approvalHash(con) }, { rn: approvalRequestId });
        const output = { approvalRequestId, draftHash: draft.draftHash, status: 'PENDING_GUARDIAN', requestRecordPath: record.path };
        await workflow.checkpoint(context, 'requestGuardianApproval', { input, output, update: (state) => {
          state.approvals[approvalRequestId] = { approvalRequestId, draftId: draft.draftId, draftHash: draft.draftHash, status: 'PENDING_GUARDIAN', sequence: Object.keys(state.approvals).length + 1, requestedAt: now(), requestRecordPath: record.path, invocation: context.invocation };
        } });
        return output;
      },
      async applyApprovedLease(input, context) {
        const { run, grant } = bind(context, 'bubble:command', 'applyApprovedLease');
        const { draft, approval } = workflow.verifyApproval(run, input.draftId, input.approvalHash);
        const policy = draft.policy;
        const lease = await privacy.createLease(guardianPrincipal, { idempotencyKey: `lease-${approval.approvalHash.slice(0, 24)}`, grantId: policy.grantId, recipientId: policy.recipientId, deviceIds: [policy.deviceId], incidentId: policy.incidentId, purpose: policy.purpose, ttlSec: policy.durationMinutes * 60 });
        const con = { type: 'LOCATION_LEASE', leaseId: lease.leaseId, runId: run.runId, recipientId: lease.recipientId, purpose: lease.purpose, deviceIds: lease.deviceIds, incidentId: lease.incidentId, expiresAt: lease.expiresAt, grantId: lease.grantId,
          grantRevision: lease.grantRevision, draftHash: draft.draftHash, approvalRequestId: approval.approvalRequestId, approvalHash: approval.approvalHash, triageGrantRevision: grant.revision };
        const payloadHash = approvalHash(con);
        const record = await oneM2M.createCin(run.task.paths.leases, { ...con, payloadHash }, { rn: `lease-${approval.approvalHash.slice(0, 16)}` });
        const output = { status: 'APPLIED', leaseId: lease.leaseId, recipientId: lease.recipientId, purpose: lease.purpose, expiresAt: lease.expiresAt, grantRevision: lease.grantRevision, leaseRecordPath: record.path, payloadHash };
        await workflow.checkpoint(context, 'applyApprovedLease', { input, output, update: (state) => {
          state.approvals[approval.approvalRequestId].consumedAt = now();
          state.approvalChecks.push({ result: 'ACCEPTED', reason: 'APPROVAL_HASH_MATCH', draftId: draft.draftId, presentedHashPrefix: input.approvalHash.slice(0, 12), invocation: context.invocation, at: now() });
          state.lease = { ...output, approvalHash: approval.approvalHash, draftHash: draft.draftHash, incidentId: lease.incidentId, deviceIds: lease.deviceIds };
        } });
        return output;
      },
    },
    MEC: {
      async queryUeLocation(input, context) {
        bind(context, 'mec:location', 'queryUeLocation');
        const point = await mec.locate(scene.ueAddress);
        const match = scene.map.match(point); const corridor = scene.map.match(point, scene.corridor);
        const lastFix = scene.lastFix();
        const output = { source: `ETSI MEC013 v3 queries/users${point.mep ? ` (${point.mep})` : ''}`, zoneId: point.zoneId ?? 'unknown', accessPointId: point.accessPointId ?? 'unknown', grid: { lat: grid3(point.lat), lon: grid3(point.lon), decimals: 3 },
          segment: { name: match.distanceM <= (scene.profile.params.corridorTolM ?? 35) ? match.name : 'unmapped area', kind: match.distanceM <= (scene.profile.params.corridorTolM ?? 35) ? match.kind : 'unknown' },
          onCorridor: (corridor?.distanceM ?? Infinity) <= (scene.profile.params.corridorTolM ?? 35), distanceHomeM: round10(scene.map.distanceHomeM(point)),
          movedSinceLastFixM: lastFix ? round10(haversineM(lastFix, point)) : 0, lastFixLocal: lastFix ? local(lastFix.t) : nowLocal(), observedLocal: nowLocal() };
        return read(context, 'MEC', 'queryUeLocation', input, output);
      },
      async queryZoneStatus(input, context) {
        bind(context, 'mec:location', 'queryZoneStatus');
        const zone = await mec.zone(input.zoneId);
        const output = { source: `ETSI MEC013 v3 queries/zones${zone.mep ? ` (${zone.mep})` : ''}`, zoneId: zone.zoneId ?? input.zoneId, numberOfAccessPoints: zone.numberOfAccessPoints ?? 0, numberOfUnserviceableAccessPoints: zone.numberOfUnserviceableAccessPoints ?? 0, numberOfUsers: zone.numberOfUsers ?? 0 };
        return read(context, 'MEC', 'queryZoneStatus', input, output);
      },
      async queryServingCell(input, context) {
        const { run } = bind(context, 'mec:rnis', 'queryServingCell');
        const cell = await mec.cell(scene.ueAddress);
        const toMs = scene.nowMs(); const fromMs = toMs - input.minutes * 60000; const changes = [];
        for (const entry of await oneM2M.listChildren(run.task.paths.rnis)) {
          const ms = Number(/^c(\d+)$/.exec(entry.rn)?.[1]) * 1000;
          if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) continue;
          const con = await oneM2M.readCon(entry.path); if (con) changes.push({ ms, localTime: local(ms), fromCell: String(con.srcCellId ?? 'unknown'), toCell: String(con.trgCellId ?? 'unknown') });
        }
        changes.sort((a, b) => a.ms - b.ms);
        const output = { source: `ETSI MEC012 RNIS rab_info${cell?.mep ? ` (${cell.mep})` : ''}`, cellId: String(cell?.cellId ?? 'none'), observedLocal: nowLocal(), cellChangesInWindow: changes.length, recentCellChanges: changes.slice(-12).map(({ ms, ...rest }) => rest) };
        return read(context, 'MEC', 'queryServingCell', input, output);
      },
    },
    Audit: {
      async readExecution(input, context) {
        const { run } = workflow.current(context.runId, { scope: 'audit:read' });
        if (input.runId !== run.runId) throw toolReview('RUN_BINDING', 'Agent session is bound to a different runId');
        return workflow.executionView(run);
      },
      async appendTriageEvidence(input, context) {
        const { run } = bind(context, 'audit:write', 'appendTriageEvidence');
        if (input.runId !== run.runId) throw toolReview('RUN_BINDING', 'Agent session is bound to a different runId');
        const evidence = { runId: run.runId, taskHash: run.taskHash, alertId: run.task.alertId, alertHash: run.alert?.alertHash ?? null, grantId: run.grantId, grantRevision: run.grantRevision,
          readCalls: run.readCalls.map(({ serverId, tool, outputHash, invocation }) => ({ serverId, tool, outputHash, invocation })),
          steps: TRIAGE.steps.filter((step) => run.steps[step]?.status === 'COMPLETED').map((step) => ({ step, outputHash: run.steps[step].outputHash, invocation: run.steps[step].invocation })),
          triage: run.triage ? { triageId: run.triage.triageId, severity: run.triage.severity, action: run.triage.action, payloadHash: run.triage.payloadHash } : null, incidentId: run.incident?.incidentId ?? null,
          lease: run.lease ? { leaseId: run.lease.leaseId, approvalHash: run.lease.approvalHash, draftHash: run.lease.draftHash, payloadHash: run.lease.payloadHash } : null };
        const evidenceHash = approvalHash(evidence); const evidenceId = `evidence-${context.operationKey.slice(0, 16)}`;
        const record = await oneM2M.createCin(run.task.paths.audit, { type: 'TRIAGE_EVIDENCE', evidenceId, evidenceHash, evidence, summary: input.summary }, { rn: evidenceId });
        const output = { evidenceId, evidenceHash, evidenceRecordPath: record.path, recordedAt: now(), status: 'COMPLETED' };
        await workflow.checkpoint(context, 'appendTriageEvidence', { input, output, update: (state) => { state.evidence = { ...output, summaryHash: approvalHash(input.summary) }; } });
        await workflow.receipt(run, 'TRIAGE_RUN_EVIDENCE', { evidenceId, evidenceHash, evidenceRecordPath: record.path });
        return output;
      },
    },
  };
}

/** Real oneM2M adapter over the HTTP binding, acting as the triage AE originator. */
export function createOneM2mTriageAdapter({ client }) {
  if (!client?.originator) throw new Error('oneM2M client with the triage AE originator required');
  const content = (payload) => parseContent(payload?.['m2m:cin']?.con);
  return {
    transport: 'oneM2M HTTP binding RVI 4',
    async readCon(path) { const result = await client.retrieve(path); if (result.rsc !== 2000) throw toolReview('CSE_READ', `oneM2M retrieve returned ${result.rsc}`); return content(result.payload); },
    async latestCon(container) { const result = await client.retrieve(`${container}/la`); if (result.rsc === 4004) return null; if (result.rsc !== 2000) throw toolReview('CSE_READ', `oneM2M latest returned ${result.rsc}`); return content(result.payload); },
    async listChildren(container) {
      const result = await client.retrieve(container, { fu: 1, ty: 4 });
      if (result.rsc !== 2000) throw toolReview('CSE_DISCOVERY', `oneM2M discovery returned ${result.rsc}`);
      return (result.payload?.['m2m:uril'] ?? []).slice(0, 400).map((uri) => `/${String(uri).replace(/^\/+/, '')}`).filter((path) => path.startsWith(`${container}/`)).map((path) => ({ path, rn: path.slice(container.length + 1) }));
    },
    async createCin(container, con, { rn = undefined, loc = undefined, lbl = undefined } = {}) {
      const payloadHash = approvalHash(con);
      const result = await client.create(container, 4, { 'm2m:cin': { ...(rn ? { rn } : {}), cnf: 'application/json', con, ...(loc ? { loc } : {}), ...(lbl ? { lbl } : {}) } });
      if (result.rsc !== 2001) throw toolReview('CSE_WRITE', `oneM2M contentInstance create returned ${result.rsc}`);
      const name = result.payload?.['m2m:cin']?.rn ?? rn;
      return { path: `${container}/${name}`, ri: result.payload?.['m2m:cin']?.ri ?? null, payloadHash };
    },
  };
}

/**
 * Real MEC adapter: MEC013 v3 users/zones and MEC012 rab_info through MecPlatformClient (pinned CA). With several MEPs
 * (MEC013/MEC012 locality per MEP) the adapter asks each MEP in order and returns the first one that lists the UE.
 */
export function createMecTriageAdapter({ platform = null, platforms = null }) {
  const list = (platforms ?? [platform]).filter(Boolean);
  if (!list.length) throw new Error('MecPlatformClient required');
  const guard = async (operation, label) => { try { return await operation(); } catch (error) { if (error?.code === 'MCP_TOOL_REVIEW') throw error; throw toolReview('MEC_QUERY', `${label} request failed (${error.code ?? 'transport'})`); } };
  const mepOf = (client) => client.platformRoot.split('/').at(-1);
  return {
    async locate(address) {
      for (const client of list) { const user = await guard(() => client.queryUser(address), 'MEC013 user query'); if (user) return { ...user, mep: mepOf(client) }; }
      throw toolReview('MEC_LOCATION', 'MEC013 response for the bound UE required');
    },
    async zone(zoneId) {
      for (const client of list) {
        try { const response = await client.request('GET', `${client.apiRoot('Location')}/queries/zones/${encodeURIComponent(zoneId)}`, undefined, [200]); if (response.data?.zoneInfo) return { ...response.data.zoneInfo, mep: mepOf(client) }; } catch { /* next MEP */ }
      }
      throw toolReview('MEC_ZONE', `MEC013 zone ${zoneId} is not served by the configured MEPs`);
    },
    async cell(address) {
      for (const client of list) { const cell = await guard(() => client.queryCell(address), 'MEC012 rab_info query'); if (cell) return { ...cell, mep: mepOf(client) }; }
      return null;
    },
  };
}

/**
 * Deterministic triage policy over the same MCP tools (the --agent=scripted dry path). It follows fixed per-kind tool
 * lists and templated explanations; the LLM agent chooses tools and wording itself.
 */
export async function scriptedTriage({ call, runId, alertId, keyringId, deviceId, guardianId }) {
  const view = await call('Audit', 'readExecution', { runId });
  if (view.nextStep === 'NONE') return { view };
  const alert = await call('oneM2M', 'readAlert', { alertId }); const checked = ['readAlert'];
  let severity; let action; let explanation;
  if (alert.kind === 'SIGNAL_GAP') {
    const cell = await call('MEC', 'queryServingCell', { minutes: 15 }); const ue = await call('MEC', 'queryUeLocation', {}); checked.push('queryServingCell', 'queryUeLocation');
    const moving = ue.onCorridor && ue.movedSinceLastFixM >= 30;
    [severity, action] = moving ? ['info', 'observe'] : ['watch', 'checkIn'];
    explanation = moving
      ? `Location updates paused near the ${alert.segment.name} since ${alert.startedLocal}; the network still serves her (cell ${cell.cellId}) and she is on her usual route at the ${ue.segment.name}, ${ue.movedSinceLastFixM} m further on.`
      : `No location update since ${alert.startedLocal} near the ${alert.segment.name} and no progress along her usual route. Please give her a call.`;
  } else if (alert.kind === 'DEVICE_SEPARATION') {
    const device = await call('oneM2M', 'readDeviceState', { deviceId: keyringId }); const ue = await call('MEC', 'queryUeLocation', {}); checked.push('readDeviceState', 'queryUeLocation');
    [severity, action] = ['watch', 'checkIn'];
    explanation = `Her keyring with the PANIC button was last seen by the ${device.bleSeenBy} at ${device.bleLastSeenLocal.slice(0, 5)} while she walks on the ${ue.segment.name}, about ${ue.distanceHomeM} m from home. Please call her.`;
  } else {
    await call('oneM2M', 'readRecentHistory', { minutes: 20 }); const profile = await call('oneM2M', 'readRoutineProfile', {}); const ue = await call('MEC', 'queryUeLocation', {}); checked.push('readRecentHistory', 'readRoutineProfile', 'queryUeLocation');
    const urgent = (alert.features.minutesAfterSunset ?? -1) > 0 && (!ue.onCorridor || alert.features.reversals >= 1);
    [severity, action] = urgent ? ['urgent', 'emergencyLease'] : ['watch', 'checkIn'];
    const since = alert.features.offCorridorSince ? `Since ${alert.features.offCorridorSince} off her usual loop` : `Since ${alert.startedLocal} stopped on her usual route`;
    explanation = `${since}; about ${Math.max(1, Math.round(alert.features.dwellSec / 60))} min at the ${ue.segment.name} going back and forth after sunset (${profile.sunsetLocal}). She is usually home by ${profile.usualReturn}.`;
  }
  const triage = await call('oneM2M', 'submitTriage', { alertId, severity, action, explanation: explanation.slice(0, 280), checked });
  if (action === 'emergencyLease') {
    const draft = await call('oneM2M', 'draftLocationLease', { recipientId: guardianId, purpose: 'wandering-check', durationMinutes: 5, deviceId });
    const request = await call('oneM2M', 'requestGuardianApproval', { draftId: draft.draftId, draftHash: draft.draftHash });
    return { alert, triage, draft, request, pending: true };
  }
  const evidence = await call('Audit', 'appendTriageEvidence', { runId, summary: `scripted triage ${alert.kind}: ${action} (${severity})` });
  return { alert, triage, evidence, pending: false };
}

/** Triage AE resume after the guardian decision: no judgement left, so it runs without an LLM. */
export async function resumeTriageAfterApproval({ call, runId }) {
  const view = await call('Audit', 'readExecution', { runId });
  if (view.nextStep !== 'applyApprovedLease' || view.approval.status !== 'APPROVED') return { view, applied: null };
  const applied = await call('oneM2M', 'applyApprovedLease', { draftId: view.approval.draftId, approvalHash: view.approval.approvalHash });
  const evidence = await call('Audit', 'appendTriageEvidence', { runId, summary: `guardian approved the location lease ${applied.leaseId}; triage AE resumed from ${view.nextStep}` });
  return { view, applied, evidence };
}

/** Location contentInstance written by the collector: segment, corridor flag and 3-decimal grid in clear, precise point only as an encrypted reference. */
export function locationRecord({ map, profile, sample, zoneId = null, accessPointId = null, precise = null, source = 'ETSI MEC013 v3 queries/users' }) {
  const tol = profile.params.corridorTolM; const match = map.match(sample); const corridor = map.match(sample, new Set(Object.keys(profile.corridor)));
  const home = map.distanceHomeM(sample) <= map.homeRadiusM;
  return { rn: `s${Math.round(sample.t / 1000)}`, loc: { typ: 1, crd: JSON.stringify([grid3(sample.lon), grid3(sample.lat)]) },
    con: { schema: 'pb.location.sample.v1', t: new Date(sample.t).toISOString(), localTime: map.localTime(sample.t, true), segment: home ? 'home' : match.distanceM <= tol ? match.name : 'unmapped area', segmentKind: home ? 'home' : match.distanceM <= tol ? match.kind : 'unknown',
      onCorridor: home || (corridor?.distanceM ?? Infinity) <= tol, zoneId, accessPointId, grid: { lat: grid3(sample.lat), lon: grid3(sample.lon) }, source, ...(precise ? { precise } : {}) } };
}

/** Guardian authority for the triage profile: household, devices, a triage grant and one location:read grant per lease purpose. */
export async function seedTriageAuthority({ store, policyService, portalService, householdId, guardianId, deviceId, keyringId, ttlSec = 86400 }) {
  const guardian = { principalId: guardianId, scopes: ['mcp:run', 'policy:approve', 'consent:write', 'grant:write', 'grant:revoke', 'portal:read'] };
  await portalService.provisionHousehold({ householdId, name: 'Resident household', ownerId: guardianId });
  await store.put('portalDevices', deviceId, { deviceId, householdId, kind: 'relay-ue' });
  await store.put('portalDevices', keyringId, { deviceId: keyringId, householdId, kind: 'keyring' });
  const consent = await policyService.createConsent({ principal: guardian, subjectId: householdId, purpose: 'anomaly triage agent context', scopes: McpTriageWorkflow.scopes, ttlSec });
  const triageGrant = await policyService.createGrant({ principal: guardian, consentId: consent.consentId, scopes: McpTriageWorkflow.scopes, ttlSec, purpose: 'anomaly-triage' });
  const leaseConsent = await policyService.createConsent({ principal: guardian, subjectId: householdId, purpose: 'guardian-approved emergency location lease', scopes: ['location:read'], ttlSec });
  const leaseGrants = {};
  for (const purpose of TRIAGE.leasePurposes) leaseGrants[purpose] = (await policyService.createGrant({ principal: guardian, consentId: leaseConsent.consentId, scopes: ['location:read'], ttlSec, purpose })).grantId;
  return { guardian, triageGrant, leaseGrants };
}

export const triageToolNames = () => Object.entries(MCP_TRIAGE_CONTRACT.servers).flatMap(([serverId, definition]) => definition.tools.map((tool) => `mcp__${serverId.toLowerCase()}__${tool.name}`));
