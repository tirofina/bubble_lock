import { createIntegrationRuntime } from './integration-runtime.mjs';

const guardianScopes = ['portal:read', 'household:write', 'device:write', 'consent:write', 'grant:write', 'grant:revoke', 'command:request', 'bubble:command', 'incident:write', 'incident:resolve'];

/** 로컬 시연용 별도 저장소이며 명령은 데모 Gateway 큐에 보관합니다. */
export async function createPortalDemo({ statePath = null, clock = () => new Date().toISOString(), core = {} } = {}) {
  const runtime = await createIntegrationRuntime({ statePath, clock, core });
  const principals = {
    guardian: { principalId: 'guardian-demo', scopes: guardianScopes, simulation: true },
    visitor: { principalId: 'visitor-demo', scopes: ['portal:read', 'command:request', 'incident:write'], simulation: true },
    operator: { principalId: 'operator-demo', scopes: ['portal:read', 'device:enroll'], simulation: true },
  };
  await runtime.portalService.provisionHousehold({ householdId: 'household-demo', name: 'Our family', ownerId: principals.guardian.principalId,
    members: [{ principalId: principals.visitor.principalId, role: 'visitor' }, { principalId: principals.operator.principalId, role: 'visitor' }] });
  await runtime.gatewayControl.enroll({ gatewayId: 'pi-01', principalId: 'gateway-demo', fingerprint: 'DEMO-ONLY-NO-TRANSPORT', credentialRevision: 'demo-1', ownershipEpoch: 0,
    devices: { 'keyring-A': 'household-demo', 'keyring-B': 'household-demo', 'keyring-C': 'household-demo' } });
  for (const [deviceId, label] of [['keyring-A', 'Keyring A'], ['keyring-B', 'Keyring B'], ['keyring-C', 'Keyring C']]) {
    await runtime.portalService.registerDevice(principals.guardian, { householdId: 'household-demo', deviceId, gatewayId: 'pi-01', label, idempotencyKey: `seed-${deviceId}` });
  }
  if(runtime.locationPrivacy.deviceIds(principals.guardian).length===0){
    const purpose='Location check for a simulated safety incident';
    const consent=await runtime.policyService.createConsent({principal:principals.guardian,subjectId:'household-demo',purpose,scopes:['location:read'],ttlSec:900});
    const grant=await runtime.policyService.createGrant({principal:principals.guardian,consentId:consent.consentId,purpose,scopes:['location:read'],ttlSec:900});
    const incident=await runtime.portalService.createIncident(principals.guardian,{householdId:'household-demo',kind:'SAFETY',message:'Simulated safety incident for the map demo',idempotencyKey:`map-incident-${grant.grantId}`});
    await runtime.locationPrivacy.createLease(principals.guardian,{grantId:grant.grantId,recipientId:principals.guardian.principalId,deviceIds:['keyring-A','keyring-B','keyring-C'],purpose,incidentId:incident.incidentId,ttlSec:300,idempotencyKey:`map-lease-${grant.grantId}`});
  }
  return { runtime, principals };
}
