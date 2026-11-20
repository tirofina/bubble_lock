import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { startReplayServer } from '../server/sse.ts';

async function post(base: string, body: unknown) {
  const response = await fetch(`${base}/api/portal/caregiver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, any> };
}

test('caregiver Living Room On runs the household group command while the delegation grant is valid and is REJECTED after expiry', { timeout: 30000 }, async (t) => {
  // Given: the demo portal with the living room group on the emulated fanOutPoint
  const directory = await mkdtemp(join(tmpdir(), 'caregiver-'));
  const service = await startReplayServer({ port: 0, portalStatePath: join(directory, 'state.json'), portal: { livingRoom: { delegationSec: 600 } } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  const status = await (await fetch(`${service.url}/api/portal/caregiver`)).json() as Record<string, any>;
  assert.equal(status['grant'].active, true);
  assert.equal(status['grant'].storyExpiryLocal, '16:00');
  assert.deepEqual(status['devices'].map((device: { deviceId: string }) => device.deviceId), ['living-room-light', 'living-room-fan']);
  // When: the guardian cannot press it as a caregiver, the caregiver can
  assert.equal((await post(service.url, { role: 'guardian', state: true })).status, 403);
  const on = await post(service.url, { role: 'visitor', state: true });
  // Then: one group command, per-member ACK and readback through the existing group command service
  assert.equal(on.status, 200);
  const result = on.body['result'];
  assert.equal(result.outcome, 'APPLIED', JSON.stringify(result).slice(0, 600));
  assert.equal(result.aggregateRsc, 2000);
  assert.match(String(result.fanoutPoint), /\/fopt$/);
  assert.deepEqual(result.members.map((member: Record<string, unknown>) => [member['deviceId'], member['status'], member['cseRsc'], member['readback'], member['cseReadback']]).sort(),
    [['living-room-fan', 'READBACK_VERIFIED', 2004, true, true], ['living-room-light', 'READBACK_VERIFIED', 2004, true, true]]);
  assert.match(String(result.approvalHash), /^[a-f0-9]{64}$/);
  // When: the delegation grant expires
  await post(service.url, { action: 'renew', ttlSec: 10 });
  await new Promise((resolve) => setTimeout(resolve, 11000));
  const late = await post(service.url, { role: 'visitor', state: true });
  // Then: REJECTED at the grant check, no claim and no CSE request
  assert.equal(late.body['result'].outcome, 'REJECTED');
  assert.equal(late.body['result'].stage, 'grant');
  assert.equal(late.body['result'].members.every((member: Record<string, unknown>) => member['status'] === 'REJECTED'), true);
  const operator = await (await fetch(`${service.url}/api/group-commands`)).json() as Record<string, any>;
  assert.deepEqual(operator['results'].map((entry: Record<string, unknown>) => entry['outcome']), ['REJECTED', 'APPLIED']);
});
