import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [tree, pki] = process.argv.slice(2);
const { GatewayBridge } = await import(pathToFileURL(join(tree, 'pc-mobius', 'src', 'gateway-bridge.mjs')));
const [ca, cert, key] = await Promise.all(['trusted.pem', 'client.pem', 'client.key'].map((name) =>
  readFile(join(pki, name))));
const input = [];
for await (const chunk of process.stdin) input.push(chunk);
const { baseUrl, originator, paths, projections } = JSON.parse(Buffer.concat(input));

function fetchImpl(url, options) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: options.method, headers: options.headers, ca, cert, key,
      agent: false, minVersion: 'TLSv1.3' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        assert.equal(res.socket.getProtocol(), 'TLSv1.3');
        assert.equal(res.headers['x-m2m-rsc'], '2004');
        resolve({ status: res.statusCode, text: async () => Buffer.concat(chunks).toString() });
      });
    });
    req.setTimeout(4000, () => req.destroy(new Error('CSE UPDATE timed out')));
    req.on('error', reject);
    req.end(options.body);
  });
}

for (const [index, order] of [projections.slice().reverse(), projections].entries()) {
  const gatewayId = index ? 'gw-test' : 'gw-baseline';
  const bridge = new GatewayBridge({ mqttClient: {}, fetchImpl, baseUrl, originator,
    resourcePath: paths[index], gatewayId });
  for (const projection of order) {
    const payload = { ...projection, gatewayId };
    const receipt = await bridge.handleMessage(bridge.telemetryTopic, Buffer.from(JSON.stringify(payload)));
    assert.equal(receipt.status, 'APPLIED');
  }
}
