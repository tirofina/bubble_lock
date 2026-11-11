import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createIntegrationRuntime } from '../integration/src/integration-runtime.mjs';

const input = process.argv.find((value) => value.startsWith('--config='))?.slice(9);
if (!input) throw new Error('--config에 PostgreSQL API 설정 파일을 지정하세요.');
const config = JSON.parse(await readFile(resolve(input), 'utf8'));
if (!config.database) throw new Error('공유 PostgreSQL database 설정을 지정하세요.');
const runtime = await createIntegrationRuntime({ database: config.database, receiptPath: config.receiptPath, core: { ...config.core, mec: { ...config.core?.mec, autoReconcile: false }, retention: { ...config.core?.retention, autoPrune: false } } });
try { console.log(JSON.stringify({ status: 'PASS', ...await runtime.retention.runOnce() }, null, 2)); }
finally { await runtime.close(); }
