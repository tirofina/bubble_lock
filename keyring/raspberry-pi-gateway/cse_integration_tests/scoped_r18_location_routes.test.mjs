import assert from 'node:assert/strict';
import test from 'node:test';
import { locationTrialPurpose as purpose, permitsLocationTrial } from '../../dev/mobius4/scoped-r18-location-routes.mjs';

test('the r18 location routes remain bound to the operator, trial incident and exact device', () => {
  const operatorId = 'operator', subjectId = 'household', deviceId = 'r18';
  const incident = { householdId: subjectId, deviceId, createdBy: operatorId, kind: 'SAFETY', message: purpose };
  const grant = { subjectId, principalId: operatorId, purpose, scopes: ['location:read'] };
  const records = { portalIncidents: { incident }, grants: { grant } };
  const scope = { operatorId, subjectId, deviceId, store: { get: (name, id) => records[name]?.[id] } };
  const lease = { incidentId: 'incident', grantId: 'grant', recipientId: operatorId, deviceIds: [deviceId], purpose, ttlSec: 60 };
  const request = (method, body, principalId = operatorId) => ({ method, body, principal: { principalId } });
  const path = '/v1/portal/location-leases';

  assert.equal(permitsLocationTrial(request('GET'), '/v1/portal/locations', scope), true);
  assert.equal(permitsLocationTrial(request('GET', {}, 'gateway'), '/v1/portal/locations', scope), false);
  assert.equal(permitsLocationTrial(request('POST', lease), path, scope), true);
  for (const bad of [{ ...lease, deviceIds: [deviceId, 'foreign'] }, { ...lease, ttlSec: 61 },
    { ...lease, recipientId: 'other' }, { ...lease, incidentId: 'other' }]) {
    assert.equal(permitsLocationTrial(request('POST', bad), path, scope), false);
  }
  assert.equal(permitsLocationTrial(request('POST', lease), '/v1/portal/relay-associations', scope), false);
  grant.scopes.push('bubble:command');
  assert.equal(permitsLocationTrial(request('POST', lease), path, scope), false);
});
