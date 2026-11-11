import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { createIntegrationServer } from '../integration/src/api-server.mjs';
import { OidcVerifier } from '../integration/src/oidc-verifier.mjs';
import { createMtlsFetch } from '../integration/src/fl-worker.mjs';
import { loadMecDeploymentSchema } from '../integration/src/mec-deployment-schema.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PRIVACY_BUBBLE_INTEGRATION_PORT ?? 8787);
const configPath = process.env.PRIVACY_BUBBLE_API_CONFIG;
const config = configPath ? JSON.parse(await readFile(resolve(configPath), 'utf8')) : {};
for (const service of ['Location', 'RNIS']) if (config.core?.mec?.[service]?.deploymentSchema) config.core.mec[service] = await loadMecDeploymentSchema(config.core.mec[service]);
const edgeTransports = [];
const transportConfigurations = [config.core?.registration?.cse, config.core?.mec?.Location, config.core?.mec?.RNIS, config.core?.fl?.publication,
  ...(config.core?.handover?.edges ?? []).flatMap((edge) => [edge, edge.deployment])];
for (const options of transportConfigurations) if (options?.tls) {
  const material = Object.fromEntries(await Promise.all(['key', 'cert', 'ca'].map(async (name) => [name, await readFile(resolve(options.tls[name]))])));
  options.fetchImpl = createMtlsFetch(material); edgeTransports.push(options.fetchImpl);
}
const runtime = await createIntegrationRuntime({ statePath: resolve(config.statePath ?? resolve(root, 'integration/state/runtime.json')), receiptPath: resolve(config.receiptPath ?? resolve(root, 'receipts/integration-api.jsonl')), database: config.database ?? null, core: config.core ?? {} });
const tls = config.tls ? Object.fromEntries(await Promise.all(['key', 'cert', 'ca'].map(async (name) => [name, await readFile(resolve(config.tls[name]))]))) : null;
for (const gateway of config.gateways ?? []) await runtime.gatewayControl.enroll(gateway);
for (const household of config.households ?? []) await runtime.portalService.provisionHousehold(household);
for (const registration of config.mcpServers ?? []) {
  await runtime.mcpOrchestrator.registerRemoteServer({ serverId: registration.serverId, endpoint: registration.endpoint, audience: registration.audience,
    getAccessToken: async (_audience, identity) => {
      const variable = identity ? registration.accessTokenEnvByPrincipal?.[identity.principalId] : registration.catalogAccessTokenEnv;
      if (!variable || typeof process.env[variable] !== 'string') throw new Error('MCP audience별 등록 사용자 token 환경변수를 연결하세요.');
      return process.env[variable];
    } });
}
const oidcVerifier = config.oidc ? new OidcVerifier(config.oidc) : null;
const deployment = process.env.BUBBLE_EDGE_INSTANCE_ID ? { hostId: process.env.BUBBLE_EDGE_HOST_ID, instanceId: process.env.BUBBLE_EDGE_INSTANCE_ID, imageDigest: process.env.BUBBLE_EDGE_IMAGE_DIGEST, pid: process.pid } : null;
const server = createIntegrationServer({ api: runtime.api, tls, principals: config.principals ?? [], oidcVerifier, deployment,
  ...(runtime.gatewayRegistration ? { certificateResolver: (fingerprint) => runtime.gatewayRegistration.resolveCertificatePrincipal(fingerprint) } : {}) });
if (runtime.gatewayRegistration) runtime.gatewayRegistration.terminateSessions = async ({ fingerprint }) => server.terminateCertificateSessions(fingerprint);
const host = tls ? config.host ?? '127.0.0.1' : '127.0.0.1';
server.listen(port, host, () => console.log(JSON.stringify({ role: 'PC-MOBIUS-INTEGRATION', endpoint: `${tls ? 'https' : 'http'}://${host}:${port}`, status: 'READY', authentication: tls ? oidcVerifier ? 'certificate-or-oidc-enrollment' : 'certificate-enrollment' : 'health-only' })));
let closing = false;
const close = async () => { if (closing) return; closing = true; server.closeAllConnections(); await new Promise((resolveClose) => server.close(resolveClose)); await runtime.close(); for (const transport of edgeTransports) transport.close(); };
process.on('SIGINT', () => void close()); process.on('SIGTERM', () => void close());
