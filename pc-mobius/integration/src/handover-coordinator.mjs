import { setTimeout as delay } from 'node:timers/promises';
import { approvalHash, id, recordEnvelope } from './integration-utils.mjs';
import { OneM2mEdgeClient } from './handover-cse.mjs';
import { MecCipher } from './mec-state.mjs';
import { EdgeDeploymentClient } from './edge-deployment.mjs';

const terminal = new Set(['ACTIVE', 'ROLLED_BACK']);
const attributes = (body) => Object.values(body ?? {})[0];

/** 자동 이동 기본값. zone, health 값은 기존 정책(30초 체류, 60초 cooldown, 10초 dwell, 1초 간격 3회)과 같다. */
export const DEFAULT_TRIGGER_POLICY = Object.freeze({
  minResidenceMs: 30000, cooldownMs: 60000, zoneDwellMs: 10000, minInsideM: 20, continuityGapMs: 5000,
  healthFailures: 3, healthFailureSpacingMs: 1000,
  availabilityFailures: 3, availabilityFailureSpacingMs: 0,
  performanceDwellMs: 10000, minScoreGain: 0.25,
  latencyBudgetMs: 100, latencyWeight: 1, latencyAlpha: 0.3, probeFailuresForDown: 3,
});
const TRIGGER_KINDS = new Set(['zone', 'health', 'availability', 'performance']);

/** load(0..1)와 측정 RTT를 합친 선택 점수. RTT가 없는 Edge는 latency budget 한 단위의 중립 점수를 받는다. */
export function edgeScore(edge, { latencyBudgetMs = DEFAULT_TRIGGER_POLICY.latencyBudgetMs, latencyWeight = DEFAULT_TRIGGER_POLICY.latencyWeight } = {}) {
  const load = Number.isFinite(edge?.load) ? edge.load : 0;
  const latency = Number.isFinite(edge?.latencyMs) && edge.latencyMs >= 0 ? Math.min(edge.latencyMs / latencyBudgetMs, 10) : 1;
  return load + latencyWeight * latency;
}

export class HandoverCoordinator {
  constructor({ store, policyService, clock = () => new Date().toISOString(), fetchImpl = globalThis.fetch, drainBudgetMs = 2000, attemptBudgetMs = 10000, triggerPolicy = {} } = {}) {
    if (!store) throw new Error('IntegrationStore를 설정하세요.');
    Object.assign(this, { store, policyService, clock, fetchImpl, drainBudgetMs, attemptBudgetMs });
    this.triggerPolicy = { ...DEFAULT_TRIGGER_POLICY, ...triggerPolicy };
    for (const [key, value] of Object.entries(this.triggerPolicy)) if (!Number.isFinite(value) || value < 0) throw new Error(`자동 이동 정책 ${key}를 확인하세요.`);
    this.edges = new Map(); this.clients = new Map(); this.running = new Map(); this.deployers = new Map(); this.listeners = new Set();
    this.observationCipher = new MecCipher({store});
    for (const edge of store.list('handoverEdges')) this.edges.set(edge.edgeId, edge);
  }
  /** transition, replay 관측 event를 측정기와 화면에 전달한다. listener 오류는 이동 상태에 영향을 주지 않는다. */
  onEvent(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) { try { listener(event); } catch { /* 측정 listener 오류는 무시한다. */ } } }
  registerEdge(edge) {
    if (!edge?.edgeId) throw new Error('edgeId를 설정하세요.');
    const next = { ...edge, region: edge.region ?? 'local', location: edge.location ?? null, health: edge.health ?? 'HEALTHY', load: edge.load ?? 0, capabilities: edge.capabilities ?? [], subscriptions: edge.subscriptions ?? [], securityContext: edge.securityContext ?? {}, simulation: edge.simulation ?? !edge.endpoint, updatedAt: this.clock() };
    this.edges.set(next.edgeId, next);
    const { headers, fetchImpl, deployment, ...persisted } = next;
    if (deployment) {
      const { fetchImpl: transport, tls, ...publicDeployment } = deployment;
      persisted.deployment = publicDeployment;
      this.deployers.set(next.edgeId, new EdgeDeploymentClient(deployment));
    }
    if (this.store.stagePut) this.store.stagePut('handoverEdges', next.edgeId, persisted);
    else this.store.collection('handoverEdges')[next.edgeId] = persisted;
    if (edge.endpoint) this.clients.set(edge.edgeId, new OneM2mEdgeClient({ ...edge, fetchImpl: edge.fetchImpl ?? this.fetchImpl }));
    return next;
  }
  updateHealth(edgeId, patch) {
    const edge = this.edges.get(edgeId); if (!edge) throw new Error('등록된 Edge를 선택하세요.');
    return this.registerEdge({ ...edge, ...patch });
  }
  selectEdge({ capabilities = [] } = {}) {
    return [...this.edges.values()].filter((edge) => edge.health === 'HEALTHY' && capabilities.every((capability) => edge.capabilities.includes(capability))).sort((a, b) => (a.load - b.load) || String(a.edgeId).localeCompare(String(b.edgeId)))[0] ?? null;
  }
  /** CSE base probe 한 번의 결과로 RTT EWMA, 연속 실패, health를 갱신한다. 지연 fence가 남은 Edge는 RECOVERING으로 둔다. */
  recordProbe(edgeId, { ok, rttMs, at = this.clock(), load } = {}) {
    const edge = this.edges.get(edgeId); if (!edge) throw new Error('등록된 Edge를 선택하세요.');
    const { latencyAlpha, probeFailuresForDown } = this.triggerPolicy;
    const patch = { probedAt: at, ...(Number.isFinite(load) ? { load: Math.min(Math.max(load, 0), 1), loadReportedAt: at } : {}) };
    if (ok && Number.isFinite(rttMs) && rttMs >= 0) {
      patch.lastRttMs = rttMs;
      patch.latencyMs = Number.isFinite(edge.latencyMs) ? edge.latencyMs + latencyAlpha * (rttMs - edge.latencyMs) : rttMs;
      patch.probeFailures = 0;
      const deferred = this.store.list('handoverDeferredFences').some((row) => row.edgeId === edgeId && row.state === 'PENDING');
      patch.health = deferred ? 'RECOVERING' : edge.health === 'REVIEW' ? 'REVIEW' : 'HEALTHY';
      if (edge.health === 'DOWN') patch.recoveredAt = at;
    } else {
      patch.probeFailures = (edge.probeFailures ?? 0) + 1;
      if (patch.probeFailures >= probeFailuresForDown) { patch.health = 'DOWN'; if (edge.health !== 'DOWN') patch.downAt = at; }
    }
    return this.updateHealth(edgeId, patch);
  }
  /** health, zone, region, capability, maxLatency 조건을 통과한 Edge를 load+latency 점수 순서로 돌려준다. */
  rankEdges({ region, zone, capabilities = [], maxLatencyMs, exclude = [] } = {}) {
    const weights = { latencyBudgetMs: this.triggerPolicy.latencyBudgetMs, latencyWeight: this.triggerPolicy.latencyWeight };
    return [...this.edges.values()].filter((edge) => edge.health === 'HEALTHY' && edge.load < 1 && !exclude.includes(edge.edgeId)
      && (!region || edge.region === region) && (!zone || edge.zones?.includes(zone))
      && capabilities.every((value) => edge.capabilities.includes(value))
      && (maxLatencyMs === undefined || (Number.isFinite(edge.latencyMs) && edge.latencyMs <= maxLatencyMs)))
      .map((edge) => ({ edge, score: edgeScore(edge, weights) }))
      .sort((a, b) => (a.score - b.score) || String(a.edge.edgeId).localeCompare(String(b.edge.edgeId)))
      .map(({ edge, score }) => ({ ...edge, score }));
  }
  async selectEligibleEdge({ region, zone, capabilities = [], maxLatencyMs, exclude = [] } = {}) {
    for (const [edgeId, deployer] of this.deployers) {
      try {
        const inventory = await deployer.inventory({ region, zone, capabilities });
        const reusable = inventory.deployments.some((item) => item.appId === deployer.appId && item.healthy);
        this.updateHealth(edgeId, { health: 'HEALTHY', region: inventory.region, zones: inventory.zones,
          load: reusable ? 0 : inventory.load, hostLoad: inventory.load, inventoryCheckedAt: this.clock(),
          capabilities: inventory.applications.find((item) => item.appId === deployer.appId).capabilities });
      } catch (error) { this.updateHealth(edgeId, { health: 'REVIEW', healthReason: error.message, inventoryCheckedAt: this.clock() }); }
    }
    return this.rankEdges({ region, zone, capabilities, maxLatencyMs, exclude })[0] ?? null;
  }
  /** 현재 소유 CSE의 manifest 자원을 읽어 장애 시 사용할 checkpoint를 갱신한다. */
  async checkpoint(ueId) {
    const session = this.status(ueId); const manifest = this.store.get('handoverManifests', ueId);
    if (!session || !terminal.has(session.state) || !manifest) return null;
    const client = this.clients.get(session.edgeId); const binding = this.store.get('logicalBindings', `${ueId}:${session.edgeId}`);
    if (!client || !binding) return null;
    const snapshot = await client.snapshot(binding, manifest);
    const current = this.status(ueId);
    if (current?.edgeId !== session.edgeId || current.epoch !== session.epoch) return null;
    return this.store.put('handoverCheckpoints', ueId, { ueId, edgeId: session.edgeId, epoch: session.epoch, snapshot, capturedAt: this.clock(), capturedWallMs: Date.now() });
  }
  /** 장애에서 돌아온 Edge에 지연 fence와 구독 해제를 적용한 뒤 HEALTHY로 되돌린다. */
  async reconcileRecoveredEdge(edgeId) {
    const client = this.clients.get(edgeId); if (!client) throw new Error('복구 Edge client를 확인하세요.');
    const applied = [];
    for (const row of this.store.list('handoverDeferredFences').filter((entry) => entry.edgeId === edgeId && entry.state === 'PENDING')) {
      const fence = await client.fence(row.binding);
      const cleanup = await client.release(row.binding);
      await this.forgetNotifications(edgeId, row.binding);
      const next = { ...row, state: 'APPLIED', fence, cleanup, appliedAt: this.clock() };
      await this.store.put('handoverDeferredFences', row.key, next);
      await this.receipt('HANDOVER_DEFERRED_FENCE_APPLIED', { ueId: row.ueId, edgeId, handoverId: row.handoverId, epoch: row.epoch });
      applied.push(next);
    }
    const edge = this.edges.get(edgeId);
    if (edge && ['RECOVERING', 'DOWN'].includes(edge.health) && edge.probeFailures === 0) this.updateHealth(edgeId, { health: 'HEALTHY', reconciledAt: this.clock() });
    return { edgeId, applied: applied.length, rows: applied };
  }
  status(ueId) { return this.store.get('handovers', ueId) ?? null; }
  async receipt(type, details) { const receipt = recordEnvelope({ type, ...details }, this.clock); await this.store.append('receipts', receipt); return receipt; }
  async registerManifest(ueId, manifest) {
    if (!ueId || !manifest?.aeName || !Array.isArray(manifest.resources)) throw new Error('논리 UE와 자원 manifest를 확인하세요.');
    const logicalIds = manifest.resources.map((resource) => resource.logicalId);
    if (new Set(logicalIds).size !== logicalIds.length || manifest.resources.some((resource) => !resource.logicalId || ![3, 28].includes(resource.ty) || !attributes(resource.body)?.rn)) throw new Error('자원 logical ID·타입·이름을 확인하세요.');
    return this.store.put('handoverManifests', ueId, { ...structuredClone(manifest), ueId, manifestHash: approvalHash(manifest) });
  }
  currentGrant(session) {
    if (session.simulation && !this.policyService) return true;
    const decision = this.policyService?.evaluateGrant(session.grantId);
    return Boolean(decision?.allowed && (!session.grantRevision || decision.grant.revision === session.grantRevision));
  }
  activeLanes(ueId) { return this.store.list('dispatchLanes').filter((lane) => lane.ueId === ueId && lane.state === 'ADMITTED'); }
  async admitDispatch({ ueId, commandId, claimId, epoch, payloadHash, desiredState, desiredGeneration = 0 }) {
    return this.store.transaction(`ownership:${ueId}`, async () => {
      const session = this.status(ueId);
      if (session && (!terminal.has(session.state) || session.epoch !== epoch)) throw new Error('현재 ACTIVE ownership epoch를 확인하세요.');
      const key = `${ueId}:${claimId}`; const prior = this.store.get('dispatchLanes', key);
      if (!Number.isSafeInteger(desiredGeneration) || desiredGeneration < 0) throw new Error('DEVICE_GENERATION_REQUIRED');
      if (prior) {
        if (prior.commandId !== commandId || prior.payloadHash !== payloadHash || prior.epoch !== epoch || (prior.desiredGeneration ?? 0) !== desiredGeneration) throw new Error('기존 command claim 정본을 확인하세요.');
        return prior;
      }
      if (this.activeLanes(ueId).length) throw new Error('이전 device 명령 정산을 완료하세요.');
      const fence = this.store.get('deviceGenerationFences', ueId);
      if (fence && (desiredGeneration < fence.generation || desiredGeneration > 0 && desiredGeneration === fence.generation && fence.commandId !== commandId)) throw new Error('DEVICE_GENERATION_STALE');
      const lane = { key, ueId, commandId, claimId, epoch, payloadHash, desiredState, desiredGeneration, state: 'ADMITTED', admittedAt: this.clock() };
      await this.store.put('deviceGenerationFences', ueId, { ueId, generation: desiredGeneration, commandId, claimId, epoch, payloadHash, admittedAt: lane.admittedAt });
      await this.store.put('dispatchLanes', key, lane); await this.receipt('DISPATCH_ADMITTED', { ueId, commandId, claimId, epoch, desiredGeneration }); return lane;
    });
  }
  async settleDispatch({ ueId, commandId, claimId, epoch, payloadHash, readback, ackState }) {
    return this.store.transaction(`ownership:${ueId}`, async () => {
      const key = `${ueId}:${claimId}`; const lane = this.store.get('dispatchLanes', key);
      if (!lane || lane.commandId !== commandId || lane.epoch !== epoch || lane.payloadHash !== payloadHash || ackState !== 'READBACK_VERIFIED' || typeof readback?.state !== 'boolean' || readback.state !== lane.desiredState?.state) throw new Error('command claim과 최종 readback을 확인하세요.');
      if (lane.state === 'SETTLED') return lane;
      const next = { ...lane, state: 'SETTLED', readback, settledAt: this.clock() };
      const command = this.store.get('gatewayCommands', commandId);
      if (command?.command.claimId === claimId && command.payloadHash === payloadHash) {
        await this.store.put('gatewayCommands', commandId, { ...command, executionState: 'APPLIED_VERIFIED', ackObservedAt: this.clock(), settledAt: this.clock(), readback });
        const key = `${commandId}:${ueId}`; const outbox = this.store.get('dispatchOutbox', key);
        if (outbox) await this.store.put('dispatchOutbox', key, { ...outbox, state: 'APPLIED_VERIFIED', settledAt: this.clock(), readback });
      }
      await this.store.put('dispatchLanes', key, next); await this.receipt('DISPATCH_READBACK_SETTLED', { ueId, commandId, claimId, epoch, readback }); return next;
    });
  }
  async acceptObservation({ ueId, sequence, payload, acceptedAt = this.clock() }) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('관측 sequence를 확인하세요.');
    return this.store.transaction(`observation:${ueId}`, async () => {
      const key = `${ueId}:${sequence}`; const sourceHash = approvalHash(payload); const prior = this.store.get('handoverObservations', key);
      if (prior) { if ((prior.sourceHash??prior.payloadHash) !== sourceHash) throw new Error('동일 sequence의 원문 hash를 확인하세요.'); return { ...prior, duplicate: true }; }
      let reference=payload;
      if(payload?.type==='encrypted-location-reference'){
        const row=this.store.get('locationPayloads',payload.payloadRef);
        if(!row||row.payloadHash!==payload.payloadHash)throw Error('저장된 암호화 위치 참조를 확인하세요.');
      }else{
        await this.observationCipher.ready;
        const payloadRef=`handover-${approvalHash({ueId,sequence,sourceHash}).slice(0,48)}`;
        const expiresAt=new Date(Date.parse(acceptedAt)+86400000).toISOString();
        await this.store.put('handoverPayloads',payloadRef,{payloadRef,ueId,sequence,sourceHash,expiresAt,cipher:this.observationCipher.seal(payload,payloadRef)});
        reference={type:'encrypted-observation-reference',payloadRef,payloadHash:sourceHash,expiresAt};
      }
      const record = { key, ueId, sequence, payload:reference, payloadHash:approvalHash(reference), sourceHash, acceptedAt, expiresAt:reference.expiresAt, applied: {} };
      await this.store.put('handoverObservations', key, record); return record;
    });
  }
  /** 해제한 구독의 callback receipt를 지워 같은 CSE로 돌아올 때 새 구독의 callback을 다시 확인하게 한다. */
  async forgetNotifications(edgeId, binding) {
    const keys = (binding?.subscriptions ?? []).map((subscription) => `${edgeId}:${subscription.path}`);
    if (!keys.length) return 0;
    return this.store.transaction(`notifications:${edgeId}`, async () => { const rows = this.store.collection('handoverNotifications'); let removed = 0; for (const key of keys) if (key in rows) { delete rows[key]; removed++; } return removed; });
  }
  async notification({ edgeId, subscriptionUri, verified = false }) {
    if (!this.edges.has(edgeId) || typeof subscriptionUri !== 'string') throw new Error('CSE notification 식별자를 확인하세요.');
    return this.store.put('handoverNotifications', `${edgeId}:${subscriptionUri}`, { edgeId, subscriptionUri, verified, receivedAt: this.clock() });
  }
  async migrateObservations() {
    await this.observationCipher.ready;
    return this.store.transaction('handover-privacy-migration',async()=>{
      let count=0;
      for(const row of this.store.list('handoverObservations')){
        if(['encrypted-location-reference','encrypted-observation-reference'].includes(row.payload?.type))continue;
        const sourceHash=approvalHash(row.payload);const payloadRef=`handover-${approvalHash({ueId:row.ueId,sequence:row.sequence,sourceHash}).slice(0,48)}`;
        const expiresAt=new Date(Date.parse(row.acceptedAt)+86400000).toISOString();
        await this.store.put('handoverPayloads',payloadRef,{payloadRef,ueId:row.ueId,sequence:row.sequence,sourceHash,expiresAt,cipher:this.observationCipher.seal(row.payload,payloadRef)});
        const reference={type:'encrypted-observation-reference',payloadRef,payloadHash:sourceHash,expiresAt};
        for(const [edgeId,applied] of Object.entries(row.applied??{}))if(applied.path&&applied.ri){
          const key=approvalHash({edgeId,path:applied.path,ri:applied.ri});
          await this.store.put('locationCsePurge',key,{key,edgeId,path:applied.path,ri:applied.ri,sourceHash,state:'PENDING',createdAt:this.clock()});
        }
        await this.store.put('handoverObservations',row.key,{...row,payload:reference,sourceHash,payloadHash:approvalHash(reference),expiresAt,applied:{}});count++;
      }
      if(count)await this.receipt('HANDOVER_LEGACY_ENCRYPTED',{count});return {count};
    });
  }
  async purgeLegacyCse() {
    for(const row of this.store.list('locationCsePurge').filter((entry)=>entry.state==='PENDING')){
      const client=this.clients.get(row.edgeId);if(!client)continue;
      try{
        const response=await client.request('GET',row.path);
        if(!response.missing){const cin=response.payload?.['m2m:cin'];if(!cin||cin.ri!==row.ri||approvalHash(cin.con)!==row.sourceHash)throw Error('이전 관측 CSE 식별자와 hash를 확인하세요.');await client.request('DELETE',row.path);}
        const checked=await client.request('GET',row.path);if(!checked.missing)throw Error('이전 CSE 관측의 삭제 readback을 확인하세요.');
        await this.store.put('locationCsePurge',row.key,{...row,state:'PURGED',completedAt:this.clock()});
        await this.receipt('LOCATION_CSE_LEGACY_PURGED',{migrationId:row.key,edgeId:row.edgeId});
      }catch(error){await this.store.put('locationCsePurge',row.key,{...row,reviewReason:error.code??'CSE_PURGE_REVIEW',checkedAt:this.clock()});}
    }
  }
  async transition(ueId, handoverId, patch, type) {
    return this.store.transaction(`ownership:${ueId}`, async () => {
      const current = this.status(ueId); if (current?.handoverId !== handoverId) throw new Error('현재 handover transition을 확인하세요.');
      const next = { ...current, ...patch, updatedAt: this.clock() };
      await this.store.put('handovers', ueId, next); await this.receipt(type, { ueId, handoverId, epoch: next.epoch, state: next.state, phase: next.phase, reason: next.reviewReason ?? next.reason });
      this.emit({ type: 'transition', receiptType: type, ueId, handoverId, epoch: next.epoch, state: next.state, phase: next.phase, sourceEdgeId: next.previousEdgeId, targetEdgeId: next.targetEdgeId });
      return next;
    });
  }
  async handover({ ueId, targetEdgeId, grantId = null, subscriptionIds = [], reason = 'location-health', rollback = false, sourceUnavailable = false, trigger = null }) {
    const queued = this.running.get(ueId) ?? Promise.resolve();
    const operation = queued.catch(() => {}).then(async () => {
      if (!targetEdgeId) {
        const manifest = this.store.get('handoverManifests', ueId);
        targetEdgeId = (await this.selectEligibleEdge({ region: manifest?.region, zone: manifest?.zone, capabilities: manifest?.capabilities ?? [] }))?.edgeId;
      }
      const existing = this.status(ueId);
      if (existing && !terminal.has(existing.state)) {
        if (existing.targetEdgeId !== targetEdgeId) throw new Error('진행 중인 handover를 먼저 정산하세요.');
        return this.resume(ueId);
      }
      // 자동 트리거가 대기열에서 기다리는 동안 앞선 이동이 같은 Edge로 끝났으면 현재 세션을 유지한다.
      if (trigger && existing?.edgeId === targetEdgeId) return existing;
      const target = this.edges.get(targetEdgeId);
      if (!target || target.health !== 'HEALTHY' || target.load >= 1) throw new Error('대상 Edge health·capacity를 확인하세요.');
      const simulation = !this.clients.has(targetEdgeId);
      if (!simulation && !this.store.get('handoverManifests', ueId)) throw new Error('UE 자원 복원 manifest를 등록하세요.');
      const session = await this.store.transaction(`ownership:${ueId}`, async () => {
        const prior = this.status(ueId);
        if(prior&&!terminal.has(prior.state))throw Error('현재 진행 중인 이동을 먼저 정산하세요.');
        const ownership = this.store.get('ownership', ueId);
        const enrolledEpoch = Math.max(0, ...this.store.list('gateways').filter((gateway) => gateway.devices?.[ueId]).map((gateway) => gateway.ownershipEpoch));
        const epoch = Math.max(prior?.epoch ?? 0, ownership?.epoch ?? 0, enrolledEpoch);
        if (epoch >= 2147483647) throw new Error('ownership epoch 한도를 확인하세요.');
        const grant = this.policyService?.evaluateGrant(grantId);
        if ((!simulation||this.policyService) && !grant?.allowed) throw new Error('현재 handover grant를 확인하세요.');
        const next = { ueId, handoverId: id('handover'), state: 'PREPARING', phase: 'CHECKPOINT', epoch, nextEpoch: epoch + 1, edgeId: prior?.edgeId ?? null, previousEdgeId: prior?.edgeId ?? null, targetEdgeId, grantId, grantRevision: grant?.grant?.revision ?? null, reason, rollback, simulation, sourceUnavailable: Boolean(sourceUnavailable && prior?.edgeId && (this.edges.get(prior.edgeId)?.health !== 'HEALTHY' || this.edges.get(prior.edgeId)?.probeFailures > 0)), trigger, subscriptions: [...new Set(subscriptionIds)], startedAt: this.clock(), startedWallMs: Date.now(), securityContext: { ...target.securityContext, grantId, epoch: epoch + 1 }, manifestHash: this.store.get('handoverManifests', ueId)?.manifestHash ?? null };
        await this.store.put('handovers', ueId, next);
        await this.store.put('ownership', ueId, { ueId, epoch, owner: next.edgeId, transitionId: next.handoverId, state: 'QUIESCING' });
        await this.receipt('HANDOVER_PREPARE', { ueId, handoverId: next.handoverId, source: next.previousEdgeId, target: targetEdgeId, epoch, simulation, reason, sourceUnavailable: next.sourceUnavailable });
        this.emit({ type: 'handover-prepare', ueId, handoverId: next.handoverId, sourceEdgeId: next.previousEdgeId, targetEdgeId, epoch, reason, sourceUnavailable: next.sourceUnavailable, trigger });
        return next;
      });
      return this.execute(session);
    });
    this.running.set(ueId, operation); operation.finally(() => { if (this.running.get(ueId) === operation) this.running.delete(ueId); }).catch(() => {});
    return operation;
  }
  async resume(ueId) { const session = this.status(ueId); if (!session) throw new Error('복구할 handover를 확인하세요.'); return this.execute(session); }
  async replay(session, binding) {
    const client = this.clients.get(session.targetEdgeId);
    const observations = this.store.list('handoverObservations').filter((row) => row.ueId === session.ueId).sort((a, b) => a.sequence - b.sequence);
    let batch = [];
    const commit = async () => {
      if (!batch.length) return;
      const accepted = batch; batch = [];
      await this.store.transaction(`observation:${session.ueId}`, async () => {
        for (const { row, result } of accepted) {
          const current = this.store.get('handoverObservations', row.key);
          await this.store.put('handoverObservations', row.key, { ...current, applied: { ...current.applied, [session.targetEdgeId]: { ...result, containerRi: binding.resources.observations.ri, appliedAt: this.clock() } } });
        }
      });
    };
    for (const row of observations) {
      if (row.applied[session.targetEdgeId]?.payloadHash === row.payloadHash && row.applied[session.targetEdgeId]?.containerRi === binding.resources.observations.ri) continue;
      const result = await client.applyObservation(binding, row);
      this.emit({ type: 'observation-applied', via: 'replay', ueId: session.ueId, edgeId: session.targetEdgeId, sequence: row.sequence, duplicate: Boolean(result.duplicate), handoverId: session.handoverId, phase: session.phase });
      batch.push({ row, result });
      if (batch.length >= 32) await commit();
    }
    await commit();
    if (observations.length) {
      const container = attributes(await client.read(binding.resources.observations.path));
      if (Number.isInteger(container.cni) && container.cni < observations.length) throw new Error('대상 CSE 관측 개수와 accepted sequence를 확인하세요.');
    }
    return { acceptedCount: observations.length, watermark: Math.max(-1, ...observations.map((row) => row.sequence)) };
  }
  async execute(initial) {
    let session = this.status(initial.ueId);
    if (terminal.has(session.state) && session.phase === 'COMPLETE') return session;
    const { ueId, handoverId } = session;
    const target = this.clients.get(session.targetEdgeId);
    const source = this.clients.get(session.previousEdgeId);
    const manifest = this.store.get('handoverManifests', ueId);
    try {
      if (!this.currentGrant(session) && !session.simulation) throw Object.assign(new Error('권한 회수·만료 상태를 확인하세요.'), { code: 'GRANT_REVIEW' });
      if (session.phase === 'CHECKPOINT') {
        const deployer = this.deployers.get(session.targetEdgeId);
        if (deployer) {
          const edge = this.edges.get(session.targetEdgeId);
          const deployment = await deployer.ensure({ ueId, epoch: session.nextEpoch, operationId: session.handoverId,
            region: edge.region, zone: manifest?.zone, capabilities: manifest?.capabilities ?? [] });
          if (!this.currentGrant(session)) throw Error('EDGE_DEPLOYMENT_CURRENT_GRANT');
          session = await this.transition(ueId, handoverId, { deployment }, 'HANDOVER_PROCESS_DEPLOYED');
        }
        const sourceBinding = this.store.get('logicalBindings', `${ueId}:${session.previousEdgeId}`);
        if (target) await target.health();
        let snapshot = {}; let checkpointSource = 'source-readback'; let checkpointAgeMs = 0;
        if (source && sourceBinding) {
          try { snapshot = await source.snapshot(sourceBinding, manifest); }
          catch (error) {
            // 출발 CSE가 응답하지 않는 failover는 같은 ownership epoch에서 저장한 마지막 checkpoint로 복원한다.
            const cached = this.store.get('handoverCheckpoints', ueId);
            if (!session.sourceUnavailable || cached?.edgeId !== session.previousEdgeId || cached.epoch !== session.epoch) throw error;
            snapshot = cached.snapshot; checkpointSource = 'cached-checkpoint'; checkpointAgeMs = Math.max(0, Date.now() - cached.capturedWallMs);
          }
        }
        session = await this.transition(ueId, handoverId, { phase: 'REGISTER_TARGET', checkpoint: { snapshot, sourceBinding, manifestHash: manifest?.manifestHash, capturedAt: this.clock(), source: checkpointSource, ageMs: checkpointAgeMs } }, 'HANDOVER_CHECKPOINT');
      }
      if (session.phase === 'REGISTER_TARGET') {
        const binding = target ? await target.register({ ueId, manifest: { ...manifest, edgeId: session.targetEdgeId } }) : { edgeId: session.targetEdgeId, simulation: true };
        await this.store.put('logicalBindings', `${ueId}:${session.targetEdgeId}`, binding);
        session = await this.transition(ueId, handoverId, { phase: 'RESTORE', state: 'RESTORING' }, 'HANDOVER_TARGET_REGISTERED');
      }
      if (session.phase === 'RESTORE') {
        let binding = this.store.get('logicalBindings', `${ueId}:${session.targetEdgeId}`);
        if (target) {
          binding = await target.restore({ binding, manifest, snapshot: session.checkpoint.snapshot }); await this.store.put('logicalBindings', `${ueId}:${session.targetEdgeId}`, binding); await this.replay(session, binding);
          // cutover 전 구독 callback을 미리 확인해 VERIFY 대기를 보관 구간 밖으로 옮긴다.
          if (manifest.requireCallbackVerification && binding.subscriptions.some((subscription) => !this.store.get('handoverNotifications', `${session.targetEdgeId}:${subscription.path}`)?.verified)) await target.probeNotifications(binding);
        }
        session = await this.transition(ueId, handoverId, { phase: 'DRAIN', state: 'QUIESCING' }, 'HANDOVER_TARGET_RESTORED');
      }
      if (session.phase === 'DRAIN') {
        const deadline = Date.now() + this.drainBudgetMs;
        while (this.activeLanes(ueId).length && Date.now() < deadline) { await delay(Math.min(25, this.drainBudgetMs)); if (this.store.refresh) await this.store.refresh(); }
        if (this.activeLanes(ueId).length) return this.transition(ueId, handoverId, { state: 'SETTLING', reviewReason: 'dispatch-readback-pending', activeCount: this.activeLanes(ueId).length, attemptTimedOut: Date.now() - session.startedWallMs >= this.attemptBudgetMs }, 'HANDOVER_DRAIN_PENDING');
        let fence = { fenced: true, simulation: true };
        if (source && session.checkpoint.sourceBinding) {
          try { fence = await source.fence(session.checkpoint.sourceBinding); }
          catch (error) {
            if (!session.sourceUnavailable) throw error;
            // 응답하지 않는 출발 CSE의 ACP 정산은 복구 probe 뒤 HEALTHY 복귀 전에 적용한다.
            const key = `${ueId}:${session.previousEdgeId}:${handoverId}`;
            await this.store.put('handoverDeferredFences', key, { key, ueId, edgeId: session.previousEdgeId, handoverId, epoch: session.epoch, binding: session.checkpoint.sourceBinding, state: 'PENDING', reason: error.code ?? 'SOURCE_UNREACHABLE', createdAt: this.clock() });
            fence = { fenced: false, deferred: true, deferredKey: key, reason: error.code ?? 'SOURCE_UNREACHABLE' };
          }
        }
        session = await this.transition(ueId, handoverId, { phase: 'CUTOVER', state: 'QUIESCING', sourceFence: fence, activeCount: 0 }, 'HANDOVER_SOURCE_FENCED');
      }
      if (session.phase === 'CUTOVER') {
        const binding = this.store.get('logicalBindings', `${ueId}:${session.targetEdgeId}`);
        const pendingDelta = () => this.store.list('handoverObservations').some((row) => row.ueId === ueId && row.applied[session.targetEdgeId]?.payloadHash !== row.payloadHash);
        let replay = target ? await this.replay(session, binding) : { acceptedCount: 0, watermark: -1 };
        // 직전 replay 중 accepted된 관측은 같은 cutover 안에서 최대 3회 더 따라잡는다.
        for (let pass = 0; target && pass < 3 && pendingDelta(); pass++) replay = await this.replay(session, binding);
        session = await this.store.transaction(`ownership:${ueId}`, async () => {
          const current = this.status(ueId); const ownership = this.store.get('ownership', ueId);
          const missing = target && this.store.list('handoverObservations').some((row) => row.ueId === ueId && row.applied[current.targetEdgeId]?.payloadHash !== row.payloadHash);
          if (missing) return this.transition(ueId, handoverId, { state: 'SETTLING', reviewReason: 'delta-replay-pending' }, 'HANDOVER_DELTA_PENDING');
          if (current.handoverId !== handoverId || ownership.transitionId !== handoverId || ownership.epoch !== current.epoch || this.activeLanes(ueId).length || !(current.sourceFence?.fenced || current.sourceFence?.deferred && current.sourceUnavailable) || (!current.simulation && !this.currentGrant(current))) throw Object.assign(new Error('cutover ownership·grant·drain CAS를 확인하세요.'), { code: 'CUTOVER_CAS_REVIEW' });
          await this.store.put('ownership', ueId, { ueId, epoch: current.nextEpoch, owner: current.targetEdgeId, transitionId: handoverId, state: 'VERIFYING' });
          const cutoverCommittedAt = this.clock();
          return this.transition(ueId, handoverId, { edgeId: current.targetEdgeId, epoch: current.nextEpoch, phase: 'VERIFY', state: 'VERIFYING', replay, cutoverAt: cutoverCommittedAt, cutoverCommittedAt }, 'HANDOVER_CUTOVER_COMMITTED');
        });
        if (session.phase === 'CUTOVER') return session;
      }
      if (session.phase === 'VERIFY') {
        if (target) {
          await target.health();
          const binding = this.store.get('logicalBindings', `${ueId}:${session.targetEdgeId}`);
          for (const resource of manifest.resources) if (resource.verifyFields?.length) {
            const readback = attributes(await target.read(binding.resources[resource.logicalId].path));
            const expected = attributes(session.checkpoint.snapshot[resource.logicalId] ?? resource.body);
            if (resource.verifyFields.some((field) => approvalHash(readback[field]) !== approvalHash(expected[field]))) throw new Error('대상 자원 최신 상태 readback을 확인하세요.');
          }
          if (manifest.requireCallbackVerification) {
            const pending = () => binding.subscriptions.some((subscription) => !this.store.get('handoverNotifications', `${session.targetEdgeId}:${subscription.path}`)?.verified);
            if (pending()) {
              await target.probeNotifications(binding);
              const until = Date.now() + 1500;
              while (pending() && Date.now() < until) { await delay(20); if (this.store.refresh) await this.store.refresh(); }
            }
            if (pending()) throw new Error('대상 구독 callback 검증 receipt를 확인하세요.');
          }
        }
        session = await this.store.transaction(`ownership:${ueId}`, async () => {
          if (!session.simulation && !this.currentGrant(session)) throw new Error('VERIFY의 현재 권한을 확인하세요.');
          await this.store.put('ownership', ueId, { ueId, epoch: session.epoch, owner: session.targetEdgeId, transitionId: handoverId, state: 'ACTIVE' });
          if (target) await this.store.put('handoverCheckpoints', ueId, { ueId, edgeId: session.targetEdgeId, epoch: session.epoch, snapshot: session.checkpoint?.snapshot ?? {}, source: 'restored-target', capturedAt: this.clock(), capturedWallMs: Date.now() });
          return this.transition(ueId, handoverId, { type: session.rollback ? 'HANDOVER_ROLLBACK' : 'HANDOVER_ACTIVE', state: session.rollback ? 'ROLLED_BACK' : 'ACTIVE', phase: 'RELEASE_SOURCE', completedAt: this.clock(), durationMs: Date.now() - session.startedWallMs }, session.rollback ? 'HANDOVER_ROLLBACK' : 'HANDOVER_ACTIVE');
        });
      }
      if (session.phase === 'RELEASE_SOURCE') {
        const released = session.sourceFence?.deferred ? { deferred: true, deferredKey: session.sourceFence.deferredKey } : source && session.checkpoint.sourceBinding ? await source.release(session.checkpoint.sourceBinding) : { simulation: true };
        if (!released.deferred && source && session.checkpoint.sourceBinding) await this.forgetNotifications(session.previousEdgeId, session.checkpoint.sourceBinding);
        const deployer = this.deployers.get(session.previousEdgeId);
        const processRelease = deployer ? await deployer.release({ ueId, epoch: session.nextEpoch - 1 }) : null;
        session = await this.transition(ueId, handoverId, { phase: 'COMPLETE', sourceCleanup: released, processRelease, cleanupPending: false }, 'HANDOVER_SOURCE_RELEASED');
      }
      return session;
    } catch (error) {
      let deploymentRollback;
      if (session.phase === 'CHECKPOINT' && this.deployers.has(session.targetEdgeId)) {
        try { deploymentRollback = await this.deployers.get(session.targetEdgeId).release({ ueId, epoch: session.nextEpoch }); }
        catch (cleanupError) { deploymentRollback = { pending: true, reason: cleanupError.message }; }
      }
      return this.transition(ueId, handoverId, { state: session.phase === 'RELEASE_SOURCE' ? session.state : 'SETTLING', cleanupPending: session.phase === 'RELEASE_SOURCE', ...(deploymentRollback ? { deploymentRollback } : {}), reviewReason: error.code ?? error.message, diagnostic: error.message, attemptTimedOut: Date.now() - session.startedWallMs >= this.attemptBudgetMs }, 'HANDOVER_REVIEW');
    }
  }
  async rollback(ueId, reason = 'handover-review') {
    const session = this.status(ueId);
    if (!session) throw new Error('롤백할 handover를 확인하세요.');
    return this.handover({ ueId, targetEdgeId: session.previousEdgeId ?? session.edgeId, grantId: session.grantId, subscriptionIds: session.subscriptions, reason, rollback: true });
  }
  async resetTrigger({ueId,targetEdgeId,kind,observedAt}) {
    return this.store.transaction(`trigger:${ueId}`,async()=>{
      const key=`${ueId}:${targetEdgeId}:${kind}`;const prior=this.store.get('handoverTriggers',key);const at=Date.parse(observedAt);
      if(!Number.isFinite(at)||prior?.lastAt>at)return;
      await this.store.put('handoverTriggers',key,{...prior,key,ueId,targetEdgeId,kind,since:at,lastAt:at,eligible:false,failures:0});
    });
  }
  async considerTrigger({ueId,targetEdgeId,grantId,grantRevision,policyId,policyRevision,kind='zone',distanceInsideM=0,healthy=true,scoreGain,observedAt=this.clock(),eventKey,subscriptionIds=[]}) {
    const policyLimits=this.triggerPolicy;
    const trigger=await this.store.transaction(`trigger:${ueId}`,async()=>{
      const decision=this.policyService?.evaluateGrant(grantId);
      if(!decision?.allowed||(grantRevision!==undefined&&decision.grant.revision!==grantRevision))throw Error('트리거의 현재 승인 revision을 확인하세요.');
      if(policyId){const policy=this.store.get('policies',policyId);if(!policy||policy.status!=='APPROVED'||policy.revision!==policyRevision||policy.policy.grantId!==grantId||policy.policy.ueId!==ueId||policy.policy.targetEdgeId!==targetEdgeId||(policy.policy.expiresAt&&Date.parse(policy.policy.expiresAt)<=Date.parse(this.clock())))throw Error('현재 승인한 이동 정책을 확인하세요.');}
      const now=Date.parse(this.clock());const at=Date.parse(observedAt);
      if(!TRIGGER_KINDS.has(kind)||!Number.isFinite(at)||at>now+2000||now-at>30000)throw Error('이동 트리거의 원본 종류와 관측 시각을 확인하세요.');
      const session=this.status(ueId);const key=`${ueId}:${targetEdgeId}:${kind}`;
      const bindingHash=approvalHash({grantId,grantRevision:decision.grant.revision,policyId:policyId??null,policyRevision:policyRevision??null,epoch:session?.epoch??0});
      const prior=this.store.get('handoverTriggers',key);
      const same=prior?.bindingHash===bindingHash;
      if(same&&(prior.eventKey===eventKey&&eventKey||at<=prior.lastAt))return {session,fresh:false};
      const counting=kind==='health'||kind==='availability';
      const spacing=kind==='health'?policyLimits.healthFailureSpacingMs:policyLimits.availabilityFailureSpacingMs;
      const eligible=counting?!healthy:kind==='performance'?healthy&&Number.isFinite(scoreGain)&&scoreGain>=policyLimits.minScoreGain:healthy&&Number.isFinite(distanceInsideM)&&distanceInsideM>=policyLimits.minInsideM;
      const continuous=same&&prior.eligible&&at-prior.lastAt<=policyLimits.continuityGapMs;
      const counted=counting&&eligible&&(!continuous||at-(prior.lastFailureAt??prior.lastAt)>=spacing);
      const failures=counting&&eligible?(continuous?(counted?prior.failures+1:prior.failures):1):0;
      const next={key,ueId,targetEdgeId,kind,bindingHash,since:eligible&&continuous?prior.since:at,lastAt:at,lastFailureAt:counted?at:prior?.lastFailureAt??at,eventKey:eventKey??null,eligible,failures,distanceInsideM:Number.isFinite(distanceInsideM)?distanceInsideM:null,scoreGain:Number.isFinite(scoreGain)?scoreGain:null,observedAt};
      await this.store.put('handoverTriggers',key,next);return {...next,session,fresh:true,now};
    });
    const session=trigger.session;
    if(session?.edgeId===targetEdgeId&&terminal.has(session.state))return session;
    if(!trigger.fresh||!trigger.eligible)return {state:'WAITING',reason:'source-trigger',targetEdgeId};
    if(session&&!terminal.has(session.state)&&this.running.has(ueId))return {state:'WAITING',reason:'handover-in-progress',targetEdgeId};
    if(!session&&kind==='zone')return this.handover({ueId,targetEdgeId,grantId,subscriptionIds,reason:'initial-approved-placement'});
    const residence=session?trigger.now-Date.parse(session.completedAt??session.startedAt):Infinity;
    const cooldown=session?.previousEdgeId?residence:Infinity;
    const details={kind,since:new Date(trigger.since).toISOString(),firedAt:new Date(trigger.now).toISOString(),observedAt:trigger.observedAt,failures:trigger.failures,scoreGain:trigger.scoreGain,distanceInsideM:trigger.distanceInsideM};
    // CSE availability는 소유 CSE 응답이 끊긴 상태이므로 체류, cooldown보다 연속 probe 실패 횟수로 판정한다.
    if(kind==='availability')return trigger.failures<policyLimits.availabilityFailures?{state:'WAITING',reason:'availability-probe-count',targetEdgeId}:this.handover({ueId,targetEdgeId,grantId,subscriptionIds,reason:kind,sourceUnavailable:true,trigger:details});
    const dwell=kind==='zone'?policyLimits.zoneDwellMs:policyLimits.performanceDwellMs;
    if(residence<policyLimits.minResidenceMs||cooldown<policyLimits.cooldownMs||(kind==='health'?trigger.failures<policyLimits.healthFailures:trigger.lastAt-trigger.since<dwell))return {state:'WAITING',reason:'residence-cooldown-trigger',targetEdgeId};
    return this.handover({ueId,targetEdgeId,grantId,subscriptionIds,reason:kind,trigger:details});
  }
}
