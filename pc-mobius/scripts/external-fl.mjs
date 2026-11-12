import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FlCoordinator } from '../integration/src/fl-coordinator.mjs';
import { EstimedVmAdapter } from '../integration/src/fl-client.mjs';
import { syntheticDataset, modelBytes, evaluateModel, trainModel, initialModel } from '../integration/src/fl-numerics.mjs';
import { requireExternal } from './external-config.mjs';

/** Run signed updates on configured workers; participant rows remain on each worker. */
export async function runExternalFl(runtime, plan, output) {
  let fl = runtime.flCoordinator;
  const publisher = fl.publisher;
  const workers = plan.workers.map((worker) => ({ ...worker, adapter: new EstimedVmAdapter(worker) }));
  const participants = workers.flatMap((worker) => worker.participants.map((participant) => ({ ...participant, worker })));
  requireExternal(participants.filter((participant) => !participant.lateJoin).length >= 3, 'FL_INITIAL_QUORUM');
  const results = [];
  for (const seed of [101, 202, 303]) {
    const taskId = `${plan.taskPrefix}-${seed}`;
    const enrolled = [];
    const rounds = [];
    const participation = {};
    for (const worker of workers) {
      await worker.adapter.probe();
      fl.registerVm({ ...worker, mode: 'ESTIMED', attested: true, health: 'HEALTHY' });
    }
    async function enroll(participant) {
      const dataset = syntheticDataset(participant.dataset);
      await fl.registerParticipant({ ...participant, vmId: participant.worker.vmId, taskId, dataset: dataset.metadata });
      await fl.setParticipantConsent({ taskId, participantId: participant.participantId, principal: participant.principal });
      enrolled.push({ ...participant, dataset });
    }
    for (const participant of participants.filter((entry) => !entry.lateJoin)) await enroll(participant);
    let round;
    let completed;
    async function trainRound(publish = true) {
      for (const selected of round.participants) {
        const participant = enrolled.find((entry) => entry.participantId === selected.participantId);
        const update = await participant.worker.adapter.train({
          round, participantId: participant.participantId, baseModelBytes: fl.readArtifact(round.baseModelRef, round.baseModelHash).toString('base64'),
        });
        await fl.submitUpdate({ ...update, principal: participant.principal });
        participation[participant.participantId] = (participation[participant.participantId] ?? 0) + 1;
      }
      completed = await fl.finalizeRound(round.roundId);
      requireExternal(completed.state === 'COMPLETED', 'FL_ROUND_INCOMPLETE');
      const published = publish ? await fl.publishRound(round.roundId) : { status: 'PENDING' };
      requireExternal(['PUBLISHED', 'PENDING'].includes(published.status), 'FL_PUBLICATION_FAILED');
      return { roundId: round.roundId, selected: round.participants.map((entry) => entry.participantId),
        modelHash: completed.modelHash, manifestHash: completed.manifestHash, publication: published.status };
    }
    for (let number = 1; number <= 10; number++) {
      if (number === 3) for (const participant of participants.filter((entry) => entry.lateJoin)) await enroll(participant);
      if (number === 5 && plan.dropoutVmId) {
        const worker = workers.find((entry) => entry.vmId === plan.dropoutVmId);
        requireExternal(Boolean(worker), 'FL_DROPOUT_VM_REQUIRED');
        fl.registerVm({ ...worker, mode: 'ESTIMED', attested: true, health: 'UNHEALTHY' });
      }
      for (const participant of enrolled) await fl.heartbeat({ taskId, participantId: participant.participantId, principal: participant.principal });
      round = await fl.createRound({ taskId, seed, minParticipants: 2, selectionPolicy: { maxParticipants: 3 } });
      rounds.push(await trainRound());
      if (number === 5) {
        // A new coordinator takes the persisted epoch; workers query this same API object.
        fl = new FlCoordinator({ store: runtime.store, mode: 'ESTIMED', publisher });
        runtime.api.flCoordinator = fl; runtime.flCoordinator = fl;
        await fl.recover(round.roundId);
      }
    }
    const artifact = fl.serveArtifact(round.roundId, completed.modelHash);
    await writeFile(join(output, `model-${seed}.f32`), modelBytes(artifact.model));
    await writeFile(join(output, `manifest-${seed}.json`), fl.readArtifact(completed.prepared.manifestRef, completed.manifestHash));
    const testRows = enrolled.flatMap((participant) => participant.dataset.test);
    const comparisonParticipation = { ...participation };
    const localOnly = enrolled.map((participant) => ({
      participantId: participant.participantId,
      localEpochs: (comparisonParticipation[participant.participantId] ?? 0) * 2,
      metrics: evaluateModel(trainModel(initialModel(seed), participant.dataset.train, { localEpochs: (comparisonParticipation[participant.participantId] ?? 0) * 2 }), testRows),
    }));
    for (const participant of enrolled) await fl.heartbeat({ taskId, participantId: participant.participantId, principal: participant.principal });
    round = await fl.createRound({ taskId, seed, minParticipants: 2 });
    const delayedPublication = await trainRound(false);
    const revoked = enrolled.find((participant) => delayedPublication.selected.includes(participant.participantId));
    await fl.setParticipantConsent({ taskId, participantId: revoked.participantId, principal: revoked.principal, status: 'REVOKED' });
    requireExternal(fl.task(taskId).state === 'SERVING_PAUSED', 'FL_REVOCATION_FENCE');
    requireExternal((await fl.publishRound(round.roundId)).status === 'SUPERSEDED', 'FL_PUBLICATION_FENCE');
    await fl.approveRetraining(taskId);
    for (const participant of enrolled) await fl.heartbeat({ taskId, participantId: participant.participantId, principal: participant.principal });
    round = await fl.createRound({ taskId, seed, minParticipants: 2 });
    const retraining = await trainRound();
    results.push({ seed, taskId, rounds, participation: comparisonParticipation, executionParticipation: participation, modelHash: rounds.at(-1).modelHash, delayedPublication: 'SUPERSEDED',
      federated: evaluateModel(artifact.model, testRows), localOnly, retraining, servingState: fl.task(taskId).state });
  }
  return { runtimeMode: 'ESTIMED', dataset: 'synthetic', results,
    workers: workers.map(({ vmId, hostId, processId, imageDigest }) => ({ vmId, hostId, processId, imageDigest })) };
}
