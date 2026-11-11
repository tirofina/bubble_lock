import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function pointer(document, path) {
  if (typeof path !== 'string' || !path.startsWith('#/')) throw Error('MEC_SCHEMA_POINTER');
  let result = document;
  for (const part of path.slice(2).split('/').map((value) => value.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!object(result) || !Object.hasOwn(result, part)) throw Error('MEC_SCHEMA_POINTER');
    result = result[part];
  }
  if (!object(result)) throw Error('MEC_CALLBACK_SCHEMA'); return result;
}
function localReferences(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.$ref === 'string' && !value.$ref.startsWith('#/')) throw Error('MEC_EXTERNAL_SCHEMA_REFERENCE');
  for (const item of Object.values(value)) localReferences(item);
}

/** 배포 OpenAPI JSON의 고정 hash·operationId·callback schema를 실행 validator로 연결한다. */
export async function loadMecDeploymentSchema(options, baseDirectory = process.cwd()) {
  if (!options?.deploymentSchema) return options;
  const { file, sha256, callbackPointer, operations } = options.deploymentSchema;
  if (!/^[a-f0-9]{64}$/.test(sha256) || !object(operations)) throw Error('MEC_DEPLOYMENT_SCHEMA_CONFIG');
  const handle = await open(resolve(baseDirectory, file), 'r'); let bytes;
  try { if ((await handle.stat()).size > 4 * 1024 * 1024) throw Error('MEC_SCHEMA_SIZE'); bytes = await handle.readFile(); }
  finally { await handle.close(); }
  if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw Error('MEC_SCHEMA_HASH');
  const document = JSON.parse(bytes.toString('utf8'));
  if (!(typeof document.openapi === 'string' && /^3\.[01]\./.test(document.openapi)) && document.swagger !== '2.0') throw Error('MEC_OPENAPI_VERSION');
  const schema = pointer(document, callbackPointer); localReferences(document);
  const expectedMethods = { query: 'get', create: 'post', read: 'get', delete: 'delete', ...(options.capabilities?.update ? { update: 'put' } : {}), ...(options.capabilities?.list ? { list: 'get' } : {}) };
  const operationIds = [];
  for (const [action, method] of Object.entries(expectedMethods)) {
    const operationId = operations[action]; const matches = [];
    for (const [path, methods] of Object.entries(document.paths ?? {})) for (const [verb, entry] of Object.entries(methods)) {
      if (object(entry) && entry.operationId === operationId) matches.push({ method: verb.toUpperCase(), path, operationId, action });
    }
    if (typeof operationId !== 'string' || matches.length !== 1 || matches[0].method !== method.toUpperCase()) throw Error('MEC_OPERATION_ID');
    operationIds.push(matches[0]);
  }
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true }); addFormats(ajv);
  const validator = ajv.compile({ ...document, ...schema, $schema: 'https://json-schema.org/draft/2020-12/schema' });
  return { ...options, capabilities: { ...options.capabilities, deploymentVerified: true, schemaHash: sha256, openapiVersion: document.openapi ?? document.swagger,
    callbackSchemaPointer: callbackPointer, operationIds, validateCallback: (payload) => validator(payload) === true } };
}

export function mecOperation(capabilities, method, url) {
  if (!capabilities.operationIds) return null;
  const path = new URL(url).pathname;
  const match = capabilities.operationIds.find((entry) => entry.method === method && new RegExp(`${entry.path.split(/(\{[^}]+\})/).map((part) => part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('')}$`).test(path));
  if (!match) throw Error('MEC_OPERATION_PATH'); return match.operationId;
}
