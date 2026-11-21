import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMobiusDependencies } from './apply-mobius-dependencies.mjs';

const pinned = fileURLToPath(new URL('../../deployment/cse/artifacts/dependencies/', import.meta.url));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mobius-dependencies-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of ['package.json', 'package-lock.json']) {
    await copyFile(join(pinned, file), join(root, file));
  }
  return root;
}

test('reapplying the pinned dependency patch preserves package bytes', async (t) => {
  const root = await fixture(t);
  const before = await Promise.all(['package.json', 'package-lock.json'].map((file) => readFile(join(root, file))));
  const receipt = await applyMobiusDependencies(root);
  assert.deepEqual(receipt.files.map((file) => file.status), ['ALREADY_APPLIED', 'ALREADY_APPLIED']);
  const after = await Promise.all(['package.json', 'package-lock.json'].map((file) => readFile(join(root, file))));
  assert.deepEqual(after, before);
});

for (const file of ['package.json', 'package-lock.json']) {
  test(`refuses changed ${file} without overwriting either input`, async (t) => {
    const root = await fixture(t);
    await writeFile(join(root, file), '{"unexpected":"dependency drift"}\n');
    const before = await Promise.all(['package.json', 'package-lock.json'].map((name) => readFile(join(root, name))));
    await assert.rejects(applyMobiusDependencies(root), {
      code: 'ERR_ASSERTION',
      message: `dependency patch context: ${file}`,
    });
    const after = await Promise.all(['package.json', 'package-lock.json'].map((name) => readFile(join(root, name))));
    assert.deepEqual(after, before);
  });
}
