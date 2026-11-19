// Builds an evidence receipt for an FL task by reading the CSE tree with the coordinator identity.
// Usage: node pc-mobius/scripts/fl-onem2m-readback.mjs --config=<coordinator.config.json> --out=<receipt.json>
//          --runtime-mode=<e.g. SANDBOX_VM_REAL_CSE> [--host-label=<where the coordinator ran>] [--hosts=<count>]
// The receipt records only what the CSE shows; execution location fields come from the operator flags.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { FlCseClient } from '../integration/src/fl-onem2m-plane.mjs';
import { readbackFlPlane, roundRows } from '../integration/src/fl-onem2m-readback.mjs';

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const configPath = resolve(arg('config') ?? ''); const base = dirname(configPath);
const config = JSON.parse(await readFile(configPath, 'utf8'));
const credentials = JSON.parse(await readFile(resolve(base, config.credentialsPath), 'utf8'));
const client = new FlCseClient({ endpoint: config.cseUrl, cseBase: config.cseBase ?? '/Mobius', originator: credentials.aeId, allowPlainHttp: config.allowPlainHttp === true });
const aePath = `${client.cseBase}/${config.flAeName}`;
const cb = await client.retrieve(client.cseBase);
const readback = await readbackFlPlane({ client, aePath, coordinatorPublicKeyPem: credentials.publicKeyPem });
const rounds = roundRows(readback.rounds);
const receipt = {
  status: Object.values(readback.checks).every(Boolean) && readback.completed.length > 0 ? 'PASS' : 'FAIL', rubric: 'R14', reference: 'oneM2M TR-0084 (FL resource model; own wording)', generatedAt: new Date().toISOString(),
  runtimeMode: arg('runtime-mode') ?? 'UNSPECIFIED', hostLabel: arg('host-label') ?? null, hostCount: Number(arg('hosts') ?? 0) || null,
  transport: `oneM2M HTTP binding (${new URL(config.cseUrl).protocol.replace(':', '')})`, cse: { cseId: cb.payload?.['m2m:cb']?.csi ?? null, cseBaseRetrieveRsc: cb.rsc },
  task: { taskId: readback.taskDefinition?.taskId ?? null, flAePath: aePath, definitionPayloadHash: readback.taskDefinition?.payloadHash ?? null },
  completedRounds: readback.completed.length, rounds, epochs: readback.epochs, catalog: readback.catalog.map((c) => ({ participantId: c.participantId, state: c.state, consentRevision: c.consentRevision })),
  currentModel: readback.current ? { modelVersion: readback.current.modelVersion, modelHash: readback.current.modelHash } : null,
  integrity: readback.integrity, dataLocality: readback.dataLocality, checks: readback.checks,
};
if (arg('out')) { await mkdir(dirname(resolve(arg('out'))), { recursive: true }); await writeFile(resolve(arg('out')), `${JSON.stringify(receipt, null, 2)}\n`); }
console.log(JSON.stringify({ status: receipt.status, completedRounds: receipt.completedRounds, checks: receipt.checks, out: arg('out') ?? null }, null, 2));
process.exitCode = receipt.status === 'PASS' ? 0 : 1;
