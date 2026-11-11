import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';

export function certificatePrincipal(request, principals) {
  if (!request.socket.authorized) return null;
  const fingerprint = request.socket.getPeerCertificate()?.fingerprint256;
  if (typeof fingerprint !== 'string' || !fingerprint) return null;
  const provisioned = principals.find((entry) => entry.mtlsFingerprint === fingerprint);
  return provisioned ? { ...provisioned } : null;
}

export function createIntegrationServer({ api, tls = null, principals = [], oidcVerifier = null, deployment = null, certificateResolver = null }) {
  const certificateSockets = new Map();
  const handler = async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'READY', transport: tls ? oidcVerifier ? 'mtls-or-oidc' : 'mtls' : 'loopback-health', ...(deployment ? { deployment } : {}) }));
        return;
      }
      let principal = null;
      if (tls && request.socket.authorized) {
        const fingerprint = request.socket.getPeerCertificate()?.fingerprint256;
        const registered = fingerprint && certificateResolver ? await certificateResolver(fingerprint) : { status: 'UNKNOWN' };
        if (!['ACTIVE', 'BOOTSTRAP', 'LOST', 'REVOKED', 'UNKNOWN'].includes(registered?.status)) throw Error('Certificate registration status required');
        if (registered.status === 'BOOTSTRAP' && !(request.method === 'POST' && request.url === '/v1/gateway-registrations')
          || ['LOST', 'REVOKED'].includes(registered.status) && !(request.method === 'GET' && /^\/api\/v1\/gateways\/[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\/credentials\/status$/.test(request.url))) {
          response.writeHead(403, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'Credential lifecycle scope required' })); return;
        }
        principal = registered.status === 'UNKNOWN' ? certificatePrincipal(request, principals) : registered.principal ?? null;
      }
      if (!principal && tls && oidcVerifier && request.headers.authorization) {
        try { principal = await oidcVerifier.principal(request.headers.authorization, principals); }
        catch { principal = null; }
      }
      if (!principal) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Verified enrolled identity required' }));
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 65536) {
          response.writeHead(413);
          response.end();
          return;
        }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const result = await api.handle({ method: request.method, path: request.url, principal, body });
      response.writeHead(result.status, result.headers);
      response.end(JSON.stringify(result.body));
    } catch {
      if (!response.headersSent) response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Valid JSON request required' }));
    }
  };
  const server = tls
    ? httpsServer({ ...tls, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: oidcVerifier === null }, handler)
    : httpServer(handler);
  if (tls) server.on('secureConnection', (socket) => {
    if (!socket.authorized) return;
    const fingerprint = socket.getPeerCertificate()?.fingerprint256;
    if (!fingerprint) return;
    let sockets = certificateSockets.get(fingerprint);
    if (!sockets) { sockets = new Set(); certificateSockets.set(fingerprint, sockets); }
    sockets.add(socket); socket.once('close', () => { sockets.delete(socket); if (!sockets.size) certificateSockets.delete(fingerprint); });
  });
  server.terminateCertificateSessions = (fingerprint) => {
    const sockets = certificateSockets.get(fingerprint); const terminated = sockets?.size ?? 0;
    for (const socket of sockets ?? []) socket.destroy();
    return { terminated, scope: 'gateway-certificate-sockets' };
  };
  return server;
}
