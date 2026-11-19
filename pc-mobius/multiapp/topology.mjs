/**
 * Shared oneM2M resource layout for the R03 multi-application scenario (DOC-REV 2.0.0).
 *
 * /Mobius/<gatewayRn>/<deviceId>             cnt, lbl pb-keyring + device/gateway/household
 *   observation  cnt mni=100                 periodic keyring observation (operator only)
 *   button       cnt mni=20                  button press events (operator, guardian, automation)
 *   battery      cnt mni=20                  battery readings (operator, guardian, automation)
 *   command      cnt mni=20 mia=900          command bundles written by the guardian AE via <group>/fopt
 *   receipt      cnt mni=50                  Gateway dispatch records and native keyring receipts
 *   switch       cod:binSh (TS-0023)         confirmed device state (readback)
 * /Mobius/<automationRn>/incidents           cnt mni=50 mia=86400, incident cin et=+1h
 */
export const STREAMS = Object.freeze(['observation', 'button', 'battery', 'command', 'receipt']);
export const BINARY_SWITCH_CND = 'org.onem2m.common.moduleclass.binarySwitch';
export const LABELS = Object.freeze({
  keyring: 'pb-keyring',
  incidents: 'pb-incidents',
  sdt: 'pb-sdt-binarySwitch',
  stream: (stream) => `pb-stream-${stream}`,
  device: (deviceId) => `pb-device-${deviceId}`,
  gateway: (gatewayId) => `pb-gateway-${gatewayId}`,
  household: (householdId) => `pb-household-${householdId}`,
});
export const CONTAINER_POLICY = Object.freeze({
  observation: { mni: 100, mbs: 262144 },
  button: { mni: 20 },
  battery: { mni: 20 },
  command: { mni: 20, mia: 900 },
  receipt: { mni: 50 },
});
export const COMMAND_BUNDLE_TYPE = 'privacy-bubble.command-bundle';
export const DISPATCH_RECORD_TYPE = 'privacy-bubble.gateway-dispatch';
export const INCIDENT_TYPE = 'privacy-bubble.automation-incident';

/** acop bits: CREATE 1, RETRIEVE 2, UPDATE 4, DELETE 8, NOTIFY 16, DISCOVERY 32. */
export const ACOP = Object.freeze({ C: 1, R: 2, U: 4, D: 8, N: 16, DISC: 32, ALL: 63 });

/**
 * Least-privilege ACP plan. Mobius4 4.24.5 evaluates <subscription> creation as CREATE on the
 * subscribed-to parent, so every subscriber needs C+R+DISC (35) on the resource it watches.
 * The remaining writer risk is closed by the creator (cr) attribute: every consumer accepts a
 * contentInstance only from its expected writer AE.
 */
export function acpPlan({ gateway, operator, guardian, automation }) {
  const subscribe = ACOP.C + ACOP.R + ACOP.DISC;
  const read = ACOP.R + ACOP.DISC;
  return {
    'acp-root': [[gateway, ACOP.ALL], [operator, read], [guardian, read], [automation, read]],
    'acp-observation': [[gateway, ACOP.ALL], [operator, subscribe]],
    'acp-events': [[gateway, ACOP.ALL], [operator, subscribe], [guardian, subscribe], [automation, subscribe]],
    'acp-command': [[gateway, ACOP.ALL], [operator, subscribe], [guardian, subscribe]],
    'acp-receipt': [[gateway, ACOP.ALL], [operator, subscribe], [guardian, subscribe]],
    'acp-switch': [[gateway, ACOP.ALL], [operator, subscribe], [guardian, subscribe]],
  };
}
export const STREAM_ACP = Object.freeze({ observation: 'acp-observation', button: 'acp-events', battery: 'acp-events', command: 'acp-command', receipt: 'acp-receipt' });

export function acpBody(rn, rules, owner) {
  return { 'm2m:acp': { rn, pv: { acr: rules.map(([acor, acop]) => ({ acor: [acor], acop })) }, pvs: { acr: [{ acor: [owner], acop: ACOP.ALL }] } } };
}

/** Which streams each application subscribes to; guardian never sees raw observation telemetry. */
export const APP_STREAMS = Object.freeze({
  operator: ['observation', 'button', 'battery', 'command', 'receipt'],
  guardian: ['button', 'battery', 'receipt'],
  automation: ['button', 'battery'],
});
