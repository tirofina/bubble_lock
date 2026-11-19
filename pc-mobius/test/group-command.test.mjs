import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPortalDemo } from '../integration/src/portal-demo.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';
import { OneM2mGroupFanout, toOneM2mTime } from '../src/onem2m-group-fanout.mjs';
import { GroupDispatcher } from '../src/group-dispatcher.mjs';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const CENTRAL = 'Ccentral';
const member = (deviceId) => `/Mobius/${deviceId}/binarySwitch`;
const acks = (deviceId) => `/Mobius/${deviceId}/commandAcks`;

// Minimal CSE double: group create/update, fopt aggregation with member ACP, member PUT/GET, cin.
class FakeCse {
  constructor() { this.resources = new Map(); this.denied = new Set(); this.calls = []; this.groups = new Map(); this.instances = []; this.macpDenied = false; }
  add(deviceId, state = false) { this.resources.set(member(deviceId), { state, ri: `ri-${deviceId}` }); }
  respond(rqi, rsc, payload, status = 200) {
    return new Response(payload === undefined ? '' : JSON.stringify(payload), { status, headers: { 'X-M2M-RSC': String(rsc), 'X-M2M-RI': rqi, 'content-type': 'application/json' } });
  }
  update(path, body, origin) {
    const resource = this.resources.get(path);
    if (!resource) return { rsc: 4004, pc: { 'm2m:dbg': 'not found' } };
    if (this.denied.has(path) || origin !== CENTRAL) return { rsc: 4103, pc: { 'm2m:dbg': 'no privilege' } };
    resource.state = body['cod:binSh'].state;
    return { rsc: 2004, pc: { 'cod:binSh': { ri: resource.ri, state: resource.state } } };
  }
  fetch = async (url, init) => {
    const { pathname } = new URL(url); const rqi = init.headers['X-M2M-RI']; const origin = init.headers['X-M2M-Origin'];
    const body = init.body ? JSON.parse(init.body) : undefined;
    this.calls.push({ method: init.method, path: pathname, body });
    if (init.method === 'POST' && body?.['m2m:grp']) {
      const path = `${pathname}/${body['m2m:grp'].rn}`;
      if (this.groups.has(path)) return this.respond(rqi, 4105, { 'm2m:dbg': 'exists' }, 409);
      this.groups.set(path, { ...body['m2m:grp'], ri: 'grp-1', mtv: true, cnm: body['m2m:grp'].mid.length });
      return this.respond(rqi, 2001, { 'm2m:grp': this.groups.get(path) }, 201);
    }
    if (init.method === 'GET' && this.groups.has(pathname)) return this.respond(rqi, 2000, { 'm2m:grp': this.groups.get(pathname) });
    if (init.method === 'PUT' && this.groups.has(pathname)) { Object.assign(this.groups.get(pathname), body['m2m:grp']); return this.respond(rqi, 2004, { 'm2m:grp': this.groups.get(pathname) }); }
    if (init.method === 'PUT' && pathname.endsWith('/fopt')) {
      const group = this.groups.get(pathname.slice(0, -5));
      if (this.macpDenied) return this.respond(rqi, 4103, { 'm2m:dbg': 'macp' }, 403);
      const rsp = group.mid.map((mid) => ({ fr: mid, rqi, ...this.update(`/${mid}`, body, origin) }));
      return this.respond(rqi, 2000, { 'm2m:agr': { 'm2m:rsp': rsp } });
    }
    if (init.method === 'PUT' && this.resources.has(pathname)) { const result = this.update(pathname, body, origin); return this.respond(rqi, result.rsc, result.pc, result.rsc === 2004 ? 200 : 403); }
    if (init.method === 'GET' && this.resources.has(pathname)) { const resource = this.resources.get(pathname); return this.respond(rqi, 2000, { 'cod:binSh': { ri: resource.ri, cnd: 'org.onem2m.common.moduleclass.binarySwitch', state: resource.state } }); }
    if (init.method === 'POST' && body?.['m2m:cin']) { this.instances.push({ path: pathname, ...body['m2m:cin'] }); return this.respond(rqi, 2001, { 'm2m:cin': { ri: `cin-${this.instances.length}`, et: body['m2m:cin'].et } }, 201); }
    return this.respond(rqi, 4004, { 'm2m:dbg': 'unknown' }, 404);
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bubble-group-command-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let now = '2026-11-19T08:00:00.000Z';
  const clock = () => now;
  const cse = new FakeCse();
  for (const deviceId of ['keyring-A', 'keyring-B', 'keyring-C']) cse.add(deviceId);
  const core = () => ({ groupCommand: { fanout: new OneM2mGroupFanout({ endpoint: 'http://127.0.0.1:7599', originator: CENTRAL, fetchImpl: cse.fetch }), groupParent: '/Mobius/pb-central',
    memberResources: Object.fromEntries(['keyring-A', 'keyring-B', 'keyring-C'].map((id) => [id, member(id)])), ackContainers: Object.fromEntries(['keyring-A', 'keyring-B', 'keyring-C'].map((id) => [id, acks(id)])),
    auditContainer: '/Mobius/pb-central/groupCommands', macp: ['/Mobius/pb-central/household-macp'] } });
  const statePath = join(dir, 'state.json');
  const { runtime, principals } = await createPortalDemo({ statePath, clock, core: core() });
  t.after(() => runtime.close());
  const api = (role, path, body = {}) => runtime.api.handle({ method: 'POST', path: `/v1/portal/${path}`, principal: principals[role], body });
  const consent = await api('guardian', 'consents', { householdId: 'household-demo', purpose: '가구 보호', scopes: ['bubble:command'], ttlSec: 3600, idempotencyKey: 'consent-group' });
  const grant = await api('guardian', 'grants', { consentId: consent.body.consentId, scopes: ['bubble:command'], ttlSec: 900, idempotencyKey: 'grant-group' });
  const gateway = { principalId: 'gateway-demo', scopes: [], mtlsFingerprint: 'DEMO-ONLY-NO-TRANSPORT' };
  return { runtime, principals, api, cse, grant: grant.body, gateway, statePath, clock, core, setTime: (value) => { now = value; } };
}

const binding = (command, payloadHash) => ({ commandId: command.commandId, deviceId: command.deviceId, claimId: command.claimId, grantRevision: command.grantRevision, ownershipEpoch: command.ownershipEpoch, payloadHash });
// Simulated Gateway/BLE stage: poll, authorize, dispatch-start and an APPLIED receipt with readback.
async function gatewayApplies(f, deviceIds) {
  const settled = [];
  for (const command of f.runtime.gatewayControl.poll('pi-01', f.gateway).commands.filter((item) => deviceIds.includes(item.deviceId))) {
    const payloadHash = f.runtime.store.get('gatewayCommands', command.commandId).payloadHash;
    assert.equal((await f.runtime.gatewayControl.authorize('pi-01', f.gateway, binding(command, payloadHash))).allowed, true);
    assert.equal((await f.runtime.gatewayControl.dispatchStart('pi-01', f.gateway, binding(command, payloadHash))).allowed, true);
    const at = f.clock();
    const receipt = { version: 1, gatewayId: 'pi-01', deviceId: command.deviceId, commandId: command.commandId, payloadHash, status: 'APPLIED', ackCode: 'APPLIED', acceptedAt: at, appliedAt: at, receivedAt: at, readback: { state: command.desiredState.state }, firmwareRevision: 'keyring-sim', ownershipEpoch: command.ownershipEpoch, grantRevision: command.grantRevision, timestampSource: 'gateway-estimated', detail: null, bootId: 'sim-boot' };
    settled.push(await f.runtime.gatewayControl.receiveReceipt('pi-01', f.gateway, receipt));
  }
  await f.runtime.groupCommands.idle();
  return settled;
}

test('toOneM2mTime converts ISO timestamps to the oneM2M basic format', () => {
  assert.equal(toOneM2mTime('2026-11-19T08:15:30.123Z'), '20261119T081530');
  assert.throws(() => toOneM2mTime('not-a-time'));
});

test('가구 전체 명령은 한 번의 fopt 요청과 구성원별 rsc, claim, readback으로 정산', async (t) => {
  const f = await fixture(t);
  f.cse.denied.add(member('keyring-C'));
  const requested = await f.api('visitor', 'commands/request', { householdId: 'household-demo', target: 'household', desiredState: { state: true }, reason: '가구 보호 모드', idempotencyKey: 'group-request' });
  assert.equal(requested.status, 200);
  assert.deepEqual(requested.body.deviceIds, ['keyring-A', 'keyring-B', 'keyring-C']);
  assert.equal(requested.body.target, 'household');
  const approveInput = { requestId: requested.body.requestId, grantId: f.grant.grantId, idempotencyKey: 'group-approve' };
  const approved = await f.api('guardian', 'commands/approve', approveInput);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.status, 'PARTIAL');
  const fopt = f.cse.calls.filter((call) => call.path.endsWith('/fopt'));
  assert.equal(fopt.length, 1, 'household command is one fanOutPoint request');
  assert.deepEqual(fopt[0].body, { 'cod:binSh': { state: true } });
  const group = f.cse.groups.get('/Mobius/pb-central/household-demo-switches');
  assert.deepEqual(group.mid, ['Mobius/keyring-A/binarySwitch', 'Mobius/keyring-B/binarySwitch', 'Mobius/keyring-C/binarySwitch']);
  assert.equal(group.mt, 28); assert.deepEqual(group.macp, ['/Mobius/pb-central/household-macp']);
  assert.equal(group.et, toOneM2mTime(f.grant.expiresAt), 'group expirationTime follows the guardian grant');
  const members = Object.fromEntries(approved.body.group.members.map((item) => [item.deviceId, item]));
  assert.equal(members['keyring-A'].status, 'DISPATCHED'); assert.equal(members['keyring-A'].cseRsc, 2004);
  assert.equal(members['keyring-C'].status, 'RETRY_PENDING'); assert.equal(members['keyring-C'].cseRsc, 4103);
  assert.match(members['keyring-C'].error, /CSE_MEMBER_RSC_4103/);
  assert.equal(approved.body.commands.length, 2, 'claims exist only for members the CSE accepted');
  for (const deviceId of ['keyring-A', 'keyring-B']) {
    const record = f.runtime.store.get('gatewayCommands', members[deviceId].memberCommandId);
    assert.equal(members[deviceId].binding.claimId, record.command.claimId);
    assert.equal(members[deviceId].binding.grantRevision, record.command.grantRevision);
    assert.equal(members[deviceId].binding.ownershipEpoch, record.command.ownershipEpoch);
    assert.equal(members[deviceId].binding.deadline, record.command.deadline);
    assert.equal(members[deviceId].payloadHash, record.payloadHash);
    assert.equal(record.payloadHash, approvalHash(record.command));
  }
  assert.equal(f.runtime.store.get('gatewayCommands', members['keyring-C'].memberCommandId), undefined);
  assert.deepEqual((await f.api('guardian', 'commands/approve', approveInput)).body, approved.body, 'same approval key replays the stored result');

  await gatewayApplies(f, ['keyring-A', 'keyring-B']);
  let summary = f.runtime.groupCommands.summary(approved.body.group.commandId);
  assert.equal(summary.appliedCount, 2);
  for (const deviceId of ['keyring-A', 'keyring-B']) {
    const item = summary.members.find((entry) => entry.deviceId === deviceId);
    assert.equal(item.status, 'READBACK_VERIFIED'); assert.deepEqual(item.readback, { state: true });
    assert.equal(item.cseReadback.state, true); assert.equal(item.cseReadback.matchesDesired, true); assert.equal(item.cseReadback.ackInstance.rsc, 2001);
  }
  const ackRows = f.cse.instances.filter((row) => row.path.endsWith('/commandAcks'));
  assert.equal(ackRows.length, 2);
  assert.equal(ackRows.every((row) => row.et && row.con.claimId && row.con.payloadHash && row.con.readback.state === true), true);

  f.cse.denied.delete(member('keyring-C'));
  const before = f.cse.calls.length;
  const retried = await f.api('guardian', 'commands/retry', { requestId: requested.body.requestId, idempotencyKey: 'group-retry' });
  assert.equal(retried.status, 200, JSON.stringify(retried.body));
  const retryCalls = f.cse.calls.slice(before).filter((call) => call.method === 'PUT');
  assert.deepEqual(retryCalls.map((call) => call.path), [member('keyring-C')], 'retry reaches only the failed member');
  assert.equal(retried.body.status, 'QUEUED');
  await gatewayApplies(f, ['keyring-C']);
  summary = f.runtime.groupCommands.summary(approved.body.group.commandId);
  assert.equal(summary.status, 'SETTLED'); assert.equal(summary.appliedCount, 3);
  assert.equal(summary.retries.length, 1); assert.equal(summary.retries[0].rsc, 2004);
  assert.equal(summary.fanouts[0].memberResults.map((item) => item.rsc).join(), '2004,2004,4103');
  const snapshot = f.runtime.portalService.snapshot(f.principals.guardian).commandRequests.find((item) => item.requestId === requested.body.requestId);
  assert.equal(snapshot.group.appliedCount, 3); assert.equal(snapshot.commands.length, 3);
  const ajv = new Ajv2020({ allErrors: true }); addFormats(ajv);
  ajv.addSchema(JSON.parse(await readFile(new URL('../../contracts/keyring/command.schema.json', import.meta.url), 'utf8')));
  const validate = ajv.compile(JSON.parse(await readFile(new URL('../contracts/portal.schema.json', import.meta.url), 'utf8')));
  assert.equal(validate(JSON.parse(JSON.stringify(f.runtime.portalService.snapshot(f.principals.guardian)))), true, JSON.stringify(validate.errors));
  const receiptTypes = f.runtime.store.list('receipts').map((row) => row.type);
  assert.equal(receiptTypes.includes('GROUP_FANOUT_SENT'), true); assert.equal(receiptTypes.includes('GROUP_MEMBER_RETRY'), true);
});

test('단일 기기 명령은 기존 Gateway 큐 경로를 유지하고 group fan-out을 사용하지 않음', async (t) => {
  const f = await fixture(t);
  const requested = await f.api('visitor', 'commands/request', { householdId: 'household-demo', deviceIds: ['keyring-A'], desiredState: { state: true }, reason: '단일 기기', idempotencyKey: 'single-request' });
  const approved = await f.api('guardian', 'commands/approve', { requestId: requested.body.requestId, grantId: f.grant.grantId, idempotencyKey: 'single-approve' });
  assert.equal(approved.body.status, 'QUEUED'); assert.equal(approved.body.group, undefined);
  assert.equal(approved.body.commands.length, 1);
  assert.equal(f.cse.calls.length, 0, 'single-device path does not touch the group CSE');
  assert.equal((await f.api('visitor', 'commands/request', { householdId: 'household-demo', target: 'household', deviceIds: ['keyring-A'], desiredState: { state: true }, reason: '혼합', idempotencyKey: 'mixed' })).status, 403);
});

test('macp 거부는 모든 구성원을 재시도 대기로 두고 재시작 뒤 실패 구성원만 다시 보냄', async (t) => {
  const f = await fixture(t);
  f.cse.macpDenied = true;
  const requested = await f.api('visitor', 'commands/request', { householdId: 'household-demo', target: 'household', desiredState: { state: false }, reason: '보호 해제', idempotencyKey: 'macp-request' });
  const approved = await f.api('guardian', 'commands/approve', { requestId: requested.body.requestId, grantId: f.grant.grantId, idempotencyKey: 'macp-approve' });
  assert.equal(approved.body.status, 'PARTIAL');
  assert.equal(approved.body.group.members.every((item) => item.status === 'RETRY_PENDING' && /GROUP_FANOUT_RSC_4103/.test(item.error)), true);
  assert.equal(approved.body.commands.length, 0);
  f.cse.macpDenied = false;
  const { runtime } = await createPortalDemo({ statePath: f.statePath, clock: f.clock, core: f.core() });
  t.after(() => runtime.close());
  const groupCommandId = approved.body.group.commandId;
  assert.equal(runtime.groupCommands.summary(groupCommandId).members.filter((item) => item.status === 'RETRY_PENDING').length, 3);
  const before = f.cse.calls.length;
  const retried = await runtime.groupCommands.retry(groupCommandId);
  assert.equal(f.cse.calls.slice(before).filter((call) => call.method === 'PUT').length, 3);
  assert.equal(retried.members.every((item) => item.status === 'DISPATCHED' && item.binding.claimId), true);
  const again = await runtime.groupCommands.retry(groupCommandId);
  assert.equal(f.cse.calls.slice(before).filter((call) => call.method === 'PUT').length, 3, 'members waiting for ACK are not re-sent');
  assert.equal(again.attempts, 3);
});

test('구성원 claim은 승인 시점 권한을 따르고 회수된 grant로는 재시도하지 않음', async (t) => {
  const f = await fixture(t);
  f.cse.denied.add(member('keyring-B'));
  const requested = await f.api('visitor', 'commands/request', { householdId: 'household-demo', target: 'household', desiredState: { state: true }, reason: '보호', idempotencyKey: 'revoke-request' });
  const approved = await f.api('guardian', 'commands/approve', { requestId: requested.body.requestId, grantId: f.grant.grantId, idempotencyKey: 'revoke-approve' });
  await f.api('guardian', 'grants/revoke', { grantId: f.grant.grantId, idempotencyKey: 'revoke-grant' });
  f.cse.denied.delete(member('keyring-B'));
  const before = f.cse.calls.length;
  const retried = await f.runtime.groupCommands.retry(approved.body.group.commandId);
  assert.equal(f.cse.calls.length, before, 'revoked grant stops the retry before any CSE write');
  assert.match(retried.members.find((item) => item.deviceId === 'keyring-B').error, /권한/);
});

test('GroupDispatcher fan-out mode is idempotent per commandId and maps per-member results', async () => {
  const sent = [];
  const bridge = { onAck: () => () => {}, sendCommand: async (command) => { sent.push(command.commandId); return { rsc: 2004 }; },
    fanOut: async ({ members }) => Object.fromEntries(members.map((item, index) => [item.memberId, index === 0 ? { ok: true, rsc: 2004 } : { ok: false, rsc: 4103, error: 'CSE_MEMBER_RSC_4103' }])) };
  const dispatcher = new GroupDispatcher({ bridge, retryScope: 'failed', clock: () => '2026-11-19T08:00:00.000Z', members: { one: { deviceId: 'kr-1', gatewayId: 'pi', groupId: 'g' }, two: { deviceId: 'kr-2', gatewayId: 'pi', groupId: 'g' } } });
  const input = { groupId: 'g', state: true, commandId: 'fan-1', deadline: '2026-11-19T08:05:00.000Z' };
  const first = await dispatcher.dispatch(input);
  assert.equal(first.transport, 'GROUP_FANOUT');
  assert.deepEqual(first.members.map((item) => [item.status, item.cseRsc]), [['DISPATCHED', 2004], ['RETRY_PENDING', 4103]]);
  assert.equal((await dispatcher.dispatch(input)).members.length, 2, 'same intent replays the durable summary');
  await assert.rejects(dispatcher.dispatch({ ...input, state: false }), /already registered/);
  await dispatcher.retryPending('fan-1');
  assert.deepEqual(sent, ['fan-1:two']);
  assert.throws(() => new GroupDispatcher({ bridge, retryScope: 'everything' }), /retryScope/);
});
