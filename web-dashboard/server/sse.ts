import { once } from 'node:events';
import { createServer } from 'node:http';
import type { Server, ServerResponse } from 'node:http';
import resources from '../fixtures/resources.json' with { type: 'json' };
import audit from '../fixtures/audit.json' with { type: 'json' };
import { ContractError } from '../shared/validation.ts';
import { loadReplay } from './replay.ts';
import type { ReplaySnapshot } from './replay.ts';

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

export function createReplayServer(replay: ReplaySnapshot): Server {
  return createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET');
      json(response, 405, { error: 'method_not_allowed' });
      return;
    }
    switch (url.pathname) {
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
        json(response, 200, {
          ...audit,
          records: audit.records.filter((record) => JSON.stringify(record).toLowerCase().includes(query)),
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
  });
}

export interface StartReplayOptions {
  readonly port?: number;
  readonly receiptFile?: string;
}

/** Loopback is deliberately fixed; port 0 is supported for integration tests. */
export async function startReplayServer(options: StartReplayOptions = {}) {
  const replay = await loadReplay(options.receiptFile);
  const server = createReplayServer(replay);
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
