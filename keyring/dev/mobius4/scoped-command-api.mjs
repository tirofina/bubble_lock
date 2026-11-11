import { X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { permitsLocationTrial } from './scoped-r18-location-routes.mjs';

const mode = process.argv[2] ?? 'legacy';
const profiles = JSON.parse(await readFile(new URL('./scoped-command-profiles.json', import.meta.url), 'utf8'));
if (!Object.hasOwn(profiles, mode)) throw new Error('Unknown scoped command API profile.');
const { directory, revision, port, gatewayId = 'gw-a', deviceId = 'keyring-feather-lab',
  subjectId = 'scoped-feather-bench', boardRevision, firmwareRevision: defaultFirmware,
  alternateFirmwareRevisions = [] } = profiles[mode];
const integrated = mode !== 'legacy';
const r18 = mode === 'r18';
const options = process.argv.slice(3);
const firmwarePrefix = '--firmware-revision=';
const firmwareOptions = options.filter((option) => option.startsWith(firmwarePrefix));
const locationTrial = options.includes('--enable-location-trial');
if ((options.length && !r18) || firmwareOptions.length > 1
    || options.length !== firmwareOptions.length + Number(locationTrial)) {
  throw new Error('Expected only the supported r18 loopback options.');
}
const firmwareRevision = firmwareOptions.length === 1 ? firmwareOptions[0].slice(firmwarePrefix.length) : defaultFirmware;
if (r18 && ![defaultFirmware, ...alternateFirmwareRevisions].includes(firmwareRevision)) {
  throw new Error('Unsupported r18 command firmware.');
}
const gatewaySlot = gatewayId.slice(3);
const profile = new URL('./.local/scoped/', import.meta.url);
const local = new URL(`${directory}/`, profile);
const team = new URL('team-source/pc-mobius/integration/src/', local);
const operatorId = r18 ? 'scoped-command-operator-r18' : 'scoped-command-operator';
const gatewayPrincipalId = `scoped-command-gateway-${gatewaySlot}`;
const label = r18 ? 'r18 bench' : 'Feather bench';

// Keep inherited database and key settings out of the loopback-only bench process.
delete process.env.BUBBLE_DATABASE_URL;
delete process.env.BUBBLE_MEC_ENCRYPTION_KEY;

if ((await readFile(new URL('team-revision', local), 'utf8')).trim() !== revision) {
  throw new Error('Pinned team command API source is required.');
}
const [{ createIntegrationRuntime }, { createIntegrationServer }, ca, cert, key, gatewayCert, operatorCert] = await Promise.all([
  import(new URL('integration-runtime.mjs', team).href), import(new URL('api-server.mjs', team).href),
  ...['ca.pem', 'server.pem', 'server.key', `gateway-${gatewaySlot}.pem`].map((name) => readFile(new URL(`tls/${name}`, profile))),
  readFile(new URL('operator.pem', local)),
]);
const fingerprint = (certificate) => new X509Certificate(certificate).fingerprint256;
const principals = [
  { principalId: gatewayPrincipalId, mtlsFingerprint: fingerprint(gatewayCert), scopes: [] },
  { principalId: operatorId, mtlsFingerprint: fingerprint(operatorCert),
    scopes: ['consent:write', 'grant:write', 'grant:revoke', 'bubble:command',
      ...(locationTrial ? ['portal:read', 'incident:write', 'incident:resolve'] : [])] },
];

const gatewayPath = `/api/v1/gateways/${gatewayId}`;
const gatewayRoutes = new Set([
  `GET ${gatewayPath}/commands`, `GET ${gatewayPath}/credentials/status`, `POST ${gatewayPath}/authorize`,
]);
const integrationFeatures = ['dispatch-start', 'receipts', 'telemetry'];
if (integrated) {
  for (const path of integrationFeatures) gatewayRoutes.add(`POST ${gatewayPath}/${path}`);
}
const operatorRoutes = new Set([
  'POST /v1/consents', 'POST /v1/grants', 'POST /v1/grants/revoke', `POST ${gatewayPath}/commands`,
]);
const denied = (status, error) => ({ status, headers: { 'content-type': 'application/json' }, body: { error } });
let runtimeApi;
let runtime;
const server = createIntegrationServer({ tls: { ca, cert, key }, principals, api: {
  async handle(request) {
    if (!runtimeApi) return denied(503, 'Scoped command API is starting');
    const path = request.path.split('?')[0];
    const route = `${request.method} ${path}`;
    if (request.principal.principalId === gatewayPrincipalId) {
      if (integrated && route === `GET ${gatewayPath}/bench-capabilities`) {
        return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          body: { status: 'READY', scope: 'scoped-command-api', mode, teamRevision: revision,
            gatewayId, deviceId, features: integrationFeatures, ...(r18 ? { boardRevision, firmwareRevision } : {}) } };
      }
      if (gatewayRoutes.has(route)) return runtimeApi.handle(request);
    }
    if (request.principal.principalId === operatorId && operatorRoutes.has(route)
        && (path !== '/v1/consents' || request.body?.subjectId === subjectId)) {
      return runtimeApi.handle(request);
    }
    if (locationTrial && permitsLocationTrial(request, path, { operatorId, subjectId, deviceId, store: runtime.store })) {
      const result = await runtimeApi.handle(request);
      return { ...result, headers: { ...result.headers, 'cache-control': 'no-store' } };
    }
    return denied(403, 'Scoped command route denied');
  },
} });

// Reserve the loopback listener before opening the dedicated state. A second process
// exits on address collision without touching the state of the running instance.
server.listen(port, '127.0.0.1');
await once(server, 'listening');
try {
  runtime = await createIntegrationRuntime({
    statePath: fileURLToPath(new URL('runtime.json', local)),
    receiptPath: fileURLToPath(new URL('integration-receipts.jsonl', local)),
  });
  const enrollment = { gatewayId, principalId: gatewayPrincipalId, fingerprint: principals[0].mtlsFingerprint,
    devices: { [deviceId]: subjectId }, credentialRevision: `scoped-${gatewayId}-1`, ownershipEpoch: 1 };
  const prior = runtime.store.get('gateways', gatewayId);
  if (prior) {
    const { status, ...identity } = prior;
    if (!['ACTIVE', 'LOST', 'REVOKED'].includes(status) || !isDeepStrictEqual(identity, enrollment)) {
      throw new Error('Existing scoped Gateway enrollment does not match this profile.');
    }
  } else {
    await runtime.gatewayControl.enroll(enrollment);
  }
  if (integrated) {
    await runtime.store.transaction(`scoped-enrollment:${subjectId}`, async () => {
      const household = runtime.store.get('households', subjectId);
      if (household) {
        if (household.ownerId !== operatorId || !household.members.some(
          ({ principalId, role }) => principalId === operatorId && role === 'guardian',
        )) throw new Error('Existing scoped household does not match the operator.');
      } else {
        await runtime.portalService.provisionHousehold({ householdId: subjectId, name: label, ownerId: operatorId });
      }
      const device = runtime.store.get('portalDevices', deviceId);
      if (device) {
        if (device.householdId !== subjectId || device.gatewayId !== gatewayId) {
          throw new Error('Existing scoped device does not match its Gateway and household.');
        }
      } else {
        const bootstrapOperator = { principalId: operatorId, scopes: ['portal:read', 'device:write'] };
        await runtime.portalService.registerDevice(bootstrapOperator, {
          householdId: subjectId, gatewayId, deviceId, label,
          idempotencyKey: r18 ? 'scoped-r18-device-registration' : 'scoped-feather-device-registration',
        });
      }
    });
  }
  runtimeApi = runtime.api;
  console.log(JSON.stringify({ status: 'READY', scope: 'scoped-command-api', endpoint: `https://127.0.0.1:${port}`,
    mode, teamRevision: revision, gatewayId, deviceId, subjectId,
    ...(integrated ? { features: integrationFeatures } : {}), ...(r18 ? { boardRevision, firmwareRevision } : {}) }));
} catch (error) {
  server.close();
  await runtime?.close?.();
  throw error;
}
