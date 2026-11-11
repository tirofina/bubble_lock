import { approvalHash, DOC_REVISION, id, nowIso, parseBearer, recordEnvelope, requireArray, requireString } from './integration-utils.mjs';

export class PolicyService {
  constructor({ store, receiptJournal = null, clock = () => new Date().toISOString(), issuer = 'privacy-bubble-oidc', audience = 'privacy-bubble-api' } = {}) {
    if (!store) throw new Error('PolicyService requires IntegrationStore');
    this.store = store;
    this.receiptJournal = receiptJournal;
    this.clock = clock;
    this.issuer = issuer;
    this.audience = audience;
    for (const name of ['createConsent', 'createGrant', 'approvePolicy']) {
      const operation = this[name].bind(this);
      this[name] = (...args) => this.store.transaction(`policy:${name}`, () => operation(...args));
    }
  }

  async receipt(event) {
    const record = recordEnvelope({ owner: 'PC-MOBIUS-INTEGRATION', ...event }, this.clock);
    await this.store.append('receipts', record);
    if (this.receiptJournal) await this.receiptJournal.append(record);
    return record;
  }

  bindPrincipal({ oidcToken, mtlsPeer, originator = null }) {
    const claims = typeof oidcToken === 'string' ? parseBearer(oidcToken) : (oidcToken ?? {});
    const now = Math.floor(Date.now() / 1000);
    if (!claims.sub) throw new Error('OIDC subject is required');
    if (claims.iss && claims.iss !== this.issuer) throw new Error('OIDC issuer review required');
    if (claims.aud) {
      const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!audiences.includes(this.audience)) throw new Error('OIDC audience review required');
    }
    if (claims.exp && claims.exp <= now) throw new Error('OIDC token expiry review required');
    if (!mtlsPeer?.verified || !mtlsPeer.fingerprint) throw new Error('mTLS peer verification is required');
    const principal = {
      principalId: String(claims.sub),
      issuer: claims.iss ?? this.issuer,
      audience: claims.aud ?? this.audience,
      originator: originator ?? `pb-${String(claims.sub).replace(/[^a-zA-Z0-9_-]/g, '_')}`,
      scopes: String(claims.scope ?? '').split(' ').filter(Boolean),
      mtlsFingerprint: mtlsPeer.fingerprint,
      mtlsSubject: mtlsPeer.subject ?? claims.sub,
      boundAt: nowIso(this.clock)
    };
    return principal;
  }

  authorize(principal, scope) {
    if (!principal?.principalId) throw new Error('Principal binding is required');
    if (scope && (!Array.isArray(principal.scopes) || (!principal.scopes.includes(scope) && !principal.scopes.includes('*')))) throw new Error(`Scope ${scope} requires an active grant`);
    return principal;
  }

  subjectAuthority(principalId, subjectId) {
    const household = this.store.get('households', subjectId);
    return !household || household.members.some((member) => member.principalId === principalId && member.role === 'guardian');
  }

  async createConsent({ principal, subjectId, purpose, scopes, ttlSec = 3600 }) {
    this.authorize(principal, 'consent:write');
    requireString(subjectId, 'subjectId');
    if (!this.subjectAuthority(principal.principalId, subjectId)) throw new Error('Household guardian binding required');
    requireString(purpose, 'purpose');
    requireArray(scopes, 'scopes');
    if (scopes.some((scope) => typeof scope !== 'string' || scope.trim().length === 0)) throw new Error('String scopes required');
    if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0) throw new Error('Positive integer TTL required');
    const consentId = id('consent');
    const createdAt = nowIso(this.clock);
    const consent = { consentId, subjectId, purpose, scopes: [...new Set(scopes)], principalId: principal.principalId, revision: 1, status: 'ACTIVE', createdAt, expiresAt: new Date(Date.parse(createdAt) + ttlSec * 1000).toISOString() };
    consent.consentHash = approvalHash(consent);
    await this.store.put('consents', consentId, consent);
    await this.receipt({ type: 'CONSENT_CREATED', consentId, subjectId, principalId: principal.principalId, approvalHash: consent.consentHash });
    return consent;
  }

  async createGrant({ principal, consentId, scopes, ttlSec = 900, purpose = 'privacy-bubble-command' }) {
    this.authorize(principal, 'grant:write');
    const consent = this.store.get('consents', consentId);
    if (!consent || consent.status !== 'ACTIVE') throw new Error('Active consent is required');
    if (consent.principalId !== principal.principalId) throw new Error('Consent owner binding required');
    const now = nowIso(this.clock);
    if (Date.parse(consent.expiresAt) <= Date.parse(now)) throw new Error('Consent expiry review required');
    requireArray(scopes, 'scopes');
    if (scopes.some((scope) => typeof scope !== 'string' || scope.trim().length === 0)) throw new Error('String scopes required');
    if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0) throw new Error('Positive integer TTL required');
    const allowed = scopes.every((scope) => consent.scopes.includes(scope));
    if (!allowed) throw new Error('Grant scope exceeds consent scope');
    const grantId = id('grant');
    const grant = { grantId, consentId, subjectId: consent.subjectId, principalId: principal.principalId, purpose, scopes: [...new Set(scopes)], revision: consent.revision, status: 'ACTIVE', createdAt: now, expiresAt: new Date(Math.min(Date.parse(consent.expiresAt), Date.parse(now) + ttlSec * 1000)).toISOString() };
    grant.approvalHash = approvalHash(grant);
    await this.store.put('grants', grantId, grant);
    await this.receipt({ type: 'GRANT_ISSUED', grantId, consentId, principalId: principal.principalId, approvalHash: grant.approvalHash });
    return grant;
  }

  evaluateGrant(grantId, { scope, approvalHash: expectedHash } = {}) {
    const grant = this.store.get('grants', grantId);
    if (!grant || grant.status !== 'ACTIVE') return { allowed: false, reason: 'grant-status', grant };
    if (Date.parse(grant.expiresAt) <= Date.parse(nowIso(this.clock))) return { allowed: false, reason: 'grant-expired', grant };
    const consent = this.store.get('consents', grant.consentId);
    if (!this.subjectAuthority(grant.principalId, grant.subjectId)) return { allowed: false, reason: 'household-authority', grant };
    if (!consent || consent.status !== 'ACTIVE' || consent.revision !== grant.revision
        || Date.parse(consent.expiresAt) <= Date.parse(nowIso(this.clock))) return { allowed: false, reason: 'consent-status', grant };
    if (scope && !grant.scopes.includes(scope) && !grant.scopes.includes('*')) return { allowed: false, reason: 'grant-scope', grant };
    if (expectedHash && expectedHash !== grant.approvalHash) return { allowed: false, reason: 'approval-hash', grant };
    return { allowed: true, grant };
  }

  async revokeGrant({ principal, grantId, reason = 'operator-revocation' }) {
    this.authorize(principal, 'grant:revoke');
    return this.store.transaction(`grant:${grantId}`, async () => {
    const grant = this.store.get('grants', grantId);
    if (!grant) throw new Error('Grant is required');
    if (grant.principalId !== principal.principalId) throw new Error('Grant owner binding required');
    const revocationCommittedAt = nowIso(this.clock);
    const next = { ...grant, status: 'REVOKED', revokedAt: revocationCommittedAt, revocationCommittedAt, revokedBy: principal.principalId, revokeReason: reason, revision: grant.revision + 1 };
    await this.store.put('grants', grantId, next);
    await this.receipt({ type: 'GRANT_REVOKED', grantId, principalId: principal.principalId, revocationCommittedAt, reason });
    return next;
    });
  }

  async approvePolicy({ principal, policy, idempotencyKey }) {
    this.authorize(principal, 'policy:approve');
    requireString(idempotencyKey, 'idempotencyKey');
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Policy object required');
    if (policy.grantId) {
      const decision = this.evaluateGrant(policy.grantId);
      if (!decision.allowed || decision.grant.principalId !== principal.principalId) throw new Error('Policy grant owner binding required');
    }
    const expectedHash = approvalHash({ policy, principalId: principal.principalId, idempotencyKey });
    const existing = this.store.list('policies').find((item) => item.idempotencyKey === idempotencyKey && item.principalId === principal.principalId);
    if (existing) {
      if (existing.approvalHash !== expectedHash) throw new Error('Policy idempotency requires the original intent');
      return existing;
    }
    const record = { policyId: id('policy'), idempotencyKey, principalId: principal.principalId, status: 'APPROVED', revision: 1, policy, approvalHash: approvalHash({ policy, principalId: principal.principalId, idempotencyKey }), approvedAt: nowIso(this.clock) };
    await this.store.put('policies', record.policyId, record);
    await this.receipt({ type: 'POLICY_APPROVED', policyId: record.policyId, principalId: principal.principalId, approvalHash: record.approvalHash });
    return record;
  }
}
