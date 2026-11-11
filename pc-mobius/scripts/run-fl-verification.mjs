import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { FlCoordinator } from '../integration/src/fl-coordinator.mjs';
import { enrollLocalClient, buildLocalUpdate } from '../integration/src/fl-client.mjs';
import { initialModel, trainModel, evaluateModel, modelBytes, digest, SYNTHETIC_FIXTURE } from '../integration/src/fl-numerics.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const output = resolve(arg('output') ?? join(root, '.local/fl-verification', `${Date.now()}-${randomUUID().slice(0, 8)}`));
await mkdir(output, { recursive: true });
const results = [];
for (const seed of [101, 202, 303]) {
  const statePath = join(output, `state-${seed}.json`);
  let store = await new IntegrationStore(statePath).init(); let fl = new FlCoordinator({ store });
  const taskId = `mobility-seed-${seed}`; const clients = []; const participation = {}; const rounds = [];
  for (let index = 0; index < 3; index++) clients.push(await enrollLocalClient(fl, { participantId: `client-${index + 1}`, taskId, seed: (index + 1) * 101, clientIndex: index }));
  let round; let complete; let bytes = { modelUpload: 0, modelDownload: 0, updateEnvelope: 0 };
  for (let roundNumber = 1; roundNumber <= 10; roundNumber++) {
    const started = performance.now();
    if (roundNumber === 3) clients.push(await enrollLocalClient(fl, { participantId: 'client-4', taskId, seed: 404, clientIndex: 3 }));
    if (roundNumber === 5) fl.registerVm({ vmId: 'client-2', mode: 'LOCAL_SIMULATION', health: 'UNHEALTHY', attested: true });
    for (const client of clients) await fl.heartbeat({ taskId, participantId: client.participantId, principal: client.principal });
    round = await fl.createRound({ taskId, seed, minParticipants: 2, selectionPolicy: { maxParticipants: 3 } });
    for (const participant of round.participants) {
      const client = clients.find((c) => c.participantId === participant.participantId); const update = buildLocalUpdate(fl, client, round);
      await fl.submitUpdate(update); participation[client.participantId] = (participation[client.participantId] ?? 0) + 1;
      bytes.modelUpload += 108; bytes.modelDownload += 108; bytes.updateEnvelope += Buffer.byteLength(JSON.stringify(update));
    }
    complete = await fl.finalizeRound(round.roundId); if (complete.state !== 'COMPLETED') throw new Error(`FL_RUN_STATE:${complete.state}`);
    const publication = await fl.publishRound(round.roundId);
    rounds.push({ roundNumber, roundId: round.roundId, selected: round.participants.map((p) => p.participantId), state: complete.state, modelHash: complete.modelHash, parentModelHash: round.baseModelHash, manifestHash: complete.manifestHash, publication: publication.status, seconds: (performance.now() - started) / 1000 });
    if (roundNumber === 5) { store = await new IntegrationStore(statePath).init(); fl = new FlCoordinator({ store }); await fl.recover(round.roundId); }
  }
  const final = fl.serveArtifact(round.roundId, complete.modelHash); const testRows = clients.flatMap((c) => c.dataset.test);
  const localOnly = clients.map((client) => ({ participantId: client.participantId, localEpochs: (participation[client.participantId] ?? 0) * 2, metrics: evaluateModel(trainModel(initialModel(seed), client.dataset.train, { localEpochs: (participation[client.participantId] ?? 0) * 2 }), testRows) }));
  const modelPath = join(output, `model-${seed}.f32`); const manifestPath = join(output, `manifest-${seed}.json`);
  await writeFile(modelPath, modelBytes(final.model)); await writeFile(manifestPath, fl.readArtifact(complete.prepared.manifestRef, complete.manifestHash));
  if (digest(await readFile(modelPath)) !== complete.modelHash || digest(await readFile(manifestPath)) !== complete.manifestHash) throw new Error('FL_EXPORTED_HASH');
  results.push({ seed, taskId, runtimeMode: 'LOCAL_SIMULATION', datasets: clients.map((c) => c.dataset.metadata), rounds, participation, bytes, federated: evaluateModel(final.model, testRows), localOnly, meanLocalOnlyMacroF1: localOnly.reduce((sum, r) => sum + r.metrics.macroF1, 0) / localOnly.length, modelHash: complete.modelHash, manifestHash: complete.manifestHash, artifacts: { model: `model-${seed}.f32`, manifest: `manifest-${seed}.json`, state: `state-${seed}.json` }, nextRound: fl.task(taskId).nextRound });
}
const report = { generatedAt: new Date().toISOString(), status: 'PASS', runtimeMode: 'LOCAL_SIMULATION', acceptanceIds: ['A13', 'A14', 'A15'], fixture: SYNTHETIC_FIXTURE, evaluation: '각 seed의 동일 고정 test split; local-only는 각 참여자의 실제 FL 선정 횟수와 동일 local epoch budget', rawDataLocation: 'client synthetic generator', externalGate: { status: 'ESTIMED_ACCOUNT_AND_DEPLOYMENT_RECEIPT_REQUIRED', required: ['ESTIMED allocation ticket', 'HTTPS worker host/process/image identity', 'oneM2M publication readback'] }, results };
await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ status: report.status, runtimeMode: report.runtimeMode, reportPath: join(output, 'report.json'), runs: results.map((r) => ({ seed: r.seed, rounds: r.rounds.length, macroF1: r.federated.macroF1, localOnlyMacroF1: r.meanLocalOnlyMacroF1, modelHash: r.modelHash })) }, null, 2));
