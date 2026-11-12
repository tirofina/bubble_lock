import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';

const runner = new URL('../scripts/run-external-services.mjs', import.meta.url);

test('configuration check resolves environment without contacting a provider', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'external-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let requests = 0;
  const server = createServer((_request, response) => { requests++; response.end('{}'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = {
    mode: 'LOCAL_SIMULATION', core: { mec: {
      callbackBaseUrl: `http://127.0.0.1:${server.address().port}`,
      Location: { endpoint: '${EXTERNAL_TEST_ENDPOINT}', simulation: true },
      RNIS: { endpoint: '${EXTERNAL_TEST_ENDPOINT}', simulation: true },
    } },
    scenario: { ueId: '192.0.2.10', callbackTimeoutMs: 1000, geofence: { type: 'circle', lat: 37.5, lon: 127, radiusM: 100 } },
  };
  const path = join(directory, 'mec.json');
  await writeFile(path, JSON.stringify(config));
  const result = spawnSync(process.execPath, [runner.pathname, `--config=${path}`, '--scenario=mec', '--check'], {
    encoding: 'utf8', env: { ...process.env, EXTERNAL_TEST_ENDPOINT: `http://127.0.0.1:${server.address().port}` }, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'CONFIG_READY');
  assert.equal(requests, 0);
});

test('invalid external plans fail before execution and never disclose environment secrets', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'external-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [scenario, config, reason] of [
    ['mec', { mode: 'EXTERNAL', core: { mec: { Location: { endpoint: '${EXTERNAL_MISSING_VALUE}' } } }, scenario: {} }, 'ENV_REQUIRED'],
    ['edge', { mode: 'EXTERNAL', core: { handover: { edges: [] } }, scenario: {} }, 'EDGE_PAIR_REQUIRED'],
    ['edge', { mode: 'EXTERNAL', core: { handover: {
      edges: [{ edgeId: 'A', endpoint: 'https://same-host.invalid:9001', deployment: { hostId: 'A' } }, { edgeId: 'B', endpoint: 'https://same-host.invalid:9002', deployment: { hostId: 'B' } }],
      manifests: [{ ueId: 'u' }],
    } }, scenario: { ueId: 'u' } }, 'EDGE_INDEPENDENT_HOSTS_REQUIRED'],
    ['fl', { mode: 'EXTERNAL', core: { fl: { mode: 'ESTIMED' } }, scenario: { workers: [] } }, 'FL_THREE_HOSTS_REQUIRED'],
  ]) {
    const path = join(directory, `${scenario}.json`); await writeFile(path, JSON.stringify(config));
    const result = spawnSync(process.execPath, [runner.pathname, `--config=${path}`, `--scenario=${scenario}`, '--check'], {
      encoding: 'utf8', env: { ...process.env, UNUSED_EXTERNAL_SECRET: 'never-print-this-secret' }, timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error, reason);
    assert.equal(result.stderr.includes('never-print-this-secret'), false);
  }
});

test('unsupported scenario fails instead of silently producing a successful receipt', () => {
  const result = spawnSync(process.execPath, [runner.pathname, '--scenario=unknown', '--config=unused'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error, 'SCENARIO_REQUIRED');
});
