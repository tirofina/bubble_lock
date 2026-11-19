// Worker-local dataset shards for the oneM2M FL coordination plane.
//
// The task is a documented synthetic task (not field data): 8 normalized BLE/motion window
// features (FEATURES in fl-numerics.mjs) and 3 classes (0 dwell, 1 transit, 2 relay-gap).
// It reuses the class means of SYNTHETIC_FIXTURE but makes the problem harder and non-IID:
//  - class overlap: per-feature Gaussian noise std 0.30 (fixture uses 0.16),
//  - label skew: each profile has its own class proportions,
//  - covariate shift: the 'new-device' profile models another hardware revision with an RSSI offset
//    and a motion-count gain,
//  - label noise: 5% of labels are flipped uniformly.
// A shard is a pure function of a worker-private seed and a profile name. The seed never leaves the
// worker; only metadata (counts and a split hash) is published to the CSE.
import { FEATURE_VERSION, SYNTHETIC_FIXTURE, digest, random } from './fl-numerics.mjs';

const f = Math.fround;
export const SHARD_TASK = Object.freeze({
  version: 'privacy-motion-8-heterogeneous-v1', featureSchemaVersion: FEATURE_VERSION, classes: ['dwell', 'transit', 'relay-gap'],
  rows: 600, split: [360, 120, 120], std: 0.30, labelNoise: 0.05, means: SYNTHETIC_FIXTURE.means,
});

export const SHARD_PROFILES = Object.freeze({
  'home-dwell': { proportions: [0.75, 0.15, 0.10], offset: [0, 0, 0, 0, 0, 0, 0, 0], gain: [1, 1, 1, 1, 1, 1, 1, 1] },
  commute: { proportions: [0.15, 0.75, 0.10], offset: [0, 0, 0, 0, 0, 0, 0, 0], gain: [1, 1, 1, 1, 1, 1, 1, 1] },
  'relay-sparse': { proportions: [0.10, 0.15, 0.75], offset: [0, 0, 0, 0, 0, 0, 0, 0], gain: [1, 1, 1, 1, 1, 1, 1, 1] },
  'new-device': { proportions: [0.40, 0.20, 0.40], offset: [0, 0, 0, 0, -0.30, 0.20, 0, 0], gain: [1, 1.4, 1, 1, 1, 1, 1, 1] },
});

export function generateShard({ seed, profile, datasetId, datasetVersion = 1 }) {
  if (!Number.isSafeInteger(seed) || seed <= 0) throw new Error('FL_SHARD_SEED');
  const spec = SHARD_PROFILES[profile]; if (!spec) throw new Error('FL_SHARD_PROFILE');
  if (typeof datasetId !== 'string' || !/^[A-Za-z0-9._-]{1,96}$/.test(datasetId)) throw new Error('FL_SHARD_DATASET_ID');
  const next = random(seed);
  const gaussian = () => Math.sqrt(-2 * Math.log(Math.max(1e-8, next()))) * Math.cos(2 * Math.PI * next());
  const [p0, p1] = spec.proportions;
  const rows = Array.from({ length: SHARD_TASK.rows }, (_, index) => {
    const draw = next(); const truth = draw < p0 ? 0 : draw < p0 + p1 ? 1 : 2;
    const x = SHARD_TASK.means[truth].map((mean, i) => f(mean * spec.gain[i] + spec.offset[i] + gaussian() * SHARD_TASK.std));
    const flip = next() < SHARD_TASK.labelNoise; const y = flip ? Math.floor(next() * 3) % 3 : truth;
    return { id: `${datasetId}:${index}`, x, y };
  });
  const [train, validation] = SHARD_TASK.split;
  const splitHash = digest(Buffer.from(JSON.stringify(rows.map((row) => row.id))));
  return {
    metadata: { datasetId, datasetVersion, featureSchemaVersion: FEATURE_VERSION, taskVersion: SHARD_TASK.version, trainCount: train, validationCount: validation, testCount: rows.length - train - validation, splitHash, rawDataLocation: 'participant-local' },
    train: rows.slice(0, train), validation: rows.slice(train, train + validation), test: rows.slice(train + validation),
  };
}
