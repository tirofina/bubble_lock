import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';
import { createIntegrationServer } from '../integration/src/api-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.PRIVACY_BUBBLE_INTEGRATION_PORT ?? 8787);
const runtime = await createIntegrationRuntime({ statePath: resolve(root, 'integration/state/runtime.json'), receiptPath: resolve(root, 'receipts/integration-api.jsonl') });
const configPath = process.env.PRIVACY_BUBBLE_API_CONFIG;
const config = configPath ? JSON.parse(await readFile(resolve(configPath), 'utf8')) : {};
const tls = config.tls ? Object.fromEntries(await Promise.all(['key', 'cert', 'ca'].map(async (name) => [name, await readFile(resolve(config.tls[name]))]))) : null;
for (const gateway of config.gateways ?? []) await runtime.gatewayControl.enroll(gateway);
const server = createIntegrationServer({ api: runtime.api, tls, principals: config.principals ?? [] });
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ role: 'PC-MOBIUS-INTEGRATION', endpoint: `${tls ? 'https' : 'http'}://127.0.0.1:${port}`, status: 'READY', authentication: tls ? 'certificate-enrollment' : 'health-only' })));
