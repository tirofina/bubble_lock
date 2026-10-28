import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const defaultPath = fileURLToPath(new URL('../contracts/oneM2M-test-contract.v1.json', import.meta.url));
const path = resolve(process.argv[2] ?? defaultPath);
const contract = JSON.parse(await readFile(path, 'utf8'));
const required = ['contractId', 'contractVersion', 'docRevision', 'owner', 'cse', 'headers', 'steps', 'mqtt', 'acceptance'];
const missing = required.filter((key) => !(key in contract));
if (missing.length > 0) throw new Error(`Contract fields required: ${missing.join(', ')}`);
if (contract.owner !== 'PC-MOBIUS-CORE') throw new Error('Contract owner must be PC-MOBIUS-CORE');
if (contract.cse.releaseVersionIndicator !== '4') throw new Error('Release version indicator must be 4');
if (contract.steps.length < 6) throw new Error('Contract includes six integration steps');
for (const step of contract.steps) {
  if (!step.id || !step.operation || !Number.isInteger(step.expectedResponseStatus)) {
    throw new Error(`Step shape required: ${step.id ?? 'unnamed'}`);
  }
}
const report = {
  contractId: contract.contractId,
  contractVersion: contract.contractVersion,
  docRevision: contract.docRevision,
  owner: contract.owner,
  stepCount: contract.steps.length,
  mqttTopics: [contract.mqtt.requestTopic, contract.mqtt.responseTopic, contract.mqtt.notificationTopic],
  status: 'PASS'
};
console.log(JSON.stringify(report, null, 2));
