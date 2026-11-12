import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const repo = resolve(import.meta.dirname, '../..');

async function fixture(t, days) {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-monitor-certs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pki = join(directory, 'pki');
  const bin = join(directory, 'bin');
  await mkdir(pki);
  await mkdir(bin);
  const docker = join(bin, 'docker');
  await writeFile(docker, `#!/bin/sh
case "$1" in
  ps) printf 'healthy-container\\n' ;;
  inspect) printf '%s\\n' '[{"Config":{"Labels":{"com.docker.compose.service":"mqtt"}},"State":{"Running":true,"OOMKilled":false,"Health":{"Status":"healthy"}}}]' ;;
  *) exit 2 ;;
esac
`);
  await chmod(docker, 0o700);
  for (const name of ['mqtt', 'gateway-1']) {
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(pki, `${name}.key`), '-out', join(pki, `${name}.pem`),
      '-days', String(days), '-subj', `/CN=${name}`]);
  }
  return { directory, bin };
}

async function monitor({ directory, bin }) {
  const child = spawn(process.execPath, ['deployment/monitor.mjs'], {
    cwd: repo,
    env: { ...process.env, RUN_TMP: directory, PATH: `${bin}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  let errors = '';
  for await (const chunk of child.stdout) output += chunk;
  for await (const chunk of child.stderr) errors += chunk;
  const [exit] = await once(child, 'close');
  assert.equal(errors, '');
  return { exit, report: JSON.parse(output) };
}

test('monitor alerts on MQTT server and Gateway certificates expiring within 14 days', async (t) => {
  const result = await monitor(await fixture(t, 5));
  assert.equal(result.exit, 1);
  assert.equal(result.report.status, 'ALERT');
  assert.deepEqual(result.report.alerts.map((alert) => alert.certificate).sort(), ['gateway-1', 'mqtt']);
});

test('monitor remains healthy when MQTT server and Gateway certificates have 60 days left', async (t) => {
  const result = await monitor(await fixture(t, 60));
  assert.equal(result.exit, 0);
  assert.equal(result.report.status, 'HEALTHY');
  assert.deepEqual(result.report.alerts, []);
});

test('monitor alerts when a Gateway certificate is missing', async (t) => {
  const input = await fixture(t, 60);
  await unlink(join(input.directory, 'pki/gateway-1.pem'));
  const result = await monitor(input);
  assert.equal(result.exit, 1);
  assert.equal(result.report.status, 'ALERT');
  assert.deepEqual(result.report.alerts.map((alert) => alert.certificate), ['gateway-1']);
});
