import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SDT_PROFILES as CORE_PROFILES, BINARY_SWITCH_CND, normalizeBinarySwitch } from '../src/sdt-adapter.mjs';
import { SDT_PROFILES, selectSdtProfile, switchResource, switchUpdate, describeSwitch, CANONICAL_SDT_PROFILE, LEGACY_SDT_PROFILE } from '../../keyring/dev/mobius4/sdt-profile.mjs';

const keyring = (path) => new URL(`../../keyring/dev/mobius4/${path}`, import.meta.url);
const registry = async (path) => JSON.parse(await readFile(keyring(path), 'utf8'))[BINARY_SWITCH_CND];

test('keyring bench profiles share the CORE SDT envelopes and registries', async () => {
  for (const name of [CANONICAL_SDT_PROFILE, LEGACY_SDT_PROFILE]) assert.equal(SDT_PROFILES[name].envelope, CORE_PROFILES[name].envelope);
  const canonical = await registry('specializations.canonical.json');
  const legacy = await registry('specializations.json');
  assert.equal(`${canonical.namespacePrefix}:${canonical.typeName}`, 'cod:binSh');
  assert.equal(`${legacy.namespacePrefix}:${legacy.typeName}`, 'pb:binarySwitch');
  assert.deepEqual(canonical.attributes, { state: { type: 'boolean', required: true } });
  assert.equal(SDT_PROFILES[LEGACY_SDT_PROFILE].deprecated, true);
  assert.equal(SDT_PROFILES[CANONICAL_SDT_PROFILE].registry, 'specializations.canonical.json');
});

test('legacy bootstrap body is unchanged and canonical body uses cod:binSh', () => {
  const legacy = selectSdtProfile(undefined);
  assert.equal(legacy.name, LEGACY_SDT_PROFILE, 'an environment without KEYRING_SDT_PROFILE keeps the bench profile');
  assert.equal(JSON.stringify(switchResource(legacy, { rn: 'bubbleState', state: false, lbl: ['dev-bootstrap', 'unobserved'] })),
    JSON.stringify({ 'pb:binarySwitch': { rn: 'bubbleState', cnd: BINARY_SWITCH_CND, state: false, lbl: ['dev-bootstrap', 'unobserved'] } }));
  const canonical = selectSdtProfile('r4-common-1.0');
  assert.deepEqual(switchResource(canonical, { rn: 'featherState', state: false, lbl: [] }), { 'cod:binSh': { rn: 'featherState', cnd: BINARY_SWITCH_CND, state: false, lbl: [] } });
  assert.deepEqual(switchUpdate(canonical, true), { 'cod:binSh': { state: true } });
  assert.deepEqual(normalizeBinarySwitch(switchUpdate(legacy, true), { sourceVersion: LEGACY_SDT_PROFILE }).envelope, switchUpdate(canonical, true));
  assert.throws(() => selectSdtProfile('home-legacy-1.0'), /Unsupported/);
  assert.throws(() => switchUpdate(canonical, 'true'));
});

test('dual reader identifies both representations and rejects mixed payloads', () => {
  assert.equal(describeSwitch({ 'cod:binSh': { rn: 'x', state: true } }).profile, CANONICAL_SDT_PROFILE);
  assert.equal(describeSwitch({ 'pb:binarySwitch': { rn: 'x', state: true } }).deprecated, true);
  assert.equal(describeSwitch({ 'cod:binSh': {}, 'pb:binarySwitch': {} }), null);
  assert.equal(describeSwitch({ 'm2m:cnt': {} }), null);
});

test('bench consumer and compose files select the envelope from KEYRING_SDT_PROFILE', async () => {
  const consumer = await readFile(keyring('scoped-telemetry/consumer.mjs'), 'utf8');
  assert.match(consumer, /'r4-common-1\.0': 'cod:binSh'/);
  assert.match(consumer, /process\.env\.KEYRING_SDT_PROFILE \|\| 'pb-legacy-1\.0'/);
  assert.doesNotMatch(consumer, /JSON\.stringify\(\{ 'pb:binarySwitch'/);
  assert.match(await readFile(keyring('compose.yaml'), 'utf8'), /\$\{KEYRING_SDT_REGISTRY:-\.\/specializations\.json\}:\/app\/config\/specializations\.json:ro/);
  assert.match(await readFile(keyring('compose.scoped.yaml'), 'utf8'), /KEYRING_SDT_PROFILE: \$\{KEYRING_SDT_PROFILE:-pb-legacy-1\.0\}/);
  assert.match(await readFile(keyring('prepare-scoped.ps1'), 'utf8'), /\$SdtProfile = 'r4-common-1\.0'/);
});
