import { randomUUID } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createNativeReceiptReader } from '../../../integration-candidate/receipt-native-source.mjs';
import { createCommandReceiptSettlement } from '../../../integration-candidate/receipt-settlement.mjs';
import { scopedCommandReceiptContainers, scopedReceiptCseKey } from '../scoped-command-receipts.mjs';

export async function readJson(path, limit) {
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
  const successful = (status === 200 && rsc === 2000) || (status === 201 && rsc === 2001);
  const body = successful && size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
  return { status, rsc, body };
}

export async function openScopedCseExchange() {
  const profile = new URL('../.local/scoped/', import.meta.url);
  const environment = parseEnv(await readFile(new URL('compose.env', profile), 'utf8'));
  const port = Number(environment.KEYRING_CSE_TLS_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !environment.CSE_ADMIN) {
    throw new Error('SCOPED_CSE_CONFIG_REQUIRED');
  }
  const [ca, cert, key] = await Promise.all(['ca.pem', 'client.pem', 'client.key']
    .map((name) => readFile(new URL(`tls/${name}`, profile))));

  return (path, { method = 'GET', body, ty } = {}) => new Promise((resolveResponse, reject) => {
    const requestId = `kr-settle-${randomUUID()}`;
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const headers = { Accept: 'application/json', 'X-M2M-Origin': environment.CSE_ADMIN,
      'X-M2M-RVI': '4', 'X-M2M-RI': requestId };
    if (encoded) Object.assign(headers, { 'Content-Type': `application/json;ty=${ty}`, 'Content-Length': encoded.length });
    const request = httpsRequest({ hostname: '127.0.0.1', servername: 'localhost', port, path, method, ca, cert, key,
      minVersion: 'TLSv1.3', rejectUnauthorized: true, signal: AbortSignal.timeout(15000),
      headers,
    }, (response) => receive(response, requestId).then(resolveResponse, reject));
    request.once('error', reject);
    request.end(encoded);
  });
}

export async function loadScopedReceiptContext({ teamRoot, state }) {
  const utility = resolve(teamRoot, 'pc-mobius/integration/src/integration-utils.mjs');
  const schemaUrl = new URL('../../../../contracts/keyring/receipt.schema.json', import.meta.url);
  const [{ approvalHash }, schema, retrieve] = await Promise.all([
    import(pathToFileURL(utility).href), readJson(schemaUrl, 65536), openScopedCseExchange(),
  ]);
  if (typeof approvalHash !== 'function') throw new Error('INVALID_TEAM_HASH_ADAPTER');
  const validateNativeReceipt = addFormats(new Ajv2020()).compile(schema);
  const readNativeReceipt = createNativeReceiptReader({ receiptContainers: scopedCommandReceiptContainers, retrieve });

  async function readSnapshot() {
    // IntegrationStore publishes by atomic rename. One opened file is one revision.
    const { gatewayCommands = {}, receipts } = await readJson(state, 16 * 1024 * 1024) ?? {};
    if (!gatewayCommands || typeof gatewayCommands !== 'object' || Array.isArray(gatewayCommands) || !Array.isArray(receipts)) {
      throw new Error('INVALID_TEAM_STATE');
    }
    return { gatewayCommands, receipts };
  }

  function settleForSnapshot({ gatewayCommands, receipts }, commitIfAbsent) {
    return createCommandReceiptSettlement({ cseKey: scopedReceiptCseKey, readNativeReceipt, validateNativeReceipt,
      readIssuedCommand: (commandId) => Object.hasOwn(gatewayCommands, commandId) ? gatewayCommands[commandId] : null,
      readAuthorizationHistory: (commandId) => receipts.filter((record) => record?.commandId === commandId),
      hashPayload: approvalHash, commitIfAbsent,
    });
  }

  return { readSnapshot, readNativeReceipt, hashPayload: approvalHash, settleForSnapshot };
}
