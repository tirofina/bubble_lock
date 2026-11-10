import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const revision = '715ef58df6c901480eb71fb3b9278e8df6547d93';
const profile = new URL('./.local/scoped/', import.meta.url);
const local = new URL('command-api/', profile);
const team = new URL('team-source/pc-mobius/integration/src/', local);
const gatewayId = 'gw-a';
const deviceId = 'keyring-feather-lab';
const subjectId = 'scoped-feather-bench';
const operatorId = 'scoped-command-operator';
const gatewayPrincipalId = 'scoped-command-gateway-a';
const port = 8787;

if ((await readFile(new URL('team-revision', local), 'utf8')).trim() !== revision) {
  throw new Error('Pinned team command API source is required.');
}
const [{ createIntegrationRuntime }, { createIntegrationServer }, ca, cert, key, gatewayCert, operatorCert] = await Promise.all([
  import(new URL('integration-runtime.mjs', team).href), import(new URL('api-server.mjs', team).href),
  ...['ca.pem', 'server.pem', 'server.key', 'gateway-a.pem'].map((name) => readFile(new URL(`tls/${name}`, profile))),
  readFile(new URL('operator.pem', local)),
]);
const fingerprint = (certificate) => new X509Certificate(certificate).fingerprint256;
const principals = [
  { principalId: gatewayPrincipalId, mtlsFingerprint: fingerprint(gatewayCert), scopes: [] },
  { principalId: operatorId, mtlsFingerprint: fingerprint(operatorCert),
    scopes: ['consent:write', 'grant:write', 'grant:revoke', 'bubble:command'] },
];

const gatewayPath = `/api/v1/gateways/${gatewayId}`;
const gatewayRoutes = new Set([
  `GET ${gatewayPath}/commands`, `GET ${gatewayPath}/credentials/status`, `POST ${gatewayPath}/authorize`,
]);
const operatorRoutes = new Set([
  'POST /v1/consents', 'POST /v1/grants', 'POST /v1/grants/revoke', `POST ${gatewayPath}/commands`,
]);
const denied = (status, error) => ({ status, headers: { 'content-type': 'application/json' }, body: { error } });
let runtimeApi;
const server = createIntegrationServer({ tls: { ca, cert, key }, principals, api: {
  async handle(request) {
    if (!runtimeApi) return denied(503, 'Scoped command API is starting');
    const path = request.path.split('?')[0];
    const route = `${request.method} ${path}`;
    if (request.principal.principalId === gatewayPrincipalId && gatewayRoutes.has(route)) {
      return runtimeApi.handle(request);
    }
    if (request.principal.principalId === operatorId && operatorRoutes.has(route)
        && (path !== '/v1/consents' || request.body?.subjectId === subjectId)) {
      return runtimeApi.handle(request);
    }
    return denied(403, 'Scoped command route denied');
  },
} });

// Reserve the loopback listener before opening the dedicated state. A second process
// exits on address collision without touching the state of the running instance.
server.listen(port, '127.0.0.1');
await once(server, 'listening');
try {
  const runtime = await createIntegrationRuntime({
    statePath: fileURLToPath(new URL('runtime.json', local)),
    receiptPath: fileURLToPath(new URL('integration-receipts.jsonl', local)),
  });
  const enrollment = { gatewayId, principalId: gatewayPrincipalId, fingerprint: principals[0].mtlsFingerprint,
    devices: { [deviceId]: subjectId }, credentialRevision: 'scoped-gw-a-1', ownershipEpoch: 1 };
  const prior = runtime.store.get('gateways', gatewayId);
  if (prior) {
    const { status, ...identity } = prior;
    if (!['ACTIVE', 'LOST', 'REVOKED'].includes(status) || !isDeepStrictEqual(identity, enrollment)) {
      throw new Error('Existing scoped Gateway enrollment does not match this profile.');
    }
  } else {
    await runtime.gatewayControl.enroll(enrollment);
  }
  runtimeApi = runtime.api;
  console.log(JSON.stringify({ status: 'READY', scope: 'scoped-command-api', endpoint: `https://127.0.0.1:${port}`,
    teamRevision: revision, gatewayId, deviceId, subjectId }));
} catch (error) {
  server.close();
  throw error;
}
