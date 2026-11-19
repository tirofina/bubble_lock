import assert from 'node:assert/strict';
import test from 'node:test';
import { incidentFor } from '../multiapp/automation-ae.mjs';
import { ACOP, acpPlan, APP_STREAMS, STREAM_ACP } from '../multiapp/topology.mjs';
import { fromOneM2mTime, normalizeSid, payloadHash, toOneM2mTime } from '../multiapp/onem2m-http.mjs';
import { approvalHash } from '../integration/src/integration-utils.mjs';

const GATEWAY = 'Cgw01';
const observation = (overrides = {}) => ({ version: 1, gatewayId: 'pi-01', deviceId: 'keyring-A', bootId: 'emu-1', sequence: 4, observedAt: '2026-11-19T01:00:00.000Z', receivedAt: '2026-11-19T01:00:00.010Z', rssi: -60, battery: 80, buttonState: 'released', sensorValues: { batteryAlert: false }, state: false, firmwareRevision: 'emulated-keyring-0.1.0', timestampSource: 'gateway-received', ...overrides });

test('automation raises SAFETY for a Gateway button press and MAINTENANCE for low battery', () => {
  // Given
  const context = { gatewayAeId: GATEWAY, householdId: 'household-demo', deviceIds: ['keyring-A', 'keyring-B'] };
  // When
  const panic = incidentFor({ ...context, stream: 'button', cin: { ri: 'b1', cr: GATEWAY, con: observation({ buttonState: 'panic' }) } });
  const battery = incidentFor({ ...context, stream: 'battery', cin: { ri: 'b2', cr: GATEWAY, con: observation({ battery: 12, sensorValues: { batteryAlert: true } }) } });
  const forged = incidentFor({ ...context, stream: 'button', cin: { ri: 'b3', cr: 'Coperator', con: observation({ buttonState: 'panic' }) } });
  const released = incidentFor({ ...context, stream: 'button', cin: { ri: 'b4', cr: GATEWAY, con: observation() } });
  // Then
  assert.equal(panic.incident.kind, 'SAFETY');
  assert.equal(panic.incident.severity, 'HIGH');
  assert.deepEqual(panic.incident.proposal.deviceIds, ['keyring-A', 'keyring-B']);
  assert.equal(panic.incident.incidentId, incidentFor({ ...context, stream: 'button', cin: { ri: 'b1', cr: GATEWAY, con: observation({ buttonState: 'panic' }) } }).incident.incidentId, 'idempotent id per source resource');
  assert.equal(battery.incident.kind, 'MAINTENANCE');
  assert.equal(forged.incident, null);
  assert.equal(forged.reason, 'unexpected-creator');
  assert.equal(released.reason, 'no-trigger');
});

test('ACP plan keeps raw observation from guardian and automation and never grants UPDATE or DELETE to apps', () => {
  // Given
  const plan = acpPlan({ gateway: 'G', operator: 'O', guardian: 'U', automation: 'A' });
  const mask = (acp, who) => plan[acp].find(([originator]) => originator === who)?.[1] ?? 0;
  // When / Then
  assert.equal(mask('acp-observation', 'U'), 0);
  assert.equal(mask('acp-observation', 'A'), 0);
  assert.equal(mask('acp-command', 'A'), 0);
  for (const [acp, rules] of Object.entries(plan)) {
    for (const [originator, acop] of rules) if (originator !== 'G') assert.equal(acop & (ACOP.U | ACOP.D), 0, `${acp}:${originator}`);
  }
  for (const [app, streams] of Object.entries(APP_STREAMS)) {
    const who = { operator: 'O', guardian: 'U', automation: 'A' }[app];
    for (const stream of streams) assert.equal(mask(STREAM_ACP[stream], who) & (ACOP.C | ACOP.R), ACOP.C | ACOP.R, `${app} can subscribe to ${stream}`);
  }
});

test('oneM2M timestamps, structured IDs and payload hash stay compatible with the central approval hash', () => {
  // Given
  const command = { version: 1, gatewayId: 'pi-01', deviceId: 'keyring-A', commandId: 'portal-1', claimId: 'claim-1', desiredState: { state: true }, issuedAt: '2026-11-19T01:00:00.000Z', deadline: '2026-11-19T01:05:00.000Z', grantRevision: 1, ownershipEpoch: 0 };
  // When / Then
  assert.equal(toOneM2mTime('2026-11-19T01:02:03.999Z'), '20261119T010203');
  assert.equal(fromOneM2mTime('20261119T010203'), '2026-11-19T01:02:03.000Z');
  assert.equal(normalizeSid('/multiapp-cse/Mobius/pb-gateway-pi-01/keyring-A/command/sub-gateway'), '/Mobius/pb-gateway-pi-01/keyring-A/command/sub-gateway');
  assert.equal(payloadHash(command), approvalHash(command));
  assert.equal(payloadHash({ b: 1, a: { d: 2, c: 3 } }), payloadHash({ a: { c: 3, d: 2 }, b: 1 }));
});
