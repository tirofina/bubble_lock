/**
 * Entry point of the oneM2M MEC IPE container (image pb-onem2m-ipe) running as a MEC application
 * instance on a MEP of the ETSI MEC Sandbox. Settings come from the environment (the sandbox scenario
 * process `environment` string cannot hold ',' or '=' inside values, so list values also accept ';').
 *
 *   MEC_BASE_URL (https://192.168.0.103), MEC_SANDBOX_NAME, MEC_MEP / PB_IPE_MEP, MEC_CA_FILE,
 *   MEC_APP_INSTANCE_ID (scenario process id), MEC_AMS_MEP (MEP whose MEC021 is used, default mep1),
 *   MEC_CALLBACK_PUBLIC_URL and MEC_IPE_ONEM2M_URL (NodePort URL of this instance),
 *   ONEM2M_CSE_URL (https), ONEM2M_CA_FILE (default MEC_CA_FILE), ONEM2M_CSE_BASE, ONEM2M_CSE_ID,
 *   MEC_IPE_ORIGINATOR, MEC_IPE_AE_NAME, MEC_IPE_REQUESTERS, MEC_IPE_READERS, MEC_IPE_ORCHESTRATORS.
 *
 * The container waits until the CSE answers, then starts the IPE. Its JSON trace goes to stdout.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { RelocatableMecIpe } from '../integration/src/mec-ipe-relocatable.mjs';
import { MecPlatformClient, createMecFetch, mecSandboxConfig } from '../integration/src/mec-platform-client.mjs';
import { Onem2mHttpClient } from '../integration/src/onem2m-http-client.mjs';

const env = process.env;
const config = mecSandboxConfig({ ...env, MEC_MEP: env.MEC_MEP ?? env.PB_IPE_MEP });
const list = (value, fallback = '') => (value ?? fallback).split(/[;,\s]+/).map((item) => item.trim()).filter(Boolean);
const log = (entry) => console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
if (!config.platformRoot || !config.appInstanceId || !env.ONEM2M_CSE_URL) { log({ step: 'IPE_CONFIG_REVIEW', platformRoot: config.platformRoot, appInstanceId: config.appInstanceId, cse: env.ONEM2M_CSE_URL ?? null }); process.exit(2); }

const mecFetch = createMecFetch({ caFile: config.caFile, insecureTls: config.insecureTls });
const cseFetch = createMecFetch({ caFile: env.ONEM2M_CA_FILE ?? config.caFile });
const cse = { endpoint: env.ONEM2M_CSE_URL, cseBase: env.ONEM2M_CSE_BASE ?? '/Mobius', cseId: env.ONEM2M_CSE_ID || null, fetchImpl: cseFetch };
const platform = new MecPlatformClient({ platformRoot: config.platformRoot, fetchImpl: mecFetch, timeoutMs: config.timeoutMs, appInstanceId: config.appInstanceId, locationVersion: config.locationVersion === 'auto' ? 'v3' : config.locationVersion, allowedOrigins: config.allowedOrigins });
const originator = env.MEC_IPE_ORIGINATOR ?? 'Cpb-mec-ipe';
const requesters = list(env.MEC_IPE_REQUESTERS, 'Cguardian-app');
const ipe = new RelocatableMecIpe({
  instance: { mep: config.mep, appInstanceId: config.appInstanceId },
  orchestrators: list(env.MEC_IPE_ORCHESTRATORS, 'Cpb-orchestrator'),
  amsRoot: `${config.baseUrl}/${config.sandboxName}/${env.MEC_AMS_MEP ?? 'mep1'}/amsi/v1`,
  cse, originator, aeName: env.MEC_IPE_AE_NAME ?? 'pb-mec-ipe', platform, consume: config.consume,
  encryptionKey: env.MEC_IPE_ENCRYPTION_KEY || randomBytes(32).toString('base64'),
  requesters: { Location: requesters, RNIS: requesters }, readers: list(env.MEC_IPE_READERS, 'Cguardian-app;Cpb-orchestrator'),
  listen: { host: env.MEC_IPE_LISTEN_HOST ?? '0.0.0.0', port: Number(env.MEC_IPE_LISTEN_PORT ?? 18080) },
  publicBaseUrl: config.callbackPublicUrl, onem2mBaseUrl: env.MEC_IPE_ONEM2M_URL || config.callbackPublicUrl,
  leaseSec: Number(env.MEC_IPE_LEASE_SEC ?? 60), renewBeforeMs: Number(env.MEC_IPE_RENEW_BEFORE_MS ?? 15000), renewCheckMs: 2000,
  simulation: false, trace: (entry) => console.log(JSON.stringify(entry)),
});
log({ step: 'IPE_POD_CONFIG', mep: config.mep, appInstanceId: config.appInstanceId, platformRoot: config.platformRoot, cse: cse.endpoint, callback: config.callbackPublicUrl });

// The CSE may start after the pod (the run script owns its lifecycle): wait until it answers.
const probe = new Onem2mHttpClient({ endpoint: cse.endpoint, cseBase: cse.cseBase, originator, fetchImpl: cseFetch, timeoutMs: 4000 });
for (let attempt = 1; ; attempt += 1) {
  try { const answer = await probe.retrieve(cse.cseBase); log({ step: 'IPE_CSE_REACHABLE', attempt, rsc: answer.rsc }); break; }
  catch (error) { if (attempt === 1 || attempt % 12 === 0) log({ step: 'IPE_CSE_WAIT', attempt, reason: error.cause?.cause?.code ?? error.cause?.name ?? error.code ?? error.message }); await delay(5000); }
}
let started;
try { started = await ipe.start(); log({ step: 'IPE_POD_READY', aePath: started.aePath, epoch: ipe.epoch, owner: ipe.owner, listen: ipe.baseUrl, mecCallbackBase: ipe.mecBase }); }
catch (error) { log({ step: 'IPE_START_FAILED', reason: error.code ?? error.message, rsc: error.rsc ?? null }); process.exit(1); }
// CSE watchdog: when the CSE is replaced (AE gone) or stays unreachable, exit so that the container
// restarts with fresh state and registers again with the next CSE.
let misses = 0;
setInterval(async () => {
  try {
    const answer = await probe.retrieve(started.aePath);
    if (answer.rsc === 4004) { log({ step: 'IPE_CSE_REPLACED', aePath: started.aePath }); process.exit(3); }
    misses = 0;
  } catch { misses += 1; if (misses >= 6) { log({ step: 'IPE_CSE_LOST', misses }); process.exit(3); } }
}, 5000).unref();
const shutdown = async (signal) => { log({ step: 'IPE_POD_SIGNAL', signal, owner: ipe.owner }); try { await ipe.stop({ teardown: ipe.owner }); } catch { /* best effort */ } process.exit(0); };
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
