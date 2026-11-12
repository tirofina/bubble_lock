import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { X509Certificate, randomUUID } from 'node:crypto';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { createIntegrationServer } from '../integration/src/api-server.mjs';
import { OneM2mEdgeClient } from '../integration/src/handover-cse.mjs';
import { encodeBinarySwitch } from '../src/sdt-adapter.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';

const { values } = parseArgs({ options: {
  endpoint: { type: 'string' }, originator: { type: 'string' }, 'cse-base': { type: 'string', default: '/Mobius' },
  evidence: { type: 'string', default: 'docs/final-evidence/group' },
} });
if (!values.endpoint || !values.originator) throw new Error('--endpoint and --originator from the prepared local CSE are required');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(values.endpoint).hostname)) throw new Error('This runner uses the prepared loopback CSE only');
const execute = promisify(execFile);
const run = randomUUID().slice(0, 8);
const temporary = await mkdtemp(join(process.env.RUN_TMP ?? tmpdir(), 'group-real-'));
const evidencePath = resolve(values.evidence);
await mkdir(evidencePath, { recursive: true });
const admin = new OneM2mEdgeClient({ endpoint: values.endpoint, originator: values.originator, cseBase: values['cse-base'] });
const trace = [];
let runtime;
let server;
let provider;
let publisher;

try {
  const certificates = {};
  for (const name of ['server', 'guardian', 'visitor', 'gateway1', 'gateway2']) {
    const keyPath = join(temporary, `${name}.key`);
    const certPath = join(temporary, `${name}.crt`);
    await execute(process.env.KEYRING_TEST_OPENSSL ?? 'openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
      '-nodes', '-days', '1', '-subj', `/CN=group-${name}`, '-addext', 'subjectAltName=IP:127.0.0.1',
      '-keyout', keyPath, '-out', certPath]);
    const key = await readFile(keyPath); const cert = await readFile(certPath);
    certificates[name] = { key, cert, fingerprint: new X509Certificate(cert).fingerprint256 };
  }
  const principals = {
    guardian: { principalId: 'group-guardian', scopes: ['portal:read', 'device:write', 'consent:write', 'grant:write', 'grant:revoke', 'bubble:command'], mtlsFingerprint: certificates.guardian.fingerprint },
    visitor: { principalId: 'group-visitor', scopes: ['portal:read', 'command:request'], mtlsFingerprint: certificates.visitor.fingerprint },
    gateway1: { principalId: 'group-gateway1', scopes: [], mtlsFingerprint: certificates.gateway1.fingerprint },
    gateway2: { principalId: 'group-gateway2', scopes: [], mtlsFingerprint: certificates.gateway2.fingerprint },
  };
  provider = await admin.ensure(admin.cseBase, 2, { 'm2m:ae': { rn: `group-final-${run}`, api: 'N.privacy.bubble.group', rr: true } }, { update: false });
  publisher = await admin.ensure(admin.cseBase, 2, { 'm2m:ae': { rn: `group-final-publisher-${run}`, api: 'N.privacy.bubble.group.publisher', rr: true } }, { update: false });
  const policy = (rn, updateAllowed) => ({ 'm2m:acp': { rn,
    pv: { acr: [{ acor: [values.originator], acop: 63 }, { acor: [publisher.aei], acop: updateAllowed ? 63 : 34 }] },
    pvs: { acr: [{ acor: [values.originator], acop: 63 }] },
  } });
  const allowed = await admin.ensure(provider.path, 1, policy('allow', true));
  const denied = await admin.ensure(provider.path, 1, policy('deny-update', false));
  await admin.request('PUT', provider.path, { 'm2m:ae': { acpi: [allowed.ri] } });
  const switches = {};
  for (const name of ['A', 'B', 'C']) {
    switches[name] = await admin.ensure(provider.path, 28, encodeBinarySwitch({ rn: `switch-${name}`, state: false, acpi: [name === 'B' ? denied.ri : allowed.ri] }, { operation: 'CREATE' }));
  }
  const members = Object.fromEntries(['A', 'B', 'C'].map((name) => [`keyring-${name}`, {
    deviceId: `keyring-${name}`, gatewayId: name === 'B' ? 'pi-02' : 'pi-01', groupId: 'group-home', resourcePath: switches[name].path,
  }]));
  const core = { retention: { autoPrune: false }, group: { cse: {
    endpoint: values.endpoint, originator: publisher.aei, cseBase: admin.cseBase, parentPath: provider.path,
  }, members } };
  const options = { statePath: join(temporary, 'state.json'), receiptPath: join(temporary, 'receipts.jsonl'), core };
  const start = async () => {
    runtime = await createIntegrationRuntime(options);
    server = createIntegrationServer({ api: runtime.api, tls: { key: certificates.server.key, cert: certificates.server.cert,
      ca: Object.entries(certificates).filter(([name]) => name !== 'server').map(([, material]) => material.cert) },
    principals: Object.values(principals) });
    await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  };
  const stop = async () => {
    server.closeAllConnections();
    await new Promise((resolveClose) => server.close(resolveClose));
    server = null;
    await runtime.close(); runtime = null;
  };
  await start();
  const call = async (identity, path, body, expected = 200) => {
    const response = await new Promise((resolveResponse, reject) => {
      const client = httpsRequest({ hostname: '127.0.0.1', port: server.address().port, path, method: body === undefined ? 'GET' : 'POST',
        key: certificates[identity].key, cert: certificates[identity].cert, ca: certificates.server.cert, minVersion: 'TLSv1.3',
        agent: false, headers: { 'content-type': 'application/json' }, timeout: 5000 }, (incoming) => {
        const chunks = [];
        incoming.on('data', (chunk) => chunks.push(chunk));
        incoming.on('end', () => resolveResponse({ status: incoming.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      client.on('error', reject); client.on('timeout', () => client.destroy(new Error('Group HTTP deadline')));
      client.end(body === undefined ? undefined : JSON.stringify(body));
    });
    trace.push({ identity, path, status: response.status, body: response.body });
    assert.equal(response.status, expected, JSON.stringify(response.body));
    return response.body;
  };
  await runtime.portalService.provisionHousehold({ householdId: 'group-home', name: 'group simulation', ownerId: principals.guardian.principalId,
    members: [{ principalId: principals.visitor.principalId, role: 'visitor' }] });
  for (const [index, devices] of [[1, { 'keyring-A': 'group-home', 'keyring-C': 'group-home' }], [2, { 'keyring-B': 'group-home' }]]) {
    await runtime.gatewayControl.enroll({ gatewayId: `pi-0${index}`, principalId: principals[`gateway${index}`].principalId,
      fingerprint: certificates[`gateway${index}`].fingerprint, devices, credentialRevision: '1', ownershipEpoch: 3 });
  }
  for (const member of Object.values(members)) await call('guardian', '/v1/portal/devices', {
    householdId: 'group-home', deviceId: member.deviceId, gatewayId: member.gatewayId, label: member.deviceId, idempotencyKey: `register-${member.deviceId}`,
  });
  const consent = await call('guardian', '/v1/portal/consents', { householdId: 'group-home', purpose: 'actual CSE group', scopes: ['bubble:command'], ttlSec: 900, idempotencyKey: 'consent' });
  const grant = await call('guardian', '/v1/portal/grants', { consentId: consent.consentId, scopes: ['bubble:command'], ttlSec: 900, idempotencyKey: 'grant' });
  const requested = await call('visitor', '/v1/portal/commands/request', { householdId: 'group-home', deviceIds: ['keyring-A', 'keyring-B'],
    desiredState: { state: true }, reason: 'actual CSE partial/retry/restart', idempotencyKey: 'request' });
  const approvalInput = { requestId: requested.requestId, grantId: grant.grantId, idempotencyKey: 'approval' };
  await call('visitor', '/v1/portal/commands/approve', approvalInput, 403);
  const issue = runtime.gatewayControl.issue.bind(runtime.gatewayControl);
  runtime.gatewayControl.issue = async (input) => {
    if (input.deviceId === 'keyring-B') throw new Error('simulated member B issue failure');
    return issue(input);
  };
  await call('guardian', '/v1/portal/commands/approve', approvalInput, 403);
  assert.deepEqual((await call('gateway1', '/api/v1/gateways/pi-01/commands')).commands, []);
  runtime.gatewayControl.issue = issue;
  const approval = await call('guardian', '/v1/portal/commands/approve', approvalInput);
  const partial = await call('guardian', '/v1/portal/commands/group', { requestId: requested.requestId });
  assert.deepEqual(partial.members.map((member) => member.status), ['DISPATCHED', 'RETRY_PENDING']);
  assert.equal(partial.appliedCount, 0);
  const csePartial = {};
  for (const name of ['A', 'B', 'C']) csePartial[name] = (await admin.read(switches[name].path))['cod:binSh'].state;
  assert.deepEqual(csePartial, { A: true, B: false, C: false });
  assert.deepEqual((await call('gateway2', '/api/v1/gateways/pi-02/commands')).commands, []);
  const binding = (command) => ({ commandId: command.commandId, deviceId: command.deviceId, claimId: command.claimId,
    grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, payloadHash: approvalHash(command) });
  const deviceJournal = new Map();
  const executeDevice = async (identity, command) => {
    const prefix = `/api/v1/gateways/${command.gatewayId}`;
    assert.equal((await call(identity, `${prefix}/authorize`, binding(command))).allowed, true);
    assert.equal((await call(identity, `${prefix}/dispatch-start`, binding(command))).allowed, true);
    const cseReadback = (await admin.read(members[command.deviceId].resourcePath))['cod:binSh'].state;
    assert.equal(cseReadback, command.desiredState.state);
    // The simulated keyring applies the canonical command to its own state, independently of the CSE desired state.
    deviceJournal.set(command.deviceId, { commandId: command.commandId, payloadHash: approvalHash(command), state: command.desiredState.state });
    const readback = { state: deviceJournal.get(command.deviceId).state };
    const receipt = { version: 1, gatewayId: command.gatewayId, deviceId: command.deviceId, commandId: command.commandId,
      payloadHash: approvalHash(command), status: 'APPLIED', ackCode: 'APPLIED', acceptedAt: command.issuedAt, appliedAt: command.issuedAt,
      receivedAt: new Date().toISOString(), readback, firmwareRevision: 'simulated-keyring-group-v1', ownershipEpoch: command.ownershipEpoch,
      grantRevision: command.grantRevision, timestampSource: 'gateway-estimated', detail: 'simulated keyring state journal; CSE desired state checked separately',
      bootId: `sim-${command.deviceId}` };
    await call(identity, `${prefix}/receipts`, { ...receipt, payloadHash: 'f'.repeat(64) }, 403);
    assert.equal((await call(identity, `${prefix}/receipts`, receipt)).executionState, 'APPLIED_VERIFIED');
    return receipt;
  };
  const commandA = (await call('gateway1', '/api/v1/gateways/pi-01/commands')).commands[0];
  const receiptA = await executeDevice('gateway1', commandA);
  const afterAck = await call('guardian', '/v1/portal/commands/group', { requestId: requested.requestId });
  assert.equal(afterAck.appliedCount, 1);
  await stop();
  await start();
  assert.equal((await call('guardian', '/v1/portal/commands/group', { requestId: requested.requestId })).appliedCount, 1);
  await admin.request('PUT', switches.B.path, { 'cod:binSh': { acpi: [allowed.ri] } });
  const retried = await call('guardian', '/v1/portal/commands/retry', { requestId: requested.requestId });
  assert.deepEqual(retried.members.map((member) => member.attempts), [1, 2]);
  const commandB = (await call('gateway2', '/api/v1/gateways/pi-02/commands')).commands[0];
  assert.deepEqual(commandB, approval.commands[1], 'restart/retry preserves the approved claim and payload');
  const receiptB = await executeDevice('gateway2', commandB);
  const settled = await call('guardian', '/v1/portal/commands/group', { requestId: requested.requestId });
  assert.equal(settled.status, 'SETTLED'); assert.equal(settled.appliedCount, 2);
  await stop(); await start();
  const recovered = await call('guardian', '/v1/portal/commands/group', { requestId: requested.requestId });
  assert.equal(recovered.status, 'SETTLED');
  assert.equal((await call('gateway1', '/api/v1/gateways/pi-01/receipts', receiptA)).status, 'DUPLICATE');
  assert.equal((await call('gateway2', '/api/v1/gateways/pi-02/receipts', receiptB)).status, 'DUPLICATE');
  const publications = runtime.store.list('receipts').filter((record) => record.type === 'GROUP_CSE_MEMBER_PUBLISHED');
  assert.deepEqual(publications.map((entry) => entry.rsc), [2004, 4103, 2004]);
  const result = { status: 'PASS', generatedAt: new Date().toISOString(), transport: 'actual local Mobius HTTP /fopt + TLS1.3 mTLS portal/Gateway API',
    devices: 'two simulated keyrings on two simulated Gateways; third device excluded', cseEndpoint: values.endpoint,
    providerPath: provider.path, partial, csePartial, afterAck, retried, recovered, publications,
    canonicalCommands: approval.commands, simulatedDeviceJournal: Object.fromEntries(deviceJournal), restartCount: 2, checks: ['partial permission 2004/4103', 'failed member hidden from poll',
      'CSE response never substitutes device ACK', 'native ACK/readback settlement', 'restart before retry and after settlement',
      'original claim/deadline/revision/epoch/payload', 'forged receipt rejection', 'duplicate receipt after restart', 'unselected member untouched',
      'partial canonical issue failure blocks Gateway poll until CSE publication'] };
  await writeFile(join(evidencePath, 'actual-cse-group.json'), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(join(evidencePath, 'http-trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
  console.log(JSON.stringify({ status: result.status, evidencePath, cseMemberRsc: publications.map((entry) => entry.rsc), settledMembers: recovered.appliedCount }));
  await stop();
} finally {
  if (server) { server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose)); }
  if (runtime) await runtime.close();
  if (provider) await admin.request('DELETE', provider.path);
  if (publisher) await admin.request('DELETE', publisher.path);
  await rm(temporary, { recursive: true, force: true });
}
