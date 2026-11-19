/**
 * Standalone MEC IPE process for a real MEC sandbox.
 *   node scripts/run-mec-ipe.mjs --discover-only   MEC011 catalog check (no CSE needed)
 *   node scripts/run-mec-ipe.mjs                   register the IPE AE and bridge requests until SIGINT
 * Settings come from the environment; see docs/rubric-work/R16-sandbox-cutover.md.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IntegrationStore } from '../integration/src/integration-store.mjs';
import { MecCipher } from '../integration/src/mec-state.mjs';
import { MecIpe } from '../integration/src/mec-ipe.mjs';
import { MecPlatformClient, createMecFetch, mecSandboxConfig } from '../integration/src/mec-platform-client.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const env = process.env;
const config = mecSandboxConfig(env);
const list = (value) => (value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
if (!config.platformRoot) throw new Error('Set MEC_BASE_URL (+ MEC_SANDBOX_NAME, MEC_MEP) or MEC_PLATFORM_ROOT.');
if (config.insecureTls && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(config.platformRoot)) console.warn('MEC_INSECURE_TLS=1 disables certificate checks; use MEC_CA_FILE for the sandbox.');
const platform = new MecPlatformClient({ platformRoot: config.platformRoot, fetchImpl: createMecFetch({ caFile: config.caFile, insecureTls: config.insecureTls }), timeoutMs: config.timeoutMs, simulation: config.simulation, allowedOrigins: config.allowedOrigins, locationVersion: config.locationVersion, appInstanceId: config.appInstanceId });
const outputDir = join(root, '.local', 'mec-ipe');
await mkdir(outputDir, { recursive: true });

if (process.argv.includes('--discover-only')) {
  const discovery = await platform.discoverServices();
  platform.bind(discovery.services);
  const receipt = { recordedAt: new Date().toISOString(), platformRootHost: new URL(config.platformRoot).host, sandboxName: config.sandboxName, mep: config.mep, tls: { caPinned: Boolean(config.caFile), insecure: config.insecureTls }, httpStatus: discovery.status, catalogHash: discovery.catalogHash, services: discovery.services.map(({ key, mecApi, serName, version, apiVersion, state, endpointRebased }) => ({ key, mecApi, serName, version, apiVersion, state, endpointRebased })), locationApiVersion: platform.locationVersionFor(), simulation: config.simulation };
  const path = join(outputDir, `discovery-${Date.now()}.json`);
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ ...receipt, receipt: path }, null, 2));
  process.exit(0);
}

const keyFile = resolve(env.MEC_IPE_ENCRYPTION_KEY_FILE ?? join(outputDir, 'ipe.key'));
let key;
try { key = (await readFile(keyFile, 'utf8')).trim(); }
catch { key = randomBytes(32).toString('base64'); await mkdir(dirname(keyFile), { recursive: true }); await writeFile(keyFile, `${key}\n`, { mode: 0o600 }); }
const cipher = new MecCipher({ store: { path: null }, encryptionKey: key });
const store = await new IntegrationStore(resolve(env.MEC_IPE_STATE ?? join(outputDir, 'ipe-state.json'))).init();
const requesters = list(env.MEC_IPE_REQUESTERS);
const ipe = new MecIpe({
  cse: { endpoint: env.ONEM2M_CSE_URL ?? 'http://127.0.0.1:7599', cseBase: env.ONEM2M_CSE_BASE ?? '/Mobius', cseId: env.ONEM2M_CSE_ID || null },
  originator: env.MEC_IPE_ORIGINATOR ?? 'Cmec-ipe',
  aeName: env.MEC_IPE_AE_NAME ?? 'mec-ipe',
  platform, consume: config.consume, cipher, store,
  requesters: { Location: requesters, RNIS: requesters },
  readers: list(env.MEC_IPE_READERS),
  listen: { host: env.MEC_IPE_LISTEN_HOST ?? '127.0.0.1', port: Number(env.MEC_IPE_LISTEN_PORT ?? 0) },
  publicBaseUrl: config.callbackPublicUrl, onem2mBaseUrl: env.MEC_IPE_ONEM2M_URL || null,
  leaseSec: Number(env.MEC_IPE_LEASE_SEC ?? 120), renewBeforeMs: Number(env.MEC_IPE_RENEW_BEFORE_MS ?? 20000),
  simulation: config.simulation,
  trace: (entry) => console.log(JSON.stringify(entry)),
});
const started = await ipe.start();
console.log(JSON.stringify({ status: 'IPE_READY', aePath: started.aePath, aei: started.aei, paths: started.paths, listen: ipe.baseUrl, mecCallbackBase: ipe.mecBase, services: started.catalog.services.map(({ key, mecApi, representation, state, consumed }) => ({ key, mecApi, representation, state, consumed })) }, null, 2));
const shutdown = async () => { await ipe.stop({ teardown: env.MEC_IPE_TEARDOWN_ON_EXIT !== '0' }); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
