import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [
  'contracts/integration-contract.v1.json',
  'integration/fixtures/fault-fixtures.json',
  'integration/src/policy-service.mjs',
  'integration/src/mec-adapter.mjs',
  'integration/src/handover-coordinator.mjs',
  'integration/src/fl-coordinator.mjs',
  'integration/src/mcp-orchestrator.mjs',
  'integration/src/api-gateway.mjs',
  'integration/src/integration-runtime.mjs',
  'integration/src/api-server.mjs',
  'integration/src/gateway-control.mjs',
  'integration/src/integration-store.mjs',
  'integration/src/integration-utils.mjs'
];
const artifacts = [];
for (const relative of files) {
  const buffer = await readFile(resolve(root, relative));
  artifacts.push({ path: relative, sha256: createHash('sha256').update(buffer).digest('hex') });
}
const manifest = { manifestId: 'privacy-bubble.integration.release', version: '1.0.0', role: 'PC-MOBIUS-INTEGRATION', docRevision: '2.0.0', generatedAt: new Date().toISOString(), commands: ['npm run integration:validate', 'npm run integration', 'npm run integration:replay'], rubric: ['R06', 'R10', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17'], artifacts };
await mkdir(resolve(root, 'integration/release'), { recursive: true });
await writeFile(resolve(root, 'integration/release/manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(manifest, null, 2));
