import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import resources from '../fixtures/resources.json' with { type: 'json' };
import audit from '../fixtures/audit.json' with { type: 'json' };
import { ContractError } from '../shared/validation.ts';
import { integrationAudit } from '../shared/integration.ts';
import { loadReplay } from './replay.ts';
import type { DashboardEvent, SourceMode } from '../shared/types.ts';
import { startCseLiveSource } from './cse-live.ts';
import type { CseLiveConfig, CseLiveSource } from './cse-live.ts';
import { loadLocationFeed } from './location-feed.ts';
import type { LocationFeed } from './location-feed.ts';
import { readFile } from 'node:fs/promises';
import { createPortalHandler } from './portal.ts';
import type { PortalHandler, PortalOptions } from './portal.ts';
import { createAlertReplay, createAlertRoutes } from './guardian-alerts.ts';
import type { AlertRoutes } from './guardian-alerts.ts';

export function parseResumeSequence(value: string | undefined | null): number {
  if (value === undefined || value === null) return 0;
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new ContractError('Resume cursor must be a nonnegative safe integer');
  }
  return Number(value);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

/**
 * Event source behind /events. A replay snapshot is finite; a live feed (oneM2M CSE) also
 * pushes new events and can re-read the CSE (la/ RETRIEVE) when a client reconnects.
 */
export interface EventFeed {
  readonly source: SourceMode;
  readonly simulation: boolean;
  readonly events: readonly DashboardEvent[];
  readonly lastSequence: number;
  subscribe?(listener: (event: DashboardEvent) => void): () => void;
  resync?(reason: string): Promise<unknown>;
  describe?(): Record<string, unknown>;
}

const RESYNC_WAIT_MS = 3000;

export function createReplayServer(replay: EventFeed, locationFeed?: LocationFeed, portal?:PortalHandler, alerts?: AlertRoutes): Server {
  return createServer(async (request, response) => {
    try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if(portal&&url.pathname.startsWith('/api/auth/')&&await portal.handleAuth(request,response))return;
    if(alerts&&portal&&(url.pathname==='/api/portal/alerts'||url.pathname.startsWith('/api/portal/alerts/'))) {void alerts.handlePortal(request,response,url,portal);return;}
    if(url.pathname.startsWith('/api/portal/')&&portal) {void portal.handle(request,response,url);return;}
    if(url.pathname==='/api/locations'&&portal?.mode==='live') {void portal.handle(request,response,new URL('/api/portal/locations',url));return;}
    if(portal&&!await portal.authorizeOperator(request,response))return;
    if(alerts&&request.method==='GET'&&await alerts.handleOperator(request,response,url))return;
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }
    switch (url.pathname) {
      case '/api/evidence':
        void readFile(new URL('../../docs/rubric-audit.json',import.meta.url),'utf8').then((text)=>json(response,200,JSON.parse(text))).catch(()=>json(response,503,{message:'The requirement trace is being prepared.'}));
        return;
      case '/api/locations':
        if (!locationFeed) { json(response, 503, { error: 'location_feed_pending' }); return; }
        void locationFeed.readSnapshot().then((snapshot) => {
          if (!response.destroyed) json(response, 200, snapshot);
        }).catch(() => {
          if (!response.destroyed) json(response, 503, { error: 'location_feed_unavailable', message: '위치 파일과 수신기 좌표 설정을 확인하세요.' });
        });
        return;
      case '/api/group-commands':
        json(response, portal?.caregiver ? 200 : 404, portal?.caregiver ? portal.caregiver.status() : { message: 'caregiver group not configured' });
        return;
      case '/api/source':
        json(response, 200, {
          source: replay.source,
          simulation: replay.simulation,
          lastSequence: replay.lastSequence,
          authentication: 'none-loopback-mock',
          roleScopeIsAuthorization: false,
          ...(replay.describe ? { live: replay.describe() } : {}),
        });
        return;
      case '/api/resources':
        json(response, 200, resources);
        return;
      case '/api/audit': {
        const query = (url.searchParams.get('q') ?? '').toLowerCase();
        const integrated = replay.source === 'integration-journal-replay';
        const records = integrated ? integrationAudit(replay.events) : audit.records;
        json(response, 200, {
          ...audit,
          source: integrated ? 'integration-journal-replay' : audit.source,
          records: records.filter((record) => JSON.stringify(record).toLowerCase().includes(query)),
        });
        return;
      }
      case '/events': break;
      default:
        json(response, 404, { error: 'not_found' });
        return;
    }
    let cursor: number;
    try {
      const header = request.headers['last-event-id'];
      if (Array.isArray(header)) throw new ContractError('Last-Event-ID must be singular');
      // Native reconnect's newer header takes precedence over the original URL cursor.
      cursor = parseResumeSequence(header ?? url.searchParams.get('lastSequence'));
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      json(response, 400, { error: 'invalid_cursor', message: error.message });
      return;
    }
    // A reconnecting client may have missed CSE notifications too: re-read the CSE first.
    if (replay.resync && (cursor > 0 || request.headers['last-event-id'] !== undefined)) {
      await Promise.race([replay.resync('sse-reconnect').catch(() => undefined), new Promise((resolve) => setTimeout(resolve, RESYNC_WAIT_MS).unref())]);
    }
    if (cursor > replay.lastSequence) {
      json(response, 409, { error: 'resync_required', lastSequence: replay.lastSequence });
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write('retry: 3000\n: connected\n\n');
    let written = cursor;
    const write = (event: DashboardEvent) => {
      if (event.sequence <= written || response.destroyed) return;
      written = event.sequence;
      response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    // Live feeds: listen before the backlog so nothing appended meanwhile is lost.
    const pendingLive: DashboardEvent[] = [];
    let backlogDone = false;
    const unsubscribe = replay.subscribe?.((event) => { if (backlogDone) write(event); else pendingLive.push(event); });
    for (const event of replay.events) write(event);
    backlogDone = true;
    for (const event of pendingLive) write(event);
    // A comment marks backlog completion without closing EventSource.
    response.write(': replay-complete\n\n');
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    heartbeat.unref();
    response.on('close', () => { clearInterval(heartbeat); unsubscribe?.(); });
    }catch{if(!response.headersSent)json(response,503,{message:'대시보드 연결 상태를 확인하세요.'});else response.end();}
  });
}

export interface StartReplayOptions {
  readonly port?: number;
  readonly receiptFile?: string;
  readonly locationFile?: string;
  readonly gatewayLocationsFile?: string;
  readonly locationSimulation?: boolean;
  readonly portalStatePath?: string;
  readonly portal?: PortalOptions;
  /** Live oneM2M CSE source. Omitted means the existing fixture or journal replay. */
  readonly cseLive?: CseLiveConfig;
  /** Guardian alert card source: the live resident feed when configured, otherwise the R17 story replay. */
  readonly alerts?: { readonly source?: 'auto' | 'replay' | 'cse-live'; readonly variant?: string; readonly start?: string; readonly storyControlUrl?: string };
}

/** Loopback is deliberately fixed; port 0 is supported for integration tests. */
export async function startReplayServer(options: StartReplayOptions = {}) {
  const live: CseLiveSource | null = options.cseLive ? await startCseLiveSource(options.cseLive) : null;
  const replay: EventFeed = live ?? await loadReplay(options.receiptFile);
  const locationFeed = await loadLocationFeed({
    emptyLive:Boolean(options.portal?.auth),
    ...(options.locationFile === undefined ? {} : { locationFile: options.locationFile }),
    ...(options.gatewayLocationsFile === undefined ? {} : { gatewayLocationsFile: options.gatewayLocationsFile }),
    ...(options.locationSimulation === undefined ? {} : { simulation: options.locationSimulation }),
  });
  const portal=await createPortalHandler(locationFeed,{...options.portal,...(options.portalStatePath===undefined?{}:{statePath:options.portalStatePath}),...(live?{cse:{overlaySnapshot:(snapshot:unknown)=>live.guardianOverlay?.apply(snapshot)??snapshot,publishApproved:(result:unknown)=>live.publishApproved(result)}}:{})});
  const alertSource = options.alerts?.source ?? 'auto';
  if (alertSource === 'cse-live' && !live?.alerts) throw new ContractError('ALERT_SOURCE=cse-live에는 CSE_LIVE_CONFIG의 guardian과 residents 설정이 필요해요.');
  const alertBackend = alertSource !== 'replay' && live?.alerts ? live.alerts : createAlertReplay({ ...(options.alerts?.variant ? { variant: options.alerts.variant } : {}), ...(options.alerts?.start ? { start: options.alerts.start } : {}) });
  const alerts = createAlertRoutes(alertBackend, { allowReplayControl: !options.portal?.auth, ...(options.alerts?.storyControlUrl ? { storyControlUrl: options.alerts.storyControlUrl } : {}) });
  const server = createReplayServer(replay, locationFeed, portal, alerts);
  const listening = once(server, 'listening');
  server.listen(options.port ?? 4174, '127.0.0.1');
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') throw new ContractError('Expected a TCP loopback server');
  const close = async (): Promise<void> => {
    const closed = once(server, 'close');
    server.closeAllConnections();
    server.close();
    await closed;
    await live?.close();
  };
  return { server, replay, live, alerts, url: `http://127.0.0.1:${address.port}`, close };
}
