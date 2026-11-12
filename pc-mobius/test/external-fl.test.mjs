import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { FlCoordinator } from '../integration/src/fl-coordinator.mjs';
import { FlTrainingWorker } from '../integration/src/fl-worker.mjs';
import { FlOneM2mPublisher } from '../integration/src/fl-publisher.mjs';
import { runExternalFl } from '../scripts/external-fl.mjs';
import { mockCse } from './helpers/external-mocks.mjs';

test('configured FL executes signed worker training, CSE readback, withdrawal and retraining for three seeds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'external-fl-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cse = await mockCse(t, 'fl-cse');
  const store = await new IntegrationStore(join(directory, 'state.json')).init();
  const publisher = new FlOneM2mPublisher(cse);
  const runtime = { store, api: {}, flCoordinator: new FlCoordinator({ store, mode: 'ESTIMED', publisher: (input) => publisher.publish(input) }) };
  const workers = [];
  const taskIds = [101, 202, 303].map((seed) => `external-mobility-${seed}`);
  for (let index = 0; index < 3; index++) {
    const identity = { hostId: `mock-host-${index}`, processId: String(index + 1), imageDigest: `mock-digest-${index}` };
    const participants = [];
    const workerClients = [];
    for (const clientIndex of index === 0 ? [0, 3] : [index]) {
      const participantId = `client-${clientIndex + 1}`;
      const keys = generateKeyPairSync('ed25519');
      const principal = { principalId: `fl:${participantId}`, originator: `CFL-${participantId}` };
      const dataset = { datasetId: `mobility-${participantId}`, seed: (clientIndex + 1) * 101, clientIndex };
      const participant = { participantId, principal, dataset, publicKeyPem: keys.publicKey.export({ format: 'pem', type: 'spki' }), lateJoin: clientIndex === 3 };
      participants.push(participant);
      for (const taskId of taskIds) workerClients.push({ ...participant, taskId, privateKeyPem: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }) });
    }
    const worker = new FlTrainingWorker({
      store: await new IntegrationStore().init(), participants: workerClients, identity,
      authorizeTraining: async (input) => runtime.flCoordinator.participantState(input),
    });
    workers.push({ ...identity, vmId: `vm-${index + 1}`, endpoint: `https://mock-${index}.invalid`, participants,
      fetchImpl: async (url, options) => new Response(JSON.stringify(url.endsWith('/health')
        ? worker.health() : await worker.train(JSON.parse(options.body), { taskIds, participantIds: participants.map((participant) => participant.participantId) }))),
    });
  }
  const result = await runExternalFl(runtime, { workers, taskPrefix: 'external-mobility', dropoutVmId: 'vm-2' }, directory);
  assert.equal(result.results.length, 3);
  for (const run of result.results) {
    assert.equal(run.rounds.length, 10);
    assert.ok(run.rounds[2].selected.includes('client-4'));
    assert.ok(run.rounds.slice(4).every((round) => !round.selected.includes('client-2')));
    assert.equal(run.delayedPublication, 'SUPERSEDED');
    assert.equal(run.retraining.publication, 'PUBLISHED');
    assert.equal(run.servingState, 'ACTIVE');
    assert.equal((await readFile(join(directory, `model-${run.seed}.f32`))).length, 108);
  }
  const models = [...cse.resources.values()].filter((value) => value['m2m:cin']?.con?.schema === 'urn:privacy-bubble:fl:model:1');
  assert.equal(models.length, 33);
  t.diagnostic(JSON.stringify({ simulation: true, transport: 'local-HTTP-CSE/in-process-signed-workers', seeds: 3, rounds: 30, delayedPublicationsSuperseded: 3, retrainedModels: 3, cseModelReadbacks: models.length }));
});
