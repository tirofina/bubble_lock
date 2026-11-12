import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pinned = fileURLToPath(new URL('../../deployment/cse/artifacts/dependencies/', import.meta.url));
const upstream = {
  'package.json': '4becf0cd79cf85f3d79c4f5b3475555b2c716b2c554260c2749a7e8a51f55a5a',
  'package-lock.json': '100e29c3b4feecc3fcd95f4af5b214180305326a5890651b165ec63fea72aea6',
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Only dependency metadata changes; upstream JavaScript and security patch bytes stay intact.
export async function applyMobiusDependencies(mobiusRoot) {
  const pending = [];
  const files = [];
  for (const [file, beforeSHA256] of Object.entries(upstream)) {
    const path = join(mobiusRoot, file);
    const [original, replacement] = await Promise.all([
      readFile(path), readFile(join(pinned, file)),
    ]);
    const current = sha256(original);
    const digest = sha256(replacement);
    assert.ok(current === beforeSHA256 || current === digest, `dependency patch context: ${file}`);
    const status = current === digest ? 'ALREADY_APPLIED' : 'APPLIED';
    files.push({ file, status, beforeSHA256, sha256: digest });
    if (status === 'APPLIED') pending.push({ path, replacement });
  }
  // Check both original files before writing either.
  for (const { path, replacement } of pending) await writeFile(path, replacement);
  return { patch: 'BUBBLE_DEPENDENCIES_V1', files };
}
