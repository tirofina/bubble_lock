import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_CONTRACT } from '../integration/src/mcp-schema.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = resolve(root, '../.local/mcp-verification', `${Date.now()}-${randomBytes(4).toString('hex')}`);
await mkdir(output, { recursive: true });
const execution = spawnSync(process.execPath, ['--test', 'test/mcp-wire.test.mjs', 'test/mcp-agent.test.mjs'], { cwd: root, env: { ...process.env, MCP_WIRE_EVIDENCE_ROOT: output }, encoding: 'utf8', timeout: 120000, windowsHide: true });
await writeFile(resolve(output, 'tests.log'), `${execution.stdout ?? ''}${execution.stderr ?? ''}`);
const files = [];
for (const name of await readdir(output)) {
  const bytes = await readFile(resolve(output, name)); files.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const report = { status: execution.status === 0 ? 'PASS' : 'REVIEW', generatedAt: new Date().toISOString(), contract: MCP_CONTRACT.contractId, protocolVersion: MCP_CONTRACT.protocolVersion, supportedProtocolVersions: MCP_CONTRACT.supportedProtocolVersions,
  scope: 'LOCAL_HTTP_REAL_WIRE', serverCount: 3, serverDomains: ['oneM2M', 'MEC', 'Audit'], domainAdapters: 'TEST_FIXTURES', hardwareExecution: 'SEPARATE_ACK_READBACK_EVIDENCE',
  agentProfile: { contract: 'privacy-bubble.mcp-agent.v1', unitTests: 'test/mcp-agent.test.mjs (fixture adapters, real oneM2M HTTP adapter against an in-memory CSE, MecAdapter against the local MEC simulator)',
    realCseRunner: 'scripts/run-mcp-llm-agent.mjs', realCseReceipt: '../docs/verification-evidence/2026-11-19/mcp-llm-agent-real-cse.json' },
  rubric: ['R17', 'A08', 'A19', 'W15', 'W16'], testProcessExit: execution.status, files, output };
await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
process.exitCode = execution.status === 0 ? 0 : 1;
