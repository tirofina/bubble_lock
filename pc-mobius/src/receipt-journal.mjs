import { appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

function hashReceipt(receipt) {
  return createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
}

export class ReceiptJournal {
  constructor(path, { clock = () => new Date().toISOString() } = {}) {
    if (!path) throw new Error('ReceiptJournal requires a JSONL path');
    this.path = path;
    this.clock = clock;
  }

  async append(receipt) {
    const record = {
      ...receipt,
      journaledAt: this.clock(),
      receiptHash: hashReceipt(receipt)
    };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }
}

export { hashReceipt };
