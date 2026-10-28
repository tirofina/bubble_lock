import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultContractPath = fileURLToPath(new URL('../contracts/oneM2M-test-contract.v1.json', import.meta.url));
const defaultReceiptDir = fileURLToPath(new URL('../receipts', import.meta.url));
const positionalArg = process.argv.slice(2).find((argument) => !argument.startsWith('--'));
const contractPath = resolve(positionalArg ?? defaultContractPath);
const contract = JSON.parse(await readFile(contractPath, 'utf8'));
const dryRun = process.argv.includes('--dry-run');
const baseUrl = (process.env.MOBIUS4_URL ?? contract.cse.httpBase).replace(/\/$/, '');
const originator = process.env.MOBIUS4_ORIGINATOR ?? contract.headers['X-M2M-Origin'];
const rvi = process.env.MOBIUS4_RVI ?? contract.headers['X-M2M-RVI'];
const receiptDir = resolve(process.env.MOBIUS4_RECEIPT_DIR ?? defaultReceiptDir);
await mkdir(receiptDir, { recursive: true });

const resolvePath = (path) => path ? `${baseUrl}${path}` : baseUrl;
const receipts = [];
for (const [index, step] of contract.steps.entries()) {
  const requestId = `${contract.contractId}-${Date.now()}-${index + 1}`;
  const headers = {
    Accept: 'application/json',
    'X-M2M-RVI': rvi,
    'X-M2M-Origin': originator,
    'X-M2M-RI': requestId
  };
  if (step.contentFormat) headers['Content-Type'] = step.contentFormat;
  const startedAt = new Date().toISOString();
  const response = dryRun
    ? {
      status: step.expectedResponseStatus,
      text: async () => JSON.stringify({ dryRun: true, stepId: step.id }),
      headers: new Headers({ 'X-M2M-RSC': String(step.expectedResponseStatus), 'X-M2M-RI': requestId })
    }
    : await fetch(resolvePath(step.path), {
      method: step.operation === 'RETRIEVE' ? 'GET' : step.operation === 'UPDATE' ? 'PUT' : 'POST',
      headers,
      body: step.body ? JSON.stringify(step.body) : undefined
    });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* text receipt remains useful */ }
  const status = response.status === step.expectedResponseStatus ? 'PASS' : 'REVIEW';
  receipts.push({
    contractId: contract.contractId,
    contractVersion: contract.contractVersion,
    stepId: step.id,
    requestId,
    requestMethod: step.operation === 'RETRIEVE' ? 'GET' : step.operation === 'UPDATE' ? 'PUT' : 'POST',
    requestUrl: resolvePath(step.path),
    startedAt,
    timestamp: new Date().toISOString(),
    status,
    responseStatus: response.status,
    expectedResponseStatus: step.expectedResponseStatus,
    responseHeaders: Object.fromEntries(['x-m2m-rsc', 'x-m2m-ri', 'x-m2m-rvi'].map((key) => [key, response.headers.get(key)]).filter(([, value]) => value)),
    responseBody: body,
    mode: dryRun ? 'dry-run' : 'mobius4-http'
  });
  console.log(JSON.stringify(receipts.at(-1)));
}
const output = resolve(receiptDir, `contract-${Date.now()}.json`);
await writeFile(output, `${JSON.stringify({ contract, receipts }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ status: 'COMPLETE', receipt: output, steps: receipts.length }));
