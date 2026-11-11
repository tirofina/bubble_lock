import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import resources from '../fixtures/resources.json' with { type: 'json' };
import audit from '../fixtures/audit.json' with { type: 'json' };
import { ContractError } from '../shared/validation.ts';
import { integrationAudit } from '../shared/integration.ts';
import { loadReplay } from './replay.ts';
import type { ReplaySnapshot } from './replay.ts';
import { loadLocationFeed } from './location-feed.ts';
import type { LocationFeed } from './location-feed.ts';
import { readFile } from 'node:fs/promises';
import { createPortalHandler } from './portal.ts';
import type { PortalHandler, PortalOptions } from './portal.ts';

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

export function createReplayServer(replay: ReplaySnapshot, locationFeed?: LocationFeed, portal?:PortalHandler): Server {
  return createServer(async (request, response) => {
    try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if(portal&&url.pathname.startsWith('/api/auth/')&&await portal.handleAuth(request,response))return;
    if(url.pathname.startsWith('/api/portal/')&&portal) {void portal.handle(request,response,url);return;}
    if(url.pathname==='/api/locations'&&portal?.mode==='live') {void portal.handle(request,response,new URL('/api/portal/locations',url));return;}
    if(portal&&!await portal.authorizeOperator(request,response))return;
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }
    switch (url.pathname) {
      case '/api/evidence':
        void readFile(new URL('../../docs/rubric-audit.json',import.meta.url),'utf8').then((text)=>json(response,200,JSON.parse(text))).catch(()=>json(response,503,{message:'구현 대조 기록을 준비하고 있습니다.'}));
        return;
      case '/api/locations':
        if (!locationFeed) { json(response, 503, { error: 'location_feed_pending' }); return; }
        void locationFeed.readSnapshot().then((snapshot) => {
          if (!response.destroyed) json(response, 200, snapshot);
        }).catch(() => {
          if (!response.destroyed) json(response, 503, { error: 'location_feed_unavailable', message: '위치 파일과 수신기 좌표 설정을 확인하세요.' });
        });
        return;
      case '/api/source':
        json(response, 200, {
          source: replay.source,
          simulation: true,
          lastSequence: replay.lastSequence,
          authentication: 'none-loopback-mock',
          roleScopeIsAuthorization: false,
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
    for (const event of replay.events) {
      if (event.sequence > cursor) response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    // A comment marks finite replay completion without closing EventSource.
    response.write(': replay-complete\n\n');
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15_000);
    heartbeat.unref();
    response.on('close', () => clearInterval(heartbeat));
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
}

/** Loopback is deliberately fixed; port 0 is supported for integration tests. */
export async function startReplayServer(options: StartReplayOptions = {}) {
  const replay = await loadReplay(options.receiptFile);
  const locationFeed = await loadLocationFeed({
    emptyLive:Boolean(options.portal?.auth),
    ...(options.locationFile === undefined ? {} : { locationFile: options.locationFile }),
    ...(options.gatewayLocationsFile === undefined ? {} : { gatewayLocationsFile: options.gatewayLocationsFile }),
    ...(options.locationSimulation === undefined ? {} : { simulation: options.locationSimulation }),
  });
  const portal=await createPortalHandler(locationFeed,{...options.portal,...(options.portalStatePath===undefined?{}:{statePath:options.portalStatePath})});
  const server = createReplayServer(replay, locationFeed, portal);
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
  };
  return { server, replay, url: `http://127.0.0.1:${address.port}`, close };
}
