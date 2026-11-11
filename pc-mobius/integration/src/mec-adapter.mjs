import { DOC_REVISION, recordEnvelope } from './integration-utils.mjs';
import { MecCipher, auditMec, currentBinding, digest, isoAfter, millis, MEC_RETENTION_MS, normalizeCallback, pointInGeofence,distanceInsideGeofence, serviceScope, validCoordinates } from './mec-state.mjs';
export { MecAdapter, MecHttpError } from './mec-http-client.mjs';
export { MecSubscriptionManager } from './mec-subscriptions.mjs';
export { pointInGeofence } from './mec-state.mjs';

export class MecCallbackIngress {
  constructor({ store, policyService, subscriptions, clock = () => new Date().toISOString(), locationAdapter = null, rnisAdapter = null, encryptionKey, maxPayloadBytes = 65536 } = {}) {
    if (!store) throw new Error('IntegrationStore를 설정하세요.');
    Object.assign(this, { store, policyService, subscriptions, clock, maxPayloadBytes });
    this.adapters = { Location: locationAdapter, RNIS: rnisAdapter };
    this.cipher = subscriptions?.cipher ?? new MecCipher({ store, encryptionKey });
    this.handlers = new Set();
  }
  onEvent(handler) { this.handlers.add(handler); return () => this.handlers.delete(handler); }
  async ingestCallback({ service, token, providerIdentity, payload } = {}) {
    await this.cipher.ready;
    let encoded;
    try { encoded = JSON.stringify(payload); } catch { return auditMec(this.store, this.clock, 'SCHEMA_REVIEW'); }
    if (!encoded || Buffer.byteLength(encoded) > this.maxPayloadBytes) return auditMec(this.store, this.clock, 'SCHEMA_REVIEW', { reason: 'payload-size' });
    const payloadHash = digest(payload);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return auditMec(this.store, this.clock, 'BINDING_REVIEW', { payloadHash });
    const routeHash = digest(token);
    return this.store.transaction(`grant:${this.store.get('mecRoutes', routeHash)?.grantId ?? routeHash}`, async () => {
      const route = this.store.get('mecRoutes', routeHash);
      const reason = currentBinding({ store: this.store, policyService: this.policyService, route, clock: this.clock });
      if (reason) return auditMec(this.store, this.clock, reason, { payloadHash, routeHash });
      const adapter = this.adapters[service];
      if (route.serviceId !== service || !adapter || !providerIdentity?.verified || providerIdentity.providerId !== route.providerId || !adapter.providerFingerprint || providerIdentity.mtlsFingerprint !== adapter.providerFingerprint) return auditMec(this.store, this.clock, 'BINDING_REVIEW', { payloadHash, routeHash });
      if (route.schemaHash !== adapter.capabilities.schemaHash || route.endpointVersion !== adapter.capabilities.endpointVersion) return auditMec(this.store, this.clock, 'BINDING_REVIEW', { payloadHash, routeHash });
      let event;
      try {
        if (!adapter.simulation && (!adapter.capabilities.deploymentVerified || typeof adapter.capabilities.validateCallback !== 'function')) throw new Error('SCHEMA_REVIEW');
        if (adapter.capabilities.validateCallback && !adapter.capabilities.validateCallback(payload)) throw new Error('SCHEMA_REVIEW');
        event = normalizeCallback(payload, route, adapter);
      } catch (error) { return auditMec(this.store, this.clock, ['BINDING_REVIEW', 'SCHEMA_REVIEW'].includes(error.message) ? error.message : 'SCHEMA_REVIEW', { payloadHash, routeHash }); }
      const prefix = { providerId: route.providerId, serviceId: route.serviceId, subscriptionId: route.subscriptionId, generation: route.generation };
      const eventKey = digest({ ...prefix, ...(event.eventId ? { eventId: event.eventId } : event.sequence !== null ? { sequence: event.sequence } : { sourceHash: event.sourceHash }) });
      const sequenceKey = event.sequence !== null ? digest({ ...prefix, sequence: event.sequence }) : null;
      const prior = this.store.get('mecDedup', eventKey);
      const sequencePrior = sequenceKey ? this.store.get('mecSequences', sequenceKey) : null;
      if ((prior && Date.parse(prior.expiresAt) > millis(this.clock)) || (sequencePrior && Date.parse(sequencePrior.expiresAt) > millis(this.clock))) {
        const matching = (!prior || prior.sourceHash === event.sourceHash) && (!sequencePrior || (sequencePrior.eventKey === eventKey && sequencePrior.sourceHash === event.sourceHash));
        return auditMec(this.store, this.clock, matching ? 'DUPLICATE' : 'IDENTITY_REVIEW', { payloadHash, eventKey });
      }
      if (event.clockQuality !== 'VERIFIED') return auditMec(this.store, this.clock, 'TIME_UNKNOWN', { payloadHash, eventKey, clockQuality: event.clockQuality });
      const age = millis(this.clock) - Date.parse(event.observedAt);
      const watermarkKey = digest({ ...prefix, ueSubject: route.ueSubject });
      const watermark = this.store.get('mecWatermarks', watermarkKey);
      if (age > 30000 || age < -2000 || (watermark && (Date.parse(event.observedAt) < Date.parse(watermark.observedAt) || (event.sequence !== null && watermark.sequence !== null && event.sequence <= watermark.sequence)))) return auditMec(this.store, this.clock, 'TIME_REVIEW', { payloadHash, eventKey });
      const receivedAt = this.clock();
      const expiresAt = isoAfter(this.clock, MEC_RETENTION_MS);
      const normalized = { ...event, receivedAt, serviceRevision: DOC_REVISION, eventKey, intent: { policyId: route.intentId, grantId: route.grantId, grantRevision: route.grantRevision, policyRevision: route.intentRevision }, subscriptionId: route.subscriptionId, generation: route.generation };
      const row = { eventKey, grantId: route.grantId, grantRevision: route.grantRevision, policyId: route.intentId, sourceHash: event.sourceHash, receivedAt, expiresAt, cipher: this.cipher.seal(normalized, eventKey) };
      await this.store.put('mecPayloads', eventKey, row);
      await this.store.put('mecDedup', eventKey, { eventKey, sourceHash: event.sourceHash, expiresAt });
      if (sequenceKey) await this.store.put('mecSequences', sequenceKey, { eventKey, sourceHash: event.sourceHash, expiresAt });
      await this.store.put('mecWatermarks', watermarkKey, { observedAt: event.observedAt, sequence: event.sequence, eventKey, expiresAt });
      await this.store.put('mecOutbox', eventKey, { eventKey, grantId: route.grantId, grantRevision: route.grantRevision, state: 'PENDING', attempts: 0, createdAt: receivedAt, expiresAt });
      return auditMec(this.store, this.clock, 'ACCEPTED', { eventKey, payloadHash });
    });
  }
  async readEvent(eventKey) {
    await this.cipher.ready;
    return this.store.transaction(`mec-read:${eventKey}`, async () => {
      const row = this.store.get('mecPayloads', eventKey);
      const decision = this.policyService?.evaluateGrant(row?.grantId);
      if (!row || Date.parse(row.expiresAt) <= millis(this.clock) || !decision?.allowed || decision.grant.revision !== row.grantRevision) {
        await auditMec(this.store, this.clock, 'READ_REVIEW', { eventKey });
        return null;
      }
      const event = this.cipher.open(row.cipher, eventKey);
      if (!this.policyService.evaluateGrant(row.grantId, { scope: serviceScope(event.service) }).allowed) return null;
      return event;
    });
  }
  async drainOutbox() {
    const results = [];
    for (const row of this.store.list('mecOutbox').filter((entry) => ['PENDING', 'RETRY'].includes(entry.state) || (entry.state === 'PROCESSING' && Date.parse(entry.leaseUntil) <= millis(this.clock)))) {
      const claim = await this.store.transaction(`grant:${row.grantId}`, async () => {
        const current = this.store.get('mecOutbox', row.eventKey);
        if (!['PENDING', 'RETRY'].includes(current.state) && !(current.state === 'PROCESSING' && Date.parse(current.leaseUntil) <= millis(this.clock))) return { skip: true };
        const event = await this.readEvent(row.eventKey);
        if (!event) { const reviewed = { ...current, state: 'REVOKED', completedAt: this.clock() }; await this.store.put('mecOutbox', row.eventKey, reviewed); return { skip: true, result: reviewed }; }
        const processing = { ...current, state: 'PROCESSING', attempts: current.attempts + 1, leaseUntil: isoAfter(this.clock, 30000) };
        await this.store.put('mecOutbox', row.eventKey, processing); return { event, processing };
      });
      if (claim.skip) { if (claim.result) results.push(claim.result); continue; }
      let next;
      try {
        const outcomes = []; for (const handler of this.handlers) outcomes.push(await handler(claim.event));
        next = { ...claim.processing, state: outcomes.some((outcome) => outcome.executionPending) ? 'RETRY' : 'COMPLETED', outcomes, completedAt: this.clock() };
      } catch { next = { ...claim.processing, state: claim.processing.attempts >= 10 ? 'FOLLOWUP' : 'RETRY' }; }
      await this.store.put('mecOutbox', row.eventKey, next); results.push(next);
    }
    return results;
  }
  /** 내부 통합 데모는 simulation 표시와 승인 정책을 함께 제공합니다. */
  async ingest(rawEvent) {
    if (rawEvent?.simulation !== true) return auditMec(this.store, this.clock, 'BINDING_REVIEW');
    const key = `simulation:${digest({ eventId: rawEvent.eventId, service: rawEvent.service, grantId: rawEvent.intent?.grantId })}`;
    return this.store.transaction(`grant:${rawEvent.intent?.grantId}`, async () => {
      if (this.store.get('events', key)) return { status: 'DUPLICATE', eventId: rawEvent.eventId, simulation: true };
      const event = { ...rawEvent, observedAt: rawEvent.observedAt ?? this.clock(), receivedAt: this.clock(), clockQuality: 'VERIFIED' };
      const outcomes = []; for (const handler of this.handlers) outcomes.push(await handler(event));
      const summary = recordEnvelope({ type: 'MEC_SIMULATION', eventId: rawEvent.eventId, status: 'RECONCILED', simulation: true, outcomeCount: outcomes.length, outcomes }, this.clock);
      await this.store.put('events', key, summary); await this.store.append('receipts', summary);
      return summary;
    });
  }
  async query(service, request) {
    const adapter = this.adapters[service];
    if (!adapter) throw new Error('MEC 서비스 설정을 확인하세요.');
    return adapter.query(request);
  }
  async prune() {
    return this.store.transaction('mec-retention', async () => {
      let removed = 0;const counts={};const deletedKeys=[];
      for (const name of ['mecPayloads', 'mecDedup', 'mecSequences', 'mecWatermarks', 'mecOutbox', 'mecRoutes']) {
        for (const [key, row] of Object.entries(this.store.collection(name))) {
          const deadline = name === 'mecRoutes' ? row.retainUntil : row.expiresAt;
          const cleanupPending = name === 'mecRoutes' && this.store.list('mecSubscriptions').some((subscription) => subscription.routeHash === key && subscription.state !== 'PROVIDER_DELETED');
          if (!cleanupPending && deadline && Date.parse(deadline) <= millis(this.clock)) { delete this.store.collection(name)[key]; removed += 1;counts[name]=(counts[name]??0)+1;deletedKeys.push(digest({collection:name,key})); }
        }
      }
      for(const [key,row] of Object.entries(this.store.collection('mecSubscriptions'))){
        if(row.state==='PROVIDER_DELETED'&&row.retainUntil&&Date.parse(row.retainUntil)<=millis(this.clock)){
          delete this.store.collection('mecSubscriptions')[key];removed++;counts.mecSubscriptions=(counts.mecSubscriptions??0)+1;deletedKeys.push(digest({collection:'mecSubscriptions',key}));
        }
      }
      if(removed)await this.store.append('receipts',recordEnvelope({type:'MEC_RETENTION_EXPIRED',deletedCount:removed,counts,deletedKeysHash:digest(deletedKeys.sort()),expiresAt:isoAfter(this.clock,30*MEC_RETENTION_MS)},this.clock));
      return { removed,counts };
    });
  }
}

export class MecPolicyReconciler {
  constructor({ store, policyService, handoverCoordinator = null, clock = () => new Date().toISOString() } = {}) { Object.assign(this, { store, policyService, handoverCoordinator, clock }); }
  async reconcileApprovedIntent(event) {
    const prepared = await this.store.transaction(`grant:${event.intent?.grantId}`, async () => {
      const policy = this.store.get('policies', event.intent?.policyId);
      const approved = policy?.policy;
      const kind=approved?.trigger?.kind??'zone';
      const decision = this.policyService.evaluateGrant(event.intent?.grantId, { scope: serviceScope(event.service) });
      let reason = 'location-health-accepted';
      if (!decision.allowed) reason = decision.reason;
      else if (!policy || policy.status !== 'APPROVED' || policy.principalId !== decision.grant.principalId || approved.grantId !== decision.grant.grantId || approved.ueId !== event.ueId || (event.intent.grantRevision && event.intent.grantRevision !== decision.grant.revision) || (event.intent.policyRevision && event.intent.policyRevision !== policy.revision)) reason = 'approved-intent-review';
      else if (approved.expiresAt && (!Number.isFinite(Date.parse(approved.expiresAt)) || Date.parse(approved.expiresAt) <= millis(this.clock))) reason = 'intent-expired';
      else if (event.clockQuality !== 'VERIFIED' || !Number.isFinite(Date.parse(event.observedAt)) || millis(this.clock) - Date.parse(event.observedAt) > 30000 || Date.parse(event.observedAt) - millis(this.clock) > 2000) reason = 'source-time-review';
      else if(!['zone','health'].includes(kind))reason='trigger-kind-review';
      else if(kind==='zone'&&(!validCoordinates(event.location??event.position)||!pointInGeofence(event.location??event.position,approved.geofence)))reason='geofence-review';
      else if(kind==='zone'&&event.health?.status!=='HEALTHY')reason='health-review';
      else if(kind==='health'&&(!['HEALTHY','UNHEALTHY','DOWN'].includes(event.health?.status)||event.service!=='RNIS'))reason='health-review';
      const allowed = reason === 'location-health-accepted';
      const outcome = recordEnvelope({ type: 'MEC_POLICY_RECONCILE', eventId: event.eventId ?? event.eventKey, eventKey: event.eventKey ?? null, ueId: event.ueId, service: event.service, policyId: policy?.policyId ?? null, allowed, reason, grantId: event.intent?.grantId ?? null, simulation: event.simulation === true }, this.clock);
      if(!allowed&&['geofence-review','health-review'].includes(reason)&&approved?.targetEdgeId)await this.handoverCoordinator?.resetTrigger?.({ueId:event.ueId,targetEdgeId:approved.targetEdgeId,kind,observedAt:event.observedAt});
      if (allowed && this.handoverCoordinator && approved.targetEdgeId) {
        const key = event.eventKey ?? digest({ eventId: event.eventId, policyId: policy.policyId });
        const prior = this.store.get('mecExecutions', key);
        if (!prior || (prior.state === 'RETRY') || (prior.state === 'PROCESSING' && Date.parse(prior.leaseUntil) <= millis(this.clock))) {
          await this.store.put('mecExecutions', key, { eventKey: key, state: 'PROCESSING', leaseUntil: isoAfter(this.clock, 30000) });
          const uncertainty=event.location?.accuracyM??event.uncertainty?.accuracyM??event.uncertainty?.radiusM??0;
          const distanceInsideM=kind==='zone'?distanceInsideGeofence(event.location??event.position,approved.geofence)-(Number.isFinite(uncertainty)&&uncertainty>=0?uncertainty:Infinity):0;
          return { outcome, key, execution: { ueId: event.ueId, targetEdgeId: approved.targetEdgeId, grantId: decision.grant.grantId,grantRevision:decision.grant.revision,policyId:policy.policyId,policyRevision:policy.revision,kind,distanceInsideM,healthy:event.health?.status==='HEALTHY',observedAt:event.observedAt,eventKey:key, subscriptionIds: event.subscriptionId ? [event.subscriptionId] : approved.subscriptionIds ?? [], reason: 'approved-mec-policy' } };
        }
      }
      await this.store.append('receipts', outcome);
      return { outcome };
    });
    if (prepared.execution) {
      try {
        const result = await this.handoverCoordinator.considerTrigger(prepared.execution);
        const pending = result.state && !['ACTIVE', 'ROLLED_BACK','WAITING'].includes(result.state);
        prepared.outcome.executionPending = Boolean(pending);
        prepared.outcome.triggerState=result.state??'ACTIVE';
        if(result.reason)prepared.outcome.triggerReason=result.reason;
        prepared.outcome.handoverId = result.handoverId;
        await this.store.put('mecExecutions', prepared.key, { eventKey: prepared.key, state: pending ? 'RETRY' : 'COMPLETED', handoverId: result.handoverId, completedAt: this.clock() });
      } catch (error) {
        await this.store.put('mecExecutions', prepared.key, { eventKey: prepared.key, state: 'RETRY' });
        throw error;
      }
      await this.store.append('receipts', prepared.outcome);
    }
    return prepared.outcome;
  }
}
