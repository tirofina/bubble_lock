import assert from 'node:assert/strict';
import { deliver, loadSdtProbe } from './core_sdt_fixture.mjs';

const { bridge, input: { paths, projections } } = await loadSdtProbe();

for (const [index, order] of [projections.slice().reverse(), projections].entries()) {
  const gatewayId = index ? 'gw-test' : 'gw-baseline';
  const instance = bridge(paths[index], gatewayId);
  for (const projection of order) {
    const receipt = await deliver(instance, { ...projection, gatewayId });
    assert.equal(receipt.status, 'APPLIED');
  }
}
