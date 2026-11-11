import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createIntegrationRuntime } from '../../pc-mobius/integration/src/integration-runtime.mjs';
import { createIntegrationServer } from '../../pc-mobius/integration/src/api-server.mjs';

const root = process.argv[2];
const fingerprint = new X509Certificate(await readFile(join(root, 'client.pem'))).fingerprint256;
const peer = { principalId: 'gw-test', scopes: [], mtlsFingerprint: fingerprint };
const principal = { principalId: 'test-guardian', scopes: ['portal:read', 'device:write', 'consent:write', 'grant:write', 'grant:revoke', 'bubble:command', 'incident:write'] };
const runtime = await createIntegrationRuntime();
await runtime.gatewayControl.enroll({ gatewayId: 'gw-test', principalId: peer.principalId, fingerprint, devices: { 'kr-test': 'test-household' }, credentialRevision: '1' });
await runtime.portalService.provisionHousehold({ householdId: 'test-household', name: 'TLS 시험 가구', ownerId: principal.principalId });
await runtime.portalService.registerDevice(principal, { householdId: 'test-household', gatewayId: 'gw-test', deviceId: 'kr-test', label: '시험 키링', idempotencyKey: 'tls-device' });
const consent = await runtime.policyService.createConsent({ principal, subjectId: 'test-household', purpose: 'integration-test', scopes: ['bubble:command', 'location:read'] });
const grant = await runtime.policyService.createGrant({ principal, consentId: consent.consentId, purpose: 'integration-test', scopes: ['bubble:command', 'location:read'] });
const incident = await runtime.portalService.createIncident(principal, { householdId: 'test-household', deviceId: 'kr-test', kind: 'HELP', message: 'TLS 위치 조회 시험', idempotencyKey: 'tls-location-incident' });
await runtime.locationPrivacy.createLease(principal, { recipientId: principal.principalId, deviceIds: ['kr-test'], grantId: grant.grantId, incidentId: incident.incidentId, purpose: 'integration-test', ttlSec: 300, idempotencyKey: 'tls-location-lease' });
const command = await runtime.gatewayControl.issue({ principal, gatewayId: 'gw-test', deviceId: 'kr-test', commandId: 'integration-command', grantId: grant.grantId, desiredState: { state: true }, deadline: new Date(Date.now() + 60000).toISOString() });
const tls = { key: await readFile(join(root, 'server.key')), cert: await readFile(join(root, 'server.pem')), ca: await readFile(join(root, 'trusted.pem')) };
const server = createIntegrationServer({ api: runtime.api, tls, principals: [peer] });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
console.log(JSON.stringify({ origin: `https://127.0.0.1:${server.address().port}`, command }));
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  if (line === 'locations') console.log(JSON.stringify(await runtime.portalLocations.read(principal)));
  if (line === 'snapshot') console.log(JSON.stringify({ command: runtime.store.get('gatewayCommands', command.commandId), activeLanes: runtime.handoverCoordinator.activeLanes('kr-test'), receipts: runtime.store.list('gatewayDeviceReceipts'), incidents: runtime.store.list('portalIncidents'), notifications: runtime.store.list('portalNotifications'), deviceEvents: runtime.store.list('deviceIncidentEvents') }));
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
await runtime.close();
