import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

const exec = promisify(execFile);
const domain = 'compose-networks.example.invalid';
let directory;
let config;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'bubble-compose-networks-'));
  for (const name of ['tmp', 'node-cache', 'bun-cache']) await mkdir(join(directory, name));
  const { stdout } = await exec('docker', [
    'compose', '-f', resolve('deployment/compose.yaml'), '--profile', 'tools',
    'config', '--no-env-resolution', '--format', 'json',
  ], {
    env: {
      ...process.env,
      RUN_TMP: directory,
      PUBLIC_DOMAIN: domain,
      TMPDIR: join(directory, 'tmp'),
      NODE_COMPILE_CACHE: join(directory, 'node-cache'),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(directory, 'bun-cache'),
    },
    maxBuffer: 2 * 1024 * 1024,
  });
  config = JSON.parse(stdout);
});
after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

const networks = (service) => Object.keys(config.services[service].networks ?? {});
const connected = (left, right) => networks(left).some((name) => networks(right).includes(name));
const pair = (left, right) => [left, right].sort().join('/');
// Addresses: nginx.conf.template, configure.mjs, provision{,-cse}.mjs,
// init-volumes.mjs, mqtt-bridge.mjs and compose.yaml.
const required = [
  ['proxy', 'web'], ['proxy', 'api'], ['proxy', 'keycloak'], ['proxy', 'cse'],
  ['web', 'api'], ['api', 'postgres'], ['api', 'cse'],
  ['keycloak', 'postgres'], ['mqtt-bridge', 'mqtt'], ['mqtt-bridge', 'cse'],
  ['cse', 'cse-db'], ['db-init', 'postgres'], ['provision', 'cse'],
];
// PostgreSQL's consumers share its private network; ingress is retained for
// the two published services and the ACME client.
const sharedPeers = [
  ['api', 'keycloak'], ['api', 'db-init'], ['keycloak', 'db-init'],
  ['proxy', 'mqtt'], ['proxy', 'certbot'], ['mqtt', 'certbot'],
];

test('runtime and tools retain every configured service connection', () => {
  for (const [left, right] of required) {
    assert.ok(connected(left, right), `${left} must reach ${right}`);
  }
});

test('unrelated services have no shared network including tools profiles', () => {
  const allowed = new Set([...required, ...sharedPeers].map(([left, right]) => pair(left, right)));
  const services = Object.keys(config.services);
  for (const [index, left] of services.entries()) {
    for (const right of services.slice(index + 1)) {
      if (!allowed.has(pair(left, right))) {
        assert.equal(connected(left, right), false, `${left} must not reach ${right}`);
      }
    }
  }
});

test('database networks contain only their consumers', () => {
  for (const [database, consumers] of [
    ['postgres', ['api', 'db-init', 'keycloak']],
    ['cse-db', ['cse']],
  ]) {
    const peers = Object.keys(config.services).filter((service) => service !== database && connected(database, service));
    assert.deepEqual(peers.sort(), consumers.sort(), `${database} peers`);
    for (const name of networks(database)) assert.equal(config.networks[name].internal, true);
  }
});

test('OIDC clients resolve the public domain to proxy on their shared internal network', () => {
  for (const client of ['web', 'api']) {
    assert.ok(networks(client).some((name) =>
      config.networks[name].internal === true
      && config.services.proxy.networks[name]?.aliases?.includes(domain),
    ), `${client} must resolve the public OIDC origin to proxy`);
  }
});

test('volume-only helpers have no network and all private networks are internal', () => {
  for (const service of ['init', 'static', 'cert-install']) {
    assert.equal(config.services[service].network_mode, 'none', `${service} needs only volumes`);
    assert.deepEqual(networks(service), []);
  }
  for (const [name, network] of Object.entries(config.networks)) {
    if (name !== 'ingress') assert.equal(network.internal, true, `${name} must be internal`);
  }
  assert.deepEqual(
    Object.keys(config.services).filter((service) => networks(service).includes('ingress')).sort(),
    ['certbot', 'mqtt', 'proxy'],
  );
});
