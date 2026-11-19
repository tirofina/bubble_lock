// Reads an FL task tree back from the CSE and checks it: coordinator signatures, update payload
// hashes, deterministic re-aggregation of the accepted updates, model lineage and data locality.
import { fedAvg, digest, modelBytes, initialModel } from './fl-numerics.mjs';
import { LAYOUT, verifyContent, decodeArtifact, cinContent, roundName } from './fl-onem2m-plane.mjs';

export async function readbackFlPlane({ client, aePath, coordinatorPublicKeyPem, rowIdPattern = null, maxRounds = 9999 }) {
  const read = async (path) => { const result = await client.retrieve(path); return result.ok ? cinContent(result) : null; };
  const integrity = { signatures: 0, signatureFailures: 0, reaggregationMatches: 0, reaggregationMismatches: 0, lineageBreaks: 0, acceptedUpdatesReadBack: 0, acceptedUpdatesMissing: 0 };
  const check = (content) => { if (verifyContent(content, coordinatorPublicKeyPem)) integrity.signatures++; else integrity.signatureFailures++; };
  const locality = { scannedContents: 0, leakFindings: 0, rule: 'no feature arrays and no row ids in any CSE content' };
  const scan = (content) => { const text = JSON.stringify(content ?? null); locality.scannedContents++; if (text.includes('"x":[') || (rowIdPattern && rowIdPattern.test(text))) locality.leakFindings++; };
  const taskDefinition = cinContent(await client.latest(`${aePath}/${LAYOUT.tasks}`)); if (taskDefinition) { check(taskDefinition); scan(taskDefinition); }
  const seed = taskDefinition?.seed ?? 101; let lineageHead = digest(modelBytes(initialModel(seed)));
  const rounds = [];
  for (let n = 1; n <= maxRounds; n++) {
    const base = `${aePath}/${LAYOUT.rounds}/${roundName(n)}`;
    const config = await read(`${base}/${LAYOUT.roundConfig}`); if (!config) break;
    const result = await read(`${base}/${LAYOUT.roundResult}`);
    check(config); scan(config); if (result) { check(result); scan(result); }
    const updates = (await client.children(`${base}/${LAYOUT.roundUpdates}`)).items; for (const u of updates) scan(u.con);
    let reaggregatedHash = null; let model = null;
    if (result?.state === 'COMPLETED') {
      const models = [];
      for (const a of result.acceptedSet) {
        const cin = updates.find((u) => u.rn === `u-${a.participantId}`);
        if (cin?.con?.payloadHash === a.payloadHash) { integrity.acceptedUpdatesReadBack++; models.push({ participantId: a.participantId, sampleCount: a.sampleCount, model: decodeArtifact(cin.con.artifact, a.artifactDigest) }); } else integrity.acceptedUpdatesMissing++;
      }
      if (models.length === result.acceptedSet.length && models.length >= 2) { reaggregatedHash = digest(modelBytes(fedAvg(models))); if (reaggregatedHash === result.model.hash) integrity.reaggregationMatches++; else integrity.reaggregationMismatches++; }
      if (result.model.parentHash !== lineageHead || config.baseModel.hash !== lineageHead) integrity.lineageBreaks++;
      lineageHead = result.model.hash; model = decodeArtifact(result.artifact, result.model.hash);
    }
    rounds.push({ roundNumber: n, config, result, updates, reaggregatedHash, model });
  }
  const current = cinContent(await client.latest(`${aePath}/${LAYOUT.currentModel}`)); if (current) { check(current); scan(current); }
  const statusItems = (await client.children(`${aePath}/${LAYOUT.status}`)).items.map((c) => c.con).filter(Boolean);
  for (const s of statusItems) scan(s);
  const inbox = (await client.children(`${aePath}/${LAYOUT.participants}`)).items; for (const c of inbox) scan(c.con);
  const catalog = (await client.children(`${aePath}/${LAYOUT.datasets}`)).items.map((c) => c.con).filter(Boolean); for (const c of catalog) scan(c);
  const completed = rounds.filter((r) => r.result?.state === 'COMPLETED');
  const checks = { signaturesValid: integrity.signatureFailures === 0, reaggregationMatches: integrity.reaggregationMismatches === 0 && integrity.reaggregationMatches === completed.length, lineageUnbroken: integrity.lineageBreaks === 0, currentModelMatchesLastRound: !completed.length || current?.modelHash === completed.at(-1).result.model.hash, noRawRowsInCse: locality.leakFindings === 0 };
  return { taskDefinition, rounds, completed, current, statusItems, epochs: statusItems.filter((s) => s.state === 'EPOCH_CLAIMED').map((s) => ({ coordinatorEpoch: s.coordinatorEpoch, instanceId: s.instanceId, at: s.at })).sort((a, b) => a.coordinatorEpoch - b.coordinatorEpoch), inboxCount: inbox.length, catalog, integrity, dataLocality: locality, checks };
}

/** Compact per-round rows for receipts. */
export const roundRows = (rounds) => rounds.map(({ roundNumber, config, result, updates, reaggregatedHash }) => ({
  roundNumber, state: result?.state ?? 'OPEN', configEpoch: config.coordinatorEpoch, resultEpoch: result?.coordinatorEpoch ?? null, trigger: result?.trigger ?? null,
  eligible: config.selection.eligible.map((e) => e.participantId), excluded: config.selection.excluded, selected: config.selected.map((s) => s.participantId),
  accepted: result?.acceptedSet.map((a) => a.participantId) ?? [], missing: result?.missing ?? [], rejected: result?.rejected ?? [], durationMs: result?.durationMs ?? null,
  baseModelVersion: config.baseModel.version, modelVersion: result?.model?.version ?? null, modelHash: result?.model?.hash ?? null, reaggregatedHash,
  federatedEvaluationOfBaseModel: result?.federatedEvaluation?.test ? { baseModelVersion: result.federatedEvaluation.baseModelVersion, accuracy: Number(result.federatedEvaluation.test.accuracy.toFixed(4)), crossEntropy: Number(result.federatedEvaluation.test.crossEntropy.toFixed(4)), samples: result.federatedEvaluation.test.samples, participants: result.federatedEvaluation.test.participants } : null,
  updatesInCse: updates.length,
}));
