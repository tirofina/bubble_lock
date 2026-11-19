import test from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  BINDING_TABLE_VERSION, BindingTableSource, HashChainedAudit, certificateIdentities, decideOrigin, headerValues,
  parseBindingTable, parseSubjectAltName, renderNginxOriginatorMap, resolveBinding, verifyAuditChain, writeBindingTable,
} from '../src/originator-binding.mjs';
import { forwardHeaders } from '../src/originator-binding-proxy.mjs';
import { authorizeMqttRequest, parseOneM2mTopic, renderMosquittoAcl, renderMosquittoConf, startMqttOriginatorGuard, topicId } from '../src/mqtt-originator-guard.mjs';
import { createTestPki } from './support/mini-pki.mjs';

const pki = createTestPki();
const guardian = pki.client('pb-guardian');
const executor = pki.client('pb-executor');
const fingerprint = (pem) => new X509Certificate(pem).fingerprint256;
const table = (bindings, revision = 1) => ({ version: BINDING_TABLE_VERSION, revision, cseId: '/acp-a', bindings });
const guardianBinding = { bindingId: 'guardian', role: 'guardian', identity: { type: 'uri', value: 'urn:privacy-bubble:test:pb-guardian' }, originator: 'Cpb-guardian', certificateSha256: fingerprint(guardian.cert), mqttUsername: 'pb-guardian' };
const executorBinding = { bindingId: 'executor', role: 'executor', identity: { type: 'cn', value: 'pb-executor' }, originator: 'Cpb-executor' };

test('binding table maps one certificate identity to exactly one originator and fails closed on bad rows', () => {
  const parsed = parseBindingTable(table([guardianBinding, executorBinding]));
  assert.equal(parsed.bindings.length, 2);
  assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
  assert.throws(() => parseBindingTable(table([guardianBinding, { ...executorBinding, identity: guardianBinding.identity }])), /duplicate identity/);
  assert.throws(() => parseBindingTable(table([{ ...guardianBinding, originator: '/Mobius/admin' }])), /originator/);
  assert.throws(() => parseBindingTable(table([{ ...guardianBinding, originator: 'C' }])), /originator/);
  assert.throws(() => parseBindingTable({ ...table([guardianBinding]), version: 'v0' }), /version/);
  assert.throws(() => parseBindingTable(table([guardianBinding, { ...executorBinding, mqttUsername: 'pb-guardian' }])), /mqttUsername/);
  assert.throws(() => parseBindingTable(table([{ ...guardianBinding, certificateSha256: 'abc' }])), /certificateSha256/);
});

test('certificate identities come from SAN URI and CN of the verified certificate', () => {
  assert.deepEqual(parseSubjectAltName('URI:urn:a, DNS:localhost, URI:"urn:b,c", IP Address:127.0.0.1').map((entry) => entry.value), ['urn:a', 'localhost', 'urn:b,c', '127.0.0.1']);
  const identities = certificateIdentities(new X509Certificate(guardian.cert));
  assert.deepEqual(identities.uris, ['urn:privacy-bubble:test:pb-guardian']);
  assert.deepEqual(identities.cns, ['pb-guardian']);
  assert.equal(identities.fingerprint256, fingerprint(guardian.cert));
  assert.deepEqual(certificateIdentities({ subject: { CN: 'x' }, subjectaltname: 'URI:urn:x', fingerprint256: fingerprint(guardian.cert) }).cns, ['x']);
});

test('resolution rejects unbound, ambiguous, cloned and expired bindings', () => {
  const parsed = parseBindingTable(table([guardianBinding, executorBinding]));
  assert.equal(resolveBinding(parsed, new X509Certificate(guardian.cert)).binding.bindingId, 'guardian');
  assert.equal(resolveBinding(parsed, new X509Certificate(executor.cert)).binding.bindingId, 'executor');
  assert.equal(resolveBinding(parsed, new X509Certificate(pki.client('pb-stranger').cert)).code, 'ORIGINATOR_BINDING_NOT_FOUND');
  const clone = pki.client('pb-guardian');
  assert.equal(resolveBinding(parsed, new X509Certificate(clone.cert)).code, 'ORIGINATOR_BINDING_CERTIFICATE_MISMATCH');
  const ambiguous = pki.client('pb-executor', { uris: ['urn:privacy-bubble:test:pb-guardian'] });
  assert.equal(resolveBinding(parseBindingTable(table([{ ...guardianBinding, certificateSha256: null }, executorBinding])), new X509Certificate(ambiguous.cert)).code, 'ORIGINATOR_BINDING_AMBIGUOUS');
  const expired = parseBindingTable(table([{ ...executorBinding, notAfter: '2026-01-01T00:00:00Z' }]));
  assert.equal(resolveBinding(expired, new X509Certificate(executor.cert), { now: Date.parse('2026-11-19T00:00:00Z') }).code, 'ORIGINATOR_BINDING_EXPIRED');
  assert.equal(resolveBinding(null, new X509Certificate(executor.cert)).code, 'BINDING_TABLE_UNAVAILABLE');
});

test('client-supplied X-M2M-Origin is injected when absent, kept when equal, rejected otherwise', () => {
  const binding = parseBindingTable(table([guardianBinding])).bindings[0];
  assert.deepEqual(decideOrigin(binding, []), { ok: true, originator: 'Cpb-guardian', supplied: 'ABSENT', mode: 'INJECTED' });
  assert.equal(decideOrigin(binding, ['Cpb-guardian']).mode, 'MATCHED');
  assert.equal(decideOrigin(binding, ['Cpb-executor']).code, 'ORIGINATOR_MISMATCH');
  assert.equal(decideOrigin(binding, ['C']).code, 'ORIGINATOR_MISMATCH');
  assert.equal(decideOrigin(binding, ['Cpb-guardian', 'Cpb-executor']).code, 'ORIGINATOR_HEADER_DUPLICATE');
  assert.equal(decideOrigin(binding, ['Cpb-guardian, Cpb-executor']).code, 'ORIGINATOR_HEADER_DUPLICATE');
  assert.match(decideOrigin(binding, ['Sadmin']).suppliedDigest, /^[0-9a-f]{16}$/);
  assert.deepEqual(headerValues(['X-M2M-Origin', 'a', 'accept', 'b', 'x-m2m-origin', 'c'], 'x-m2m-origin'), ['a', 'c']);
});

test('forwarded headers carry only the bound originator and drop forged identity hints', () => {
  const { headers, stripped } = forwardHeaders({ host: 'front', connection: 'keep-alive, x-hop', 'x-hop': '1', 'x-m2m-origin': 'Sadmin', 'x-ssl-client-s-dn': 'CN=pb-executor', 'x-forwarded-client-cert': 'Hash=1', forwarded: 'for=1', 'x-m2m-ri': 'rq-1', 'content-type': 'application/json;ty=4', 'transfer-encoding': 'chunked' }, 'Cpb-guardian', 5);
  assert.deepEqual(headers, { 'x-m2m-ri': 'rq-1', 'content-type': 'application/json;ty=4', 'x-m2m-origin': 'Cpb-guardian', 'content-length': '5' });
  assert.deepEqual(stripped.sort(), ['forwarded', 'x-forwarded-client-cert', 'x-ssl-client-s-dn']);
});

test('binding table source reloads on change without restart and fails closed on missing or malformed tables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-binding-'));
  try {
    const path = join(directory, 'bindings.json');
    await writeBindingTable(path, table([guardianBinding, executorBinding], 1));
    const source = new BindingTableSource(path);
    assert.equal((await source.current()).table.bindings.length, 2);
    await writeBindingTable(path, table([executorBinding], 2));
    const revoked = await source.current();
    assert.equal(revoked.table.revision, 2);
    assert.equal(resolveBinding(revoked.table, new X509Certificate(guardian.cert)).code, 'ORIGINATOR_BINDING_NOT_FOUND');
    await writeFile(path, '{"version":');
    assert.equal((await source.current()).table, null);
    await rm(path);
    assert.equal((await source.current()).error, 'ENOENT');
    await assert.rejects(writeBindingTable(path, table([guardianBinding, { ...executorBinding, identity: guardianBinding.identity }])), /duplicate/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('audit rows form a SHA-256 chain that exposes edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-audit-'));
  try {
    const path = join(directory, 'audit.jsonl');
    const audit = new HashChainedAudit(path);
    await Promise.all([audit.append({ decision: 'FORWARDED' }), audit.append({ decision: 'REJECTED' }), audit.append({ decision: 'FORWARDED' })]);
    const resumed = new HashChainedAudit(path); await resumed.append({ decision: 'REJECTED' });
    const verified = await verifyAuditChain(path);
    assert.equal(verified.ok, true); assert.equal(verified.entries, 4);
    const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    rows[1] = rows[1].replace('REJECTED', 'FORWARDED');
    await writeFile(path, `${rows.join('\n')}\n`);
    assert.deepEqual({ ok: (await verifyAuditChain(path)).ok, brokenAt: (await verifyAuditChain(path)).brokenAt }, { ok: false, brokenAt: 2 });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('nginx and Mosquitto configs are generated per binding from the same table', () => {
  const parsed = parseBindingTable(table([guardianBinding, executorBinding, { bindingId: 'uri-only', identity: { type: 'uri', value: 'urn:x' }, originator: 'Cpb-uri' }]));
  const nginx = renderNginxOriginatorMap(parsed);
  assert.match(nginx.text, /"CN=pb-executor" "Cpb-executor";/);
  assert.deepEqual(nginx.skipped, ['guardian', 'uri-only']);
  const acl = renderMosquittoAcl(parsed, { receivers: ['/acp-a'] });
  assert.equal(acl.users, 2);
  assert.match(acl.text, /user pb-guardian\ntopic write ext\/\/oneM2M\/req\/Cpb-guardian\/acp-a\/json\ntopic read ext\/\/oneM2M\/resp\/Cpb-guardian\/acp-a\/json/);
  assert.match(acl.text, /user pb-executor\ntopic write ext\/\/oneM2M\/req\/Cpb-executor\/acp-a\/json/);
  assert.doesNotMatch(acl.text, /Cpb-uri/);
  assert.doesNotMatch(acl.text, /^topic .*[+#]/m);
  const conf = renderMosquittoConf({ internalPort: 1, externalPort: 2, caPath: 'C:\\a\\ca.pem', certPath: 'c', keyPath: 'k', aclPath: 'a' });
  assert.match(conf, /require_certificate true\nuse_identity_as_username true\ntls_version tlsv1.3\ncafile C:\/a\/ca.pem/);
  assert.match(conf, /listener 2 127.0.0.1\nmount_point ext\//);
});

test('keyring example table generates the nginx include and Mosquitto ACL used by the sibling template', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-configs-'));
  try {
    const script = fileURLToPath(new URL('../scripts/build-originator-binding-configs.mjs', import.meta.url));
    const example = fileURLToPath(new URL('../../keyring/dev/mobius4/originator-binding/bindings.example.json', import.meta.url));
    const result = spawnSync(process.execPath, [script, `--table=${example}`, `--out=${directory}`, '--receiver=/Mobius4', '--mount-point='], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).nginxEntries, 1);
    assert.match(await readFile(join(directory, 'originator-map.conf'), 'utf8'), /"CN=keyring-dev-gateway" "Ckeyring-dev-gateway";/);
    assert.match(await readFile(join(directory, 'originator.acl'), 'utf8'), /user keyring-dev-gateway\ntopic write \/oneM2M\/req\/Ckeyring-dev-gateway\/Mobius4\/json/);
    const template = await readFile(fileURLToPath(new URL('../../keyring/dev/mobius4/originator-binding/nginx.conf.template', import.meta.url)), 'utf8');
    assert.match(template, /include \/etc\/nginx\/keyring-originator-binding\/originator-map\.conf;/);
    assert.match(template, /proxy_set_header X-M2M-Origin \$bound_originator;/);
    assert.doesNotMatch(template, /CSE_ADMIN/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('MQTT guard binds payload fr to the ACL-authenticated topic originator', () => {
  const parsed = parseBindingTable(table([guardianBinding, executorBinding]));
  assert.equal(topicId('//sp/cse'), ':sp:cse'); assert.equal(topicId('/acp-a'), 'acp-a');
  assert.deepEqual(parseOneM2mTopic('/oneM2M/req/Cpb-guardian/acp-a/json'), { kind: 'req', originator: 'Cpb-guardian', receiver: 'acp-a', serialization: 'json' });
  assert.equal(parseOneM2mTopic('/oneM2M/req/+/acp-a/json'), null);
  const ok = authorizeMqttRequest({ table: parsed, topic: '/oneM2M/req/Cpb-guardian/acp-a/json', primitive: { op: 2, fr: 'Cpb-guardian', rqi: '1' } });
  assert.equal(ok.ok, true); assert.equal(ok.mode, 'MATCHED');
  assert.equal(authorizeMqttRequest({ table: parsed, topic: '/oneM2M/req/Cpb-guardian/acp-a/json', primitive: { op: 2, rqi: '1' } }).primitive.fr, 'Cpb-guardian');
  assert.equal(authorizeMqttRequest({ table: parsed, topic: '/oneM2M/req/Cpb-guardian/acp-a/json', primitive: { op: 3, fr: 'Cpb-executor' } }).code, 'ORIGINATOR_MISMATCH');
  assert.equal(authorizeMqttRequest({ table: parsed, topic: '/oneM2M/req/Cpb-ghost/acp-a/json', primitive: { op: 2 } }).code, 'ORIGINATOR_BINDING_NOT_FOUND');
  assert.equal(authorizeMqttRequest({ table: parsed, topic: '/oneM2M/resp/Cpb-guardian/acp-a/json', primitive: {} }).code, 'MQTT_TOPIC_INVALID');
  assert.equal(authorizeMqttRequest({ table: parsed, topic: '/oneM2M/req/Cpb-guardian/acp-a/json', primitive: [] }).code, 'MQTT_PRIMITIVE_INVALID');
  const rotated = parseBindingTable(table([executorBinding, { bindingId: 'executor-next', identity: { type: 'cn', value: 'pb-executor-next' }, originator: 'Cpb-executor' }, { bindingId: 'old', identity: { type: 'cn', value: 'pb-old' }, originator: 'Cpb-old', notAfter: '2020-01-01T00:00:00Z' }]));
  assert.equal(authorizeMqttRequest({ table: rotated, topic: '/oneM2M/req/Cpb-executor/acp-a/json', primitive: { op: 2, fr: 'Cpb-executor' } }).ok, true);
  assert.equal(authorizeMqttRequest({ table: rotated, topic: '/oneM2M/req/Cpb-old/acp-a/json', primitive: { op: 2 } }).code, 'ORIGINATOR_BINDING_EXPIRED');
});

test('MQTT guard relays only fr-consistent requests and answers spoofs with rsc 4103', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pb-guard-'));
  try {
    const path = join(directory, 'bindings.json');
    await writeBindingTable(path, table([guardianBinding, executorBinding]));
    const published = []; const handlers = [];
    const client = { on: (event, handler) => { if (event === 'message') handlers.push(handler); }, publishAsync: async (topic, payload) => { published.push({ topic, payload: JSON.parse(String(payload)) }); }, subscribeAsync: async (topics) => topics.map((topic) => ({ topic, qos: 1 })), endAsync: async () => {} };
    const guard = await startMqttOriginatorGuard({ client, receivers: ['/acp-a'], tableSource: new BindingTableSource(path), audit: new HashChainedAudit(join(directory, 'guard.jsonl')) });
    assert.ok(guard.subscriptions.includes('ext//oneM2M/req/+/acp-a/json'));
    const deliver = async (topic, body) => { for (const handler of handlers) await handler(topic, Buffer.from(JSON.stringify(body))); };
    await deliver('ext//oneM2M/req/Cpb-guardian/acp-a/json', { op: 2, rqi: 'a', to: 'Mobius/x' });
    assert.deepEqual(published.at(-1), { topic: '/oneM2M/req/Cpb-guardian/acp-a/json', payload: { op: 2, rqi: 'a', to: 'Mobius/x', fr: 'Cpb-guardian' } });
    await deliver('ext//oneM2M/req/Cpb-guardian/acp-a/json', { op: 3, rqi: 'b', fr: 'Cpb-executor' });
    assert.equal(published.at(-1).topic, 'ext//oneM2M/resp/Cpb-guardian/acp-a/json');
    assert.deepEqual([published.at(-1).payload.rsc, published.at(-1).payload.pc['pb:originatorBinding'].code], [4103, 'ORIGINATOR_MISMATCH']);
    await deliver('/oneM2M/resp/Cpb-guardian/acp-a/json', { rqi: 'a', rsc: 2000 });
    assert.equal(published.at(-1).topic, 'ext//oneM2M/resp/Cpb-guardian/acp-a/json');
    await writeBindingTable(path, table([executorBinding], 2));
    await deliver('ext//oneM2M/req/Cpb-guardian/acp-a/json', { op: 2, rqi: 'c', fr: 'Cpb-guardian' });
    assert.equal(published.at(-1).payload.pc['pb:originatorBinding'].code, 'ORIGINATOR_BINDING_NOT_FOUND');
    assert.deepEqual(guard.stats, { forwarded: 1, rejected: 2, responses: 1 });
    assert.equal((await verifyAuditChain(join(directory, 'guard.jsonl'))).entries, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
