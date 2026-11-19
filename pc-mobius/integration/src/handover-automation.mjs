import { performance } from 'node:perf_hooks';
import { pointInGeofence } from './mec-state.mjs';
import { edgeScore } from './handover-coordinator.mjs';
import { requireTelemetryShape } from '../../src/gateway-bridge.mjs';

const terminal = new Set(['ACTIVE', 'ROLLED_BACK']);
const makeBeforeBreak = new Set(['CHECKPOINT', 'REGISTER_TARGET', 'RESTORE']);

/**
 * 위치(MEC zone 정책), CSE 가용성(probe 실패), 성능(probe RTT EWMA와 load)을 HandoverCoordinator.considerTrigger로 연결한다.
 * 이 controller는 handover를 직접 호출하지 않고, 트리거의 체류, cooldown, grant 검사를 coordinator 정책에 맡긴다.
 */
export class HandoverAutomation {
  constructor({ coordinator, reconciler = null, ueId, grantId, zones = [], zonePolicies = [], clock = () => new Date().toISOString(), now = () => performance.now(), locationSimulation = true, resumeBackoffMs = 250, onEvent = () => {} }) {
    if (!coordinator || !ueId || !grantId) throw new Error('자동 이동 coordinator, UE, grant를 설정하세요.');
    Object.assign(this, { coordinator, reconciler, ueId, grantId, zones, zonePolicies, clock, now, locationSimulation, resumeBackoffMs, onEvent });
    this.zone = null; this.location = null; this.sequence = 0; this.timers = []; this.busy = new Set(); this.lastResumeAt = -Infinity;
  }
  emit(event) { try { this.onEvent({ at: this.now(), ...event }); } catch { /* 측정 listener 오류는 무시한다. */ } }
  session() { return this.coordinator.status(this.ueId); }
  grantRevision() { return this.coordinator.policyService?.evaluateGrant(this.grantId)?.grant?.revision; }
  zoneOf(location) { return this.zones.find((zone) => pointInGeofence(location, zone.geofence))?.zoneId ?? null; }
  record(kind, result, before, details = {}) {
    if (result?.handoverId && result.handoverId !== before && result.state !== 'WAITING') this.emit({ type: 'trigger-fired', kind, handoverId: result.handoverId, state: result.state, phase: result.phase, epoch: result.epoch, edgeId: result.edgeId, reviewReason: result.reviewReason, ...details });
    return result;
  }
  /** MEC Location 보고를 zone 정책마다 reconciler에 전달한다. zone 정책은 승인된 targetEdgeId와 geofence를 가진다. */
  async onLocation({ location, observedAt = this.clock(), eventKey = `location-${++this.sequence}` }) {
    this.location = location; this.zone = this.zoneOf(location);
    const results = [];
    for (const policy of this.zonePolicies) {
      const event = { eventId: `${eventKey}:${policy.policyId}`, eventKey: `${eventKey}:${policy.policyId}`, service: 'Location', ueId: this.ueId, observedAt, clockQuality: 'VERIFIED', location, health: { status: 'HEALTHY' }, simulation: this.locationSimulation, intent: { policyId: policy.policyId, policyRevision: policy.policyRevision, grantId: this.grantId, grantRevision: this.grantRevision() } };
      const before = this.session()?.handoverId;
      const outcome = await this.reconciler.reconcileApprovedIntent(event);
      if (outcome.handoverId && outcome.handoverId !== before && outcome.triggerState && outcome.triggerState !== 'WAITING') this.emit({ type: 'trigger-fired', kind: 'zone', handoverId: outcome.handoverId, state: outcome.triggerState, zone: this.zone, policyId: policy.policyId });
      results.push(outcome);
    }
    return results;
  }
  /** CSE base RTT를 측정하고, 소유 CSE의 연속 실패는 availability 트리거로, 복구는 지연 fence 정산으로 연결한다. */
  async probeEdge(edgeId) {
    if (this.busy.has(`probe:${edgeId}`)) return null;
    this.busy.add(`probe:${edgeId}`);
    try {
      const client = this.coordinator.clients.get(edgeId); const started = this.now(); let ok = true; let reason = null;
      try { await client.health(); } catch (error) { ok = false; reason = error.code ?? 'CSE_PROBE_REVIEW'; }
      const rttMs = this.now() - started;
      let edge = this.coordinator.recordProbe(edgeId, { ok, rttMs, at: this.clock() });
      this.emit({ type: 'probe', edgeId, ok, rttMs, reason, health: edge.health, latencyMs: edge.latencyMs, probeFailures: edge.probeFailures });
      if (edge.health === 'RECOVERING') {
        const reconciled = await this.coordinator.reconcileRecoveredEdge(edgeId);
        edge = this.coordinator.edges.get(edgeId);
        this.emit({ type: 'edge-reconciled', edgeId, applied: reconciled.applied, health: edge.health });
      }
      const session = this.session();
      if (session?.edgeId === edgeId && terminal.has(session.state) && !this.coordinator.running.has(this.ueId)) {
        if (!ok) await this.availability(edgeId, { failures: edge.probeFailures, reason });
        else for (const other of this.coordinator.edges.keys()) if (other !== edgeId) await this.reset(other, 'availability');
      }
      return edge;
    } finally { this.busy.delete(`probe:${edgeId}`); }
  }
  async reset(targetEdgeId, kind) {
    const prior = this.coordinator.store.get('handoverTriggers', `${this.ueId}:${targetEdgeId}:${kind}`);
    if (prior?.eligible) await this.coordinator.resetTrigger({ ueId: this.ueId, targetEdgeId, kind, observedAt: this.clock() });
  }
  async availability(failedEdgeId, details = {}) {
    const target = await this.coordinator.selectEligibleEdge({ zone: this.zone ?? undefined, exclude: [failedEdgeId] });
    if (!target) { this.emit({ type: 'availability-no-target', edgeId: failedEdgeId, zone: this.zone }); return null; }
    const before = this.session()?.handoverId;
    const result = await this.coordinator.considerTrigger({ ueId: this.ueId, targetEdgeId: target.edgeId, grantId: this.grantId, grantRevision: this.grantRevision(), kind: 'availability', healthy: false, observedAt: this.clock(), eventKey: `availability-${failedEdgeId}-${++this.sequence}` });
    return this.record('availability', result, before, { sourceEdgeId: failedEdgeId, targetEdgeId: target.edgeId, ...details });
  }
  /** 현재 zone에서 소유 Edge와 최선 Edge의 load+latency 점수 차이를 performance 트리거로 전달한다. */
  async evaluatePerformance() {
    if (this.busy.has('performance')) return null;
    this.busy.add('performance');
    try {
      const session = this.session();
      if (!session || !terminal.has(session.state) || this.coordinator.running.has(this.ueId)) return null;
      const owner = this.coordinator.edges.get(session.edgeId);
      if (!owner || owner.health !== 'HEALTHY' || (this.zone && !owner.zones?.includes(this.zone))) return null;
      const best = await this.coordinator.selectEligibleEdge({ zone: this.zone ?? undefined });
      if (!best) return null;
      if (best.edgeId === owner.edgeId) { for (const other of this.coordinator.edges.keys()) if (other !== owner.edgeId) await this.reset(other, 'performance'); return null; }
      const weights = { latencyBudgetMs: this.coordinator.triggerPolicy.latencyBudgetMs, latencyWeight: this.coordinator.triggerPolicy.latencyWeight };
      const scoreGain = edgeScore(owner, weights) - best.score;
      const before = session.handoverId;
      const result = await this.coordinator.considerTrigger({ ueId: this.ueId, targetEdgeId: best.edgeId, grantId: this.grantId, grantRevision: this.grantRevision(), kind: 'performance', healthy: true, scoreGain, observedAt: this.clock(), eventKey: `performance-${++this.sequence}` });
      return this.record('performance', result, before, { sourceEdgeId: owner.edgeId, targetEdgeId: best.edgeId, scoreGain, ownerLatencyMs: owner.latencyMs, targetLatencyMs: best.latencyMs, ownerLoad: owner.load, targetLoad: best.load });
    } finally { this.busy.delete('performance'); }
  }
  /** 검토 상태로 멈춘 이동은 backoff 뒤 같은 handoverId로 이어서 실행한다. */
  async resumeSettling() {
    const session = this.session();
    if (session?.state !== 'SETTLING' || this.coordinator.running.has(this.ueId) || this.now() - this.lastResumeAt < this.resumeBackoffMs) return null;
    this.lastResumeAt = this.now();
    const result = await this.coordinator.resume(this.ueId);
    this.emit({ type: 'resume', handoverId: result.handoverId, state: result.state, phase: result.phase, reviewReason: result.reviewReason });
    return result;
  }
  async checkpoint() {
    if (this.busy.has('checkpoint') || this.coordinator.running.has(this.ueId)) return null;
    this.busy.add('checkpoint');
    try { return await this.coordinator.checkpoint(this.ueId); } catch { return null; } finally { this.busy.delete('checkpoint'); }
  }
  start({ probeIntervalMs = 100, evaluateIntervalMs = 200, checkpointIntervalMs = 500 } = {}) {
    const guard = (operation) => () => operation().catch((error) => this.emit({ type: 'automation-review', message: error.message }));
    for (const edgeId of this.coordinator.clients.keys()) this.timers.push(setInterval(guard(() => this.probeEdge(edgeId)), probeIntervalMs));
    this.timers.push(setInterval(guard(async () => { await this.resumeSettling(); await this.evaluatePerformance(); }), evaluateIntervalMs));
    this.timers.push(setInterval(guard(() => this.checkpoint()), checkpointIntervalMs));
    return this;
  }
  stop() { for (const timer of this.timers) clearInterval(timer); this.timers = []; }
}

/**
 * Gateway telemetry를 sequence 단위 관측으로 받아 현재 ownership epoch의 CSE에 CIN으로 기록한다.
 * cutover 구간(DRAIN, CUTOVER, VERIFY)과 검토 상태에서는 Gateway 쪽에 보관하고, 전송 실패는 재시도한다.
 * 같은 sequence 재전송은 dedup key(deviceId:sequence)와 payload hash로 정리한다.
 */
export class ObservationForwarder {
  constructor({ coordinator, ueId, concurrency = 4, retryMs = 40, holdMs = 10, markFlushMs = 100, mirror = false, mirrorConcurrency = 2, mirrorQueueLimit = 5000, now = () => performance.now(), onEvent = () => {} }) {
    Object.assign(this, { coordinator, ueId, concurrency, retryMs, holdMs, markFlushMs, mirror, mirrorConcurrency, mirrorQueueLimit, now, onEvent });
    this.store = coordinator.store; this.queue = new Map(); this.done = new Map(); this.inFlight = 0; this.marks = []; this.timers = [];
    this.mirrorQueue = []; this.mirrorInFlight = 0;
    this.counts = { submitted: 0, accepted: 0, retransmissionsSuppressed: 0, holds: 0, writeFailures: 0, liveWrites: 0, replayDelivered: 0, cseDuplicateWrites: 0, mirrored: 0, mirrorFailures: 0, mirrorDropped: 0 };
  }
  emit(event) { try { this.onEvent({ at: this.now(), ...event }); } catch { /* 측정 listener 오류는 무시한다. */ } }
  /** 현재 기록할 CSE. make-before-break 구간은 출발 CSE, cutover 구간과 검토 상태는 보관(null)이다. */
  route() {
    const session = this.coordinator.status(this.ueId);
    if (!session) return null;
    if (terminal.has(session.state)) return session.edgeId;
    if (session.state !== 'SETTLING' && makeBeforeBreak.has(session.phase) && !session.sourceUnavailable) return session.previousEdgeId;
    return null;
  }
  submit(telemetry, producedAt = this.now()) {
    requireTelemetryShape(telemetry);
    this.counts.submitted++;
    const key = `${telemetry.deviceId}:${telemetry.sequence}`;
    if (this.queue.has(key) || this.done.has(key)) { this.counts.retransmissionsSuppressed++; this.emit({ type: 'retransmission-suppressed', sequence: telemetry.sequence }); return { duplicate: true, key }; }
    this.queue.set(key, { key, sequence: telemetry.sequence, telemetry, producedAt, nextAt: 0, attempts: 0, record: null });
    this.tick();
    return { duplicate: false, key };
  }
  tick() {
    const now = this.now();
    for (const item of this.queue.values()) {
      if (this.inFlight >= this.concurrency) break;
      if (item.busy || item.nextAt > now) continue;
      item.busy = true; this.inFlight++;
      this.process(item).catch((error) => { item.nextAt = this.now() + this.retryMs; this.emit({ type: 'forwarder-review', sequence: item.sequence, message: error.message }); })
        .finally(() => { item.busy = false; this.inFlight--; setImmediate(() => this.tick()); });
    }
  }
  async process(item) {
    const edgeId = this.route();
    if (!edgeId) { item.nextAt = this.now() + this.holdMs; if (!item.held) { item.held = true; this.counts.holds++; } return; }
    if (!item.record) {
      item.record = await this.coordinator.acceptObservation({ ueId: this.ueId, sequence: item.sequence, payload: item.telemetry });
      if (!item.record.duplicate) this.counts.accepted++;
      item.acceptedAt = this.now();
    }
    const row = this.store.get('handoverObservations', `${this.ueId}:${item.sequence}`);
    const binding = this.store.get('logicalBindings', `${this.ueId}:${edgeId}`);
    const client = this.coordinator.clients.get(edgeId);
    if (!row || !binding || !client) { item.nextAt = this.now() + this.retryMs; return; }
    const prior = row.applied?.[edgeId];
    if (prior?.payloadHash === row.payloadHash && prior.containerRi === binding.resources.observations.ri) return this.finish(item, edgeId, 'replay', false);
    const epoch = this.coordinator.status(this.ueId)?.epoch;
    let result;
    try { result = await client.applyObservation(binding, row); }
    catch (error) { item.attempts++; item.nextAt = this.now() + this.retryMs; this.counts.writeFailures++; this.emit({ type: 'write-failed', edgeId, sequence: item.sequence, reason: error.code ?? 'CSE_WRITE_REVIEW' }); return; }
    this.marks.push({ key: row.key, edgeId, applied: { ...result, containerRi: binding.resources.observations.ri, appliedAt: new Date().toISOString() } });
    this.counts.liveWrites++; if (result.duplicate) this.counts.cseDuplicateWrites++;
    this.emit({ type: 'observation-applied', via: 'live', edgeId, sequence: item.sequence, duplicate: Boolean(result.duplicate), epoch });
    return this.finish(item, edgeId, 'live', Boolean(result.duplicate));
  }
  finish(item, edgeId, via, duplicate) {
    if (via === 'replay') this.counts.replayDelivered++;
    this.queue.delete(item.key);
    this.done.set(item.key, { sequence: item.sequence, edgeId, via, duplicate, producedAt: item.producedAt, deliveredAt: this.now(), attempts: item.attempts, held: Boolean(item.held) });
    if (this.mirror) {
      this.mirrorQueue.push({ sequence: item.sequence, primary: edgeId });
      if (this.mirrorQueue.length > this.mirrorQueueLimit) { this.mirrorQueue.shift(); this.counts.mirrorDropped++; }
      this.mirrorTick();
    }
  }
  /** warm standby: 소유 CSE에 기록한 관측을 HEALTHY 대기 CSE에도 같은 CIN 이름으로 복제해 다음 이동의 replay 양을 줄인다. */
  mirrorTick() {
    while (this.mirrorInFlight < this.mirrorConcurrency && this.mirrorQueue.length) {
      const job = this.mirrorQueue.shift(); this.mirrorInFlight++;
      this.mirrorOne(job).catch(() => { this.counts.mirrorFailures++; }).finally(() => { this.mirrorInFlight--; setImmediate(() => this.mirrorTick()); });
    }
  }
  async mirrorOne({ sequence, primary }) {
    const row = this.store.get('handoverObservations', `${this.ueId}:${sequence}`); if (!row) return;
    for (const [edgeId, edge] of this.coordinator.edges) {
      if (edgeId === primary || edge.health !== 'HEALTHY') continue;
      const binding = this.store.get('logicalBindings', `${this.ueId}:${edgeId}`); const client = this.coordinator.clients.get(edgeId);
      if (!binding?.resources?.observations || !client) continue;
      const prior = row.applied?.[edgeId];
      if (prior?.payloadHash === row.payloadHash && prior.containerRi === binding.resources.observations.ri) continue;
      try {
        const result = await client.applyObservation(binding, row);
        this.marks.push({ key: row.key, edgeId, applied: { ...result, containerRi: binding.resources.observations.ri, appliedAt: new Date().toISOString() } });
        this.counts.mirrored++; this.emit({ type: 'observation-mirrored', edgeId, sequence, duplicate: Boolean(result.duplicate) });
      } catch { this.counts.mirrorFailures++; }
    }
  }
  async flushMarks() {
    if (!this.marks.length) return 0;
    const marks = this.marks; this.marks = [];
    await this.store.transaction(`observation:${this.ueId}`, async () => {
      for (const mark of marks) {
        const current = this.store.get('handoverObservations', mark.key);
        if (current) await this.store.put('handoverObservations', mark.key, { ...current, applied: { ...current.applied, [mark.edgeId]: mark.applied } });
      }
    });
    return marks.length;
  }
  start() {
    this.timers.push(setInterval(() => this.tick(), Math.max(5, Math.min(this.retryMs, this.holdMs))));
    this.timers.push(setInterval(() => { this.flushMarks().catch((error) => this.emit({ type: 'forwarder-review', message: error.message })); }, this.markFlushMs));
    return this;
  }
  async stop() { for (const timer of this.timers) clearInterval(timer); this.timers = []; await this.flushMarks(); }
  pending() { return this.queue.size + this.inFlight; }
  mirrorPending() { return this.mirrorQueue.length + this.mirrorInFlight; }
}
