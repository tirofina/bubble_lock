import { readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import pg from 'pg';
import { IntegrationStore } from './integration-store.mjs';

const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const migrationUrl = new URL('../../db/migrations/003_runtime_transactions.sql', import.meta.url);

/** PostgreSQL namespace row가 정책·claim·model pointer와 outbox의 선형화 경계다. */
export class PostgresIntegrationStore extends IntegrationStore {
  constructor({ connectionString, namespace = 'bubble-lock', pool = null, receiptJournal = null, ssl, lockTimeoutMs = 10000, statementTimeoutMs = 30000, autoDrainJournal = true } = {}) {
    super(null, { receiptJournal });
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(namespace)) throw new Error('POSTGRES_NAMESPACE');
    this.kind = 'postgres'; this.namespace = namespace; this.writerId = `${process.pid}:${randomUUID()}`;
    this.pool = pool ?? new pg.Pool({ connectionString, ssl, max: 4, connectionTimeoutMillis: 5000, application_name: `bubble-runtime-${process.pid}` }); this.ownsPool = !pool;
    this.lockTimeoutMs = lockTimeoutMs; this.statementTimeoutMs = statementTimeoutMs; this.autoDrainJournal = autoDrainJournal;
    this.version = 0; this.staged = new Map(); this.stageSequence = 0; this.initializePromise = null;
  }

  async init() {
    if (this.initialized) return this;
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = (async () => {
      for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN'); await client.query("SELECT pg_advisory_xact_lock(hashtext('privacy-bubble-runtime-schema-v3'))");
        await client.query(await readFile(migrationUrl, 'utf8'));
        await client.query('INSERT INTO privacy_bubble.runtime_state(namespace,state) VALUES($1,$2::jsonb) ON CONFLICT(namespace) DO NOTHING', [this.namespace, JSON.stringify(this.data)]);
        await client.query('COMMIT');
        break;
      } catch (error) {
        await client.query('ROLLBACK');
        if (!['40001', '40P01'].includes(error.code) || attempt >= 4) throw error;
      }
      finally { client.release(); }
      }
      const result = await this.pool.query('SELECT state,version FROM privacy_bubble.runtime_state WHERE namespace=$1', [this.namespace]);
      this.data = result.rows[0].state; this.version = Number(result.rows[0].version); this.initialized = true; return this;
    })();
    try { return await this.initializePromise; } catch (error) { this.initializePromise = null; throw error; }
  }

  stagePut(collection, key, value) {
    const context = this.transactionContext.getStore();
    if (context) { this.collection(collection)[key] = structuredClone(value); return value; }
    const stage = { collection, key, value: structuredClone(value), sequence: ++this.stageSequence };
    this.staged.set(`${collection}:${key}`, stage); this.collection(collection)[key] = structuredClone(value); return value;
  }

  async flush() {
    if (this.transactionContext.getStore()) return;
    if (this.staged.size) await this.transaction('staged-configuration', async () => {});
  }

  async transaction(lockKey, operation) {
    if (typeof lockKey === 'function') { operation = lockKey; lockKey = 'runtime'; }
    if (this.transactionContext.getStore()) return operation();
    const result = this.transactionQueue.then(async () => {
      await this.init(); let value;
      const stages = [...this.staged.values()];
      for (let attempt = 0; ; attempt++) {
      const client = await this.pool.connect(); let context;
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        await client.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)", [`${this.lockTimeoutMs}ms`, `${this.statementTimeoutMs}ms`]);
        const selected = await client.query('SELECT state,version FROM privacy_bubble.runtime_state WHERE namespace=$1 FOR UPDATE', [this.namespace]);
        const dbClock = await client.query('SELECT clock_timestamp() AS db_now');
        const original = selected.rows[0].state; const version = Number(selected.rows[0].version);
        context = { lockKey, data: structuredClone(original), receipts: [], client, version, dbNow: dbClock.rows[0].db_now.toISOString() };
        for (const stage of stages) { context.data[stage.collection] ??= {}; context.data[stage.collection][stage.key] = structuredClone(stage.value); }
        value = await this.transactionContext.run(context, operation);
        if (!equal(original, context.data) || context.receipts.length) {
          await this.project(client, original, context.data);
          const state = JSON.stringify(context.data);
          const updated = await client.query('UPDATE privacy_bubble.runtime_state SET state=$1::jsonb,version=version+1,updated_at=clock_timestamp() WHERE namespace=$2 AND version=$3 RETURNING version', [state, this.namespace, version]);
          if (updated.rowCount !== 1) throw new Error('POSTGRES_STATE_CAS');
          context.version = Number(updated.rows[0].version);
          await client.query('INSERT INTO privacy_bubble.runtime_commit(namespace,version,lock_key,writer_id,state_sha256) VALUES($1,$2,$3,$4,$5)', [this.namespace, context.version, String(lockKey), this.writerId, hash(state)]);
          for (const receipt of context.receipts) await client.query('INSERT INTO privacy_bubble.runtime_receipt_outbox(namespace,receipt_id,receipt) VALUES($1,$2,$3::jsonb) ON CONFLICT(namespace,receipt_id) DO NOTHING', [this.namespace, receipt.eventId ?? hash(receipt), JSON.stringify(receipt)]);
        }
        await client.query('COMMIT');
        this.data = context.data; this.version = context.version;
        for (const stage of stages) if (this.staged.get(`${stage.collection}:${stage.key}`)?.sequence === stage.sequence) this.staged.delete(`${stage.collection}:${stage.key}`);
        for (const stage of this.staged.values()) { this.data[stage.collection] ??= {}; this.data[stage.collection][stage.key] = structuredClone(stage.value); }
        break;
      } catch (error) { await client.query('ROLLBACK'); if (['40001', '40P01'].includes(error.code) && attempt < 4) { this.serializationRetries = (this.serializationRetries ?? 0) + 1; continue; } throw error; }
      finally { client.release(); }
      }
      if (this.autoDrainJournal && this.receiptJournal) {
        try { await this.drainJournal(); this.lastJournalError = null; }
        catch (error) { this.lastJournalError = error.code ?? error.message; }
      }
      return value;
    });
    this.transactionQueue = result.catch(() => {}); return result;
  }

  async project(client, original, data) {
    const changed = (collection) => Object.entries(data[collection] ?? {}).filter(([key, value]) => !equal(original[collection]?.[key], value));
    for (const [, record] of changed('gatewayCommands')) {
      const c = record.command;
      const result = await client.query('INSERT INTO privacy_bubble.runtime_claim(namespace,command_id,member_id,claim_id,grant_revision,ownership_epoch,payload_hash,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(namespace,command_id,member_id) DO UPDATE SET body=EXCLUDED.body WHERE runtime_claim.claim_id=EXCLUDED.claim_id AND runtime_claim.payload_hash=EXCLUDED.payload_hash RETURNING claim_id', [this.namespace, c.commandId, c.deviceId, c.claimId, c.grantRevision, c.ownershipEpoch, record.payloadHash, JSON.stringify(record)]);
      if (result.rowCount !== 1) throw new Error('POSTGRES_CLAIM_CAS');
    }
    for (const [, policy] of changed('policies')) {
      const result = await client.query('INSERT INTO privacy_bubble.runtime_policy(namespace,principal_id,idempotency_key,policy_id,approval_hash,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(namespace,principal_id,idempotency_key) DO UPDATE SET body=EXCLUDED.body WHERE runtime_policy.policy_id=EXCLUDED.policy_id AND runtime_policy.approval_hash=EXCLUDED.approval_hash RETURNING policy_id', [this.namespace, policy.principalId, policy.idempotencyKey, policy.policyId, policy.approvalHash, JSON.stringify(policy)]);
      if (result.rowCount !== 1) throw new Error('POSTGRES_POLICY_CAS');
    }
    for (const [, commit] of changed('flCommits')) {
      const round = data.flRounds[commit.roundId];
      const result = await client.query('INSERT INTO privacy_bubble.runtime_fl_commit(namespace,task_id,round_id,base_model_version,model_hash,manifest_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(namespace,task_id,round_id,base_model_version) DO UPDATE SET model_hash=EXCLUDED.model_hash WHERE runtime_fl_commit.model_hash=EXCLUDED.model_hash AND runtime_fl_commit.manifest_hash=EXCLUDED.manifest_hash RETURNING model_hash', [this.namespace, round.taskId, round.roundId, round.baseModelVersion, commit.modelHash, commit.manifestHash]);
      if (result.rowCount !== 1) throw new Error('POSTGRES_FL_COMMIT_CAS');
    }
    for (const [taskId, task] of changed('flTasks')) {
      const result = await client.query('INSERT INTO privacy_bubble.runtime_model_pointer(namespace,task_id,model_version,serving_generation,coordinator_epoch,consent_policy_revision,state,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(namespace,task_id) DO UPDATE SET model_version=EXCLUDED.model_version,serving_generation=EXCLUDED.serving_generation,coordinator_epoch=EXCLUDED.coordinator_epoch,consent_policy_revision=EXCLUDED.consent_policy_revision,state=EXCLUDED.state,body=EXCLUDED.body WHERE runtime_model_pointer.model_version<=EXCLUDED.model_version AND runtime_model_pointer.serving_generation<=EXCLUDED.serving_generation AND runtime_model_pointer.coordinator_epoch<=EXCLUDED.coordinator_epoch AND runtime_model_pointer.consent_policy_revision<=EXCLUDED.consent_policy_revision RETURNING task_id', [this.namespace, taskId, task.modelVersion, task.servingGeneration, task.coordinatorEpoch, task.consentPolicyRevision, task.state, JSON.stringify(task)]);
      if (result.rowCount !== 1) throw new Error('POSTGRES_MODEL_GENERATION_CAS');
    }
    for (const collection of ['flPublicationOutbox', 'mecOutbox', 'mcpOutbox', 'dispatchOutbox']) {
      for (const [key, row] of changed(collection)) await client.query('INSERT INTO privacy_bubble.runtime_delivery_outbox(namespace,channel,item_id,status,body) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(namespace,channel,item_id) DO UPDATE SET status=EXCLUDED.status,body=EXCLUDED.body', [this.namespace, collection, key, row.status ?? row.state ?? 'PENDING', JSON.stringify(row)]);
      for (const key of Object.keys(original[collection] ?? {})) if (!(key in (data[collection] ?? {}))) await client.query('DELETE FROM privacy_bubble.runtime_delivery_outbox WHERE namespace=$1 AND channel=$2 AND item_id=$3', [this.namespace, collection, key]);
    }
  }

  async refresh() { await this.transaction('read-refresh', async () => {}); return this; }

  async pruneReceiptOutbox(ids) {
    const context = this.transactionContext.getStore(); if (!context) throw new Error('POSTGRES_RETENTION_TRANSACTION');
    return context.client.query('DELETE FROM privacy_bubble.runtime_receipt_outbox WHERE namespace=$1 AND receipt_id=ANY($2::text[])', [this.namespace, ids]);
  }

  async pruneReceiptJournal(expired) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`journal:${this.namespace}`]);
      const rows = await client.query('SELECT receipt_id,receipt FROM privacy_bubble.runtime_receipt_outbox WHERE namespace=$1', [this.namespace]);
      const ids = rows.rows.filter((row) => expired(row.receipt)).map((row) => row.receipt_id);
      if (ids.length) await client.query('DELETE FROM privacy_bubble.runtime_receipt_outbox WHERE namespace=$1 AND receipt_id=ANY($2::text[])', [this.namespace, ids]);
      const result = await this.receiptJournal.prune(expired); await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  now() { return this.transactionContext.getStore()?.dbNow ?? new Date().toISOString(); }

  async compareAndSwap(collection, key, expected, next) {
    return this.transaction(`cas:${collection}:${key}`, async () => { if (!equal(this.get(collection, key), expected)) return false; await this.put(collection, key, next); return true; });
  }

  async drainJournal(limit = 1000) {
    if (!this.receiptJournal) return { delivered: 0 };
    const client = await this.pool.connect(); let delivered = 0;
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`journal:${this.namespace}`]);
      const rows = await client.query('SELECT receipt_id,receipt FROM privacy_bubble.runtime_receipt_outbox WHERE namespace=$1 AND delivered_at IS NULL ORDER BY created_at,receipt_id LIMIT $2 FOR UPDATE', [this.namespace, limit]);
      let existing = ''; try { existing = await readFile(this.receiptJournal.path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const ids = new Set(existing.split('\n').filter(Boolean).map((line) => { try { const r = JSON.parse(line); return r.eventId ?? hash(Object.fromEntries(Object.entries(r).filter(([k]) => !['receiptHash', 'journaledAt'].includes(k)))); } catch { return null; } }));
      for (const row of rows.rows) {
        if (!ids.has(row.receipt_id)) { await this.receiptJournal.append(row.receipt); ids.add(row.receipt_id); }
        await client.query('UPDATE privacy_bubble.runtime_receipt_outbox SET delivered_at=clock_timestamp() WHERE namespace=$1 AND receipt_id=$2', [this.namespace, row.receipt_id]); delivered++;
      }
      await client.query('COMMIT'); return { delivered };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async close() { await this.transactionQueue; if (this.ownsPool) await this.pool.end(); }
}
