import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

test('사용자 포털의 실제 응답은 snapshot과 canonical command 계약을 함께 만족한다', async () => {
  const [snapshotSchema, commandSchema] = await Promise.all([
    readFile(new URL('../../pc-mobius/contracts/portal.schema.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../../contracts/keyring/command.schema.json', import.meta.url), 'utf8').then(JSON.parse),
  ]);
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  ajv.addSchema(commandSchema);
  const validate = ajv.compile(snapshotSchema);
  const moduleUrl = new URL('../../pc-mobius/integration/src/portal-demo.mjs', import.meta.url).href;
  const { createPortalDemo } = await import(moduleUrl);
  const { runtime, principals } = await createPortalDemo();
  const action = async (role: string, path: string, body: Record<string, unknown>) => {
    const response = await runtime.api.handle({ method: 'POST', path: `/v1/portal/${path}`, principal: principals[role], body });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  };
  const consent = await action('guardian', 'consents', { householdId: 'household-demo', purpose: '가구 보호', scopes: ['bubble:command', 'location:read'], idempotencyKey: 'schema-consent' });
  const grant = await action('guardian', 'grants', { consentId: consent.consentId, scopes: ['bubble:command', 'location:read'], idempotencyKey: 'schema-grant' });
  const requested = await action('visitor', 'commands/request', { householdId: 'household-demo', deviceIds: ['keyring-A'], desiredState: { state: true }, reason: '보호 모드', idempotencyKey: 'schema-command' });
  await action('guardian', 'commands/approve', { requestId: requested.requestId, grantId: grant.grantId, idempotencyKey: 'schema-approve' });
  const incident = await action('visitor', 'incidents', { householdId: 'household-demo', kind: 'HELP', message: '위치 확인', idempotencyKey: 'schema-incident' });
  await action('guardian', 'incidents/resolve', { incidentId: incident.incidentId, idempotencyKey: 'schema-resolve' });
  for (const principal of Object.values(principals)) {
    const snapshot = runtime.portalService.snapshot(principal);
    assert.equal(validate(snapshot), true, JSON.stringify(validate.errors));
  }
  const altered = runtime.portalService.snapshot(principals.guardian);
  altered.commandRequests[0].commands[0].grantRevision = 0;
  assert.equal(validate(altered), false);
});
