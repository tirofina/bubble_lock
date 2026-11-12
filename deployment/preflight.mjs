import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
if (process.env.RUN_TMP && !isAbsolute(process.env.RUN_TMP)) throw new TypeError('RUN_TMP must be absolute');
const ports = [
  Number(process.env.HTTP_PORT ?? 80),
  Number(process.env.HTTPS_PORT ?? 443),
  Number(process.env.MQTT_PORT ?? 8883),
];
if (new Set(ports).size !== ports.length) throw new RangeError('Published ports must be distinct');
for (const port of ports) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Invalid TCP port');
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, process.env.BIND_ADDRESS ?? '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
console.log(JSON.stringify({ status: 'PORTS_AVAILABLE', ports }));
