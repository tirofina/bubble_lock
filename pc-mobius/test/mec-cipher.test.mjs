import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { MecCipher } from '../integration/src/mec-state.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-mec-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: { path: join(directory, 'state.json') } };
}

test('MEC의 동시 초기화 64개는 완성된 동일 키로 상호 복호화한다', async (t) => {
  for (let round = 0; round < 4; round++) {
    const { directory, store } = await fixture(t);
    const ciphers = Array.from({ length: 64 }, () => new MecCipher({ store }));
    await Promise.all(ciphers.map((cipher) => cipher.ready));
    const key = await readFile(`${store.path}.mec-key`);
    assert.equal(key.length, 32);
    const payload = { deviceId: 'keyring-1', location: { lat: 37.5, lon: 127.0 }, round };
    const sealed = ciphers[0].seal(payload, 'location:household-1');
    for (const cipher of ciphers) {
      assert.deepEqual(cipher.key, key);
      assert.deepEqual(cipher.open(sealed, 'location:household-1'), payload);
    }
    assert.deepEqual(await readdir(directory), ['state.json.mec-key']);
  }
});

test('MEC 재시작은 저장된 키와 과거 암호문을 복구한다', async (t) => {
  const { directory, store } = await fixture(t);
  const first = new MecCipher({ store }); await first.ready;
  const key = await readFile(`${store.path}.mec-key`);
  const sealed = first.seal({ sequence: 9 }, 'handover:device-1');
  const restarted = Array.from({ length: 32 }, () => new MecCipher({ store }));
  await Promise.all(restarted.map((cipher) => cipher.ready));
  for (const cipher of restarted) assert.deepEqual(cipher.open(sealed, 'handover:device-1'), { sequence: 9 });
  assert.deepEqual(await readFile(`${store.path}.mec-key`), key);
  assert.deepEqual(await readdir(directory), ['state.json.mec-key']);
});

test('MEC의 손상된 기존 키는 원본을 보존하고 복구 검토 오류를 반환한다', async (t) => {
  for (const length of [0, 31, 33]) {
    const { directory, store } = await fixture(t);
    const original = randomBytes(length);
    await writeFile(`${store.path}.mec-key`, original, { mode: 0o600 });
    const outcomes = await Promise.allSettled(Array.from({ length: 16 }, () => new MecCipher({ store }).ready));
    assert.ok(outcomes.every((result) => result.status === 'rejected' && /32바이트/.test(result.reason.message)));
    assert.deepEqual(await readFile(`${store.path}.mec-key`), original);
    assert.deepEqual(await readdir(directory), ['state.json.mec-key']);
  }
});

test('주입된 MEC 비밀 키는 설정된 키로 암호화하고 디스크 키 경로와 분리한다', async (t) => {
  const { directory, store } = await fixture(t);
  const encryptionKey = randomBytes(32);
  const first = new MecCipher({ store, encryptionKey });
  const second = new MecCipher({ store, encryptionKey: encryptionKey.toString('base64') });
  await Promise.all([first.ready, second.ready]);
  assert.deepEqual(second.open(first.seal({ checked: true }, 'injected'), 'injected'), { checked: true });
  assert.deepEqual(await readdir(directory), []);
});
