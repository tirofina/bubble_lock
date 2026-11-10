import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export class IntegrationStore {
  constructor(path = null, { receiptJournal = null } = {}) {
    this.path = path;
    this.receiptJournal = receiptJournal;
    this.data = { consents: {}, grants: {}, policies: {}, events: {}, handovers: {}, flRounds: {}, mcpRuns: {}, receipts: [] };
    this.initialized = false;
    this.writeQueue = Promise.resolve();
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

  async flush() {
    if (!this.path) return;
    const snapshot = `${JSON.stringify(this.data, null, 2)}\n`;
    const write = this.writeQueue.then(async () => {
      const temporary = `${this.path}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try {
          await handle.writeFile(snapshot, 'utf8');
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, this.path);
      } finally { await rm(temporary, { force: true }); }
    });
    this.writeQueue = write.catch(() => {});
    await write;
  }

  collection(name) {
    if (!this.data[name]) this.data[name] = {};
    return this.data[name];
  }

  async put(collection, id, value) {
    await this.init();
    this.collection(collection)[id] = value;
    await this.flush();
    return value;
  }

  async append(collection, value) {
    await this.init();
    if (!Array.isArray(this.data[collection])) this.data[collection] = [];
    this.data[collection].push(value);
    await this.flush();
    if (collection === 'receipts' && this.receiptJournal) await this.receiptJournal.append(value);
    return value;
  }

  get(collection, id) {
    return this.collection(collection)[id];
  }

  list(collection) {
    const value = this.data[collection];
    return Array.isArray(value) ? [...value] : Object.values(value ?? {});
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.data));
  }
}
