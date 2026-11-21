import { createServer } from 'node:https';

export function createExternalEdgeCallback(runtime, config) {
  return createServer({ ...config.server.tls, minVersion: 'TLSv1.3', requestCert: true, rejectUnauthorized: true }, async (request, response) => {
    const send = (status) => { response.writeHead(status, { 'X-M2M-RSC': status === 200 ? '2000' : '4000', 'X-M2M-RI': request.headers['x-m2m-ri'] ?? '' }); response.end(); };
    try {
      const url = new URL(request.url, 'https://callback.invalid');
      const edge = config.core.handover.edges.find((entry) => new URL(entry.callbackUrl).pathname === url.pathname);
      if (request.method !== 'POST' || !edge || !request.socket.authorized
        || request.socket.getPeerCertificate().fingerprint256 !== edge.notificationFingerprint
        || request.headers['x-m2m-origin'] !== edge.cseId) return send(403);
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 65536) return send(413); chunks.push(chunk); }
      const signal = JSON.parse(Buffer.concat(chunks).toString())['m2m:sgn'];
      const expected = url.searchParams.get('subscription');
      const raw = signal.sur;
      if (typeof raw !== 'string' || !expected?.startsWith(`${edge.cseBase}/`)) return send(400);
      const subscriptionUri = raw.startsWith(`${edge.cseBase.slice(1)}/`) ? `/${raw}` : raw.slice(raw.indexOf(edge.cseBase));
      if (subscriptionUri !== expected) return send(400);
      await runtime.handoverCoordinator.notification({ edgeId: edge.edgeId, subscriptionUri, verified: true });
      return send(200);
    } catch { return send(400); }
  });
}
