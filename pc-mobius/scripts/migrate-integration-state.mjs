import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { PostgresIntegrationStore } from '../integration/src/postgres-integration-store.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
if (!arg('input') || !arg('namespace') || !arg('config')) throw new Error('--input, --namespace, --config are required');
const sourcePath = resolve(arg('input')); const source = await readFile(sourcePath, 'utf8'); const state = JSON.parse(source);
if (!state || Array.isArray(state) || typeof state !== 'object' || !Array.isArray(state.receipts)) throw new Error('INTEGRATION_STATE_SCHEMA');
const config = JSON.parse(await readFile(resolve(arg('config')), 'utf8'));
const connectionString = config.connectionString ?? `postgresql://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.policyDatabase}`;
const store = await new PostgresIntegrationStore({ connectionString, namespace: arg('namespace'), autoDrainJournal: false }).init();
try {
  await store.transaction('legacy-json-import', async () => {
    const context = store.transactionContext.getStore();
    if (context.version !== 0 || Object.values(context.data).some((value) => Object.keys(value).length)) throw new Error('EMPTY_POSTGRES_NAMESPACE_REQUIRED');
    context.data = structuredClone(state);
    // 기존 receipt도 같은 SQL commit의 journal outbox로 등록한다.
    context.receipts = state.receipts;
  });
  console.log(JSON.stringify({ status: 'IMPORTED', namespace: store.namespace, version: store.version, sourceSha256: createHash('sha256').update(source).digest('hex'), collections: Object.keys(state), receipts: state.receipts.length }, null, 2));
} finally { await store.close(); }
