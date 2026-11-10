import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { get } from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { commandReceiptName, createNativeReceiptReader } from '../../../integration-candidate/receipt-native-source.mjs';
import { createFileSettlementCommit } from '../../../integration-candidate/receipt-settlement-files.mjs';
import { createCommandReceiptSettlement } from '../../../integration-candidate/receipt-settlement.mjs';
import { scopedCommandReceiptContainers } from '../scoped-command-receipts.mjs';

async function readJson(path, limit) {
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw new Error('INVALID_INPUT_FILE');
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

async function receive(response, requestId) {
  if (response.headers['x-m2m-ri'] !== requestId) {
    response.destroy();
    throw new Error('CSE_RESPONSE_RQI_MISMATCH');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 65536) throw new Error('CSE_RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  const status = response.statusCode;
  const rsc = Number(response.headers['x-m2m-rsc']);
  const body = status === 200 && rsc === 2000 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  return { status, rsc, body };
}

async function scopedRetrieve() {
  const profile = new URL('../.local/scoped/', import.meta.url);
  const environment = parseEnv(await readFile(new URL('compose.env', profile), 'utf8'));
  const port = Number(environment.KEYRING_CSE_TLS_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !environment.CSE_ADMIN) {
    throw new Error('SCOPED_CSE_CONFIG_REQUIRED');
  }
  const [ca, cert, key] = await Promise.all(['ca.pem', 'client.pem', 'client.key']
    .map((name) => readFile(new URL(`tls/${name}`, profile))));

  return (path) => new Promise((resolveResponse, reject) => {
    const requestId = `kr-settle-${randomUUID()}`;
    const request = get({ hostname: '127.0.0.1', servername: 'localhost', port, path, ca, cert, key,
      minVersion: 'TLSv1.3', rejectUnauthorized: true, signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/json', 'X-M2M-Origin': environment.CSE_ADMIN,
        'X-M2M-RVI': '4', 'X-M2M-RI': requestId },
    }, (response) => receive(response, requestId).then(resolveResponse, reject));
    request.once('error', reject);
  });
}

async function main() {
  if (typeof process.getuid !== 'function') throw new Error('POSIX_SETTLEMENT_HOST_REQUIRED');
  const { values } = parseArgs({ options: {
    'team-root': { type: 'string' }, state: { type: 'string' }, ledger: { type: 'string' },
    gateway: { type: 'string' }, command: { type: 'string' }, ack: { type: 'string' },
  } });
  if (!values['team-root'] || !values.state || !values.ledger || !values.gateway || !values.command) {
    throw new Error('REQUIRED_ARGUMENTS_TEAM_ROOT_STATE_LEDGER_GATEWAY_COMMAND');
  }
  if (!Object.hasOwn(scopedCommandReceiptContainers, values.gateway)) throw new Error('UNKNOWN_SCOPED_GATEWAY');
  const nativeRef = `${scopedCommandReceiptContainers[values.gateway]}/${commandReceiptName(values.command)}`;
  const utility = resolve(values['team-root'], 'pc-mobius/integration/src/integration-utils.mjs');
  const schemaUrl = new URL('../../../../contracts/keyring/receipt.schema.json', import.meta.url);
  // IntegrationStore replaces its JSON by rename. Read one snapshot for both lookups.
  const [snapshot, { approvalHash }, schema, ack, retrieve] = await Promise.all([
    readJson(values.state, 16 * 1024 * 1024), import(pathToFileURL(utility).href), readJson(schemaUrl, 65536),
    values.ack ? readJson(values.ack, 65536) : undefined, scopedRetrieve(),
  ]);
  const { gatewayCommands, receipts } = snapshot ?? {};
  if (!gatewayCommands || typeof gatewayCommands !== 'object' || Array.isArray(gatewayCommands)
      || !Array.isArray(receipts) || typeof approvalHash !== 'function') throw new Error('INVALID_TEAM_STATE');
  const validateNativeReceipt = addFormats(new Ajv2020()).compile(schema);
  const settle = createCommandReceiptSettlement({
    readNativeReceipt: createNativeReceiptReader({ receiptContainers: scopedCommandReceiptContainers, retrieve }),
    validateNativeReceipt,
    readIssuedCommand: (commandId) => Object.hasOwn(gatewayCommands, commandId) ? gatewayCommands[commandId] : null,
    readAuthorizationHistory: (commandId) => receipts.filter((record) => record?.commandId === commandId),
    hashPayload: approvalHash,
    commitIfAbsent: createFileSettlementCommit(values.ledger),
  });
  const result = await settle({ nativeRef, ack });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status === 'WAITING_FOR_NATIVE') process.exitCode = 2;
  if (result.status === 'REVIEW') process.exitCode = 3;
}

try {
  await main();
} catch (error) {
  const code = [error.code, error.message].find((value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]+$/.test(value));
  process.stderr.write(`${JSON.stringify({ status: 'ERROR', code: code ?? 'SCOPED_SETTLEMENT_FAILED' })}\n`);
  process.exitCode = 1;
}
