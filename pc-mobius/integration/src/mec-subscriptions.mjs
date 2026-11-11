import { randomBytes } from 'node:crypto';
import { MecCipher, currentBinding, digest, isoAfter, millis, MEC_RETENTION_MS, serviceScope } from './mec-state.mjs';
import { recordEnvelope, requireString } from './integration-utils.mjs';

const RETRY_SECONDS = [1, 2, 4, 8, 16, 30];
const publicSubscription = ({ requestCipher, ...record }) => record;

export class MecSubscriptionManager {
  constructor({ store, policyService, adapters = {}, callbackBaseUrl = 'http://127.0.0.1:8001', encryptionKey, clock = () => new Date().toISOString(), random = Math.random, operator = 'mec-operations' } = {}) {
    Object.assign(this, { store, policyService, adapters, callbackBaseUrl, clock, random, operator });
    this.cipher = new MecCipher({ store, encryptionKey });
  }
  async receipt(type, details) { return this.store.append('receipts', recordEnvelope({ type, ...details }, this.clock)); }
  list() { return this.store.list('mecSubscriptions').map(publicSubscription); }
  async discover(service) {
    const adapter = this.adapters[service];
    if (!adapter) throw new Error('MEC 서비스를 확인하세요.');
    const receipt = await adapter.discover();
    await this.store.put('mecDiscovery', service, receipt);
    await this.store.append('receipts', receipt);
    return receipt;
  }
  async create({ policyId, service, idempotencyKey }) {
    await this.cipher.ready;
    requireString(idempotencyKey, 'idempotencyKey');
    const adapter = this.adapters[service];
    if (!adapter) throw new Error('MEC 서비스를 확인하세요.');
    if (!adapter.endpoint) await this.discover(service);
    const key = digest({ policyId, service, idempotencyKey });
    const existing = this.store.get('mecSubscriptions', key);
    if (existing) return publicSubscription(existing);
    const created = await this.store.transaction(`mec-intent:${policyId}`, async () => {
      const prior = this.store.get('mecSubscriptions', key);
      if (prior) return { existing: prior };
      const intent = this.store.get('policies', policyId);
      const grantId = intent?.policy.grantId;
      const decision = this.policyService.evaluateGrant(grantId, { scope: serviceScope(service) });
      if (!intent || intent.status !== 'APPROVED' || !decision.allowed || decision.grant.principalId !== intent.principalId) throw new Error('승인 정책과 현재 MEC 권한을 확인하세요.');
      const ueSubject = requireString(intent.policy.ueId, 'policy.ueId');
      if (intent.policy.services && !intent.policy.services.includes(service)) throw new Error('정책의 서비스 범위를 확인하세요.');
      const expires = Math.min(Date.parse(decision.grant.expiresAt), Date.parse(intent.policy.expiresAt ?? decision.grant.expiresAt));
      if (!Number.isFinite(expires) || expires <= millis(this.clock)) throw new Error('정책 유효기간을 확인하세요.');
      const siblings = this.store.list('mecSubscriptions').filter((entry) => entry.intentId === policyId && entry.serviceId === service);
      const generation = Math.max(0, ...siblings.map((entry) => entry.generation)) + 1;
      for (const entry of siblings.filter((entry) => entry.desiredState === 'ACTIVE')) await this.requestCancel(entry.key);
      const token = randomBytes(32).toString('base64url');
      const routeHash = digest(token);
      const callbackUrl = `${this.callbackBaseUrl.replace(/\/$/, '')}/callbacks/${service}/${token}`;
      const clientCorrelator = `pb-${key.slice(0, 32)}`;
      const body = adapter.subscriptionPayload({ callbackUrl, ueSubject, clientCorrelator, appInstanceId: intent.policy.appInstanceId });
      const route = { routeHash, providerId: adapter.providerId, serviceId: service, endpointVersion: adapter.capabilities.endpointVersion, subscriptionId: null, resourceUrl: null, generation, intentId: policyId, intentRevision: intent.revision, grantId, grantRevision: decision.grant.revision, ueSubject, schemaHash: adapter.capabilities.schemaHash, expiresAt: new Date(expires).toISOString(), state: 'CREATING', clientCorrelator, tokenCipher: this.cipher.seal(token, routeHash), subscriptionKey: key };
      const subscription = { key, providerId: adapter.providerId, serviceId: service, intentId: policyId, grantId, grantRevision: decision.grant.revision, generation, routeHash, clientCorrelator, resourceUrl: null, subscriptionId: null, endpointVersion: adapter.capabilities.endpointVersion, desiredState: 'ACTIVE', state: 'CREATING', attempts: 0, createdAt: this.clock(), retryStartedAt: this.clock(), nextAttemptAt: this.clock(), expiresAt: route.expiresAt, requestCipher: this.cipher.seal(body, key) };
      await this.store.put('mecRoutes', routeHash, route);
      await this.store.put('mecSubscriptions', key, subscription);
      await this.receipt('MEC_SUBSCRIPTION_DESIRED', { subscriptionKey: key, service, generation, desiredState: 'ACTIVE' });
      return { subscription, body };
    });
    if (created.existing) return publicSubscription(created.existing);
    try {
      const result = await adapter.createSubscription(created.body);
      return this.activate(key, result.resourceUrl);
    } catch (error) { return this.retry(key, 'CREATE_UNCERTAIN', error); }
  }
  async activate(key, resourceUrl) {
    return this.store.transaction(`mec-subscription:${key}`, async () => {
      const current = this.store.get('mecSubscriptions', key);
      const adapter = this.adapters[current.serviceId];
      const resource = adapter.resourceUrl(resourceUrl);
      const subscriptionId = decodeURIComponent(new URL(resource).pathname.split('/').at(-1));
      const route = this.store.get('mecRoutes', current.routeHash);
      const decision = this.policyService.evaluateGrant(current.grantId, { scope: serviceScope(current.serviceId) });
      const active = current.desiredState === 'ACTIVE' && decision.allowed && decision.grant.revision === current.grantRevision && Date.parse(current.expiresAt) > millis(this.clock) && route.state !== 'TOMBSTONED';
      const next = { ...current, subscriptionId, resourceUrl: resource, state: active ? 'ACTIVE' : 'CANCEL_REQUESTED', desiredState: active ? 'ACTIVE' : 'CANCEL_REQUESTED', attempts: 0, updatedAt: this.clock(), nextAttemptAt: isoAfter(this.clock, active ? 30000 : 0) };
      await this.store.put('mecSubscriptions', key, next);
      if (active) await this.store.put('mecRoutes', route.routeHash, { ...route, subscriptionId, resourceUrl: resource, state: 'ACTIVE' });
      else await this.tombstone(current);
      await this.receipt('MEC_SUBSCRIPTION_CONFIRMED', { subscriptionKey: key, subscriptionId, generation: current.generation, state: next.state });
      return publicSubscription(next);
    });
  }
  async tombstone(subscription, cleanupAt = null) {
    const prior = this.store.get('mecRoutes', subscription.routeHash);
    const deadline = Math.max(Date.parse(prior?.retainUntil ?? 0) || 0, millis(this.clock) + MEC_RETENTION_MS);
    await this.store.put('mecRoutes', subscription.routeHash, { routeHash: subscription.routeHash, generation: subscription.generation, state: 'TOMBSTONED', retainUntil: new Date(deadline).toISOString(), ...(cleanupAt ? { cleanupAt } : {}) });
  }
  async requestCancel(key) {
    return this.store.transaction(`mec-subscription:${key}`, async () => {
      const current = this.store.get('mecSubscriptions', key);
      if (!current) throw new Error('MEC 구독 식별자를 확인하세요.');
      if (current.desiredState === 'CANCEL_REQUESTED') return current;
      const next = { ...current, desiredState: 'CANCEL_REQUESTED', state: 'CANCEL_REQUESTED', cancelRequestedAt: this.clock(), retryStartedAt: this.clock(), attempts: 0, nextAttemptAt: this.clock() };
      await this.store.put('mecSubscriptions', key, next);
      await this.tombstone(current);
      await this.receipt('MEC_CANCEL_COMMITTED', { subscriptionKey: key, generation: current.generation });
      return next;
    });
  }
  async cancel(key) { await this.requestCancel(key); return this.cleanup(key); }
  async cleanup(key) {
    let current = this.store.get('mecSubscriptions', key);
    const adapter = this.adapters[current.serviceId];
    try {
      if (!current.resourceUrl) {
        const found = await this.findOwned(current);
        if (!found) return adapter.capabilities.listComplete ? this.confirmDeleted(key, 404) : this.retry(key, 'DELETE_UNCERTAIN', { code: 'PROVIDER_ID_PENDING' });
        await this.activate(key, found);
        current = this.store.get('mecSubscriptions', key);
      }
      const response = await adapter.deleteSubscription(current.resourceUrl);
      return this.confirmDeleted(key, response.status);
    } catch (error) { return this.retry(key, 'DELETE_UNCERTAIN', error); }
  }
  async confirmDeleted(key, providerStatus) {
    return this.store.transaction(`mec-subscription:${key}`, async () => {
        const latest = this.store.get('mecSubscriptions', key);
        const { requestCipher, ...retained } = latest;
        const next = { ...retained, state: 'PROVIDER_DELETED', cleanupAt: this.clock(), retainUntil: isoAfter(this.clock, MEC_RETENTION_MS), nextAttemptAt: null, providerStatus };
        await this.store.put('mecSubscriptions', key, next);
        await this.tombstone(next, next.cleanupAt);
        await this.receipt('MEC_PROVIDER_CLEANUP', { subscriptionKey: key, generation: next.generation, providerStatus });
        return publicSubscription(next);
      });
  }
  async retry(key, state, error) {
    return this.store.transaction(`mec-subscription:${key}`, async () => {
      const current = this.store.get('mecSubscriptions', key);
      if (current.state === 'PROVIDER_DELETED') return publicSubscription(current);
      const attempts = current.attempts + 1;
      const followup = attempts >= 10 || millis(this.clock) - Date.parse(current.retryStartedAt) >= 300000;
      const seconds = RETRY_SECONDS[Math.min(attempts - 1, RETRY_SECONDS.length - 1)] * (1 + 0.2 * this.random());
      const next = { ...current, state: current.desiredState === 'CANCEL_REQUESTED' ? 'DELETE_UNCERTAIN' : state, attempts, lastError: error.code ?? 'MEC_OPERATION_REVIEW', nextAttemptAt: isoAfter(this.clock, followup ? 300000 : seconds * 1000), followup: followup ? { status: 'FOLLOWUP', owner: this.operator, nextCheckAt: isoAfter(this.clock, 300000) } : null };
      await this.store.put('mecSubscriptions', key, next);
      await this.receipt('MEC_RETRY_SCHEDULED', { subscriptionKey: key, state: next.state, attempts, nextAttemptAt: next.nextAttemptAt, reason: next.lastError, followup: next.followup });
      return publicSubscription(next);
    });
  }
  async findOwned(subscription) {
    const adapter = this.adapters[subscription.serviceId];
    if (subscription.resourceUrl) {
      try { await adapter.readSubscription(subscription.resourceUrl); return subscription.resourceUrl; }
      catch (error) { if (![404, 410].includes(error.status)) throw error; }
    }
    const items = await adapter.listSubscriptions();
    await this.cipher.ready;
    const request = this.cipher.open(subscription.requestCipher, subscription.key);
    const expectedCallback = request.userTrackingSubscription?.callbackReference?.notifyURL ?? request.callbackReference;
    const owned = items.filter((item) => { const value = item.userTrackingSubscription ?? item; return (value.callbackReference?.notifyURL ?? value.callbackReference) === expectedCallback && (value.clientCorrelator === undefined || value.clientCorrelator === subscription.clientCorrelator); });
    if (owned.length > 1) throw Object.assign(new Error('소유 구독 개수를 확인하세요.'), { code: 'PROVIDER_DUPLICATE_REVIEW' });
    const item = owned[0];
    return item ? adapter.resourceUrl(item.resourceURL ?? item.userTrackingSubscription?.resourceURL ?? item._links?.self?.href) : null;
  }
  async read(key) {
    const current = this.store.get('mecSubscriptions', key);
    if (!current?.resourceUrl) throw new Error('공급자 구독 확인을 완료하세요.');
    return this.adapters[current.serviceId].readSubscription(current.resourceUrl);
  }
  async update(key) {
    await this.cipher.ready;
    const current = this.store.get('mecSubscriptions', key);
    const route = this.store.get('mecRoutes', current?.routeHash);
    const reason = currentBinding({ store: this.store, policyService: this.policyService, route, clock: this.clock });
    if (reason) throw new Error(reason);
    const response = await this.adapters[current.serviceId].updateSubscription(current.resourceUrl, this.cipher.open(current.requestCipher, key));
    await this.receipt('MEC_SUBSCRIPTION_UPDATED', { subscriptionKey: key, providerStatus: response.status });
    return { subscriptionKey: key, providerStatus: response.status };
  }
  async reconcile({ force = false } = {}) {
    const results = [];
    for (const item of this.store.list('mecSubscriptions')) {
      if (item.state === 'PROVIDER_DELETED' || (!force && Date.parse(item.nextAttemptAt) > millis(this.clock)) || item.followup) continue;
      const decision = this.policyService.evaluateGrant(item.grantId, { scope: serviceScope(item.serviceId) });
      if (item.desiredState === 'CANCEL_REQUESTED' || !decision.allowed || decision.grant.revision !== item.grantRevision || Date.parse(item.expiresAt) <= millis(this.clock)) { results.push(await this.cancel(item.key)); continue; }
      try {
        const resource = await this.findOwned(item);
        if (resource) results.push(await this.activate(item.key, resource));
        else if (this.adapters[item.serviceId].capabilities.listComplete) {
          await this.receipt('MEC_ABSENCE_CONFIRMED', { subscriptionKey: item.key, generation: item.generation, inventory: 'complete' });
          await this.requestCancel(item.key);
          await this.confirmDeleted(item.key, 404);
          results.push(await this.create({ policyId: item.intentId, service: item.serviceId, idempotencyKey: `recovery-${item.key}` }));
        } else results.push(await this.retry(item.key, 'CREATE_UNCERTAIN', { code: 'PROVIDER_ID_PENDING' }));
      } catch (error) {
        if ([404, 410, 503].includes(error.status) && this.adapters[item.serviceId].platformRoot) {
          try { await this.discover(item.serviceId); } catch { /* 검색 결과는 다음 재시도에서 정산합니다. */ }
        }
        results.push(await this.retry(item.key, item.state, error));
      }
    }
    return results;
  }
  start() { if (!this.timer) { this.timer = setInterval(() => this.reconcile().catch(() => {}), 30000); this.timer.unref?.(); } return this; }
  stop() { clearInterval(this.timer); this.timer = null; }
}
