import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const contractPath = fileURLToPath(new URL('../contracts/oneM2M-test-contract.v1.json', import.meta.url));
const gatewayPath = fileURLToPath(new URL('../contracts/raspberrypi-gateway.v1.json', import.meta.url));
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const gateway = JSON.parse(await readFile(gatewayPath, 'utf8'));

test('oneM2M contract keeps the CORE ownership and release headers', () => {
  assert.equal(contract.owner, 'PC-MOBIUS-CORE');
  assert.equal(contract.cse.releaseVersionIndicator, '4');
  assert.deepEqual(Object.keys(contract.headers).sort(), ['X-M2M-Origin', 'X-M2M-RI', 'X-M2M-RVI'].sort());
  assert.equal(Object.keys(contract.steps[1].body)[0], 'pb:binarySwitch');
  assert.equal(contract.steps.length, 6);
});

test('oneM2M flow covers resource creation, state update, retrieve, subscription and group', () => {
  assert.deepEqual(contract.steps.map((step) => step.id), [
    'create-ae', 'create-state', 'create-subscription', 'update-state', 'discover-state', 'group-fanout'
  ]);
  assert.ok(contract.steps.every((step) => [200, 201, 204].includes(step.expectedResponseStatus)));
});

test('Raspberry Pi Gateway contract binds BLE, MQTT, HTTPS and oneM2M mapping', () => {
  assert.equal(gateway.owner, 'KEYRING');
  assert.equal(gateway.reviewOwner, 'PC-MOBIUS-CORE');
  assert.equal(gateway.device.transportIn, 'BLE GATT');
  assert.deepEqual(gateway.device.transportOut, ['MQTT', 'HTTPS']);
  assert.equal(gateway.processing.oneM2MMapping, '/Mobius/privacy-bubble-test-ae/bubbleState');
  assert.ok(gateway.processing.ackStates.includes('READBACK_VERIFIED'));
});
