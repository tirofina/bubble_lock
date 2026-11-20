import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BINARY_SWITCH_CND, KEYRING_STREAMS, LABELS, STREAM_POLICY, TAGS,
  desiredTopology, normalizeSite, redactReport, runTopology,
} from '../multiapp/bubblelock-topology.mjs';
import * as contract from '../multiapp/topology.mjs';
import { parseArgs, remoteCommand } from '../scripts/bubblelock-topology.mjs';

const ADMIN = 'Ctest-admin-originator';
const ENDPOINT = 'http://cse.test:7599';
const LEGACY = ['Mobius/bubble-household-1', 'Mobius/bubble-household-1/gateway-1', 'Mobius/bubble-household-1/gateway-1/observations', 'Mobius/bubble-household-1/resident-relay'];

const spec = (overrides = {}) => ({
  householdId: 'household-1',
  gateways: [{ rn: 'gateway-1', devices: ['keyring-A', 'keyring-B'] }],
  readers: [{ originator: 'Cpb-dash-operator', acop: 35 }],
  legacyRoots: ['bubble-household-1'],
  labelAdditions: [{ path: 'bubble-household-1/gateway-1', add: ['pb-gateway-gateway-1'] }],
  ...overrides,
});

/** In-memory Mobius4 stand-in: structured paths, 4004/4105/2001/2004, fu=1 discovery, every call recorded. */
function fakeCse(seed = []) {
  const store = new Map([['Mobius', { ty: 5, res: { ri: 'cb', rn: 'Mobius' } }]]);
  const calls = [];
  let sequence = 0;
  const tagOf = (ty) => TAGS[ty] ?? 'm2m:cb';
  for (const [path, ty, res] of seed) store.set(path, { ty, res: { ri: `seed-${++sequence}`, rn: path.split('/').at(-1), ty, ...res } });
  const reply = (rsc, payload = null) => ({ headers: { get: (name) => (name.toLowerCase() === 'x-m2m-rsc' ? String(rsc) : null) }, text: async () => (payload ? JSON.stringify(payload) : '') });
  async function fetchImpl(href, init) {
    const url = new URL(href);
    const path = decodeURIComponent(url.pathname).replace(/^\//, '');
    const origin = init.headers['X-M2M-Origin'];
    calls.push({ method: init.method, path, origin, body: init.body ? JSON.parse(init.body) : null });
    const node = store.get(path);
    if (init.method === 'GET') {
      if (!node) return reply(4004, { 'm2m:dbg': 'resource does not exist' });
      if (url.searchParams.get('fu') === '1') {
        const ty = Number(url.searchParams.get('ty') ?? 0);
        return reply(2000, { 'm2m:uril': [...store.entries()].filter(([key, value]) => key.startsWith(`${path}/`) && (!ty || value.ty === ty)).map(([key]) => key) });
      }
      return reply(2000, { [tagOf(node.ty)]: structuredClone(node.res) });
    }
    if (init.method === 'POST') {
      if (!node) return reply(4004);
      const ty = Number(/;ty=(\d+)/.exec(init.headers['Content-Type'])[1]);
      const body = JSON.parse(init.body)[TAGS[ty]];
      const child = `${path}/${body.rn}`;
      if (store.has(child)) return reply(4105, { 'm2m:dbg': 'resource already exists' });
      const res = { ...body, ri: `r${++sequence}`, ty, pi: node.res.ri, cr: origin };
      store.set(child, { ty, res });
      return reply(2001, { [TAGS[ty]]: res });
    }
    if (init.method === 'PUT') {
      if (!node) return reply(4004);
      Object.assign(node.res, JSON.parse(init.body)[tagOf(node.ty)]);
      return reply(2004, { [tagOf(node.ty)]: structuredClone(node.res) });
    }
    return reply(4005);
  }
  const snapshot = (paths) => Object.fromEntries(paths.map((path) => [path, structuredClone(store.get(path))]));
  return { fetchImpl, store, calls, snapshot, writes: () => calls.filter((call) => call.method !== 'GET') };
}

const partialServer = () => fakeCse([
  ['Mobius/bubble-household-1', 2, { api: 'Nlegacy', aei: 'Clegacy', lbl: ['legacy'] }],
  ['Mobius/bubble-household-1/gateway-1', 3, { lbl: [], mni: 10 }],
  ['Mobius/bubble-household-1/gateway-1/observations', 3, { mni: 1000 }],
  ['Mobius/bubble-household-1/resident-relay', 3, { mni: 10 }],
  ['Mobius/BubbleLock', 2, { api: 'Npb.bubblelock', aei: 'Cpb-bubblelock', lbl: ['keep-me'] }],
  ['Mobius/BubbleLock/gateway-1', 3, { lbl: ['pb-gateway-gateway-1', 'operator-note'] }],
  ['Mobius/BubbleLock/grp-switches', 9, { mt: 28, mnm: 1, csy: 1, mid: ['Mobius/BubbleLock/gateway-1/keyring-A/switch'], lbl: ['pb-app-bubblelock', 'pb-household-household-1'] }],
]);

test('engine constants match the DOC-REV 2.0 keyring contract in topology.mjs', () => {
  // Given / When / Then
  assert.deepEqual([...KEYRING_STREAMS], [...contract.STREAMS]);
  assert.deepEqual(STREAM_POLICY, contract.CONTAINER_POLICY);
  assert.equal(BINARY_SWITCH_CND, contract.BINARY_SWITCH_CND);
  assert.equal(LABELS.keyring, contract.LABELS.keyring);
  assert.equal(LABELS.sdt, contract.LABELS.sdt);
  assert.equal(LABELS.incidents, contract.LABELS.incidents);
  for (const fn of ['stream', 'device', 'gateway', 'household']) assert.equal(LABELS[fn]('x-1'), contract.LABELS[fn]('x-1'));
});

test('target tree has one AE directly under CSEBase and every other resource below it', () => {
  // Given
  const nodes = desiredTopology(spec({ labelAdditions: [] }));
  // When
  const aes = nodes.filter((node) => node.ty === 2);
  const roots = nodes.filter((node) => node.path.split('/').at(-1) === 'keyring-A');
  const group = nodes.find((node) => node.ty === 9);
  // Then
  assert.deepEqual(aes.map((node) => node.path), ['Mobius/BubbleLock']);
  assert.ok(nodes.every((node) => node.path === 'Mobius/BubbleLock' || node.path.startsWith('Mobius/BubbleLock/')));
  assert.ok(nodes.every((node) => [1, 2, 3, 9, 23, 28].includes(node.ty)));
  assert.equal(roots[0].attrs.lbl[0], 'pb-keyring', 'dashboard discovery label sits on the device root');
  assert.ok(nodes.filter((node) => node.attrs.lbl?.includes('pb-keyring')).every((node) => node.path.split('/').length === 4));
  assert.deepEqual(group.attrs.mid, ['Mobius/BubbleLock/gateway-1/keyring-A/switch', 'Mobius/BubbleLock/gateway-1/keyring-B/switch']);
  for (const feed of ['observations', 'receipts', 'health']) assert.ok(nodes.some((node) => node.path === `Mobius/BubbleLock/gateway-1/${feed}`));
  for (const feed of ['location', 'rnis']) assert.ok(nodes.some((node) => node.path === `Mobius/BubbleLock/resident-relay/${feed}`));
  assert.ok(nodes.some((node) => node.path === 'Mobius/BubbleLock/services/incidents'));
});

test('spec validation rejects unsafe names and label additions inside the BubbleLock AE', () => {
  assert.throws(() => normalizeSite(spec({ householdId: '../x' })), /householdId/);
  assert.throws(() => normalizeSite(spec({ gateways: [{ rn: 'gw 1' }] })), /gateways\[0\]\.rn/);
  assert.throws(() => normalizeSite(spec({ labelAdditions: [{ path: 'BubbleLock/gateway-1', add: ['x'] }] })), /outside the BubbleLock AE/);
  assert.throws(() => normalizeSite(spec({ readers: [{ originator: 'admin', acop: 63 }] })), /readers\[0\]/);
});

test('plan mode is read only and lists only CREATE and label/member append UPDATE actions', async () => {
  // Given
  const cse = partialServer();
  // When
  const report = await runTopology({ spec: spec(), endpoint: ENDPOINT, admin: ADMIN, fetchImpl: cse.fetchImpl });
  // Then
  assert.equal(report.mode, 'plan');
  assert.deepEqual(cse.writes(), [], 'plan issues GET only');
  assert.ok(report.actions.every((action) => ['create', 'update'].includes(action.op)));
  const update = (path) => report.actions.find((action) => action.op === 'update' && action.path === path)?.body;
  assert.deepEqual(update('Mobius/BubbleLock')['m2m:ae'], { lbl: ['keep-me', 'pb-app-bubblelock', 'pb-household-household-1'] });
  assert.deepEqual(update('Mobius/BubbleLock/gateway-1')['m2m:cnt'], { lbl: ['pb-gateway-gateway-1', 'operator-note', 'pb-household-household-1'] });
  assert.deepEqual(update('Mobius/BubbleLock/grp-switches')['m2m:grp'], { mid: ['Mobius/BubbleLock/gateway-1/keyring-A/switch', 'Mobius/BubbleLock/gateway-1/keyring-B/switch'], mnm: 2 });
  assert.deepEqual(update('Mobius/bubble-household-1/gateway-1')['m2m:cnt'], { lbl: ['pb-gateway-gateway-1'] });
  assert.ok(report.actions.some((action) => action.op === 'create' && action.path === 'Mobius/BubbleLock/acp-bubblelock'));
  assert.ok(!report.actions.some((action) => action.op === 'create' && LEGACY.includes(action.path)), 'legacy roots are never created');
  assert.deepEqual(report.legacy[0].containers, LEGACY.slice(1));
  assert.equal(report.legacy[0].action, 'preserve');
});

test('apply needs an explicit confirm and sends nothing without it', async () => {
  // Given
  const cse = partialServer();
  // When / Then
  await assert.rejects(runTopology({ spec: spec(), mode: 'apply', endpoint: ENDPOINT, admin: ADMIN, fetchImpl: cse.fetchImpl }), /confirm=BubbleLock/);
  await assert.rejects(runTopology({ spec: spec(), mode: 'apply', confirm: 'Mobius', endpoint: ENDPOINT, admin: ADMIN, fetchImpl: cse.fetchImpl }), /confirm=BubbleLock/);
  assert.equal(cse.calls.length, 0);
});

test('apply converges in one pass, preserves legacy resources and is idempotent on a second run', async () => {
  // Given
  const cse = partialServer();
  const legacyBefore = cse.snapshot(LEGACY);
  // When
  const first = await runTopology({ spec: spec(), mode: 'apply', confirm: 'BubbleLock', endpoint: ENDPOINT, admin: ADMIN, fetchImpl: cse.fetchImpl });
  const writesAfterFirst = cse.writes().length;
  const second = await runTopology({ spec: spec(), mode: 'apply', confirm: 'BubbleLock', endpoint: ENDPOINT, admin: ADMIN, fetchImpl: cse.fetchImpl });
  // Then
  assert.equal(first.verify.ok, true, JSON.stringify(first.applied.filter((item) => item.outcome === 'failed')));
  assert.equal(first.verify.remainingActions, 0);
  assert.equal(first.verify.legacyPreserved, true);
  assert.ok(cse.calls.every((call) => call.method !== 'DELETE'), 'no DELETE request');
  assert.equal(second.applied.length, 0);
  assert.equal(cse.writes().length, writesAfterFirst, 'second run writes nothing');
  const legacyAfter = cse.snapshot(LEGACY);
  for (const path of LEGACY.filter((item) => item !== 'Mobius/bubble-household-1/gateway-1')) assert.deepEqual(legacyAfter[path], legacyBefore[path]);
  const { lbl, ...restAfter } = legacyAfter['Mobius/bubble-household-1/gateway-1'].res;
  const { lbl: lblBefore, ...restBefore } = legacyBefore['Mobius/bubble-household-1/gateway-1'].res;
  assert.deepEqual(restAfter, restBefore);
  assert.deepEqual(lbl, [...lblBefore, 'pb-gateway-gateway-1']);
  // Writers: BubbleLock subtree by the BubbleLock AE-ID, the legacy label append by the admin originator.
  const writes = cse.writes();
  assert.ok(writes.filter((call) => call.path.startsWith('Mobius/BubbleLock')).every((call) => call.origin === 'Cpb-bubblelock'));
  assert.ok(writes.filter((call) => call.path.startsWith('Mobius/bubble-household-1')).every((call) => call.origin === ADMIN && call.method === 'PUT'));
  // Children reference the created ACP, and the switch is the TS-0023 binarySwitch.
  const acpRi = cse.store.get('Mobius/BubbleLock/acp-bubblelock').res.ri;
  assert.deepEqual(cse.store.get('Mobius/BubbleLock/gateway-1/keyring-B/command').res.acpi, [acpRi]);
  assert.equal(cse.store.get('Mobius/BubbleLock/gateway-1/keyring-B/switch').res.cnd, BINARY_SWITCH_CND);
  assert.deepEqual(cse.store.get('Mobius/BubbleLock/gateway-1').res.acpi, undefined, 'existing resources keep their acpi');
});

test('ACP gains a newly configured reader by appending a rule only', async () => {
  // Given
  const cse = partialServer();
  await runTopology({ spec: spec(), mode: 'apply', confirm: 'BubbleLock', endpoint: ENDPOINT, admin: ADMIN, fetchImpl: cse.fetchImpl });
  const before = cse.store.get('Mobius/BubbleLock/acp-bubblelock').res.pv.acr;
  // When
  const report = await runTopology({ spec: spec({ readers: [{ originator: 'Cpb-dash-operator', acop: 35 }, { originator: 'Cpb-gateway-reader', acop: 3 }] }), mode: 'apply', confirm: 'BubbleLock', endpoint: ENDPOINT, admin: ADMIN, fetchImpl: cse.fetchImpl });
  // Then
  assert.equal(report.verify.ok, true);
  assert.deepEqual(report.applied.map((item) => item.path), ['Mobius/BubbleLock/acp-bubblelock']);
  assert.deepEqual(cse.store.get('Mobius/BubbleLock/acp-bubblelock').res.pv.acr, [...before, { acor: ['Cpb-gateway-reader'], acop: 3 }]);
});

test('a resource of another type at a target path is reported, never touched, and blocks its subtree', async () => {
  // Given
  const cse = fakeCse([['Mobius/BubbleLock', 2, { api: 'Npb.bubblelock', lbl: ['pb-app-bubblelock', 'pb-household-household-1'] }], ['Mobius/BubbleLock/services', 28, { cnd: 'other', lbl: [] }]]);
  // When
  const report = await runTopology({ spec: spec({ labelAdditions: [], legacyRoots: [] }), mode: 'apply', confirm: 'BubbleLock', endpoint: ENDPOINT, admin: ADMIN, fetchImpl: cse.fetchImpl });
  // Then
  assert.deepEqual(report.skipped.map(({ path, status }) => [path, status]), [['Mobius/BubbleLock/services', 'conflict'], ['Mobius/BubbleLock/services/incidents', 'blocked']]);
  assert.ok(cse.writes().every((call) => !call.path.startsWith('Mobius/BubbleLock/services')));
  assert.equal(report.verify.remainingActions, 0);
  assert.equal(report.verify.summary.conflict, 1);
});

test('reports and the remote command carry no device ID or admin originator in clear text', async () => {
  // Given
  const cse = partialServer();
  const report = await runTopology({ spec: spec(), endpoint: ENDPOINT, admin: ADMIN, fetchImpl: cse.fetchImpl });
  // When
  const text = redactReport({ ...report, note: ADMIN }, { spec: spec(), admin: ADMIN });
  const command = remoteCommand({ container: 'cse-1', mode: 'apply', confirm: 'BubbleLock', spec: spec() });
  // Then
  for (const secret of ['keyring-A', 'keyring-B', ADMIN]) { assert.ok(!text.includes(secret), secret); assert.ok(!command.includes(secret), secret); }
  assert.ok(text.includes('[device-1]') && text.includes('[admin]'));
  assert.match(command, /^docker exec -i -e PB_TOPOLOGY_MAIN=1 -e PB_TOPOLOGY_MODE=apply -e PB_TOPOLOGY_SPEC_B64=[A-Za-z0-9+/=]+ -e PB_TOPOLOGY_CONFIRM=BubbleLock cse-1 node --input-type=module -$/);
  assert.throws(() => remoteCommand({ container: 'cse-1;id', spec: spec() }), /--container/);
  assert.throws(() => remoteCommand({ container: 'cse-1', mode: 'delete', spec: spec() }), /--mode/);
  assert.throws(() => parseArgs(['--spec', 'a.json']), /one transport/);
  assert.throws(() => parseArgs(['--spec', 'a.json', '--ssh', '-oProxyCommand=x', '--container', 'c']), /--ssh/);
  assert.equal(parseArgs(['--spec', 'a.json', '--endpoint', ENDPOINT]).mode, 'plan', 'plan is the default mode');
});
