import { startReplayServer } from './sse.ts';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createOidcSessionManager } from './oidc-session.ts';
import type { OidcSessionConfig } from './oidc-session.ts';
import { createPortalUpstream } from './portal-upstream.ts';
import type { PortalOptions } from './portal.ts';
import type { CseLiveConfig } from './cse-live.ts';

const receiptFile = process.env['RECEIPT_FILE'];
const locationFile = process.env['LOCATION_FILE'];
const gatewayLocationsFile = process.env['GATEWAY_LOCATIONS_FILE'];
const locationSimulation = process.env['LOCATION_SIMULATION'];
const portalConfigFile=process.env['PORTAL_CONFIG_FILE'];
let portal:PortalOptions|undefined;
if(portalConfigFile){
  const config=JSON.parse(await readFile(portalConfigFile,'utf8')) as {oidc:OidcSessionConfig;api:{baseUrl:string;caFile?:string}};
  const auth=await createOidcSessionManager(config.oidc);
  const upstream=createPortalUpstream({baseUrl:config.api.baseUrl,...(config.api.caFile?{ca:await readFile(config.api.caFile,'utf8')}:{} )});
  portal={auth,upstream};
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
const service = await startReplayServer({
  ...(port === undefined ? {} : { port }),
  ...(cseLive ? { cseLive } : {}),
  ...(receiptFile === undefined ? {} : { receiptFile }),
  ...(locationFile === undefined ? {} : { locationFile }),
  ...(gatewayLocationsFile === undefined ? {} : { gatewayLocationsFile }),
  locationSimulation: locationSimulation !== 'false',
  portalStatePath:process.env['PORTAL_DEMO_STATE']??fileURLToPath(new URL('../../.local/portal-demo/state.json',import.meta.url)),
  ...(portal?{portal}:{}),
});
console.log(`이벤트 재생: ${service.url} · ${service.replay.source} · ${service.replay.lastSequence}개 · ${portal?'OIDC 계정 인증':'로컬 체험 환경'}`);
if (service.live) console.log(`oneM2M 실시간 원천: ${JSON.stringify(service.live.describe())}`);
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
