import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadSdtProbe() {
  const [tree, pki] = process.argv.slice(2);
  const { GatewayBridge } = await import(pathToFileURL(join(tree, 'pc-mobius', 'src', 'gateway-bridge.mjs')));
  const [ca, cert, key] = await Promise.all(['trusted.pem', 'client.pem', 'client.key'].map((name) =>
    readFile(join(pki, name))));
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks));

  function tlsFetch(url, options) {
    return new Promise((resolve, reject) => {
      const req = request(url, { method: options.method, headers: options.headers, ca, cert, key,
        agent: false, minVersion: 'TLSv1.3' }, (res) => {
        const body = [];
        res.on('data', (chunk) => body.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          try {
            assert.equal(res.socket.getProtocol(), 'TLSv1.3');
            assert.equal(res.headers['x-m2m-rsc'], '2004');
            resolve({ status: res.statusCode, text: async () => Buffer.concat(body).toString() });
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(4000, () => req.destroy(new Error('CSE UPDATE timed out')));
      req.on('error', reject);
      req.end(options.body);
    });
  }

  function bridge(resourcePath, gatewayId, fetchImpl = tlsFetch) {
    return new GatewayBridge({ mqttClient: {}, fetchImpl, baseUrl: input.baseUrl, originator: input.originator,
      resourcePath, gatewayId });
  }
  return { tree, pki, input, tlsFetch, bridge };
}

export function deliver(bridge, payload) {
  return bridge.handleMessage(bridge.telemetryTopic, Buffer.from(JSON.stringify(payload)));
}
