import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const executed = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/mec-http.test.mjs','test/mec-trigger.test.mjs','test/mec-deployment-schema.test.mjs'], { cwd: root, encoding: 'utf8', timeout: 120000 });
const output = `${executed.stdout ?? ''}${executed.stderr ?? ''}`;
const contract = await readFile(resolve(root, 'contracts/mec-callback.v1.json'));
const receipt = {
  contractId: 'privacy-bubble.mec-callback.v1',
  generatedAt: new Date().toISOString(),
  status: executed.status === 0 ? 'PASS' : 'REVIEW',
  transport: 'local-http-vendor', simulation: true,
  fixtures: ['M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09'],
  passed: Number(output.match(/# pass (\d+)/)?.[1] ?? 0),
  failed: Number(output.match(/# fail (\d+)/)?.[1] ?? 0),
  contractHash: createHash('sha256').update(contract).digest('hex'),
  executionHash: createHash('sha256').update(output).digest('hex'),
  externalDeploymentGate: 'G-MEC endpoint/Swagger/provider/TLS callback receipts',
};
await mkdir(resolve(root, 'receipts'), { recursive: true });
await writeFile(resolve(root, 'receipts/mec-http-verification.log'), output);
await writeFile(resolve(root, 'receipts/mec-http-verification.json'), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt, null, 2));
if (executed.status !== 0) { process.stderr.write(output); process.exitCode = 1; }
