import { readFile } from 'node:fs/promises';
import { X509Certificate, generateKeyPairSync, sign } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createIntegrationRuntime } from '../../pc-mobius/integration/src/integration-runtime.mjs';
import { createIntegrationServer } from '../../pc-mobius/integration/src/api-server.mjs';
import { OidcVerifier } from '../../pc-mobius/integration/src/oidc-verifier.mjs';

const root = process.argv[2];
const fingerprint = new X509Certificate(await readFile(join(root, 'client.pem'))).fingerprint256;
const peer = { principalId: 'gw-test', scopes: [], mtlsFingerprint: fingerprint };
const guardian = { principalId: 'guardian-test', scopes: ['portal:read'], oidcIssuer: 'https://test-issuer.example', oidcSubject: 'guardian-subject' };
const runtime = await createIntegrationRuntime();
await runtime.portalService.provisionHousehold({ householdId: 'test-household', name: '시험 가구', ownerId: guardian.principalId });
await runtime.gatewayControl.enroll({ gatewayId: 'gw-test', principalId: peer.principalId, fingerprint, devices: { 'kr-test': 'test-household' }, credentialRevision: '1' });
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = { keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' }] };
const oidcVerifier = new OidcVerifier({ issuer: guardian.oidcIssuer, audience: 'privacy-bubble-api', jwks, clockSkewSec: 0 });
const token = (change = {}) => {
  const input = [{ alg: 'RS256', kid: 'test-key' }, { iss: guardian.oidcIssuer, aud: 'privacy-bubble-api', sub: guardian.oidcSubject, exp: Math.floor(Date.now() / 1000) + 120, scope: 'portal:read', ...change }]
    .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
  return `${input}.${sign('sha256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
};
const tls = { key: await readFile(join(root, 'server.key')), cert: await readFile(join(root, 'server.pem')), ca: await readFile(join(root, 'trusted.pem')) };
const server = createIntegrationServer({ api: runtime.api, tls, principals: [peer, guardian], oidcVerifier });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
console.log(JSON.stringify({ origin: `https://127.0.0.1:${server.address().port}`, token: token(), expired: token({ exp: 1 }), noScope: token({ scope: 'unregistered:scope' }) }));
const input = createInterface({ input: process.stdin });
for await (const line of input) { if (line === 'close') break; }
input.close();
process.stdin.destroy();
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
