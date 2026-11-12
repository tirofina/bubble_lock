import { OneM2mEdgeClient } from '../pc-mobius/integration/src/handover-cse.mjs';
import { encodeBinarySwitch } from '../pc-mobius/src/sdt-adapter.mjs';
const admin = new OneM2mEdgeClient({ endpoint: 'https://cse:8443', originator: process.env.CSE_ADMIN });
const provider = await admin.ensure('/Mobius', 2, { 'm2m:ae': { rn: 'bubble-household-1', api: 'N.bubble.deployment', rr: true } }, { update: false });
const publisher = await admin.ensure('/Mobius', 2, { 'm2m:ae': { rn: 'bubble-group-publisher', api: 'N.bubble.group', rr: true } }, { update: false });
const gatewayId = process.env.GATEWAY_ID ?? 'gateway-1';
const acp = await admin.ensure(provider.path, 1, { 'm2m:acp': {
  rn: 'deployment-access',
  pv: { acr: [{ acor: [process.env.CSE_ADMIN, publisher.aei], acop: 63 }, { acor: [gatewayId], acop: 2 }] },
  pvs: { acr: [{ acor: [process.env.CSE_ADMIN], acop: 63 }] },
} });
await admin.request('PUT', provider.path, { 'm2m:ae': { acpi: [acp.ri] } });
const members = {};
for (const name of ['A', 'B']) {
  const resource = await admin.ensure(provider.path, 28, encodeBinarySwitch({ rn: `switch-${name}`, state: false, acpi: [acp.ri] }, { operation: 'CREATE' }), { update: false });
  members[`keyring-${name}`] = { deviceId: `keyring-${name}`, gatewayId, groupId: 'household-1', resourcePath: resource.path };
}
const gatewayAcp = await admin.ensure(provider.path, 1, { 'm2m:acp': {
  rn: `${gatewayId}-data-access`,
  pv: { acr: [{ acor: [process.env.CSE_ADMIN], acop: 63 }, { acor: [gatewayId], acop: 3 }] },
  pvs: { acr: [{ acor: [process.env.CSE_ADMIN], acop: 63 }] },
} });
await admin.ensure(provider.path, 3, { 'm2m:cnt': { rn: gatewayId, acpi: [gatewayAcp.ri] } }, { update: false });
for (const rn of ['observations', 'receipts', 'health']) await admin.ensure(`${provider.path}/${gatewayId}`, 3, { 'm2m:cnt': { rn, acpi: [gatewayAcp.ri] } }, { update: false });
console.log(JSON.stringify({ cse: { endpoint: 'https://cse:8443', cseBase: '/Mobius', originator: publisher.aei, parentPath: provider.path }, members }));
