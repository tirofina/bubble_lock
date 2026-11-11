import { createPublicKey, verify } from 'node:crypto';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const segment = (value) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('JWT encoding required');
  const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!object(decoded)) throw new Error('JWT object required');
  return decoded;
};

/** 등록된 issuer/JWKS의 서명과 API audience를 검증하는 access token verifier입니다. */
export class OidcVerifier {
  constructor({ issuer, audience, jwks = null, jwksUri = null, fetchImpl = globalThis.fetch, clock = () => Date.now(), cacheMs = 300_000, clockSkewSec = 30 } = {}) {
    if (typeof issuer !== 'string' || new URL(issuer).protocol !== 'https:' || typeof audience !== 'string' || !audience) throw new Error('HTTPS OIDC issuer and audience required');
    if (!jwks && (!jwksUri || new URL(jwksUri).protocol !== 'https:')) throw new Error('Trusted HTTPS JWKS URI required');
    if (!Number.isFinite(cacheMs) || cacheMs < 1000 || cacheMs > 3_600_000 || !Number.isInteger(clockSkewSec) || clockSkewSec < 0 || clockSkewSec > 60) throw new Error('Bounded OIDC cache and clock skew required');
    Object.assign(this, { issuer, audience, jwksUri, fetchImpl, clock, cacheMs, clockSkewSec });
    this.staticKeys = jwks ? this.validateKeys(jwks) : null;
    this.keys = null;
    this.expiresAt = 0;
    this.fetching = null;
  }

  validateKeys(document) {
    if (!object(document) || !Array.isArray(document.keys) || document.keys.length < 1 || document.keys.length > 100) throw new Error('JWKS key set required');
    return document.keys.filter((key) => object(key) && typeof key.kid === 'string' && key.kid.length <= 128
      && ['RSA', 'EC'].includes(key.kty) && (!key.use || key.use === 'sig') && (!key.key_ops || (Array.isArray(key.key_ops) && key.key_ops.includes('verify'))));
  }

  async trustedKeys() {
    if (this.staticKeys) return this.staticKeys;
    if (this.keys && this.clock() < this.expiresAt) return this.keys;
    if (this.fetching) return this.fetching;
    this.fetching = (async () => {
      const response = await this.fetchImpl(this.jwksUri, { redirect: 'error', signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('JWKS retrieval required');
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw new Error('JWKS response limit exceeded');
        chunks.push(chunk);
      }
      const keys = this.validateKeys(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      this.keys = keys;
      this.expiresAt = this.clock() + this.cacheMs;
      return keys;
    })();
    try { return await this.fetching; } finally { this.fetching = null; }
  }

  async verify(authorization) {
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization) || authorization.length > 16384) throw new Error('Signed bearer access token required');
    const token = authorization.slice(7);
    const parts = token.split('.');
    if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[2])) throw new Error('Signed JWT required');
    const header = segment(parts[0]);
    const claims = segment(parts[1]);
    if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== 'string' || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined) throw new Error('Registered JWT algorithm and key required');
    const keys = await this.trustedKeys();
    const matching = keys.filter((key) => key.kid === header.kid && (!key.alg || key.alg === header.alg)
      && (header.alg === 'RS256' ? key.kty === 'RSA' : key.kty === 'EC' && key.crv === 'P-256'));
    if (matching.length !== 1) throw new Error('Unique enrolled JWT verification key required');
    const key = createPublicKey({ key: matching[0], format: 'jwk' });
    if (header.alg === 'RS256' && (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error('RSA key size required');
    const valid = verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key, ...(header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' } : {}) }, Buffer.from(parts[2], 'base64url'));
    if (!valid) throw new Error('JWT signature verification required');
    const now = this.clock() / 1000;
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (claims.iss !== this.issuer || !Array.isArray(audiences) || !audiences.every((aud) => typeof aud === 'string') || !audiences.includes(this.audience)) throw new Error('OIDC issuer/audience binding required');
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 256 || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now - this.clockSkewSec) throw new Error('Active OIDC subject and expiry required');
    for (const field of ['iat', 'nbf']) if (claims[field] !== undefined && (typeof claims[field] !== 'number' || !Number.isFinite(claims[field]) || claims[field] > now + this.clockSkewSec)) throw new Error('OIDC token validity time required');
    if (claims.iat !== undefined && claims.exp <= claims.iat) throw new Error('OIDC validity interval required');
    if (claims.scope !== undefined && typeof claims.scope !== 'string') throw new Error('OIDC scope claim required');
    return Object.freeze({ ...claims });
  }

  async principal(authorization, enrollment) {
    const claims = await this.verify(authorization);
    const matches = enrollment.filter((entry) => entry.oidcIssuer === claims.iss && entry.oidcSubject === claims.sub && typeof entry.principalId === 'string');
    if (matches.length !== 1) throw new Error('OIDC subject enrollment required');
    const entry = matches[0];
    const tokenScopes = String(claims.scope ?? '').split(' ').filter(Boolean);
    const scopes = (entry.scopes ?? []).filter((name) => name !== '*' && tokenScopes.includes(name));
    return { principalId: entry.principalId, originator: entry.originator ?? `pb-${entry.principalId}`, scopes, authentication: 'oidc', issuer: claims.iss, subject: claims.sub, expiresAt: new Date(claims.exp * 1000).toISOString() };
  }
}
