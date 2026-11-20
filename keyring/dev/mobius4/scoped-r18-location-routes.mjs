// Additional operator routes for the explicit loopback r18 location trial.
export const locationTrialPurpose = 'r18-scoped-location-trial';

export function permitsLocationTrial(request, path, { operatorId, subjectId, deviceId, store }) {
  if (request.principal.principalId !== operatorId) return false;
  const { method, body = {} } = request;
  if (method === 'GET') return ['/v1/portal/location-access', '/v1/portal/locations'].includes(path);
  if (method !== 'POST' || !body || typeof body !== 'object') return false;

  const trialIncident = (incidentId) => {
    const incident = store.get('portalIncidents', incidentId);
    return incident?.householdId === subjectId && incident.deviceId === deviceId
      && incident.createdBy === operatorId && incident.kind === 'SAFETY' && incident.message === locationTrialPurpose;
  };
  if (path === '/v1/portal/incidents') {
    return body.householdId === subjectId && body.deviceId === deviceId
      && body.kind === 'SAFETY' && body.message === locationTrialPurpose;
  }
  if (path === '/v1/portal/incidents/resolve') return trialIncident(body.incidentId);
  if (path === '/v1/portal/consents/revoke') {
    const consent = store.get('consents', body.consentId);
    return consent?.subjectId === subjectId && consent.principalId === operatorId
      && consent.purpose === locationTrialPurpose && isExactList(consent.scopes, 'location:read');
  }
  if (path === '/v1/portal/location-leases') {
    const grant = store.get('grants', body.grantId);
    return body.recipientId === operatorId && isExactList(body.deviceIds, deviceId)
      && body.purpose === locationTrialPurpose && trialIncident(body.incidentId)
      && Number.isInteger(body.ttlSec) && body.ttlSec >= 1 && body.ttlSec <= 60
      && grant?.subjectId === subjectId && grant.principalId === operatorId
      && grant.purpose === locationTrialPurpose && isExactList(grant.scopes, 'location:read');
  }
  if (path === '/v1/portal/location-leases/revoke') {
    const lease = store.get('locationLeases', body.leaseId);
    return lease?.householdId === subjectId && lease.recipientId === operatorId
      && isExactList(lease.deviceIds, deviceId) && lease.purpose === locationTrialPurpose && trialIncident(lease.incidentId);
  }
  return false;
}

function isExactList(value, item) {
  return Array.isArray(value) && value.length === 1 && value[0] === item;
}
