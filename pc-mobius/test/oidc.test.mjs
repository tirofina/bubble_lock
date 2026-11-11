import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { OidcVerifier } from '../integration/src/oidc-verifier.mjs';

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const now = Date.parse('2026-11-10T00:00:00.000Z');
const issuer = 'https://identity.example.test';
const key = (pair, kid, alg) => ({ ...pair.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' });
const keys = { keys: [key(rsa, 'rsa-1', 'RS256'), key(ec, 'ec-1', 'ES256')] };
const base = { iss: issuer, aud: 'privacy-bubble-api', sub: 'guardian-subject', exp: now / 1000 + 300, iat: now / 1000, scope: 'portal:read consent:write' };
const token = (claims = base, header = { alg: 'RS256', kid: 'rsa-1' }, pair = rsa) => {
  const body = [header, claims].map((entry) => Buffer.from(JSON.stringify(entry)).toString('base64url')).join('.');
  const signature = sign('sha256', Buffer.from(body), { key: pair.privateKey, ...(header.alg === 'ES256' ? { dsaEncoding: 'ieee-p1363' } : {}) });
  return `Bearer ${body}.${signature.toString('base64url')}`;
};
const verifier = (options = {}) => new OidcVerifier({ issuer, audience: 'privacy-bubble-api', jwks: keys, clock: () => now, clockSkewSec: 0, ...options });

test('RS256/ES256 access token은 서명과 등록된 subject/scope로 principal을 만든다', async () => {
  const verify = verifier();
  assert.equal((await verify.verify(token())).sub, base.sub);
  assert.equal((await verify.verify(token(base, { alg: 'ES256', kid: 'ec-1' }, ec))).sub, base.sub);
  const principal = await verify.principal(token(), [{ principalId: 'guardian-1', oidcSubject: base.sub, oidcIssuer: issuer, scopes: ['portal:read', 'bubble:command', '*'] }]);
  assert.deepEqual(principal.scopes, ['portal:read']);
  assert.equal(principal.authentication, 'oidc');
});

test('서명 변조·alg 혼동·주입 키·미등록 subject를 차단한다', async () => {
  const verify = verifier();
  const valid = token();
  const segments = valid.slice(7).split('.');
  segments[1] = Buffer.from(JSON.stringify({ ...base, sub: 'attacker' })).toString('base64url');
  await assert.rejects(verify.verify(`Bearer ${segments.join('.')}`), /signature/);
  for (const header of [{ alg: 'none', kid: 'rsa-1' }, { alg: 'HS256', kid: 'rsa-1' }, { alg: 'RS256', kid: 'rsa-1', jku: 'https://other.test/keys' }, { alg: 'RS256', kid: 'rsa-1', crit: ['x'] }]) await assert.rejects(verify.verify(token(base, header)));
  await assert.rejects(verify.principal(valid, []), /enrollment/);
});

test('issuer·audience·만료·nbf·iat와 exp 필수값을 검증한다', async () => {
  const verify = verifier();
  for (const change of [{ iss: 'https://other.test' }, { aud: 'other-api' }, { exp: now / 1000 }, { nbf: now / 1000 + 1 }, { iat: now / 1000 + 1 }, { exp: undefined }, { sub: '' }, { scope: ['portal:read'] }]) await assert.rejects(verify.verify(token({ ...base, ...change })));
  assert.equal((await verify.verify(token({ ...base, aud: ['other', 'privacy-bubble-api'] }))).sub, base.sub);
});

test('JWKS URI는 등록된 HTTPS 경로만 조회하고 동시 조회·캐시를 유지한다', async () => {
  let requests = 0; let time = now;
  const fetchImpl = async (url, options) => {
    requests += 1;
    assert.equal(url, `${issuer}/jwks`);
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify(keys), { status: 200 });
  };
  const verify = verifier({ jwks: null, jwksUri: `${issuer}/jwks`, fetchImpl, clock: () => time, cacheMs: 1000 });
  await Promise.all([verify.verify(token()), verify.verify(token())]);
  assert.equal(requests, 1);
  await verify.verify(token());
  assert.equal(requests, 1);
  time += 1001;
  await verify.verify(token());
  assert.equal(requests, 2);
  assert.throws(() => verifier({ jwks: null, jwksUri: 'http://identity.test/jwks' }));
});

test('JWKS 키 중복과 서버 장애는 인증 검증 오류를 반환한다', async () => {
  await assert.rejects(verifier({ jwks: { keys: [keys.keys[0], keys.keys[0]] } }).verify(token()), /Unique/);
  await assert.rejects(verifier({ jwks: null, jwksUri: `${issuer}/jwks`, fetchImpl: async () => new Response('{}', { status: 503 }) }).verify(token()), /retrieval/);
});
