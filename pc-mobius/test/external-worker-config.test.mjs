import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';

test('worker preparation emits existing worker CLI configurations for all three seeds and all assigned participants', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'external-workers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' });
  await writeFile(join(directory, 'public.pem'), publicKey);
  // Check reads local TLS paths but never negotiates TLS or contacts these .invalid hosts.
  const tls = { ca: 'public.pem', cert: 'public.pem', key: 'public.pem' };
  const workers = [1, 2, 3].map((index) => ({
    vmId: `vm-${index}`, hostId: `host-${index}`, endpoint: `https://vm-${index}.invalid:9443`, processId: String(index), imageDigest: `source-${index}`, tls,
    participants: (index === 1 ? [1, 4] : [index]).map((number) => ({
      participantId: `client-${number}`, lateJoin: number === 4, publicKeyFile: 'public.pem',
      principal: { principalId: `fl:${number}`, originator: `CFL-${number}`, mtlsFingerprint: `fingerprint-${number}` },
      dataset: { datasetId: `d-${number}`, seed: number * 101, clientIndex: number - 1, version: 1 },
    })),
  }));
  const config = {
    mode: 'EXTERNAL', server: { tls },
    core: { fl: { mode: 'ESTIMED', publication: { endpoint: 'https://cse.invalid' } } },
    scenario: { taskPrefix: 'mobility', dropoutVmId: 'vm-2', workers, workerSetup: {
      coordinatorEndpoint: 'https://coordinator.invalid:8787', coordinatorFingerprint: 'controller-fingerprint',
      pkiRoot: '/etc/bubble/pki', keyRoot: '/etc/bubble/keys', stateRoot: '/var/lib/bubble/fl',
    } },
  };
  const path = join(directory, 'fl.json'); await writeFile(path, JSON.stringify(config));
  const output = join(directory, 'workers');
  const command = new URL('../scripts/prepare-external-fl-workers.mjs', import.meta.url).pathname;
  const result = spawnSync(process.execPath, [command, `--config=${path}`, `--output=${output}`], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).networkRequests, 0);
  for (const index of [1, 2, 3]) {
    const worker = JSON.parse(await readFile(join(output, `vm-${index}.json`), 'utf8'));
    assert.equal(worker.participants.length, index === 1 ? 6 : 3);
    assert.deepEqual(worker.coordinators[0].taskIds, ['mobility-101', 'mobility-202', 'mobility-303']);
    assert.equal(worker.port, 9443);
    assert.equal(worker.runtimeMode, 'ESTIMED');
    assert.equal(worker.participants[0].dataset.datasetVersion, 1);
    assert.equal(worker.participants[0].privateKeyFile, `/etc/bubble/keys/client-${index}.pem`);
  }
});
