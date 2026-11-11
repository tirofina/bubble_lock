import { appendFile, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

const queues = new Map();
function serialized(path, operation) {
  const key = resolve(path); const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.then(operation); const settled = next.catch(() => {}); queues.set(key, settled);
  settled.finally(() => { if (queues.get(key) === settled) queues.delete(key); }); return next;
}

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
    await serialized(this.path, async () => { await mkdir(dirname(this.path), { recursive: true }); await appendFile(this.path, `${JSON.stringify(record)}\n`, 'utf8'); });
    return record;
  }

  async prune(expired) {
    return serialized(this.path, async () => {
      let contents; try { contents = await readFile(this.path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return { removed: 0 }; throw error; }
      const rows = contents.split('\n').filter(Boolean).map((line) => { try { return { line, record: JSON.parse(line) }; } catch { throw new Error('JOURNAL_RETENTION_FORMAT'); } });
      const kept = rows.filter(({ record }) => !expired(record)); const removed = rows.length - kept.length;
      if (removed) {
        const temporary = `${this.path}.${randomUUID()}.retention.tmp`;
        try { await writeFile(temporary, kept.map(({ line }) => `${line}\n`).join(''), { encoding: 'utf8', mode: 0o600 }); await rename(temporary, this.path); }
        finally { await rm(temporary, { force: true }); }
      }
      return { removed, remaining: kept.length };
    });
  }
}

export { hashReceipt };
