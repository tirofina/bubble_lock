import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const exec = promisify(execFile);

test('generated deployment chains support strict TLS verification and enforce certificate purposes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-cert-strict-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const domain = 'deployment.example.invalid';
  await exec(process.execPath, ['deployment/configure.mjs'], {
    env: { ...process.env, RUN_TMP: directory, PUBLIC_DOMAIN: domain, HTTPS_PORT: '443' },
  });
  const ca = join(directory, 'pki/ca.pem');
  for (const [name, purpose, hostname] of [
    ['public', 'sslserver', domain],
    ['api', 'sslserver', 'api'],
    ['cse-server', 'sslserver', 'cse'],
    ['mqtt', 'sslserver', domain],
    ['gateway-1', 'sslclient'],
    ['cse', 'sslclient'],
  ]) {
    await t.test(name, async () => {
      const certificate = join(directory, `pki/${name}.pem`);
      const args = ['verify', '-x509_strict', '-CAfile', ca, '-purpose', purpose];
      if (hostname) args.push('-verify_hostname', hostname);
      await exec('openssl', [...args, certificate]);
      const { stdout } = await exec('openssl', ['x509', '-in', certificate, '-noout', '-ext', 'keyUsage']);
      assert.match(stdout, /X509v3 Key Usage: critical\s+Digital Signature, Key Encipherment/);
      await assert.rejects(exec('openssl', [
        'verify', '-x509_strict', '-CAfile', ca,
        '-purpose', purpose === 'sslserver' ? 'sslclient' : 'sslserver', certificate,
      ]), /unsuitable certificate purpose/);
    });
  }
  await exec('openssl', ['verify', '-x509_strict', '-CAfile', ca, '-verify_hostname', 'mqtt', join(directory, 'pki/mqtt.pem')]);
  await assert.rejects(exec('openssl', [
    'verify', '-x509_strict', '-CAfile', ca, '-verify_hostname', 'foreign.example.invalid', join(directory, 'pki/mqtt.pem'),
  ]), /hostname mismatch/);
});
