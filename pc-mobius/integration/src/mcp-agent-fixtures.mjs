import { createServer } from 'node:http';
import { once } from 'node:events';
import { approvalHash } from './integration-utils.mjs';
import { toolReview } from './mcp-schema.mjs';
import { BINARY_SWITCH_CND } from '../../src/sdt-adapter.mjs';

/**
 * Local ETSI MEC 013 Location simulator (simulation: true). It serves the service-management discovery and the
 * users query that the project MecAdapter calls; the shape follows the vendor fixture of test/mec-http.test.mjs.
 */
export async function startMecLocationSimulator({ users = {}, host = '127.0.0.1', clock = () => new Date().toISOString() } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://simulator');
    requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), at: clock() });
    const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(value === undefined ? undefined : JSON.stringify(value)); };
    if (request.method === 'GET' && url.pathname === '/mec_service_mgmt/v1/services') {
      return reply(200, [{ serName: url.searchParams.get('ser_name'), serInstanceId: 'mec-location-sim-1', state: 'ACTIVE', transportInfo: { endPoint: { uris: [base] } } }]);
    }
    if (request.method === 'GET' && url.pathname === '/location/v2/queries/users') {
      const address = url.searchParams.get('address'); const user = users[address];
      if (!user) return reply(404, { problemDetails: { status: 404, detail: 'unknown UE' } });
      const seconds = Math.floor(Date.parse(clock()) / 1000);
      return reply(200, { userList: { resourceURL: `${base}/location/v2/queries/users`, user: [{ address, accessPointId: user.accessPointId ?? 'ap-sim-1', zoneId: user.zoneId ?? 'zone-sim-1',
        resourceURL: `${base}/location/v2/queries/users?address=${encodeURIComponent(address)}`, timestamp: { seconds, nanoSeconds: 0 },
        locationInfo: { latitude: [user.lat], longitude: [user.lon], shape: 2, accuracy: user.accuracy ?? 15 } }] } });
    }
    return reply(404, { problemDetails: { status: 404 } });
  });
  server.listen(0, host); await once(server, 'listening');
  const base = `http://${host}:${server.address().port}`;
  return { url: base, requests, simulation: true, async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}

/** In-memory oneM2M adapter with the real adapter interface for unit tests (simulation: true). */
export function createFixtureOneM2mAdapter({ householdId = 'household-fixture', devices = [{ deviceId: 'keyring-a', ueAddress: '192.0.2.10', sdtState: true }], visitors = { 'visitor-1': 'Cvisitor-1' }, guardianOriginator = 'Cguardian', clock = () => new Date().toISOString() } = {}) {
  const householdPath = `/Mobius/pb-hh-${householdId}`; const records = new Map(); const acps = new Map(); const acpis = new Map(); let sequence = 0;
  const known = devices.map((device) => ({ deviceId: device.deviceId, resourcePath: `${householdPath}/${device.deviceId}`, sdtPath: `${householdPath}/${device.deviceId}/bubble`, sdtState: device.sdtState ?? true, ueAddress: device.ueAddress,
    paths: { location: `${householdPath}/${device.deviceId}/location`, bubble: `${householdPath}/${device.deviceId}/bubble`, grants: `${householdPath}/${device.deviceId}/grants` } }));
  const write = (path, con) => { if (records.has(path) && approvalHash(records.get(path)) !== approvalHash(con)) throw new Error('fixture immutable record conflict'); records.set(path, structuredClone(con)); return path; };
  return {
    simulation: true, transport: 'FIXTURE', records, acps, acpis,
    async discoverDevices({ householdId: requested }) {
      if (requested !== householdId) throw toolReview('HOUSEHOLD_BINDING', `Adapter is bound to household ${householdId}`);
      return { discovery: { fu: 1, ty: 28, cnd: BINARY_SWITCH_CND, rsc: 2000, matched: known.length }, devices: structuredClone(known), observedAt: clock() };
    },
    async readDeviceAccess(device) {
      const visitorGrants = [...records.entries()].filter(([path, con]) => path.startsWith(`${device.paths.grants}/`) && con.type === 'VISITOR_GRANT').map(([, con]) => ({ visitorId: con.visitorId, notAfter: con.notAfter, acop: con.acop }));
      return { locationAcpi: acpis.get(device.paths.location) ?? ['acp-household'], visitorGrants };
    },
    visitorOriginator(visitorId) { if (!visitors[visitorId]) throw toolReview('VISITOR_REGISTRY', `Visitor ${visitorId} is not registered`); return visitors[visitorId]; },
    async publishApprovalRequest(request) { const con = { type: 'APPROVAL_REQUEST', ...request }; return { path: write(`${householdPath}/approvals/${request.approvalRequestId}`, con), payloadHash: approvalHash(con) }; },
    async applyVisitorAccess({ device, policy, draftHash, approval, notAfter }) {
      const tag = approval.approvalHash.slice(0, 16); const acpRi = `acp-visit-${tag}`;
      acps.set(acpRi, { rn: `visit-${tag}`, pv: { acr: [{ acor: [policy.visitorOriginator], acop: policy.acop }] }, pvs: { acr: [{ acor: [guardianOriginator], acop: 63 }] }, notAfter });
      const acpi = [...new Set([...(acpis.get(policy.resourcePath) ?? ['acp-household']), acpRi])]; acpis.set(policy.resourcePath, acpi);
      const con = { type: 'VISITOR_GRANT', runId: policy.runId, grantId: policy.grantId, grantRevision: policy.grantRevision, deviceId: device.deviceId, visitorId: policy.visitorId, visitorOriginator: policy.visitorOriginator,
        incidentId: policy.incidentId, resource: policy.resource, resourcePath: policy.resourcePath, operations: policy.operations, acop: policy.acop, notAfter, deadline: notAfter, draftHash, approvalRequestId: approval.approvalRequestId, approvalHash: approval.approvalHash, acpRi };
      const payloadHash = approvalHash(con);
      return { acpPath: `${householdPath}/visit-${tag}`, acpRi, grantRecordPath: write(`${device.paths.grants}/grant-${tag}`, { ...con, payloadHash }), payloadHash, acpi };
    },
    async publishLocation(device, sample) { const payloadHash = approvalHash(sample); const path = `${device.paths.location}/cin-${++sequence}`; records.set(path, { ...sample, payloadHash }); return { path, payloadHash }; },
    async publishEvidence({ evidenceId, evidence, evidenceHash, summary }) { const path = `${householdPath}/audit/${evidenceId}`; if (!records.has(path)) records.set(path, { type: 'MCP_AGENT_EVIDENCE', evidenceId, evidence, evidenceHash, summary }); return { path }; },
  };
}

export function createFixtureMecAdapter({ users = { '192.0.2.10': { lat: 37.5665, lon: 126.978, zoneId: 'zone-fixture' } }, clock = () => new Date().toISOString() } = {}) {
  return {
    simulation: true,
    async locate({ ueAddress }) {
      const user = users[ueAddress]; if (!user) throw toolReview('MEC_LOCATION', 'MEC Location response for the device UE required');
      return { serviceInstanceId: 'mec-fixture', zoneId: user.zoneId, point: { lat: user.lat, lon: user.lon }, accuracyM: 15, observedAt: clock(), source: 'FIXTURE', simulation: true };
    },
  };
}
