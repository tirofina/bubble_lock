import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';

export function certificatePrincipal(request, principals) {
  if (!request.socket.authorized) return null;
  const fingerprint = request.socket.getPeerCertificate()?.fingerprint256;
  const provisioned = principals.find((entry) => entry.mtlsFingerprint === fingerprint);
  return provisioned ? { ...provisioned } : null;
}

export function createIntegrationServer({ api, tls = null, principals = [] }) {
  const handler = async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'READY', transport: tls ? 'mtls' : 'loopback-health' }));
        return;
      }
      const principal = tls ? certificatePrincipal(request, principals) : null;
      if (!principal) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'Verified certificate enrollment required' }));
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
  return tls
    ? httpsServer({ ...tls, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true }, handler)
    : httpServer(handler);
}
