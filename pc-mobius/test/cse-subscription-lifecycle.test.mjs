import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeWithTransientCreate, revokeSubscriber } from '../integration/src/cse-subscription-lifecycle.mjs';

function fakeAdmin(initial) {
  const state = { pv: structuredClone(initial), log: [], deleteRsc: {} };
  return {
    state,
    async request(method, path, body) {
      state.log.push(`${method} ${path}`);
      if (method === 'PUT') { state.pv = structuredClone(body['m2m:acp'].pv); return { rsc: 2004 }; }
      if (method === 'DELETE') return { rsc: state.deleteRsc[path] ?? 2002 };
      throw new Error(`unexpected ${method}`);
    },
    async read() { return { 'm2m:acp': { pv: structuredClone(state.pv) } }; },
  };
}

const policy = { acr: [{ acor: ['admin'], acop: 63 }, { acor: ['mec'], acop: 2 }] };

test('MEC IPE gets CREATE only while its subscription is created', async () => {
  const admin = fakeAdmin(policy);
  let seen;
  const created = await subscribeWithTransientCreate({ admin, acpPath: '/acp', policy, subscriberId: 'mec', createAsSubscriber: async () => { seen = structuredClone(admin.state.pv); return { rsc: 2001 }; } });
  assert.equal(created.rsc, 2001);
  assert.equal(seen.acr.find((rule) => rule.acor[0] === 'mec').acop, 3);
  assert.deepEqual(admin.state.pv, policy);
});

test('policy is restored when the subscription CREATE fails', async () => {
  const admin = fakeAdmin(policy);
  await assert.rejects(subscribeWithTransientCreate({ admin, acpPath: '/acp', policy, subscriberId: 'mec', createAsSubscriber: async () => { throw new Error('transport'); } }), /transport/);
  assert.deepEqual(admin.state.pv, policy);
});

test('a subscriber without a rule gets a temporary rule that is removed afterwards', async () => {
  const base = { acr: [{ acor: ['admin'], acop: 63 }] };
  const admin = fakeAdmin(base);
  await subscribeWithTransientCreate({ admin, acpPath: '/acp', policy: base, subscriberId: 'op', createAsSubscriber: async () => ({ rsc: 5204 }) });
  assert.deepEqual(admin.state.pv, base);
});

test('revocation deletes subscriptions before changing the ACP', async () => {
  const admin = fakeAdmin(policy);
  admin.state.deleteRsc['/c/gone'] = 4004;
  const revoked = { acr: [{ acor: ['admin'], acop: 63 }] };
  const result = await revokeSubscriber({ admin, subscriptionPaths: ['/c/sub', '/c/gone'], acpPath: '/acp', revokedPolicy: revoked });
  assert.deepEqual(admin.state.log, ['DELETE /c/sub', 'DELETE /c/gone', 'PUT /acp']);
  assert.deepEqual(result.subscriptions.map((entry) => entry.rsc), [2002, 4004]);
  assert.deepEqual(admin.state.pv, revoked);
});

test('revocation stops before the ACP change when a subscription cannot be deleted', async () => {
  const admin = fakeAdmin(policy);
  admin.state.deleteRsc['/c/sub'] = 4103;
  await assert.rejects(revokeSubscriber({ admin, subscriptionPaths: ['/c/sub'], acpPath: '/acp', revokedPolicy: { acr: [] } }), /4103/);
  assert.deepEqual(admin.state.log, ['DELETE /c/sub']);
});
