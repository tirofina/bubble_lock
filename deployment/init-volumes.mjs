import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';
const exec = promisify(execFile);
const directory = resolve(process.env.RUN_TMP ?? '.local/deployment');
const project = process.env.COMPOSE_PROJECT_NAME ?? 'bubblelock-deploy';
const name = `${project}-config-init`;
const compose = ['compose', '-f', 'deployment/compose.yaml', '--profile', 'tools'];
const run = async (args) => (await exec('docker', args, { maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
const bridge = JSON.parse(await readFile(resolve(directory, 'bridge.json'), 'utf8'));
const gatewayId = bridge.identities[0];
const fingerprint = new X509Certificate(await readFile(resolve(directory, 'pki/gateway-1.pem'))).fingerprint.replaceAll(':', '');
const mapOrigins = new Set(['https://tile.openstreetmap.org', 'https://tiles.stadiamaps.com']);
if (process.env.VITE_MAP_TILE_URL && !process.env.VITE_MAP_TILE_URL.startsWith('/')) {
  const url = new URL(process.env.VITE_MAP_TILE_URL);
  if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('Custom map tiles require an HTTPS origin without credentials');
  mapOrigins.add(url.origin);
}
const nginx = await readFile('deployment/nginx.conf.template', 'utf8');
const origin = new URL(`https://${process.env.PUBLIC_DOMAIN || 'bubble.localhost'}:${process.env.HTTPS_PORT ?? 443}`).origin;
const keycloakEnv = await readFile(resolve(directory, 'keycloak.env'), 'utf8');
await writeFile(resolve(directory, 'keycloak.env'), `${keycloakEnv.replace(/^KC_HOSTNAME=.*\n?/m, '')}KC_HOSTNAME=${origin}/identity\n`, { mode: 0o600 });
await writeFile(resolve(directory, 'nginx.conf'), nginx.replaceAll('@HOST@', process.env.PUBLIC_DOMAIN || 'bubble.localhost').replaceAll('@PUBLIC_ORIGIN@', origin).replaceAll('@HTTPS_PORT@', process.env.HTTPS_PORT ?? '443').replaceAll('@GATEWAY_ID@', gatewayId).replaceAll('@GATEWAY_FINGERPRINT@', fingerprint).replaceAll('@MAP_ORIGINS@', [...mapOrigins].join(' ')), { mode: 0o600 });
bridge.endpoint = 'https://cse:8443';
await writeFile(resolve(directory, 'bridge.json'), JSON.stringify(bridge), { mode: 0o600 });
await run([...compose, 'run', '-d', '--no-deps', '--name', name, 'init']);
try {
  await run(['exec', name, 'sh', '-c', 'mkdir -p /init/api/pki /init/web/pki /init/postgres /init/cse /init/bridge /init/mqtt; chown 70:70 /init/postgres; chown 999:999 /init/cse-db; chown 1000:1000 /init/receipts /init/static /init/cse /init/mqtt-data']);
  for (const [source, target] of [
    ['api.json', 'api/api.json'], ['portal.json', 'web/portal.json'], ['realm.json', 'identity/bubble-realm.json'],
    ['nginx.conf', 'proxy/nginx.conf'], ['pki/public.pem', 'proxy/public.pem'], ['pki/public.key', 'proxy/public.key'], ['pki/ca.pem', 'proxy/ca.pem'],
    ['pki/api.pem', 'api/pki/api.pem'], ['pki/api.key', 'api/pki/api.key'], ['pki/ca.pem', 'api/pki/ca.pem'], ['pki/ca.pem', 'web/pki/ca.pem'],
    ['pki/mqtt.pem', 'mqtt/server.pem'], ['pki/mqtt.key', 'mqtt/server.key'], ['pki/ca.pem', 'mqtt/ca.pem'],
    ['bridge.json', 'bridge/bridge.json'], ['pki/cse.pem', 'bridge/client.pem'], ['pki/cse.key', 'bridge/client.key'], ['pki/ca.pem', 'bridge/ca.pem'],
    ['pki/cse-server.pem', 'cse-config/server.pem'], ['pki/cse-server.key', 'cse-config/server.key'], ['pki/ca.pem', 'cse-config/ca.pem'],
    ['pki/gateway-1.pem', 'proxy/gateway.pem'], ['pki/gateway-1.key', 'proxy/gateway.key'],
  ]) await run(['cp', resolve(directory, source), `${name}:/init/${target}`]);
  await run(['cp', 'deployment/mosquitto.conf', `${name}:/init/mqtt/mosquitto.conf`]);
  await writeFile(resolve(directory, 'mqtt.acl'), (await readFile('deployment/mqtt.acl', 'utf8')).replaceAll('gateway-1', gatewayId), { mode: 0o600 });
  await run(['cp', resolve(directory, 'mqtt.acl'), `${name}:/init/mqtt/acl`]);
  await run(['exec', name, 'sh', '-c', 'chown -R 1000:1000 /init/api /init/web /init/identity /init/bridge /init/cse-config; chown -R 101:101 /init/proxy; chown -R 1883:1883 /init/mqtt /init/mqtt-data; chmod -R go-rwx /init/api /init/web /init/identity /init/bridge /init/cse-config /init/proxy /init/mqtt']);
  console.log(JSON.stringify({ status: 'VOLUMES_INITIALIZED', project, hostBindMounts: 0 }));
} finally {
  await run(['rm', '-f', name]);
}
await run([...compose, 'up', '-d', 'postgres', 'cse-db']);
await run([...compose, 'run', '--rm', 'db-init']);
console.log(JSON.stringify({ status: 'DATABASES_INITIALIZED', project }));
