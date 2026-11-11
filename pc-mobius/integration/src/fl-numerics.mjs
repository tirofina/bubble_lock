import { createHash } from 'node:crypto';

export const FEATURE_VERSION = 'privacy-motion-8-v1';
export const MODEL_FORMAT = { dtype: 'float32', W: [8, 3], b: [3], bytes: 108 };
export const TRAINING = { learningRate: 0.05, batchSize: 32, localEpochs: 2 };
export const FEATURES = ['window_seconds', 'normalized_motion_count', 'zone_transition_count', 'relay_gap_seconds', 'rssi_mean', 'rssi_std', 'dwell_seconds', 'return_interval_seconds'];
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const f = Math.fround;

export function random(seed) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
}

export function initialModel(seed = 101) {
  const next = random(seed);
  return { W: Array.from({ length: 8 }, () => Array.from({ length: 3 }, () => f((next() - 0.5) * 0.02))), b: [0, 0, 0] };
}

export function modelBytes(model) {
  if (!Array.isArray(model?.W) || model.W.length !== 8 || model.W.some((row) => !Array.isArray(row) || row.length !== 3) || !Array.isArray(model.b) || model.b.length !== 3) throw new Error('FL_MODEL_SHAPE');
  const values = [...model.W.flat(), ...model.b];
  if (values.some((v) => typeof v !== 'number' || !Number.isFinite(v) || !Number.isFinite(f(v)))) throw new Error('FL_MODEL_FINITE');
  const bytes = Buffer.alloc(MODEL_FORMAT.bytes);
  values.forEach((value, i) => bytes.writeFloatLE(f(value), i * 4));
  return bytes;
}

export function decodeModel(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length !== MODEL_FORMAT.bytes) throw new Error('FL_ARTIFACT_LENGTH');
  const values = Array.from({ length: 27 }, (_, i) => bytes.readFloatLE(i * 4));
  const model = { W: Array.from({ length: 8 }, (_, i) => values.slice(i * 3, i * 3 + 3)), b: values.slice(24) };
  modelBytes(model);
  return model;
}

export function fedAvg(updates) {
  if (updates.length < 2) throw new Error('FL_QUORUM');
  const sorted = [...updates].sort((a, b) => a.participantId.localeCompare(b.participantId));
  const total = sorted.reduce((sum, u) => sum + u.sampleCount, 0);
  const values = Array(27).fill(0);
  for (const update of sorted) {
    const bytes = modelBytes(update.model);
    for (let i = 0; i < 27; i++) values[i] = f(values[i] + f(bytes.readFloatLE(i * 4) * (update.sampleCount / total)));
  }
  return { W: Array.from({ length: 8 }, (_, i) => values.slice(i * 3, i * 3 + 3)), b: values.slice(24) };
}

// 합성 fixture의 정규화된 8개 특징. 모든 client가 동일 통계와 label 의미를 공유한다.
export const SYNTHETIC_FIXTURE = {
  version: 'synthetic-mobility-v1', count: 600, split: [360, 120, 120],
  normalization: { offset: [0, 0, 0, 0, 0, 0, 0, 0], scale: [1, 1, 1, 1, 1, 1, 1, 1] },
  means: [[0.3, 0.8, 0.5, 0.1, 0.8, 0.2, 0.1, 0.2], [0.8, 0.1, 0.1, 0.2, 0.7, 0.1, 0.9, 0.8], [0.5, 0.5, 0.8, 0.9, 0.1, 0.8, 0.4, 0.9]], std: 0.16,
  proportions: [[0.7, 0.2, 0.1], [0.2, 0.7, 0.1], [0.2, 0.2, 0.6], [0.4, 0.3, 0.3]]
};

export function syntheticDataset({ seed = 101, clientIndex = 0, datasetId = `synthetic-${seed}`, version = 1 } = {}) {
  if (!Number.isInteger(seed) || !Number.isInteger(clientIndex) || clientIndex < 0 || clientIndex > 3) throw new Error('FL_DATASET_CONFIG');
  const next = random(seed);
  const ratios = SYNTHETIC_FIXTURE.proportions[clientIndex];
  const rows = Array.from({ length: 600 }, (_, index) => {
    const draw = next(); const y = draw < ratios[0] ? 0 : draw < ratios[0] + ratios[1] ? 1 : 2;
    const x = SYNTHETIC_FIXTURE.means[y].map((mean) => {
      const gaussian = Math.sqrt(-2 * Math.log(Math.max(1e-8, next()))) * Math.cos(2 * Math.PI * next());
      return f(mean + gaussian * SYNTHETIC_FIXTURE.std);
    });
    return { id: `${datasetId}:${index}`, x, y };
  });
  const splitHash = digest(Buffer.from(JSON.stringify(rows.map((row) => row.id))));
  return { metadata: { datasetId, datasetVersion: version, seed, clientIndex, featureSchemaVersion: FEATURE_VERSION, fixtureVersion: SYNTHETIC_FIXTURE.version, trainCount: 360, splitHash }, train: rows.slice(0, 360), validation: rows.slice(360, 480), test: rows.slice(480) };
}

function probabilities(model, x) {
  const logits = model.b.map((b, c) => x.reduce((sum, v, i) => f(sum + f(v * model.W[i][c])), b));
  const max = Math.max(...logits); const exp = logits.map((v) => Math.exp(v - max)); const total = exp.reduce((a, b) => a + b, 0);
  return exp.map((v) => v / total);
}

export function trainModel(base, rows, { localEpochs = 2, learningRate = 0.05, batchSize = 32 } = {}) {
  if (!rows.length || rows.some((r) => r.x.length !== 8 || ![0, 1, 2].includes(r.y))) throw new Error('FL_TRAIN_ROWS');
  const model = decodeModel(modelBytes(base));
  for (let epoch = 0; epoch < localEpochs; epoch++) {
    for (let start = 0; start < rows.length; start += batchSize) {
      const batch = rows.slice(start, start + batchSize); const gW = Array.from({ length: 8 }, () => [0, 0, 0]); const gb = [0, 0, 0];
      for (const row of batch) {
        const p = probabilities(model, row.x);
        for (let c = 0; c < 3; c++) {
          const error = f(p[c] - (row.y === c ? 1 : 0)); gb[c] = f(gb[c] + error);
          for (let i = 0; i < 8; i++) gW[i][c] = f(gW[i][c] + f(error * row.x[i]));
        }
      }
      for (let c = 0; c < 3; c++) {
        model.b[c] = f(model.b[c] - f(learningRate * gb[c] / batch.length));
        for (let i = 0; i < 8; i++) model.W[i][c] = f(model.W[i][c] - f(learningRate * gW[i][c] / batch.length));
      }
    }
  }
  return model;
}

export function evaluateModel(model, rows) {
  const confusionMatrix = Array.from({ length: 3 }, () => [0, 0, 0]); let loss = 0;
  for (const row of rows) { const p = probabilities(model, row.x); const predicted = p.indexOf(Math.max(...p)); confusionMatrix[row.y][predicted]++; loss -= Math.log(Math.max(1e-9, p[row.y])); }
  const f1 = [0, 1, 2].map((c) => { const tp = confusionMatrix[c][c]; const fp = confusionMatrix.reduce((sum, row) => sum + row[c], 0) - tp; const fn = confusionMatrix[c].reduce((sum, v) => sum + v, 0) - tp; return 2 * tp / (2 * tp + fp + fn || 1); });
  const correct = [0, 1, 2].reduce((sum, c) => sum + confusionMatrix[c][c], 0);
  return { macroF1: f1.reduce((a, b) => a + b, 0) / 3, errorRate: 1 - correct / rows.length, crossEntropy: loss / rows.length, confusionMatrix, samples: rows.length };
}
