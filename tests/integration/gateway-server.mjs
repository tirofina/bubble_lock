import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createIntegrationRuntime } from '../../pc-mobius/integration/src/integration-runtime.mjs';
import { createIntegrationServer } from '../../pc-mobius/integration/src/api-server.mjs';

const root = process.argv[2];
const fingerprint = new X509Certificate(await readFile(join(root, 'client.pem'))).fingerprint256;
const peer = { principalId: 'gw-test', scopes: [], mtlsFingerprint: fingerprint };
const principal = { principalId: 'test-guardian', scopes: ['consent:write', 'grant:write', 'grant:revoke', 'bubble:command'] };
const runtime = await createIntegrationRuntime();
await runtime.gatewayControl.enroll({ gatewayId: 'gw-test', principalId: peer.principalId, fingerprint, devices: { 'kr-test': 'test-household' }, credentialRevision: '1' });
const consent = await runtime.policyService.createConsent({ principal, subjectId: 'test-household', purpose: 'integration-test', scopes: ['bubble:command'] });
const grant = await runtime.policyService.createGrant({ principal, consentId: consent.consentId, scopes: ['bubble:command'] });
const command = await runtime.gatewayControl.issue({ principal, gatewayId: 'gw-test', deviceId: 'kr-test', commandId: 'integration-command', grantId: grant.grantId, desiredState: { state: true }, deadline: new Date(Date.now() + 60000).toISOString() });
const tls = { key: await readFile(join(root, 'server.key')), cert: await readFile(join(root, 'server.pem')), ca: await readFile(join(root, 'trusted.pem')) };
const server = createIntegrationServer({ api: runtime.api, tls, principals: [peer] });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
console.log(JSON.stringify({ origin: `https://127.0.0.1:${server.address().port}`, command }));
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line === 'revoke') {
    await runtime.policyService.revokeGrant({ principal, grantId: grant.grantId });
    console.log(JSON.stringify({ revoked: true }));
  }
  if (line === 'close') break;
}
input.close();
process.stdin.destroy();
server.closeAllConnections();
await new Promise((resolve) => server.close(resolve));
