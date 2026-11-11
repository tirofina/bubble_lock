import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncLocalStorage } from 'node:async_hooks';

export class IntegrationStore {
  constructor(path = null, { receiptJournal = null } = {}) {
    this.path = path;
    this.receiptJournal = receiptJournal;
    this.data = { consents: {}, grants: {}, policies: {}, events: {}, handovers: {}, flRounds: {}, mcpRuns: {}, receipts: [] };
    this.initialized = false;
    this.writeQueue = Promise.resolve();
    this.transactionQueue = Promise.resolve();
    this.transactionContext = new AsyncLocalStorage();
  }

  async init() {
    if (this.initialized) return this;
    if (this.path) {
      try {
        this.data = JSON.parse(await readFile(this.path, 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await mkdir(dirname(this.path), { recursive: true });
        await this.flush();
      }
    }
    this.initialized = true;
    return this;
  }

  async flush(data) {
    if (data === undefined && this.transactionContext.getStore()) return;
    data ??= this.data;
    if (!this.path) return;
    const snapshot = `${JSON.stringify(data, null, 2)}\n`;
    const write = this.writeQueue.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(snapshot, 'utf8');
          await handle.sync();
        } finally { await handle.close(); }
        for (let attempt = 0; ; attempt += 1) {
          try { await rename(temporary, this.path); break; }
          catch (error) {
            if (process.platform !== 'win32' || !['EACCES', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
            await delay(10 * 2 ** attempt);
          }
        }
      } finally { await rm(temporary, { force: true }); }
    });
    this.writeQueue = write.catch(() => {});
    await write;
  }

  collection(name) {
    const data = this.transactionContext.getStore()?.data ?? this.data;
    if (!data[name]) data[name] = {};
    return data[name];
  }

  /** 단일 runtime의 쓰기를 직렬화하고 전체 스냅샷을 한 번에 commit합니다. */
  async transaction(lockKey, operation) {
    if (typeof lockKey === 'function') { operation = lockKey; lockKey = 'runtime'; }
    const active = this.transactionContext.getStore();
    if (active) return operation();
    const result = this.transactionQueue.then(async () => {
      await this.init();
      const context = { lockKey, data: structuredClone(this.data), receipts: [] };
      return this.transactionContext.run(context, async () => {
        const value = await operation();
        await this.flush(context.data);
        this.data = context.data;
        for (const receipt of context.receipts) if (this.receiptJournal) await this.receiptJournal.append(receipt);
        return value;
      });
    });
    this.transactionQueue = result.catch(() => {});
    return result;
  }

  async put(collection, id, value) {
    return this.transaction(`${collection}:${id}`, async () => {
      this.collection(collection)[id] = structuredClone(value);
      return value;
    });
  }

  async append(collection, value) {
    return this.transaction(collection, async () => {
      const context = this.transactionContext.getStore();
      if (!Array.isArray(context.data[collection])) context.data[collection] = [];
      context.data[collection].push(structuredClone(value));
      if (collection === 'receipts') context.receipts.push(value);
      return value;
    });
  }

  get(collection, id) {
    return this.collection(collection)[id];
  }

  list(collection) {
    const value = (this.transactionContext.getStore()?.data ?? this.data)[collection];
    return Array.isArray(value) ? [...value] : Object.values(value ?? {});
  }

  snapshot() {
    return structuredClone(this.transactionContext.getStore()?.data ?? this.data);
  }

  stagePut(collection, key, value) { this.collection(collection)[key] = structuredClone(value); return value; }
  async refresh() { await this.init(); return this; }
  async close() { await this.transactionQueue; await this.writeQueue; }
}
