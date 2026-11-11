import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindAppliedReceipt } from '../../integration-candidate/receipt-binding.mjs';

const team = process.argv[2];
const teamImport = (path) => import(pathToFileURL(resolve(team, path)).href);
const { GatewayBridge } = await teamImport('pc-mobius/src/gateway-bridge.mjs');
const { approvalHash } = await teamImport('pc-mobius/integration/src/integration-utils.mjs');
const { command, authorization, receipt, ack } = JSON.parse(readFileSync(0, 'utf8'));
const payloadHash = approvalHash(command);
assert.equal(payloadHash, receipt.payloadHash);
const args = { trustedGatewayId: command.gatewayId, commandRecord: { command, payloadHash },
  authorization, receipt, ack };
assert.equal(bindAppliedReceipt(args).readbackState, command.desiredState.state);
assert.equal(bindAppliedReceipt({ ...args, ack: undefined }).commandId, command.commandId);
const forgedHashAck = { ...ack, payloadHash: '0'.repeat(64) };
const rejected = [
  [{ ...args, trustedGatewayId: 'other-gateway' }, /ISSUED_COMMAND_BINDING/],
  [{ ...args, receipt: { ...receipt, grantRevision: command.grantRevision + 1 } }, /ISSUED_COMMAND_BINDING/],
  [{ ...args, authorization: { ...authorization, allowed: false } }, /AUTHORIZATION_BINDING/],
  [{ ...args, authorization: { ...authorization, claimId: 'other-claim' } }, /AUTHORIZATION_BINDING/],
  [{ ...args, receipt: { ...receipt, readback: { state: !command.desiredState.state } } }, /APPLIED_READBACK_BINDING/],
  [{ ...args, ack: forgedHashAck }, /CORE_ACK_BINDING/],
  [{ ...args, ack: { ...ack, gatewayReceipt: { ...receipt, payloadHash: '0'.repeat(64) } } }, /CORE_ACK_BINDING/],
];
for (const [input, reason] of rejected) assert.throws(() => bindAppliedReceipt(input), reason);

const bridge = new GatewayBridge({ mqttClient: { publish: async () => {} }, gatewayId: command.gatewayId });
const beforeRegistration = await bridge.handleAck(ack);
assert.equal(beforeRegistration.status, 'REVIEW');
assert.equal(beforeRegistration.reason, 'ack-command-binding');
await bridge.sendCommand(command); // Only the bridge's in-memory registration; MQTT is stubbed.
const wrongHash = await bridge.handleAck(forgedHashAck);
assert.equal(wrongHash.status, 'ACK_RECORDED');

console.log(JSON.stringify({ hashesMatchAcrossRuntimes: true,
  upstreamHttpIssuedAck: beforeRegistration.status, upstreamRegisteredWrongHashAck: wrongHash.status,
  candidateValidCases: 2, candidateRejectedCases: rejected.length }));
