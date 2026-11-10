/**
 * Additional authorization gate for a device managed by handover.
 * gatewayByEdge is trusted deployment configuration with one gateway ID per edge.
 * gateway and handover come from central enrollment and the handover coordinator.
 */
export function matchesHandoverOwner({ command, gateway, handover, gatewayByEdge }) {
  if (!command || !gateway?.devices || !handover || !(gatewayByEdge instanceof Map)
      || !['ACTIVE', 'ROLLED_BACK'].includes(handover.state)
      || handover.ueId !== command.deviceId || !Object.hasOwn(gateway.devices, command.deviceId)
      || !Number.isInteger(handover.epoch) || handover.epoch < 0 || handover.epoch > 2147483647
      || handover.epoch !== command.ownershipEpoch) {
    return false;
  }
  const owner = gatewayByEdge.get(handover.edgeId);
  return typeof owner === 'string' && owner.length > 0
    && owner === gateway.gatewayId && owner === command.gatewayId;
}
