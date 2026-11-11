import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { loadMecDeploymentSchema, mecOperation } from '../integration/src/mec-deployment-schema.mjs';

test('JSON 배포 manifest는 OpenAPI hash·callback ref·실제 method/path를 검증한다', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mec-deployment-')); const file = join(directory, 'openapi.json');
  const document = { openapi: '3.1.0', info: { title: 'Local test vendor', version: '1' }, paths: {
    '/queries/users': { get: { operationId: 'query' } }, '/subscriptions/userTracking': { post: { operationId: 'create' } },
    '/subscriptions/userTracking/{id}': { get: { operationId: 'read' }, delete: { operationId: 'delete' } },
  }, components: { schemas: { Notification: { type: 'object', required: ['eventId', 'location'], additionalProperties: false, properties: { eventId: { type: 'string' }, location: { $ref: '#/components/schemas/Location' } } }, Location: { type: 'object', required: ['lat'], additionalProperties: false, properties: { lat: { type: 'number', minimum: -90, maximum: 90 } } } } } };
  const bytes = Buffer.from(JSON.stringify(document)); await writeFile(file, bytes);
  const options = { deploymentSchema: { file, sha256: createHash('sha256').update(bytes).digest('hex'), callbackPointer: '#/components/schemas/Notification', operations: { query: 'query', create: 'create', read: 'read', delete: 'delete' } } };
  const loaded = await loadMecDeploymentSchema(options);
  assert.equal(loaded.capabilities.validateCallback({ eventId: 'one', location: { lat: 37.5 } }), true);
  assert.equal(loaded.capabilities.validateCallback({ eventId: 'one', location: { lat: 91 } }), false);
  assert.equal(mecOperation(loaded.capabilities, 'DELETE', 'https://example.test/location/v2/subscriptions/userTracking/one'), 'delete');
  assert.throws(() => mecOperation(loaded.capabilities, 'POST', 'https://example.test/unexpected'), /MEC_OPERATION_PATH/);
  await assert.rejects(loadMecDeploymentSchema({ ...options, deploymentSchema: { ...options.deploymentSchema, sha256: '0'.repeat(64) } }), /MEC_SCHEMA_HASH/);
  await assert.rejects(loadMecDeploymentSchema({ ...options, deploymentSchema: { ...options.deploymentSchema, operations: { ...options.deploymentSchema.operations, create: 'delete' } } }), /MEC_OPERATION_ID/);
});
