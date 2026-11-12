import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startReplayServer } from '../../web-dashboard/server/sse.ts';

test('private container bind accepts a request from the bridge address', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'bubble-bff-bind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const address = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === 'IPv4' && !entry.internal)?.address;
  assert.ok(address, 'A non-loopback network interface is required for this deployment test');
  const service = await startReplayServer({ port: 0, host: '0.0.0.0', portalStatePath: join(directory, 'state.json') });
  t.after(service.close);
  const response = await fetch(service.url.replace('127.0.0.1', address) + '/api/auth/session', { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { mode: 'demo', authenticated: false });
});
