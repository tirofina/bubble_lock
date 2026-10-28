import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const inputIndex = process.argv.indexOf('--input');
if (inputIndex < 0 || !process.argv[inputIndex + 1]) throw new Error('Replay input uses --input <receipt.json>');
const inputPath = resolve(process.argv[inputIndex + 1]);
const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
const receipts = Array.isArray(parsed) ? parsed : parsed.receipts ?? [parsed];
const requestIds = receipts.map((receipt) => receipt.requestId).filter(Boolean);
const uniqueRequestIds = new Set(requestIds);
console.log(JSON.stringify({
  status: 'REPLAY_READY',
  inputPath,
  contractId: parsed.contract?.contractId ?? receipts[0]?.contractId ?? 'unknown',
  receiptCount: receipts.length,
  requestCount: requestIds.length,
  uniqueRequestCount: uniqueRequestIds.size,
  statuses: [...new Set(receipts.map((receipt) => receipt.status).filter(Boolean))]
}, null, 2));
