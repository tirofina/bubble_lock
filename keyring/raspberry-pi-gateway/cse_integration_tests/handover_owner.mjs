import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { matchesHandoverOwner } from '../../integration-candidate/handover-owner.mjs';

const [tree, pki] = process.argv.slice(2);
const teamImport = (name) => import(pathToFileURL(join(tree, 'pc-mobius', 'integration', 'src', name)));
const { createIntegrationRuntime } = await teamImport('integration-runtime.mjs');
const { createIntegrationServer } = await teamImport('api-server.mjs');
const { approvalHash } = await teamImport('integration-utils.mjs');
const credentials = async (name) => ({
  cert: await readFile(join(pki, name + '.pem')),
  key: await readFile(join(pki, name + '.key')),
});
const ca = await readFile(join(pki, 'trusted.pem'));
const [serverTls, clientA, clientB, guardianClient] =
  await Promise.all(['server', 'client', 'gateway-b', 'guardian'].map(credentials));
const peer = (principalId, client, scopes = []) => ({
  principalId, scopes, mtlsFingerprint: new X509Certificate(client.cert).fingerprint256,
});
const a = peer('gw-a-test', clientA);
const b = peer('gw-b-test', clientB);
const guardian = peer('guardian-test', guardianClient, ['consent:write', 'grant:write', 'bubble:command']);
const deviceId = 'kr-handover-test';
const subjectId = 'handover-test-household';
const gatewayByEdge = new Map([['edge-a-test', a.principalId], ['edge-b-test', b.principalId]]);
const statePath = join(pki, 'handover-state.json');

function guarded(runtime) {
  const active = runtime.gatewayControl.active.bind(runtime.gatewayControl);
  runtime.gatewayControl.active = (record, gateway) => active(record, gateway)
    && matchesHandoverOwner({ command: record.command, gateway,
      handover: runtime.handoverCoordinator.status(record.command.deviceId), gatewayByEdge });
}

async function withApi(runtime, run) {
  const server = createIntegrationServer({ api: runtime.api, tls: { ...serverTls, ca }, principals: [a, b, guardian] });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  function call(client, method, path, value) {
    const body = value === undefined ? undefined : JSON.stringify(value);
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, method, path, ca, ...client, agent: false,
        minVersion: 'TLSv1.3', headers: body && { 'content-type': 'application/json',
          'content-length': Buffer.byteLength(body) } }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()),
              tls: res.socket.getProtocol() });
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(4000, () => req.destroy(new Error('loopback mTLS request timed out')));
      req.on('error', reject);
      req.end(body);
    });
  }
  try {
    await run(call);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const gatewayPath = (gateway, route) => `/api/v1/gateways/${gateway.principalId}/${route}`;
const binding = (command) => ({
  ...Object.fromEntries(['commandId', 'deviceId', 'claimId', 'grantRevision', 'ownershipEpoch'].map(
    (key) => [key, command[key]])),
  payloadHash: approvalHash(command),
});
const authorize = (call, gateway, client, command) =>
  call(client, 'POST', gatewayPath(gateway, 'authorize'), binding(command));
const poll = (call, gateway, client) =>
  call(client, 'GET', gatewayPath(gateway, 'commands?limit=16'));
function issue(call, gateway, commandId, grantId) {
  return call(guardianClient, 'POST', gatewayPath(gateway, 'commands'), {
    deviceId, commandId, grantId, desiredState: { state: true },
    deadline: new Date(Date.now() + 60000).toISOString(),
  });
}

const runtime = await createIntegrationRuntime({ statePath });
for (const gateway of [a, b]) {
  await runtime.gatewayControl.enroll({ gatewayId: gateway.principalId, principalId: gateway.principalId,
    fingerprint: gateway.mtlsFingerprint, devices: { [deviceId]: subjectId }, credentialRevision: '1' });
}
const coordinator = runtime.handoverCoordinator;
for (const edgeId of gatewayByEdge.keys()) coordinator.registerEdge({ edgeId });
const original = await coordinator.handover({ ueId: deviceId, targetEdgeId: 'edge-a-test' });
let rollbackCommand;
let formerAfterCutover;
await withApi(runtime, async (call) => {
  const scope = ['bubble:command'];
  const consent = await call(guardianClient, 'POST', '/v1/consents', { subjectId, scopes: scope, purpose: 'handover-test' });
  assert.equal(consent.status, 201);
  const grant = await call(guardianClient, 'POST', '/v1/grants', { consentId: consent.body.consentId, scopes: scope });
  assert.equal(grant.status, 201);
  const grantId = grant.body.grantId;
  const before = await issue(call, a, 'before-cutover', grantId);
  assert.equal(before.status, 201);
  assert.equal(before.body.ownershipEpoch, original.epoch);
  assert.equal((await authorize(call, a, clientA, before.body)).body.allowed, true);
  assert.equal((await authorize(call, a, clientB, before.body)).status, 403);

  const cutover = await coordinator.handover({ ueId: deviceId, targetEdgeId: 'edge-b-test' });
  assert.equal(cutover.epoch, original.epoch + 1);
  assert.equal((await authorize(call, a, clientA, before.body)).body.allowed, false);

  const former = await issue(call, a, 'new-command-former-gateway', grantId);
  assert.equal(former.status, 201);
  assert.equal(former.body.ownershipEpoch, cutover.epoch);
  formerAfterCutover = former.body;
  const unsafe = await authorize(call, a, clientA, former.body);
  assert.equal(unsafe.status, 200);
  assert.equal(unsafe.tls, 'TLSv1.3');
  assert.equal(unsafe.body.allowed, true);

  guarded(runtime);
  assert.equal((await issue(call, a, 'former-gateway-guarded', grantId)).status, 403);
  assert.deepEqual((await poll(call, a, clientA)).body.commands, []);
  assert.equal((await authorize(call, a, clientA, former.body)).body.allowed, false);
  const active = await issue(call, b, 'active-gateway-guarded', grantId);
  assert.equal(active.status, 201);
  assert.equal((await authorize(call, b, clientB, active.body)).body.allowed, true);
  assert.deepEqual((await poll(call, b, clientB)).body.commands, [active.body]);
  const guardInput = { command: active.body, gateway: runtime.gatewayControl.gateway(b.principalId),
    handover: cutover, gatewayByEdge };
  assert.equal(matchesHandoverOwner(guardInput), true);
  assert.equal(matchesHandoverOwner({ ...guardInput, handover: null }), false);
  assert.equal(matchesHandoverOwner({ ...guardInput, handover: { ...cutover, state: 'DRAINING' } }), false);
  assert.equal(matchesHandoverOwner({ ...guardInput, handover: { ...cutover, ueId: 'another-device' } }), false);
  assert.equal(matchesHandoverOwner({ ...guardInput, gatewayByEdge: new Map() }), false);
  assert.equal(matchesHandoverOwner({ ...guardInput, command: { ...active.body, ownershipEpoch: original.epoch } }), false);

  const rollback = await coordinator.rollback(deviceId);
  assert.equal(rollback.edgeId, 'edge-a-test');
  assert.equal(rollback.epoch, cutover.epoch + 1);
  assert.equal((await authorize(call, b, clientB, active.body)).body.allowed, false);
  assert.equal((await issue(call, b, 'former-after-rollback', grantId)).status, 403);
  const restored = await issue(call, a, 'restored-after-rollback', grantId);
  assert.equal(restored.status, 201);
  assert.equal((await authorize(call, a, clientA, restored.body)).body.allowed, true);
  rollbackCommand = restored.body;
});

const reopened = await createIntegrationRuntime({ statePath });
guarded(reopened);
assert.equal(reopened.handoverCoordinator.status(deviceId).state, 'ROLLED_BACK');
await withApi(reopened, async (call) => {
  assert.equal((await authorize(call, a, clientA, rollbackCommand)).body.allowed, true);
  assert.equal((await authorize(call, a, clientA, formerAfterCutover)).body.allowed, false);
  assert.deepEqual((await poll(call, b, clientB)).body.commands, []);
});
console.log(JSON.stringify({
  transport: 'loopback-mtls-tls1.3', oldEpochRejectedByTeam: true, newEpochFormerGatewayAllowedByTeam: true,
  guardRejectsFormerGatewayOnIssuePollAndAuthorize: true, newOwnerAuthorized: true,
  rollbackOwnerAuthorizedAfterRuntimeRestart: true, invalidOwnershipInputsRejected: 5,
}));
