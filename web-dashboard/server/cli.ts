import { startReplayServer } from './sse.ts';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createOidcSessionManager } from './oidc-session.ts';
import type { OidcSessionConfig } from './oidc-session.ts';
import { createPortalUpstream } from './portal-upstream.ts';
import type { PortalOptions } from './portal.ts';
import type { CseLiveConfig } from './cse-live.ts';
import { loadLocalAccounts } from './local-accounts.ts';
import type { LivingRoomConfig } from './caregiver.ts';

const receiptFile = process.env['RECEIPT_FILE'];
const locationFile = process.env['LOCATION_FILE'];
const gatewayLocationsFile = process.env['GATEWAY_LOCATIONS_FILE'];
const locationSimulation = process.env['LOCATION_SIMULATION'];
const maxEventStreams = process.env['SSE_MAX_STREAMS'];
if (maxEventStreams !== undefined && !/^[1-9]\d{0,3}$/.test(maxEventStreams)) {
  throw new TypeError('SSE_MAX_STREAMS must be an integer from 1 through 1024');
}
const portalConfigFile=process.env['PORTAL_CONFIG_FILE'];
let portal:PortalOptions|undefined;
if(portalConfigFile){
  const config=JSON.parse(await readFile(portalConfigFile,'utf8')) as {oidc:OidcSessionConfig;api:{baseUrl:string;caFile?:string}};
  const auth=await createOidcSessionManager(config.oidc);
  const upstream=createPortalUpstream({baseUrl:config.api.baseUrl,...(config.api.caFile?{ca:await readFile(config.api.caFile,'utf8')}:{} )});
  portal={auth,upstream};
}
// LOCAL_ACCOUNTS_FILE enables self-hosted password accounts (scripts/add-local-account.mjs writes the file).
const localAccountsFile=process.env['LOCAL_ACCOUNTS_FILE'];
if(localAccountsFile){
  if(portal)throw new TypeError('PORTAL_CONFIG_FILE와 LOCAL_ACCOUNTS_FILE 중 하나만 지정하세요.');
  portal={localAccounts:await loadLocalAccounts(localAccountsFile)};
}
// DASHBOARD_SOURCE=cse-live reads oneM2M notifications from a real CSE; default stays fixture or journal replay.
const sourceMode = process.env['DASHBOARD_SOURCE'] ?? 'replay';
if (!['replay', 'cse-live'].includes(sourceMode)) throw new TypeError('DASHBOARD_SOURCE 값은 replay 또는 cse-live로 지정하세요.');
const cseLiveConfigFile = process.env['CSE_LIVE_CONFIG'];
if (sourceMode === 'cse-live' && !cseLiveConfigFile) throw new TypeError('cse-live 모드에는 CSE_LIVE_CONFIG 파일을 지정하세요.');
const cseLive = sourceMode === 'cse-live' && cseLiveConfigFile ? JSON.parse(await readFile(cseLiveConfigFile, 'utf8')) as CseLiveConfig : undefined;
const port = process.env['DASHBOARD_PORT'] === undefined ? undefined : Number(process.env['DASHBOARD_PORT']);
if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new TypeError('DASHBOARD_PORT 값을 확인하세요.');
if (locationSimulation !== undefined && !['true', 'false'].includes(locationSimulation)) {
  throw new TypeError('LOCATION_SIMULATION 값은 true 또는 false로 지정하세요.');
}
// Guardian alert card: ALERT_SOURCE=auto|replay|cse-live, ALERT_REPLAY_VARIANT=scripted|claude, ALERT_REPLAY_START=home|walk|alert.
const alertSource = process.env['ALERT_SOURCE'] ?? 'auto';
if (!['auto', 'replay', 'cse-live'].includes(alertSource)) throw new TypeError('ALERT_SOURCE 값은 auto, replay, cse-live 중 하나로 지정하세요.');
const alerts = { source: alertSource as 'auto' | 'replay' | 'cse-live', ...(process.env['ALERT_REPLAY_VARIANT'] ? { variant: process.env['ALERT_REPLAY_VARIANT'] } : {}), ...(process.env['ALERT_REPLAY_START'] ? { start: process.env['ALERT_REPLAY_START'] } : {}), ...(process.env['ALERT_STORY_CONTROL_URL'] ? { storyControlUrl: process.env['ALERT_STORY_CONTROL_URL'] } : {}) };
// Caregiver living room group: PORTAL_CORE_CONFIG=<json with livingRoom.groupCommand> (live CSE) or CAREGIVER_DEMO=1 (emulated fanout).
const coreConfigFile = process.env['PORTAL_CORE_CONFIG'];
const livingRoom = coreConfigFile ? (JSON.parse(await readFile(coreConfigFile, 'utf8')) as { livingRoom: LivingRoomConfig }).livingRoom : process.env['CAREGIVER_DEMO'] === '1' ? {} : undefined;
if (livingRoom && portal) throw new TypeError('방문 돌봄 기기 그룹은 로컬 체험 포털에서만 실행하세요.');
const service = await startReplayServer({
  host: process.env['BFF_HOST'] ?? '127.0.0.1',
  ...(port === undefined ? {} : { port }),
  ...(cseLive ? { cseLive } : {}),
  alerts,
  ...(receiptFile === undefined ? {} : { receiptFile }),
  ...(locationFile === undefined ? {} : { locationFile }),
  ...(gatewayLocationsFile === undefined ? {} : { gatewayLocationsFile }),
  locationSimulation: locationSimulation !== 'false',
  ...(maxEventStreams === undefined ? {} : { maxEventStreams: Number(maxEventStreams) }),
  ...(livingRoom ? { portal: { livingRoom } } : {}),
  portalStatePath:process.env['PORTAL_DEMO_STATE']??fileURLToPath(new URL('../../.local/portal-demo/state.json',import.meta.url)),
  ...(portal?{portal}:{}),
});
console.log(`이벤트 재생: ${service.url} · ${service.replay.source} · ${service.replay.lastSequence}개 · ${portal?.auth?'OIDC 계정 인증':portal?.localAccounts?`로컬 계정 인증 (${portal.localAccounts.length}개)`:'로컬 체험 환경'}`);
if (service.live) console.log(`oneM2M 실시간 원천: ${JSON.stringify(service.live.describe())}`);
console.log(`보호자 알림 카드: ${JSON.stringify(service.alerts.backend.describe())}`);
process.send?.({ type: 'ready', url: service.url, source: service.replay.source, live: service.live?.describe() ?? null });
console.log(`위치 지도: ${locationFile === undefined ? '모의 fixture' : locationSimulation === 'false' ? '현장 JSONL 관측' : '모의 JSONL 관측'} · GET /api/locations · 4초 갱신`);
const stop = () => {
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  portal?.auth?.close();
  void service.close();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
// A parent runner (pc-mobius/scripts/run-multiapp-real.mjs) stops the server over IPC so subscriptions are deleted first.
process.on('message', (message: unknown) => {
  if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'stop') {
    portal?.auth?.close();
    void service.close().finally(() => process.exit(0));
  }
});
