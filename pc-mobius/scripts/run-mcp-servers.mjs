import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { createMcpHttpServer } from '../integration/src/mcp-http.mjs';
import { MCP_CONTRACT } from '../integration/src/mcp-schema.mjs';
import { createMcpAuthorizer, createMcpDomainHandlers } from '../integration/src/mcp-domain-tools.mjs';
import { OidcVerifier } from '../integration/src/oidc-verifier.mjs';
import { createMcpDiscoveryAdapter } from '../integration/src/mcp-discovery.mjs';

const configPath = process.env.PRIVACY_BUBBLE_API_CONFIG;
if (!configPath) throw new Error('PRIVACY_BUBBLE_API_CONFIG 경로를 설정하세요.');
const config = JSON.parse(await readFile(resolve(configPath), 'utf8'));
if (!config.tls || !config.oidc || (!config.database && !process.env.BUBBLE_DATABASE_URL)) throw new Error('MCP 서버의 TLS·OIDC·공유 PostgreSQL 설정을 등록하세요.');
const tls = Object.fromEntries(await Promise.all(['key', 'cert', 'ca'].map(async (name) => [name, await readFile(resolve(config.tls[name]))])));
const runtime = await createIntegrationRuntime({ database: config.database, core: config.core ?? {} });
const discoverDevices = config.mcp?.oneM2m ? createMcpDiscoveryAdapter({ ...config.mcp.oneM2m, clock: runtime.policyService.clock }) : null;
const handlers = createMcpDomainHandlers(runtime, { discoverDevices });
const servers = [];
for (const [serverId, definition] of Object.entries(MCP_CONTRACT.servers)) {
  const verifier = new OidcVerifier({ ...config.oidc, audience: definition.audience });
  const port = config.mcp?.ports?.[serverId] ?? ({ oneM2M: 8791, MEC: 8792, Audit: 8793 }[serverId]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('MCP 서버 포트를 확인하세요.');
  const server = createMcpHttpServer({ serverId, audience: definition.audience, tools: definition.tools, handlers: handlers[serverId], store: runtime.store, tls,
    clock: runtime.policyService.clock, allowedOrigins: config.mcp?.allowedOrigins ?? [], authorizeCall: createMcpAuthorizer(runtime),
    authenticate: async (request) => { try { return await verifier.principal(request.headers.authorization, config.principals ?? []); } catch { return null; } } });
  await new Promise((resolveReady, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolveReady); });
  servers.push(server);
  console.log(JSON.stringify({ role: 'MCP_SERVER', serverId, audience: definition.audience, protocolVersion: MCP_CONTRACT.protocolVersion, endpoint: `https://127.0.0.1:${port}/mcp`, status: 'READY' }));
}
const close = async () => { for (const server of servers) { server.close(); server.closeAllConnections(); } await runtime.close(); };
process.once('SIGINT', () => void close()); process.once('SIGTERM', () => void close());
