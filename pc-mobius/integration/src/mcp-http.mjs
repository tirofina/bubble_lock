import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { randomBytes } from 'node:crypto';
import { approvalHash, recordEnvelope } from './integration-utils.mjs';
import { MCP_CONTRACT, compileTools, validateTool, wireTool } from './mcp-schema.mjs';

const VERSION = MCP_CONTRACT.protocolVersion;
const VERSIONS = new Set(MCP_CONTRACT.supportedProtocolVersions ?? [VERSION]);
const json = (response, status, body, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); response.end(body === null ? '' : JSON.stringify(body)); };
const boundedJson = async (body, limit = 1024 * 1024) => {
  const chunks = []; let size = 0;
  for await (const chunk of body) { size += chunk.length; if (size > limit) throw new Error('MCP payload size required'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
};

export class McpHttpClient {
  constructor({ endpoint, audience, getAccessToken, fetchImpl = globalThis.fetch, timeoutMs = 5000, allowLoopbackHttp = false, trace = null, principalId = null, protocolVersion = VERSION }) {
    const url = new URL(endpoint);
    if ((url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.hash) throw new Error('Pinned HTTPS MCP endpoint required');
    if (!audience || typeof getAccessToken !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new Error('MCP audience, credentials and bounded timeout required');
    if (!VERSIONS.has(protocolVersion)) throw new Error('Supported MCP protocol version required');
    Object.assign(this, { endpoint: url.href, audience, getAccessToken, fetchImpl, timeoutMs, trace, allowLoopbackHttp, principalId, protocolVersion });
    this.sessionId = null; this.sequence = 0; this.connecting = null;
    this.actors = new Map();
  }
  async request(method, params = {}, { notification = false, timeoutMs = this.timeoutMs } = {}) {
    const token = await this.getAccessToken(this.audience);
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('MCP audience token required');
    const id = notification ? undefined : ++this.sequence;
    const message = { jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params };
    this.trace?.({ direction: 'send', method, id: id ?? null, payloadHash: approvalHash(message) });
    const response = await this.fetchImpl(this.endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(Math.min(timeoutMs, this.timeoutMs)),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`, ...(method === 'initialize' ? {} : { 'MCP-Protocol-Version': this.protocolVersion }), ...(this.sessionId ? { 'MCP-Session-Id': this.sessionId } : {}) }, body: JSON.stringify(message) });
    if (notification) { if (response.status !== 202) throw new Error('MCP notification acceptance required'); return null; }
    if (!response.ok || !response.body) {
      if (response.status === 404 && this.sessionId) { this.sessionId = null; this.connecting = null; }
      throw Object.assign(new Error(`MCP transport status ${response.status}`), { status: response.status });
    }
    const session = response.headers.get('mcp-session-id');
    if (method === 'initialize' && session) {
      if (!/^[\x21-\x7E]{1,256}$/.test(session)) throw new Error('MCP session identity required');
      this.sessionId = session;
    }
    const raw = await boundedJson(response.body);
    let messageResponse;
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const events = raw.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n')).filter(Boolean).map((entry) => JSON.parse(entry));
      messageResponse = events.find((entry) => entry.id === id);
    } else if (response.headers.get('content-type')?.includes('application/json')) messageResponse = JSON.parse(raw);
    if (!messageResponse || messageResponse.jsonrpc !== '2.0' || messageResponse.id !== id) throw new Error('MCP response identity required');
    this.trace?.({ direction: 'receive', method, id, payloadHash: approvalHash(messageResponse), status: response.status });
    if (messageResponse.error) throw new Error(`MCP protocol error ${messageResponse.error.code}`);
    return messageResponse.result;
  }
  async connect() {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const result = await this.request('initialize', { protocolVersion: this.protocolVersion, capabilities: {}, clientInfo: { name: 'bubble-lock-orchestrator', version: '1.0.0' } });
      if (!VERSIONS.has(result?.protocolVersion) || !result.capabilities?.tools) throw new Error('MCP tools protocol capability required');
      this.protocolVersion = result.protocolVersion;
      await this.request('notifications/initialized', {}, { notification: true });
      const listed = await this.request('tools/list');
      if (!Array.isArray(listed?.tools) || listed.tools.length > 64 || listed.nextCursor) throw new Error('Bounded MCP tool catalog required');
      return { serverInfo: result.serverInfo, tools: listed.tools };
    })();
    try { return await this.connecting; } catch (error) { this.connecting = null; throw error; }
  }
  async call(tool, input, context, timeoutMs) {
    if (this.principalId === null && context.principalId) {
      let actor = this.actors.get(context.principalId);
      if (!actor) {
        if (this.actors.size >= 128) throw new Error('MCP principal session capacity required');
        actor = new McpHttpClient({ endpoint: this.endpoint, audience: this.audience, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs, allowLoopbackHttp: this.allowLoopbackHttp, trace: this.trace,
          principalId: context.principalId, protocolVersion: this.protocolVersion, getAccessToken: (audience) => this.getAccessToken(audience, { principalId: context.principalId }) });
        this.actors.set(context.principalId, actor);
      }
      return actor.call(tool, input, context, timeoutMs);
    }
    await this.connect();
    const params = { name: tool, arguments: input, _meta: { 'privacy-bubble': context } };
    let result;
    try { result = await this.request('tools/call', params, { timeoutMs }); }
    catch (error) { if (error.status !== 404) throw error; await this.connect(); result = await this.request('tools/call', params, { timeoutMs }); }
    if (result?.isError === true || !result?.structuredContent || !Array.isArray(result.content)) throw new Error('MCP successful structured output required');
    return result.structuredContent;
  }
  async close() {
    await Promise.all([...this.actors.values()].map((actor) => actor.close())); this.actors.clear();
    if (!this.sessionId) return;
    try {
      const token = await this.getAccessToken(this.audience);
      await this.fetchImpl(this.endpoint, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs), headers: { Authorization: `Bearer ${token}`, 'MCP-Session-Id': this.sessionId, 'MCP-Protocol-Version': this.protocolVersion } });
    } catch { return { remoteSession: 'CLOSED_OR_UNREACHABLE' };
    } finally { this.sessionId = null; this.connecting = null; }
  }
}

/** Streamable HTTP JSON response profile. Tool writes and dedup receipts share one server-store transaction. */
export function createMcpHttpServer({ serverId, audience, tools, handlers, store, authenticate, authorizeCall, tls = null, allowedOrigins = [], clock = () => new Date().toISOString(), trace = null, timeoutMs = 5000 }) {
  if (!serverId || !audience || !store || typeof authenticate !== 'function' || typeof authorizeCall !== 'function') throw new Error('MCP server identity, store and authorization required');
  const catalog = compileTools(tools);
  const sessions = new Map();
  const server = (tls ? httpsServer : httpServer)(...(tls ? [{ ...tls, minVersion: 'TLSv1.3' }] : []), async (request, response) => {
    let rpcId = null; let method = 'transport';
    try {
      if (new URL(request.url, 'http://localhost').pathname !== '/mcp') { json(response, 404, { error: 'mcp_endpoint_required' }); return; }
      if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) { json(response, 403, { error: 'mcp_origin_required' }); return; }
      const principal = await authenticate(request, audience);
      if (!principal?.principalId) { json(response, 401, { error: 'mcp_identity_required' }); return; }
      const now = Date.parse(clock());
      for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
      const sessionId = request.headers['mcp-session-id']; const session = sessions.get(sessionId);
      if (request.method === 'DELETE') {
        if (!session || session.principalId !== principal.principalId) { json(response, 404, null); return; }
        if (request.headers['mcp-protocol-version'] !== session.protocolVersion) { json(response, 400, { error: 'mcp_protocol_version_required' }); return; }
        sessions.delete(sessionId); json(response, 200, null); return;
      }
      if (request.method !== 'POST') { json(response, 405, null, { Allow: 'POST, DELETE' }); return; }
      if (!String(request.headers['content-type']).startsWith('application/json') || !String(request.headers.accept).includes('application/json') || !String(request.headers.accept).includes('text/event-stream')) { json(response, 415, { error: 'mcp_content_type_required' }); return; }
      const message = JSON.parse(await boundedJson(request, 131072));
      if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || (message.id !== undefined && typeof message.id !== 'string' && typeof message.id !== 'number')) throw new Error('MCP JSON-RPC message required');
      rpcId = message.id ?? null; method = message.method;
      trace?.({ direction: 'receive', serverId, method, id: rpcId, payloadHash: approvalHash(message) });
      if (method === 'initialize') {
        if (typeof message.params?.protocolVersion !== 'string' || sessions.size >= 256 || rpcId === null) throw new Error('MCP initialization version and capacity required');
        const protocolVersion = VERSIONS.has(message.params.protocolVersion) ? message.params.protocolVersion : VERSION;
        const newSession = randomBytes(24).toString('base64url');
        sessions.set(newSession, { principalId: principal.principalId, protocolVersion, initialized: false, expiresAt: now + 600000 });
        json(response, 200, { jsonrpc: '2.0', id: rpcId, result: { protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: serverId, version: '1.0.0' } } }, { 'MCP-Session-Id': newSession }); return;
      }
      if (!session || session.principalId !== principal.principalId) { json(response, 404, { error: 'mcp_session_required' }); return; }
      if (request.headers['mcp-protocol-version'] !== session.protocolVersion) { json(response, 400, { error: 'mcp_protocol_version_required' }); return; }
      if (method === 'notifications/initialized' && rpcId === null) { session.initialized = true; json(response, 202, null); return; }
      if (!session.initialized || rpcId === null) throw new Error('Initialized MCP request required');
      if (method === 'ping') { json(response, 200, { jsonrpc: '2.0', id: rpcId, result: {} }); return; }
      if (method === 'tools/list') { json(response, 200, { jsonrpc: '2.0', id: rpcId, result: { tools: [...catalog.values()].map(wireTool) } }); return; }
      if (method !== 'tools/call') { json(response, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32601, message: 'Registered MCP method required' } }); return; }
      const { name, arguments: input = {}, _meta } = message.params ?? {};
      if (!catalog.has(name)) throw new Error('Registered MCP tool required');
      let tool;
      try { tool = validateTool(catalog, name, 'input', input); }
      catch { json(response, 200, { jsonrpc: '2.0', id: rpcId, result: { content: [{ type: 'text', text: 'MCP tool input schema review required' }], isError: true } }); return; }
      const context = _meta?.['privacy-bubble'];
      if (!context || !/^[a-f0-9]{64}$/.test(context.operationKey) || !/^[a-f0-9]{64}$/.test(context.approvalHash)
        || context.principalId !== principal.principalId || context.audience !== audience || typeof context.grantId !== 'string'
        || !Number.isInteger(context.grantRevision) || context.grantRevision < 1 || !Number.isFinite(Date.parse(context.deadline)) || Date.parse(context.deadline) <= Date.parse(clock())) throw new Error('MCP call approval and deadline required');
      if (!Array.isArray(principal.scopes) || !principal.scopes.includes(tool.requiredScope)) throw new Error('MCP token tool scope required');
      if (typeof handlers?.[name] !== 'function') throw new Error('MCP domain tool adapter required');
      const result = await store.transaction(`mcp-tool:${context.operationKey}`, async () => {
        await authorizeCall({ principal, context, tool: { serverId, name, requiredScope: tool.requiredScope }, input });
        const intentHash = approvalHash({ serverId, name, input, principalId: principal.principalId, approvalHash: context.approvalHash, grantId: context.grantId, grantRevision: context.grantRevision });
        const prior = store.get('mcpToolOperations', context.operationKey);
        if (prior) { if (prior.intentHash !== intentHash) throw new Error('MCP original operation intent required'); return prior.output; }
        let timer;
        let output;
        try { output = await Promise.race([handlers[name](input, { ...context, store, principal }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MCP server tool timeout')), timeoutMs); })]); }
        finally { clearTimeout(timer); }
        validateTool(catalog, name, 'output', output);
        if (Date.parse(context.deadline) <= Date.parse(clock())) throw new Error('Current MCP tool deadline required');
        await authorizeCall({ principal, context, tool: { serverId, name, requiredScope: tool.requiredScope }, input });
        await store.put('mcpToolOperations', context.operationKey, { operationKey: context.operationKey, intentHash, output, completedAt: clock() });
        await store.append('receipts', recordEnvelope({ type: 'MCP_TOOL_COMMITTED', serverId, tool: name, runId: context.runId, operationKey: context.operationKey, outputHash: approvalHash(output) }, clock));
        return output;
      });
      const envelope = { jsonrpc: '2.0', id: rpcId, result: { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false } };
      trace?.({ direction: 'send', serverId, method, id: rpcId, payloadHash: approvalHash(envelope) });
      json(response, 200, envelope);
    } catch {
      if (!response.headersSent) json(response, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32602, message: 'MCP schema, approval or current authority review required' } });
      else response.end();
    }
  });
  return server;
}
